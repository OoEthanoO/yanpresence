/**
 * Normalizers shared by the two ways of reading the web players.
 *
 * The extension bridge and MPRIS both hand us the same thing in the end -- what
 * the page told the browser through the Media Session API -- so both funnel
 * through here and come out shaped exactly like the snapshots Music.app and
 * TV.app produce. Everything downstream (catalog lookup, artwork, presence)
 * therefore cannot tell which platform, or which browser, it is serving.
 */

import { str } from './watcher.js';

const MUSIC_HOSTS = ['music.apple.com', 'beta.music.apple.com', 'embed.music.apple.com'];

/**
 * "music" for the Apple Music web player, null for everything else.
 *
 * This is the whole identification problem in one function. Firefox publishes
 * the page URL over MPRIS and the companion extension always knows it, so both
 * sources can answer "is this Apple Music" honestly. Chrome publishes no URL at
 * all, which is why the extension exists.
 *
 * tv.apple.com is deliberately absent. Apple TV is a macOS source here, driven
 * through TV.app, where the show, season and episode numbers arrive as fields
 * rather than as something to be inferred from a page title -- see src/tv.js.
 */
export function classifyAppleUrl(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  return MUSIC_HOSTS.includes(host) ? 'music' : null;
}

/** Media Session artists come as a string, or as MPRIS's array of them. */
export function joinArtists(value) {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean).join(', ');
  return str(value);
}

/**
 * A snapshot in the shape MusicWatcher emits.
 *
 * `duration` is routinely 0 here: Firefox publishes no `mpris:length`, and the
 * Media Session API only carries a duration if the page bothered to set the
 * position state. The catalog lookup fills it in later (see index.js), which is
 * what puts a progress bar under a Firefox-sourced track.
 */
export function webMusicSnapshot({ state, media, receivedAt = Date.now() }) {
  if (state !== 'playing' && state !== 'paused') {
    return { state, active: false, track: null, receivedAt };
  }

  const duration = positive(media.durationSec);
  const position = clampPosition(media.positionSec, duration);

  const track = {
    name: str(media.title),
    artist: joinArtists(media.artist),
    album: str(media.album),
    albumArtist: joinArtists(media.albumArtist),
    duration,
    position,
    persistentId: '',
    databaseId: 0,
    // Read by isCatalogTrack(): saying "Apple Music" keeps the local-file
    // artwork path (which shells out to Music.app) off the browser sources.
    kind: 'Apple Music web',
    mediaKind: 'song',
    year: 0,
    trackNumber: 0,
    discNumber: 0,
    hasArtwork: Boolean(media.artUrl),
    // Not part of the Music.app shape; carried for the artwork fallback and
    // for logging which tab this came from.
    artUrl: str(media.artUrl),
    pageUrl: str(media.pageUrl),
    origin: str(media.origin),
  };

  // No persistent ID exists for a web stream, so identity is the metadata
  // triple -- the same fallback Music.app tracks use when theirs is empty.
  track.key = `meta:${track.name}\0${track.artist}\0${track.album}`;
  track.albumKey = `${track.albumArtist || track.artist}\0${track.album}`.toLowerCase();

  return { state, active: true, track, receivedAt };
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampPosition(value, duration) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, duration || Infinity);
}
