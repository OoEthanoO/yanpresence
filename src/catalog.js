import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import log from './log.js';

const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const AMP_BASE = 'https://amp-api.music.apple.com/v1';
const ITUNES_BASE = 'https://itunes.apple.com';

const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Text normalization / matching
 * ------------------------------------------------------------------ */

// Apple's catalog title and the local library title rarely agree character for
// character: "Song (feat. X) - Remastered 2011" vs "Song". Strip the editorial
// decoration before comparing so those still match.
const NOISE = [
  /\s*[([][^)\]]*\b(feat|ft|featuring|with)\b[^)\]]*[)\]]/gi,
  /\s*[([][^)\]]*\b(remaster(ed)?|deluxe|expanded|bonus track|single version|album version|mono|stereo|explicit|clean|edit|version|mix|anniversary)\b[^)\]]*[)\]]/gi,
  /\s*-\s*(remaster(ed)?|deluxe|expanded|bonus track|single version|album version|mono|stereo|explicit|clean|radio edit|.*\bversion\b|.*\bremaster\b).*$/gi,
];

export function normalizeTitle(input) {
  let s = String(input || '');
  for (const re of NOISE) s = s.replace(re, ' ');
  return normalizeLoose(s);
}

export function normalizeLoose(input) {
  return String(input || '')
    .normalize('NFKD')
    // Drop *Latin* combining marks so "Beyoncé" and "Beyonce" compare equal.
    // Deliberately not all of \p{M}: NFKD splits Japanese ダ into タ + U+3099,
    // and dropping that mark would turn "dansu" into "tansu" -- a different
    // word. Those survive to the NFC recomposition below instead.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Letters, digits and combining marks in any script, not just ASCII.
    // Restricting this to [a-z0-9] erased non-Latin titles entirely -- a wholly
    // Hangul, Cyrillic or CJK track normalized to the empty string, which
    // `lookup()` reads as "nothing to search for" and skips, so it got no links
    // and no artwork. Marks are kept so a decomposed character is not split by
    // a space before it can be put back together.
    .replace(/[^\p{L}\p{N}\p{M}']+/gu, ' ')
    // Reassemble what NFKD took apart, so ダ is ダ again rather than タ+mark.
    .normalize('NFC')
    .trim();
}

function tokenSet(s) {
  return new Set(normalizeLoose(s).split(' ').filter(Boolean));
}

/** 0..1 similarity: exact match, containment, then Jaccard on word tokens. */
function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const sa = tokenSet(na);
  const sb = tokenSet(nb);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/* ------------------------------------------------------------------ *
 * Artwork URLs
 * ------------------------------------------------------------------ */

/**
 * Apple artwork URLs are templates: `.../{w}x{h}bb.jpg`. iTunes Search returns
 * a concrete small size instead, which we rewrite. Either way we can ask for
 * any square size we want -- whatever `artworkSize` is set to.
 */
export function artworkAt(template, size) {
  if (!template) return null;
  if (template.includes('{w}') || template.includes('{h}')) {
    return template
      .replace('{w}', String(size))
      .replace('{h}', String(size))
      .replace('{f}', 'jpg')
      .replace(/\{c\}/, 'bb');
  }
  // iTunes Search style: .../source/100x100bb.jpg
  return template.replace(/\/\d+x\d+([a-z]{0,2})\.(jpg|png)/i, `/${size}x${size}$1.$2`);
}

/* ------------------------------------------------------------------ *
 * Anonymous developer token
 * ------------------------------------------------------------------ */

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * music.apple.com ships a short-lived anonymous MusicKit token inside its JS
 * bundle. That token is what the web player itself uses against amp-api, and
 * it is the only route to editorial (motion) artwork -- the public MusicKit
 * API does not expose `editorialVideo`.
 */
class TokenProvider {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.token = null;
    this.expiresAt = 0;
    this.inflight = null;
    this.loadCache();
  }

  loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (data.token && data.expiresAt > Date.now() + 60_000) {
        this.token = data.token;
        this.expiresAt = data.expiresAt;
        log.debug('Loaded cached Apple Music token');
      }
    } catch {
      /* no cache yet */
    }
  }

  saveCache() {
    fsp
      .writeFile(this.cacheFile, JSON.stringify({ token: this.token, expiresAt: this.expiresAt }))
      .catch(() => {});
  }

  async get({ force = false } = {}) {
    if (!force && this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken()
      .catch((err) => {
        log.debug(`Apple Music token fetch failed: ${err.message}`);
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async fetchToken() {
    const html = await httpText('https://music.apple.com/us/browse');
    const bundles = [...html.matchAll(/\/assets\/[^"'\s]*index[^"'\s]*\.js/g)]
      .map((m) => m[0])
      .filter((p) => !p.includes('legacy'));

    if (!bundles.length) throw new Error('no index bundle found on music.apple.com');

    const candidates = [];
    for (const bundle of [...new Set(bundles)].slice(0, 2)) {
      const js = await httpText(new URL(bundle, 'https://music.apple.com').toString());
      for (const m of js.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g)) {
        const token = m[0];
        const payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) continue;
        if (payload.exp * 1000 <= Date.now()) continue;
        candidates.push({ token, exp: payload.exp * 1000, iss: payload.iss });
      }
      if (candidates.length) break;
    }

    if (!candidates.length) throw new Error('no unexpired token in bundle');

    // The bundle carries several tokens for different Apple services; only one
    // is accepted by amp-api, so probe them.
    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate.token)) continue;
      seen.add(candidate.token);
      const ok = await probeToken(candidate.token);
      if (ok) {
        this.token = candidate.token;
        this.expiresAt = candidate.exp;
        this.saveCache();
        log.debug(`Apple Music token acquired (iss=${candidate.iss})`);
        return this.token;
      }
    }
    throw new Error(`none of the ${seen.size} candidate tokens were accepted by amp-api`);
  }
}

async function probeToken(token) {
  try {
    const res = await fetch(
      `${AMP_BASE}/catalog/us/search?term=test&types=songs&limit=1`,
      { headers: ampHeaders(token), signal: AbortSignal.timeout(8000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function ampHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
    'User-Agent': WEB_UA,
    Accept: 'application/json',
  };
}

async function httpText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': WEB_UA, Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

export class AppleCatalog {
  constructor({ storefront = 'us', cacheDir, artworkSize = 1000 } = {}) {
    this.storefront = storefront;
    this.artworkSize = artworkSize;
    this.cacheFile = path.join(cacheDir, 'catalog.json');
    this.tokens = new TokenProvider(path.join(cacheDir, 'token.json'));
    this.memo = new Map();
    this.inflight = new Map();
    this.disk = this.loadDisk();
  }

  loadDisk() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveDisk() {
    // Same reasoning as the artwork cache: an unref'd debounced write is lost
    // if the process exits first. Once per newly seen track is cheap.
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.disk));
    } catch (err) {
      log.debug(`Could not persist catalog cache: ${err.message}`);
    }
  }

  cacheKey(track) {
    return [normalizeTitle(track.name), normalizeLoose(track.artist), normalizeLoose(track.album)]
      .join('|');
  }

  /** Resolve a Music.app track to Apple Music catalog links + artwork. */
  async lookup(track) {
    const key = this.cacheKey(track);
    if (!key.replace(/\|/g, '').trim()) return null;

    if (this.memo.has(key)) return this.memo.get(key);

    const cached = this.disk[key];
    if (cached) {
      const ttl = cached.result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      if (Date.now() - cached.ts < ttl) {
        const result = this.withCurrentArtworkSize(cached.result);
        if (result) this.memo.set(key, result);
        return result;
      }
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = this.resolve(track)
      .catch((err) => {
        log.debug(`Catalog lookup failed for "${track.name}": ${err.message}`);
        return null;
      })
      .then((result) => {
        // Only misses expire, and they expire on disk. Memoizing a null would
        // pin a transient network failure for the life of the process.
        if (result) this.memo.set(key, result);
        this.disk[key] = { ts: Date.now(), result };
        this.saveDisk();
        this.inflight.delete(key);
        return result;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Re-derives the artwork URL from the stored template at the size currently
   * configured. Entries live for 30 days, so without this a change to
   * `artworkSize` would keep serving the old dimensions until they aged out.
   */
  withCurrentArtworkSize(result) {
    if (!result?.artworkTemplate) return result;
    const url = artworkAt(result.artworkTemplate, this.artworkSize);
    return url && url !== result.artworkUrl ? { ...result, artworkUrl: url } : result;
  }

  async resolve(track) {
    const viaAmp = await this.searchAmp(track).catch((err) => {
      log.debug(`amp-api search failed: ${err.message}`);
      return null;
    });
    if (viaAmp) return viaAmp;

    log.debug('Falling back to the iTunes Search API');
    return this.searchItunes(track);
  }

  /* ---------------- amp-api (music.apple.com's own backend) ---------------- */

  async searchAmp(track, { retried = false } = {}) {
    const token = await this.tokens.get({ force: retried });
    if (!token) return null;

    const term = [track.name, track.artist, track.album].filter(Boolean).join(' ');
    const url =
      `${AMP_BASE}/catalog/${encodeURIComponent(this.storefront)}/search` +
      `?term=${encodeURIComponent(term)}&types=songs&limit=25` +
      `&include[songs]=albums,artists`;

    const res = await fetch(url, { headers: ampHeaders(token), signal: AbortSignal.timeout(10000) });

    if ((res.status === 401 || res.status === 403) && !retried) {
      log.debug('amp-api rejected the cached token; refreshing');
      return this.searchAmp(track, { retried: true });
    }
    if (!res.ok) throw new Error(`amp search -> ${res.status}`);

    const body = await res.json();
    const songs = body?.results?.songs?.data ?? [];
    if (!songs.length) return null;

    const scored = songs
      .map((song) => ({ item: song, score: scoreAmpSong(song, track) }))
      .sort((a, b) => b.score - a.score);

    const best = pickBest(scored);
    if (!best) return null;

    // The same release is often in the catalog twice — a clean edition and an
    // explicit one — with identical title, artist, album name and duration, so
    // scoring alone cannot separate them and whichever sorted first wins. Only
    // one of them tends to carry motion artwork (usually the explicit, which
    // is the primary release). Resolve the tie on that directly.
    const chosen = await this.preferAlbumWithMotion(scored, best, token);
    const song = chosen.entry.item;
    const attrs = song.attributes ?? {};
    const albumRel = song.relationships?.albums?.data?.[0];
    const artistRel = song.relationships?.artists?.data?.[0];

    const result = {
      source: 'amp',
      score: chosen.entry.score,
      songId: song.id,
      songName: attrs.name ?? track.name,
      songUrl: attrs.url ?? null,
      artistName: attrs.artistName ?? track.artist,
      artistUrl: artistRel?.attributes?.url ?? null,
      albumName: attrs.albumName ?? track.album,
      albumId: albumRel?.id ?? null,
      albumUrl: albumRel?.attributes?.url ?? null,
      artworkTemplate: attrs.artwork?.url ?? null,
      artworkUrl: artworkAt(attrs.artwork?.url, this.artworkSize),
      artworkBgColor: attrs.artwork?.bgColor ?? null,
      animatedUrl: null,
      isrc: attrs.isrc ?? null,
      // The web players do not always report how long the song is; this is
      // what puts a progress bar under those.
      durationSec: attrs.durationInMillis ? attrs.durationInMillis / 1000 : 0,
    };

    // The song payload never carries editorialVideo; the album does.
    if (result.albumId) {
      const motion = chosen.motionChecked
        ? chosen.motion
        : await this.fetchAnimatedArtwork(result.albumId, token).catch((err) => {
            log.debug(`editorialVideo lookup failed: ${err.message}`);
            return null;
          });
      if (motion) {
        result.animatedUrl = motion.url;
        result.animatedKind = motion.kind;
      }
    }

    // A song URL without an album URL still leaves the album clickable.
    if (!result.albumUrl && result.songUrl) result.albumUrl = result.songUrl;
    if (!result.artistUrl && result.songUrl) result.artistUrl = result.songUrl;

    return result;
  }

  /**
   * Breaks a scoring tie between different albums by asking which one actually
   * has motion artwork.
   *
   * A release is frequently in the catalog twice -- a clean edition and an
   * explicit one -- sharing a title, artist, album name and duration, so the
   * score is identical and sort order decides. Usually only one carries
   * `editorialVideo` (typically the explicit, being the primary release), so
   * checking is the only way to tell them apart.
   *
   * Costs one extra request per tied album, and only when a tie exists. The
   * result is passed back so the caller does not look it up twice.
   */
  async preferAlbumWithMotion(scored, best, token) {
    const TIE_EPSILON = 0.02;
    const albumIdOf = (entry) => entry.item.relationships?.albums?.data?.[0]?.id ?? null;

    const byAlbum = new Map();
    for (const entry of scored) {
      if (entry.score < best.score - TIE_EPSILON) break; // sorted desc
      const id = albumIdOf(entry);
      if (id && !byAlbum.has(id)) byAlbum.set(id, entry);
    }

    // Unambiguous: leave it alone rather than spending requests.
    if (byAlbum.size < 2) return { entry: best, motionChecked: false, motion: null };

    const candidates = [...byAlbum.values()].slice(0, 3);
    const motions = await Promise.all(
      candidates.map((entry) =>
        this.fetchAnimatedArtwork(albumIdOf(entry), token).catch(() => null)
      )
    );

    // candidates keeps score order, so this is the best-scoring one that has
    // motion artwork -- and is `best` itself whenever `best` already had it.
    const index = motions.findIndex(Boolean);
    if (index === -1) {
      log.debug(`${candidates.length} albums tied, none with motion artwork`);
      return { entry: best, motionChecked: false, motion: null };
    }

    if (candidates[index] !== best) {
      log.debug(
        `Tie between ${candidates.length} albums; switched to ${albumIdOf(candidates[index])} ` +
          `(has motion artwork) from ${albumIdOf(best)}`
      );
    }
    return { entry: candidates[index], motionChecked: true, motion: motions[index] };
  }

  /**
   * Motion artwork lives on the album under `editorialVideo`, as an HLS
   * playlist. Prefer the square variants -- Discord's asset slot is square.
   */
  async fetchAnimatedArtwork(albumId, token) {
    const url =
      `${AMP_BASE}/catalog/${encodeURIComponent(this.storefront)}/albums/${encodeURIComponent(albumId)}` +
      `?extend=editorialVideo&fields=editorialVideo,name,url,artwork`;

    const res = await fetch(url, { headers: ampHeaders(token), signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const body = await res.json();
    const video = body?.data?.[0]?.attributes?.editorialVideo;
    if (!video) return null;

    const preference = [
      'motionSquareVideo1x1',
      'motionDetailSquare',
      'motionDetailTall',
      'motionTallVideo3x4',
      'motionWideVideo16x9',
    ];
    for (const kind of preference) {
      const candidate = video[kind]?.video;
      if (candidate) return { url: candidate, kind };
    }
    // Unknown future variant names: take whatever has a `.video`.
    for (const [kind, value] of Object.entries(video)) {
      if (value?.video) return { url: value.video, kind };
    }
    return null;
  }

  /* ---------------- iTunes Search (no auth, always available) ------------- */

  async searchItunes(track) {
    const term = [track.name, track.artist, track.album].filter(Boolean).join(' ');
    const url =
      `${ITUNES_BASE}/search?term=${encodeURIComponent(term)}` +
      `&entity=song&limit=25&country=${encodeURIComponent(this.storefront)}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': WEB_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`itunes search -> ${res.status}`);

    const body = await res.json();
    const items = body?.results ?? [];
    if (!items.length) return null;

    const best = pickBest(items.map((item) => ({ item, score: scoreItunesSong(item, track) })));
    if (!best) return null;

    const item = best.item;
    return {
      source: 'itunes',
      score: best.score,
      songId: item.trackId ? String(item.trackId) : null,
      songName: item.trackName ?? track.name,
      songUrl: stripItunesParams(item.trackViewUrl),
      artistName: item.artistName ?? track.artist,
      artistUrl: stripItunesParams(item.artistViewUrl),
      albumName: item.collectionName ?? track.album,
      albumId: item.collectionId ? String(item.collectionId) : null,
      albumUrl: stripItunesParams(item.collectionViewUrl),
      artworkTemplate: item.artworkUrl100 ?? null,
      artworkUrl: artworkAt(item.artworkUrl100, this.artworkSize),
      artworkBgColor: null,
      // iTunes Search has no concept of motion artwork.
      animatedUrl: null,
      durationSec: item.trackTimeMillis ? item.trackTimeMillis / 1000 : 0,
    };
  }
}

function stripItunesParams(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}

const MIN_TITLE_SIMILARITY = 0.5;

function pickBest(scored) {
  let best = null;
  for (const entry of scored) {
    if (!best || entry.score > best.score) best = entry;
  }
  // Below this the "match" is usually a cover or a karaoke version; better to
  // show no links than wrong ones.
  return best && best.score >= 0.55 ? best : null;
}

export function scoreCommon({ name, artist, album, durationSec }, track) {
  const nameScore = similarity(name, track.name);
  // A different song from the right album still scores ~0.55 on artist and
  // album alone, which is enough to sail past the overall threshold and
  // attach a link to the wrong track. The title has to actually match.
  if (nameScore < MIN_TITLE_SIMILARITY) return 0;
  const artistScore = similarity(artist, track.artist || track.albumArtist);
  const albumScore = track.album ? similarity(album, track.album) : 0.5;

  let durationScore = 0.5;
  if (durationSec && track.duration) {
    const delta = Math.abs(durationSec - track.duration);
    durationScore = delta <= 2 ? 1 : delta <= 5 ? 0.8 : delta <= 15 ? 0.4 : 0;
  }

  let score = (nameScore * 4 + artistScore * 3 + albumScore * 2 + durationScore * 1) / 10;

  // "Greatest Hits" and "Greatest Hits (Deluxe Edition)" both hit 1.0 on the
  // album once the noise strip runs, so different *editions* tie and search
  // order picks one — showing the deluxe cover and link under the plain
  // edition's name, or vice versa. An album named exactly what the player
  // reports gets a bump past TIE_EPSILON, so the playing edition wins the tie
  // outright. Clean/explicit variants share one album name, so they either
  // both get this or neither does, and the motion tie-break still separates
  // them.
  if (track.album && normalizeLoose(album) === normalizeLoose(track.album)) score += 0.03;

  return score;
}

function scoreAmpSong(song, track) {
  const a = song.attributes ?? {};
  return scoreCommon(
    {
      name: a.name,
      artist: a.artistName,
      album: a.albumName,
      durationSec: a.durationInMillis ? a.durationInMillis / 1000 : 0,
    },
    track
  );
}

function scoreItunesSong(item, track) {
  return scoreCommon(
    {
      name: item.trackName,
      artist: item.artistName,
      album: item.collectionName,
      durationSec: item.trackTimeMillis ? item.trackTimeMillis / 1000 : 0,
    },
    track
  );
}
