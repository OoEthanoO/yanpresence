import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { AppWatcher, str } from './watcher.js';
import { POWERSHELL, psArgs } from './win.js';

const WATCHER = path.join(PROJECT_ROOT, 'scripts', 'smtc-watch.ps1');
const DUMP_ARTWORK = path.join(PROJECT_ROOT, 'scripts', 'smtc-artwork.ps1');

// The AUMIDs the Store apps publish their media sessions under. Prefixes, not
// exact matches: the full identifier carries the package family and an entry
// point (`AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`), and only the leading
// publisher-and-name part is stable across versions.
export const APPLE_MUSIC_APP_ID = 'AppleInc.AppleMusicWin';
export const APPLE_TV_APP_ID = 'AppleInc.AppleTVWin';

/**
 * Watches the Windows Apple Music and Apple TV apps and emits `state` with a
 * normalized snapshot, tagged with the channel it came from.
 *
 * Both apps are read by one child process rather than two. On macOS the two
 * watchers are genuinely independent -- separate Apple Event connections to
 * separate applications -- but here they are two entries in a single list of
 * media sessions, so asking twice would mean two PowerShell hosts polling the
 * same API. Sources.js splits the stream back into channels.
 */
export class SmtcWatcher extends AppWatcher {
  constructor({ pollIntervalMs, idlePollIntervalMs, tv = false, appIds = {} } = {}) {
    super({
      script: WATCHER,
      label: 'Windows media',
      normalize,
      pollIntervalMs,
      idlePollIntervalMs,
      command: POWERSHELL,
      args: psArgs(WATCHER),
      env: {
        YP_SMTC_CHANNELS: tv ? 'music,tv' : 'music',
        YP_SMTC_MUSIC_ID: appIds.music || APPLE_MUSIC_APP_ID,
        YP_SMTC_TV_ID: appIds.tv || APPLE_TV_APP_ID,
      },
    });
  }
}

/**
 * One watcher line to one snapshot.
 *
 * The channel decides the shape: music snapshots mirror what Music.app
 * produces, TV snapshots mirror TV.app, and everything downstream stays unable
 * to tell which platform it is serving.
 */
export function normalize(raw) {
  const channel = raw.channel === 'tv' ? 'tv' : 'music';
  const snapshot = channel === 'tv' ? normalizeTv(raw) : normalizeMusic(raw);
  snapshot.channel = channel;
  return snapshot;
}

/* ------------------------------------------------------------------ */

export function normalizeMusic(raw) {
  const state = raw.state ?? 'unknown';
  const active = state === 'playing' || state === 'paused';

  if (!active) {
    return { state, active: false, track: null, receivedAt: Date.now() };
  }

  const duration = positive(raw.duration);
  const position = clamp(raw.position, duration);
  const { artist, album } = splitArtistAlbum(raw);

  const track = {
    name: str(raw.name),
    artist,
    album,
    // SMTC carries an album artist field, but the Windows app fills it with
    // the same string it puts in the artist field rather than with an album
    // artist, so there is nothing extra to be had from it.
    albumArtist: artist,
    duration,
    position,
    // Windows publishes no stable identifier for what is playing; identity
    // comes from the metadata, the same fallback a Music.app cloud track uses.
    persistentId: '',
    databaseId: 0,
    kind: 'Apple Music for Windows',
    mediaKind: 'song',
    year: 0,
    trackNumber: Number(raw.trackNumber) || 0,
    discNumber: 0,
    hasArtwork: Boolean(raw.hasArtwork),
    // Not part of the Music.app shape; carried so --watch can say where a
    // snapshot came from, and so the artwork dump knows which app to ask.
    origin: str(raw.appId) || APPLE_MUSIC_APP_ID,
  };

  track.key = `meta:${track.name}\0${track.artist}\0${track.album}`;
  track.albumKey = `${track.albumArtist || track.artist}\0${track.album}`.toLowerCase();

  return { state, active: true, track, receivedAt: Date.now() };
}

// What the Windows Apple Music app joins the two fields with: a spaced em
// dash. Not a hyphen, which is what Apple's own catalog titles use for
// editorial suffixes (" - Single", " - EP"), so the two do not collide.
const ARTIST_ALBUM_JOINER = ' — ';

/**
 * The artist and the album, which arrive as one field.
 *
 * The Windows app publishes `"<artist> — <album>"` as the SMTC artist *and*
 * as the album artist, and leaves the album title empty:
 *
 *   Title       LOV3 (feat. Bryan Chase & Okasian)
 *   Artist      Sik-K & Lil Moshpit — K-FLIP+
 *   AlbumTitle  (empty)
 *
 * Left alone that puts "Sik-K & Lil Moshpit — K-FLIP+" on the card's artist
 * line, and hands the catalog a nonexistent artist and no album to score
 * against -- so it is worth unpicking rather than passing through.
 *
 * The guard is the empty album, which is the part that cannot happen by
 * accident: a payload where Apple filled the field in properly is left
 * untouched, so this heals itself if a future version of the app stops doing
 * it. The split takes the LAST separator, because an em dash inside a name is
 * rare in either field and, when one does occur, keeping the artist whole
 * matters more -- it is what goes on the status line and what the catalog
 * scores against, while the album mostly feeds a cache key.
 */
export function splitArtistAlbum(raw) {
  const artist = str(raw.artist);
  const album = str(raw.album);
  if (album || !artist.includes(ARTIST_ALBUM_JOINER)) return { artist, album };

  const at = artist.lastIndexOf(ARTIST_ALBUM_JOINER);
  return {
    artist: artist.slice(0, at).trim(),
    album: artist.slice(at + ARTIST_ALBUM_JOINER.length).trim(),
  };
}

/* ------------------------------------------------------------------ */

export function normalizeTv(raw) {
  const state = raw.state ?? 'unknown';
  const active = state === 'playing' || state === 'paused';

  if (!active) {
    return { state, active: false, item: null, receivedAt: Date.now() };
  }

  const duration = positive(raw.duration);
  const position = clamp(raw.position, duration);
  const parsed = parseEpisode(raw);

  const item = {
    name: parsed.name,
    show: parsed.show,
    season: parsed.season,
    episode: parsed.episode,
    episodeId: '',
    duration,
    position,
    persistentId: '',
    databaseId: 0,
    kind: 'Apple TV for Windows',
    mediaKind: parsed.show ? 'TV show' : 'movie',
    year: parsed.year,
    director: '',
    description: str(raw.subtitle),
    hasArtwork: Boolean(raw.hasArtwork),
    origin: str(raw.appId) || APPLE_TV_APP_ID,
  };

  item.isEpisode = Boolean(item.show) || item.season > 0 || item.episode > 0;
  item.key = `meta:${item.show}\0${item.name}\0${item.season}\0${item.episode}`;

  return { state, active: true, item, receivedAt: Date.now() };
}

/**
 * A show, an episode title and its numbering, out of three free-text fields.
 *
 * TV.app on macOS answers `show`, `season number` and `episode number` as
 * properties. Windows has no such thing: the Apple TV app publishes the same
 * three SMTC strings a music player does -- title, artist, album -- and
 * whichever of them happens to carry the numbering carries it as prose. So the
 * numbering is read out of the text wherever it appears, and the field that
 * held it is cleaned up rather than shown with "Season 2, Episode 7" trailing
 * off the end of it.
 *
 * A film sets none of this and falls through with just a title, which is
 * exactly what buildWatchActivity wants for one.
 */
export function parseEpisode(raw) {
  const title = str(raw.name);
  const artist = str(raw.artist);
  const album = str(raw.album);
  const subtitle = str(raw.subtitle);

  let season = 0;
  let episode = 0;
  // Ordered by how likely the field is to be the one carrying the numbering,
  // so that a title containing a bare "Episode 3" does not outrank a subtitle
  // that spells out both numbers.
  for (const text of [subtitle, album, artist, title]) {
    const found = readEpisodeCode(text);
    if (found.season || found.episode) {
      season = found.season;
      episode = found.episode;
      break;
    }
  }

  // The show is whichever of the two supporting fields is not the numbering.
  // Apple has shipped it in both slots across versions, so neither is assumed.
  const show = pickShow([artist, album, subtitle]);

  return {
    name: cleanTitle(title) || title,
    show: show === cleanTitle(title) ? '' : show,
    season,
    episode,
    year: readYear(subtitle) || readYear(album),
  };
}

/** "S2E7", "Season 2, Episode 7", "2x07" — the numbering, wherever it hides. */
export function readEpisodeCode(text) {
  const s = String(text ?? '');
  if (!s) return { season: 0, episode: 0 };

  let m = s.match(/\bS(?:eason)?\s*(\d{1,3})\s*[,·:\-\u2013]?\s*E(?:p(?:isode)?)?\s*(\d{1,4})\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };

  m = s.match(/\b(\d{1,3})\s*[x\u00d7]\s*(\d{1,4})\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };

  const season = s.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
  const episode = s.match(/\bE(?:p(?:isode)?)?\s*(\d{1,4})\b/i);
  if (season || episode) {
    return { season: season ? Number(season[1]) : 0, episode: episode ? Number(episode[1]) : 0 };
  }
  return { season: 0, episode: 0 };
}

/**
 * The first field that reads like a name rather than like numbering.
 * Everything Apple puts in these slots is either the show or a description of
 * where in it you are, and only the former belongs on the status line.
 */
function pickShow(candidates) {
  for (const candidate of candidates) {
    const text = str(candidate);
    if (!text) continue;
    const cleaned = cleanTitle(text);
    if (cleaned) return cleaned;
  }
  return '';
}

/** Strips a trailing or leading episode code, and the punctuation around it. */
export function cleanTitle(text) {
  return String(text ?? '')
    .replace(/\bS(?:eason)?\s*\d{1,3}\s*[,·:\-\u2013]?\s*E(?:p(?:isode)?)?\s*\d{1,4}\b/gi, '')
    .replace(/\b\d{1,3}\s*[x\u00d7]\s*\d{1,4}\b/g, '')
    .replace(/\bSeason\s+\d{1,3}\b/gi, '')
    .replace(/\bEpisode\s+\d{1,4}\b/gi, '')
    // Whatever separated the numbering from the name is now separating the
    // name from nothing. Collapse runs of them, then take them off both ends.
    // The em dash matters: it is what the app puts between show and episode.
    .replace(/\s*[,·:|\-–—]+\s*/g, ' · ')
    .replace(/^[\s,·:|\-–—]+|[\s,·:|\-–—]+$/g, '')
    .trim();
}

function readYear(text) {
  const m = String(text ?? '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

/* ------------------------------------------------------------------ */

/**
 * The cover art the app handed the media flyout, written to a file.
 *
 * Returns { file, format, bytes } or null; the caller owns deleting the file.
 * This is the Windows counterpart of dump-artwork.applescript, and it matters
 * for the same reason: a track imported into your own library is not in
 * Apple's catalog, so the only cover that exists is the one embedded in the
 * file, and SMTC is the only place Windows will show it to us.
 */
export async function dumpCurrentArtwork({ appId = APPLE_MUSIC_APP_ID } = {}) {
  const file = path.join(os.tmpdir(), `yanpresence-art-${process.pid}-${Date.now()}`);

  const format = await new Promise((resolve) => {
    execFile(
      POWERSHELL,
      psArgs(DUMP_ARTWORK, appId, file),
      { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          log.debug(`Artwork dump failed: ${String(stderr || err.message).trim().split('\n')[0]}`);
          resolve(null);
          return;
        }
        resolve(String(stdout).trim() || 'unknown');
      }
    );
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

/* ------------------------------------------------------------------ */

/**
 * Every Apple media session Windows currently knows about, raw.
 *
 * Only used by `--smtc`, which exists because the mapping from these fields to
 * a show, a season and an episode is read out of free text (see parseEpisode)
 * and the only way to check it is to see what the app actually published.
 */
export function readSessionsOnce({ timeoutMs = 15000, appIds = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      POWERSHELL,
      psArgs(WATCHER),
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          YP_SMTC_CHANNELS: 'music,tv',
          YP_SMTC_MUSIC_ID: appIds.music || APPLE_MUSIC_APP_ID,
          YP_SMTC_TV_ID: appIds.tv || APPLE_TV_APP_ID,
        },
      },
      () => {
        /* killed below once it has answered; a non-zero exit is expected */
      }
    );

    child.on('error', (err) => reject(err));

    const lines = [];
    let buffer = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(lines);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.state === 'watcher-ready') continue;
        lines.push(payload);
        // One full pass over every requested channel, then we are done.
        if (lines.length >= 2) finish();
      }
    });

    child.on('exit', () => finish());
    setTimeout(finish, timeoutMs).unref?.();
  });
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(value, duration) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, duration || Infinity);
}
