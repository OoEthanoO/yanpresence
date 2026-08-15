import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BridgeSource } from './bridge.js';
import { MprisSource } from './mpris.js';
import { MusicWatcher, dumpCurrentArtwork, isCatalogTrack } from './music.js';
import { TvWatcher } from './tv.js';
import log from './log.js';

// How long the extension gets to introduce itself before MPRIS starts
// complaining about players it cannot identify.
const MPRIS_WARN_GRACE_MS = 30_000;

/**
 * Where playback state comes from, decided once at startup.
 *
 * Two implementations, one shape: each exposes a `music` and a `tv` channel
 * that emit `state` with the snapshot the rest of the program understands.
 *
 *   apple-apps  Music.app and TV.app over Apple Events (macOS).
 *   browser     music.apple.com, read over the companion extension's loopback
 *               bridge and/or MPRIS (Linux, and macOS if that is where you
 *               play). Audio only -- see WebSources.
 */
export function createSources(config) {
  const wanted = resolveSourceKind(config);
  return wanted === 'apple-apps' ? new AppleAppSources(config) : new WebSources(config);
}

export function resolveSourceKind(config) {
  const requested = String(config.source ?? 'auto').toLowerCase();
  if (requested === 'apple-apps' || requested === 'browser') return requested;
  // "auto": the Apple apps exist on macOS only, so everywhere else the browser
  // is not a fallback, it is the only place Apple Music runs at all.
  return process.platform === 'darwin' ? 'apple-apps' : 'browser';
}

/** A `state`-emitting facade with the AppWatcher lifecycle the app expects. */
class Channel extends EventEmitter {
  constructor(onStart, onStop) {
    super();
    this.onStart = onStart;
    this.onStop = onStop;
  }

  start() {
    this.onStart();
  }

  stop() {
    this.onStop();
  }
}

/* ------------------------------------------------------------------ */

class AppleAppSources {
  constructor(config) {
    this.kind = 'apple-apps';
    this.config = config;

    const timing = {
      pollIntervalMs: config.pollIntervalMs,
      idlePollIntervalMs: config.idlePollIntervalMs,
    };
    this.music = new MusicWatcher(timing);
    this.tv = config.tv?.enabled ? new TvWatcher(timing) : null;
  }

  describe() {
    return this.tv ? 'Watching Music.app and TV.app' : 'Watching Music.app';
  }

  /** Said when audio goes away and the presence comes down. */
  idleMessage(state) {
    return `Music.app is ${state}`;
  }

  /**
   * Embedded artwork for a local library file. Catalog streams are skipped:
   * their cover is already on Apple's CDN, and pulling it out of Music.app
   * would cost an Apple Event for nothing.
   */
  async localArtworkFor(track) {
    if (!track.hasArtwork || isCatalogTrack(track)) return null;
    return dumpCurrentArtwork();
  }
}

/* ------------------------------------------------------------------ */

/**
 * The Apple Music web player, read two ways at once.
 *
 * The bridge is authoritative when it has anything to say: the extension runs
 * inside the page, so it knows the URL, the exact playhead and the real
 * artwork URL. MPRIS covers the case where nothing is installed -- which works
 * in Firefox, because it publishes the page URL, and does not in Chrome, which
 * publishes none.
 *
 * Audio only. Apple TV is a macOS source: TV.app reports the show, the season
 * and the episode as fields, while the web player publishes an episode title
 * and little else, and the card would be the poorer for it. `tv.enabled` is
 * simply inert here -- keeping it set costs nothing and is what the same
 * config file wants on a Mac.
 */
class WebSources {
  constructor(config) {
    this.kind = 'browser';
    this.config = config;

    const bridgeCfg = config.browser?.bridge ?? {};
    const mprisCfg = config.browser?.mpris ?? {};

    this.bridge =
      bridgeCfg.enabled === false
        ? null
        : new BridgeSource({
            host: bridgeCfg.host,
            port: bridgeCfg.port,
            staleMs: bridgeCfg.staleMs,
            token: bridgeCfg.token,
          });

    this.mprisEnabled = mprisCfg.enabled !== false && process.platform === 'linux';
    this.mpris = this.mprisEnabled
      ? new MprisSource({
          pollIntervalMs: config.pollIntervalMs,
          idlePollIntervalMs: config.idlePollIntervalMs,
          discoverIntervalMs: mprisCfg.discoverIntervalMs,
          busctlPath: mprisCfg.busctlPath,
          players: mprisCfg.players,
          // The extension reports within a second of the browser having a tab
          // open, but MPRIS polls immediately -- so on every start there is a
          // moment where Chrome looks unidentifiable and is about to identify
          // itself. Warning then is just noise at every login.
          shouldWarnUnmapped: () =>
            !this.bridge?.everReported && Date.now() - this.startedAt > MPRIS_WARN_GRACE_MS,
        })
      : null;

    this.latest = {};
    this.started = 0;
    this.startedAt = 0;

    this.music = new Channel(
      () => this.begin(),
      () => this.end()
    );
    // Apple TV runs through TV.app on macOS and nowhere else.
    this.tv = null;

    this.bridge?.on('music', (snapshot) => this.ingest('bridge', snapshot));
    this.mpris?.on('music', (snapshot) => this.ingest('mpris', snapshot));
  }

  describe() {
    const ways = [
      this.bridge ? `the extension bridge on port ${this.bridge.port}` : null,
      this.mpris ? 'MPRIS' : null,
    ].filter(Boolean);
    return ways.length
      ? `Watching music.apple.com over ${ways.join(' and ')}`
      : 'Watching music.apple.com';
  }

  idleMessage() {
    return 'Nothing is playing at music.apple.com';
  }

  begin() {
    if (this.started++ > 0) return;
    this.startedAt = Date.now();
    this.bridge?.start();
    this.mpris?.start();
  }

  end() {
    if (--this.started > 0) return;
    this.bridge?.stop();
    this.mpris?.stop();
  }

  ingest(from, snapshot) {
    this.latest[from] = snapshot;
    const chosen = this.choose();
    if (chosen) this.music.emit('state', chosen);
  }

  /** Bridge first, because it is the one that knows what it is looking at. */
  choose() {
    const { bridge, mpris } = this.latest;
    if (bridge?.active) return bridge;
    if (mpris?.active) return mpris;
    return bridge ?? mpris ?? null;
  }

  /**
   * Artwork the browser already fetched, when the catalog turned nothing up.
   *
   * Both Firefox and Chrome hand MPRIS a `file://` path to a copy they wrote
   * out themselves; it is copied here because the browser will delete or
   * overwrite the original the moment the track changes, and the caller owns
   * what it is given. An `https:` artwork URL (what the extension reports)
   * needs none of this -- it is used directly, upstream of here.
   */
  async localArtworkFor(track) {
    const artUrl = String(track.artUrl ?? '');
    if (!artUrl.startsWith('file://')) return null;

    let source;
    try {
      source = decodeURIComponent(new URL(artUrl).pathname);
    } catch {
      return null;
    }

    const target = path.join(os.tmpdir(), `yanpresence-art-${process.pid}-${Date.now()}`);
    try {
      await fs.copyFile(source, target);
      const stat = await fs.stat(target);
      if (!stat.size) throw new Error('empty file');
      return { file: target, format: path.extname(source).replace('.', '') || 'png', bytes: stat.size };
    } catch (err) {
      log.debug(`Could not read browser artwork at ${source}: ${err.message}`);
      await fs.rm(target, { force: true }).catch(() => {});
      return null;
    }
  }
}
