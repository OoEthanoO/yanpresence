import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import { AppWatcher, str } from './watcher.js';

const WATCHER = path.join(PROJECT_ROOT, 'scripts', 'tv-watch.js');

/**
 * Watches TV.app and emits `state` with a normalized snapshot.
 *
 * Shares its process supervision with the Music watcher; only the script and
 * the snapshot shape are different.
 */
export class TvWatcher extends AppWatcher {
  constructor({ pollIntervalMs, idlePollIntervalMs } = {}) {
    super({ script: WATCHER, label: 'TV', normalize, pollIntervalMs, idlePollIntervalMs });
  }
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
