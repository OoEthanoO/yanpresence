import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { AppWatcher, str } from './watcher.js';

const WATCHER = path.join(PROJECT_ROOT, 'scripts', 'music-watch.js');
const DUMP_ARTWORK = path.join(PROJECT_ROOT, 'scripts', 'dump-artwork.applescript');

/**
 * Watches Music.app and emits `state` with a normalized snapshot.
 *
 * The heavy lifting happens in a resident osascript process (scripts/music-watch.js)
 * supervised by AppWatcher; this only supplies the script and the snapshot shape.
 */
export class MusicWatcher extends AppWatcher {
  constructor({ pollIntervalMs, idlePollIntervalMs } = {}) {
    super({ script: WATCHER, label: 'Music', normalize, pollIntervalMs, idlePollIntervalMs });
  }
}

function normalize(raw) {
  const state = raw.state ?? 'unknown';
  const active = state === 'playing' || state === 'paused';

  if (!active) {
    return { state, active: false, track: null, receivedAt: Date.now() };
  }

  const duration = Number(raw.duration) || 0;
  const position = Math.max(0, Math.min(Number(raw.position) || 0, duration || Infinity));

  const track = {
    name: str(raw.name),
    artist: str(raw.artist),
    album: str(raw.album),
    albumArtist: str(raw.albumArtist),
    duration,
    position,
    persistentId: str(raw.persistentId),
    databaseId: Number(raw.databaseId) || 0,
    kind: str(raw.kind),
    mediaKind: str(raw.mediaKind),
    year: Number(raw.year) || 0,
    trackNumber: Number(raw.trackNumber) || 0,
    discNumber: Number(raw.discNumber) || 0,
    hasArtwork: Boolean(raw.hasArtwork),
  };

  // Identity for "is this still the same track". persistentID is stable for
  // library items but empty for some cloud/radio tracks, so fall back to the
  // metadata triple.
  track.key = track.persistentId
    ? `pid:${track.persistentId}`
    : `meta:${track.name}\0${track.artist}\0${track.album}`;

  // Album identity, used to key artwork caches.
  track.albumKey = `${track.albumArtist || track.artist}\0${track.album}`.toLowerCase();

  return { state, active: true, track, receivedAt: Date.now() };
}


/**
 * Pulls the embedded artwork out of the currently playing track.
 * Returns { file, format } or null. Caller owns deleting the file.
 */
export async function dumpCurrentArtwork() {
  const file = path.join(os.tmpdir(), `yanpresence-art-${process.pid}-${Date.now()}`);

  const format = await new Promise((resolve) => {
    const child = spawn('/usr/bin/osascript', [DUMP_ARTWORK, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) {
        log.debug(`Artwork dump failed: ${err.trim() || `exit ${code}`}`);
        resolve(null);
      } else {
        resolve(out.trim() || 'unknown');
      }
    });
    // Music.app can hang here on a large iCloud item.
    setTimeout(() => child.kill('SIGKILL'), 10000).unref?.();
  });

  if (format === null) {
    await fs.rm(file, { force: true }).catch(() => {});
    return null;
  }

  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.rm(file, { force: true }).catch(() => {});
    return null;
  }

  return { file, format, bytes: stat.size };
}

/** True when Music.app is a catalog stream rather than a local file. */
export function isCatalogTrack(track) {
  const kind = `${track.kind} ${track.mediaKind}`.toLowerCase();
  return kind.includes('apple music') || kind.includes('internet') || kind.includes('stream');
}
