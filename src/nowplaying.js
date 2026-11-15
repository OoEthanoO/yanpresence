import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { AppWatcher, str } from './watcher.js';

/**
 * TV.app through macOS's system Now Playing, for everything Apple Events cannot see.
 *
 * TV.app answers Apple Events with "stopped" and no current track while it streams, which is every Apple TV+
 * title and every rental or purchase played from the cloud. The Now Playing record still has the title, the
 * show, the duration and the position. Reading it takes an Apple-signed process (macOS 15.4 and later), so
 * macos/nowplaying.m is a small library that /usr/bin/perl loads; see the comment at its top.
 */

export const HELPER_NAME = 'yanpresence-nowplaying.dylib';
const SOURCE = path.join(PROJECT_ROOT, 'macos', 'nowplaying.m');
const PERL = '/usr/bin/perl';
// Load the library, then call its watch loop as an XSUB. Calling it after loading matters: see nowplaying.m.
export const LOADER = 'require DynaLoader; my $l = DynaLoader::dl_load_file($ARGV[0], 0) or die DynaLoader::dl_error();'
  + ' my $s = DynaLoader::dl_find_symbol($l, "yp_nowplaying_watch") or die DynaLoader::dl_error();'
  + ' DynaLoader::dl_install_xsub("main::watch", $s); main::watch();';

/** Where the helper is: built into the app bundle, or compiled from source into .build for a checkout. */
export function helperPath(root = PROJECT_ROOT) {
  const inAppBundle = root.endsWith(path.join('.app', 'Contents', 'Resources', 'app'));
  return inAppBundle
    ? path.resolve(root, '..', '..', 'Frameworks', HELPER_NAME)
    : path.join(root, '.build', 'nowplaying', HELPER_NAME);
}

/**
 * The helper's path, compiling it first in a source checkout when it is missing or older than its source.
 * Resolves to null when it cannot be had; the caller then watches TV.app over Apple Events alone.
 */
export async function ensureHelper(root = PROJECT_ROOT) {
  const target = helperPath(root);
  const source = path.join(root, 'macos', 'nowplaying.m');
  const mtime = (p) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  const built = mtime(target);
  const src = mtime(source);
  if (built >= 0 && (src < 0 || built >= src)) return target;
  if (src < 0) return null; // inside the app the helper is prebuilt; a missing one stays missing

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['clang', '-dynamiclib', '-fobjc-arc', '-O2', '-framework', 'AppKit',
    '-arch', 'arm64', '-arch', 'x86_64', '-o', target, source];
  return new Promise((resolve) => {
    execFile('/usr/bin/xcrun', args, { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) {
        log.warn(`Could not build the Now Playing helper, so streamed TV.app titles will not show: ${
          (stderr || err.message).trim().split('\n')[0]}`);
        resolve(null);
      } else {
        log.debug(`Built the Now Playing helper at ${target}`);
        resolve(target);
      }
    });
  });
}

export class NowPlayingTvWatcher extends AppWatcher {
  constructor({ helper, pollIntervalMs, idlePollIntervalMs } = {}) {
    super({
      script: SOURCE,
      label: 'TV Now Playing',
      normalize: normalizeNowPlaying,
      pollIntervalMs,
      idlePollIntervalMs,
      command: PERL,
      args: ['-e', LOADER, helper],
    });
  }
}

/**
 * The helper's line, in the snapshot shape tv.js uses for TV.app.
 *
 * Now Playing has no season or episode numbers. For an episode, TV.app puts the episode's title in Title and
 * the show in Album; a film has an empty Album.
 */
export function normalizeNowPlaying(raw) {
  const state = raw.state ?? 'unknown';
  const active = (state === 'playing' || state === 'paused') && raw.bundle === 'com.apple.TV' && Boolean(str(raw.title));
  if (!active) return { state: 'stopped', active: false, item: null, receivedAt: Date.now() };

  const duration = Number(raw.duration) || 0;
  const position = Math.max(0, Math.min(Number(raw.position) || 0, duration || Infinity));
  const show = str(raw.album);
  const item = {
    name: str(raw.title),
    show,
    season: 0,
    episode: 0,
    episodeId: '',
    duration,
    position,
    persistentId: '',
    databaseId: 0,
    kind: '',
    mediaKind: show ? 'TV show' : 'movie',
    year: 0,
    director: '',
    description: '',
    hasArtwork: false,
    isEpisode: Boolean(show),
    source: 'now-playing',
  };
  // The same identity rule as tv.js for a stream, so an item does not look new when one source hands over to
  // the other mid-episode.
  item.key = `meta:${item.show}\0${item.name}\0${item.season}\0${item.episode}`;
  return { state, active: true, item, receivedAt: Date.now() };
}
