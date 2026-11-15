import { EventEmitter } from 'node:events';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { ensureHelper, NowPlayingTvWatcher } from './nowplaying.js';
import { AppWatcher, str } from './watcher.js';

const WATCHER = path.join(PROJECT_ROOT, 'scripts', 'tv-watch.js');

/**
 * Watches TV.app over Apple Events and emits `state` with a normalized snapshot.
 *
 * Shares its process supervision with the Music watcher; only the script and
 * the snapshot shape are different.
 */
export class AppleEventsTvWatcher extends AppWatcher {
  constructor({ pollIntervalMs, idlePollIntervalMs } = {}) {
    super({ script: WATCHER, label: 'TV', normalize, pollIntervalMs, idlePollIntervalMs });
  }
}

/**
 * TV.app from two sources, emitting one `state`.
 *
 * Apple Events come first: for a downloaded episode they carry the season and
 * episode numbers. But TV.app reports "stopped" with no current track while it
 * streams -- every Apple TV+ title, rental and cloud purchase -- so then the
 * system Now Playing record (nowplaying.js) stands in. Either source alone is
 * enough to run; the second is skipped where its helper cannot be built.
 */
export class TvWatcher extends EventEmitter {
  constructor(timing = {}, { appleEvents, nowPlaying, helper = ensureHelper } = {}) {
    super();
    this.timing = timing;
    this.appleEvents = appleEvents ?? new AppleEventsTvWatcher(timing);
    this.nowPlaying = nowPlaying ?? null;
    this.findHelper = helper;
    this.latest = { appleEvents: null, nowPlaying: null };
    this.stopped = false;
    this.appleEvents.on('state', (s) => this.take('appleEvents', s));
    if (this.nowPlaying) this.nowPlaying.on('state', (s) => this.take('nowPlaying', s));
  }

  start() {
    this.stopped = false;
    this.appleEvents.start();
    if (this.nowPlaying) {
      this.nowPlaying.start();
      return;
    }
    Promise.resolve(this.findHelper())
      .then((helper) => {
        if (!helper || this.stopped || this.nowPlaying) return;
        this.nowPlaying = new NowPlayingTvWatcher({ helper, ...this.timing });
        this.nowPlaying.on('state', (s) => this.take('nowPlaying', s));
        this.nowPlaying.start();
      })
      .catch((err) => log.debug(`Now Playing helper unavailable: ${err.message}`));
  }

  stop() {
    this.stopped = true;
    this.appleEvents.stop();
    this.nowPlaying?.stop();
  }

  take(source, snapshot) {
    this.latest[source] = snapshot;
    this.emit('state', mergeTvSnapshots(this.latest.appleEvents, this.latest.nowPlaying));
  }
}

/** The snapshot to act on: Apple Events when they see something, else Now Playing, else Apple Events' idle state. */
export function mergeTvSnapshots(appleEvents, nowPlaying) {
  if (appleEvents?.active) return appleEvents;
  if (nowPlaying?.active) return nowPlaying;
  return appleEvents ?? nowPlaying ?? { state: 'unknown', active: false, item: null, receivedAt: Date.now() };
}

function normalize(raw) {
  const state = raw.state ?? 'unknown';
  const active = state === 'playing' || state === 'paused';

  if (!active) {
    return { state, active: false, item: null, receivedAt: Date.now() };
  }

  const duration = Number(raw.duration) || 0;
  const position = Math.max(0, Math.min(Number(raw.position) || 0, duration || Infinity));

  const item = {
    name: str(raw.name),
    show: str(raw.show),
    season: Number(raw.seasonNumber) || 0,
    episode: Number(raw.episodeNumber) || 0,
    episodeId: str(raw.episodeId),
    duration,
    position,
    persistentId: str(raw.persistentId),
    databaseId: Number(raw.databaseId) || 0,
    kind: str(raw.kind),
    mediaKind: str(raw.mediaKind),
    year: Number(raw.year) || 0,
    director: str(raw.director),
    description: str(raw.description),
    hasArtwork: Boolean(raw.hasArtwork),
  };

  item.isEpisode = isEpisode(item);

  // Identity for "is this still the same thing". persistentID is empty for
  // Apple TV+ streams, so fall back to the metadata that actually varies.
  item.key = item.persistentId
    ? `pid:${item.persistentId}`
    : `meta:${item.show}\0${item.name}\0${item.season}\0${item.episode}`;

  return { state, active: true, item, receivedAt: Date.now() };
}

/**
 * An episode has a show to belong to; a film does not. `mediaKind` reports
 * "TV show" for episodes, but a downloaded file can leave it blank, so the
 * presence of a show name is the more reliable signal.
 */
export function isEpisode(item) {
  if (item.show) return true;
  return /tv show|episode/i.test(`${item.mediaKind} ${item.kind}`);
}

/** "S2E7", or "" when the numbering is missing. */
export function episodeCode(item) {
  if (!item.season && !item.episode) return '';
  if (!item.season) return `E${item.episode}`;
  if (!item.episode) return `S${item.season}`;
  return `S${item.season}E${item.episode}`;
}
