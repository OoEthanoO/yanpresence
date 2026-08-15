import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

import log from './log.js';
import { classifyAppleUrl, webMusicSnapshot } from './webmedia.js';

const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const NAME_PREFIX = 'org.mpris.MediaPlayer2.';

/**
 * Reads what a browser is playing off the session bus, with no install.
 *
 * Every browser on Linux publishes the page's Media Session metadata over
 * MPRIS -- title, artist, album, artwork, position -- which is exactly the
 * material the presence card is built from. What it does not always publish is
 * *which page*, and that is the difference between a working integration and
 * announcing YouTube as Apple Music:
 *
 *   Firefox   sets xesam:url to the page URL. Fully self-identifying, so
 *             Apple Music and Apple TV are picked out automatically.
 *   Chrome    sets no URL at all (verified on 151). Worse, for Apple Music
 *             there is nothing else either: the site publishes no Media
 *             Session metadata to Chrome, so Chrome falls back to the tab
 *             title and the artist and album come through empty. Chrome is a
 *             job for the companion extension, not for this file.
 *
 * Emits `music` snapshots shaped exactly like the Music.app watcher's own.
 */
export class MprisSource extends EventEmitter {
  constructor({
    pollIntervalMs = 1000,
    idlePollIntervalMs = 5000,
    discoverIntervalMs = 5000,
    busctlPath = 'busctl',
    players = {},
    shouldWarnUnmapped = () => true,
  } = {}) {
    super();
    this.pollIntervalMs = pollIntervalMs;
    this.idlePollIntervalMs = Math.max(pollIntervalMs, idlePollIntervalMs);
    this.discoverIntervalMs = discoverIntervalMs;
    this.busctlPath = busctlPath;
    this.players = normalizePlayerMap(players);
    // A player with no page URL is only worth complaining about while nothing
    // else can identify it. Once the extension is reporting, Chrome playing
    // something unrelated is not a problem to be solved.
    this.shouldWarnUnmapped = shouldWarnUnmapped;

    this.names = [];
    this.identities = new Map();
    this.lastDiscoverAt = 0;
    this.timer = null;
    this.stopped = true;
    this.ticking = false;
    this.warned = new Set();
    this.available = null; // null = not yet determined
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    // Deliberately not unref'd: on the browser sources this timer is the only
    // thing holding the event loop open, and an unref'd one lets the daemon
    // exit the moment it finishes starting up.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;

    let busy = false;
    try {
      busy = await this.poll();
    } catch (err) {
      this.warnOnce('poll', `MPRIS poll failed: ${err.message}`);
      this.emitIdle();
    } finally {
      this.ticking = false;
      this.schedule(busy ? this.pollIntervalMs : this.idlePollIntervalMs);
    }
  }

  async poll() {
    const now = Date.now();
    if (now - this.lastDiscoverAt >= this.discoverIntervalMs || !this.names.length) {
      this.lastDiscoverAt = now;
      await this.discover();
    }
    if (!this.names.length) {
      this.emitIdle();
      return false;
    }

    const readings = await Promise.all(this.names.map((name) => this.read(name)));
    const live = readings.filter(Boolean);

    // A player that answered nothing is gone (tab closed, browser quit); drop
    // it now rather than waiting for the next discovery pass.
    this.names = live.map((r) => r.name);

    const music = pickPlayer(live);

    this.emit(
      'music',
      music
        ? webMusicSnapshot({ state: music.state, media: music.media, receivedAt: now })
        : idle()
    );

    return Boolean(music);
  }

  emitIdle() {
    this.emit('music', idle());
  }

  /** Well-known MPRIS names currently on the session bus. */
  async discover() {
    let out;
    try {
      out = await this.run(['--user', 'list', '--no-pager', '--no-legend', '--acquired']);
      this.available = true;
    } catch (err) {
      this.available = false;
      if (err.code === 'ENOENT') {
        this.warnOnce(
          'busctl',
          `MPRIS source: "${this.busctlPath}" not found. It ships with systemd; ` +
            'set browser.mpris.busctlPath, or turn browser.mpris off and use the extension bridge.'
        );
      } else {
        this.warnOnce('list', `MPRIS source: could not list bus names (${err.message})`);
      }
      this.names = [];
      return;
    }

    const found = [];
    for (const line of out.split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (name?.startsWith(NAME_PREFIX)) found.push(name);
    }

    for (const name of found) {
      if (!this.names.includes(name)) log.debug(`MPRIS player appeared: ${name}`);
    }
    this.names = found;
  }

  /**
   * Metadata, playback status and position for one player, plus what we make
   * of it. Returns null when the player is gone, unreadable, or not Apple.
   */
  async read(name) {
    let out;
    try {
      out = await this.run([
        '--user',
        '--json=short',
        'get-property',
        name,
        OBJECT_PATH,
        PLAYER_IFACE,
        'Metadata',
        'PlaybackStatus',
        'Position',
      ]);
    } catch (err) {
      if (/access denied/i.test(err.message)) this.warnAccessDenied(name, err.message);
      else log.debug(`MPRIS ${name}: ${err.message}`);
      return null;
    }

    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return null;

    let metadata;
    let status;
    let positionUs;
    try {
      metadata = unwrap(JSON.parse(lines[0])) ?? {};
      status = unwrap(JSON.parse(lines[1]));
      positionUs = unwrap(JSON.parse(lines[2]));
    } catch (err) {
      log.debug(`MPRIS ${name}: unparseable reply (${err.message})`);
      return null;
    }

    const kind = await this.classify(name, metadata);
    if (!kind) return { name, kind: null, state: 'stopped', media: null };

    const state = playbackState(status);
    if (state !== 'playing' && state !== 'paused') return { name, kind: null, state, media: null };

    return {
      name,
      kind,
      state,
      media: {
        title: metadata['xesam:title'],
        artist: metadata['xesam:artist'],
        album: metadata['xesam:album'],
        albumArtist: metadata['xesam:albumArtist'],
        durationSec: usToSec(metadata['mpris:length']),
        positionSec: usToSec(positionUs),
        artUrl: metadata['mpris:artUrl'],
        pageUrl: metadata['xesam:url'],
        origin: `mpris:${name}`,
      },
    };
  }

  /**
   * "music" | "tv" | null.
   *
   * The page URL decides it when there is one. When there is not, the only
   * remaining evidence is which player it is, and that is a question only the
   * user can answer -- hence the explicit map, and the silence otherwise.
   */
  async classify(name, metadata) {
    // An explicit mapping is the user talking, so it is consulted first -- but
    // only "ignore" outranks the page URL. A player mapped to "music" that
    // turns out to be showing tv.apple.com is showing tv.apple.com.
    const mapped = this.players.length ? await this.mappingFor(name) : null;
    if (mapped === 'ignore') return null;

    const byUrl = classifyAppleUrl(metadata['xesam:url']);
    if (byUrl) return byUrl;
    if (mapped) return mapped;

    if (metadata['xesam:title'] && this.shouldWarnUnmapped()) {
      const identity = await this.identityOf(name);
      this.warnOnce(
        `unmapped:${name}`,
        `${identity || name} is playing something, but publishes no page URL over MPRIS, ` +
          'so there is no way to tell whether it is Apple Music. Install the companion ' +
          'extension (browser/README.md). Note that Apple Music publishes no Media ' +
          'Session metadata to Chrome at all -- Chrome falls back to the tab title -- so ' +
          'browser.mpris.players cannot rescue that case, only the extension can.'
      );
    }
    return null;
  }

  /** What `browser.mpris.players` says about this player, if anything. */
  async mappingFor(name) {
    const identity = await this.identityOf(name);
    const haystack = `${name}\n${identity}`.toLowerCase();
    for (const [needle, kind] of this.players) {
      if (haystack.includes(needle)) return kind;
    }
    return null;
  }

  async identityOf(name) {
    if (this.identities.has(name)) return this.identities.get(name);
    let identity = '';
    try {
      const out = await this.run([
        '--user',
        '--json=short',
        'get-property',
        name,
        OBJECT_PATH,
        ROOT_IFACE,
        'Identity',
      ]);
      identity = String(unwrap(JSON.parse(out.trim())) ?? '');
    } catch {
      /* an unreadable Identity changes nothing; the bus name still matches */
    }
    this.identities.set(name, identity);
    return identity;
  }

  run(args) {
    return new Promise((resolve, reject) => {
      execFile(
        this.busctlPath,
        args,
        { timeout: 5000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message).trim().split('\n')[0];
            const error = new Error(detail || 'busctl failed');
            error.code = err.code;
            reject(error);
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(message);
  }

  /**
   * Snap-packaged browsers mediate their MPRIS interface through AppArmor and
   * only answer callers that are themselves unconfined. Running yanpresence
   * from a confined app's terminal is the usual way to trip this, and the
   * error on its own explains none of that.
   */
  warnAccessDenied(name, detail) {
    this.warnOnce(
      `denied:${name}`,
      `${name} refused the MPRIS query (${detail}). Snap-packaged browsers only answer ` +
        'unconfined callers — run yanpresence from a normal terminal or as the systemd user ' +
        'service (scripts/systemd), not from inside another sandboxed app.'
    );
  }
}

function idle() {
  return { state: 'closed', active: false, track: null, receivedAt: Date.now() };
}

/** Playing beats paused: a paused tab left open should not mask a live one. */
function pickPlayer(readings) {
  const mine = readings.filter((r) => r.kind === 'music');
  return mine.find((r) => r.state === 'playing') ?? mine.find((r) => r.state === 'paused') ?? null;
}

function normalizePlayerMap(players) {
  const out = [];
  for (const [needle, kind] of Object.entries(players ?? {})) {
    const value = String(kind).toLowerCase();
    if (!['music', 'ignore'].includes(value)) {
      log.warn(`browser.mpris.players["${needle}"] must be "music" or "ignore" (got ${kind})`);
      continue;
    }
    out.push([needle.toLowerCase(), value]);
  }
  return out;
}

function playbackState(status) {
  switch (String(status).toLowerCase()) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    default:
      return 'stopped';
  }
}

function usToSec(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n / 1e6 : 0;
}

/**
 * busctl's JSON keeps every value in a {"type","data"} envelope, nested all the
 * way down a variant. Strip the envelopes and keep the values.
 */
export function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    if ('type' in value && 'data' in value) return unwrap(value.data);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrap(v);
    return out;
  }
  return value;
}
