import fs from 'node:fs';
import path from 'node:path';

import log from './log.js';

/**
 * Artwork and links for what TV.app is playing.
 *
 * The iTunes Search API no longer carries TV content -- `media=tvShow` and
 * `media=movie` both return zero results for everything -- and Apple TV+
 * streams have no embedded cover. What does work is the backend behind
 * tv.apple.com, which is where the web app itself gets its art.
 *
 * It needs a `utsk` session key, obtained the same way catalog.js obtains the
 * music token: load the public web page and read the key out of it. Requests
 * without one are rejected outright.
 */

const UTS_BASE = 'https://uts-api.itunes.apple.com/uts/v3';
const TV_WEB = 'https://tv.apple.com';

const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Apple's numeric storefront ids, for the handful of regions likely to come up.
// Anything unknown falls back to the US, which still resolves artwork.
const STOREFRONTS = {
  us: 143441, ca: 143455, gb: 143444, au: 143460, nz: 143461, ie: 143449,
  de: 143443, fr: 143442, es: 143454, it: 143450, nl: 143452, se: 143456,
  no: 143457, dk: 143458, fi: 143447, jp: 143462, kr: 143466, cn: 143465,
  in: 143467, br: 143503, mx: 143468, sg: 143464, hk: 143463, tw: 143470,
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * The `utsk` key is embedded in every tv.apple.com page. It outlives a single
 * request comfortably, so it is cached on disk and only refetched when a call
 * is rejected.
 */
class UtsTokenProvider {
  constructor(file, storefront) {
    this.file = file;
    this.storefront = storefront;
    this.value = null;
    this.inflight = null;
  }

  load() {
    try {
      const { token, ts } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // A week is well inside its useful life and avoids a fetch per launch.
      if (token && Date.now() - ts < 7 * 24 * 60 * 60 * 1000) return token;
    } catch {
      /* no cache yet */
    }
    return null;
  }

  save(token) {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ token, ts: Date.now() }));
    } catch (err) {
      log.debug(`Could not persist the Apple TV token: ${err.message}`);
    }
  }

  async get({ force = false } = {}) {
    if (!force) {
      this.value ??= this.load();
      if (this.value) return this.value;
    }
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async fetchToken() {
    const url = `${TV_WEB}/${this.storefront}/`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        log.debug(`Apple TV token page returned ${res.status}`);
        return null;
      }
      const html = await res.text();
      const match = html.match(/"utsk"\s*:\s*"([^"]+)"/);
      if (!match) {
        log.debug('No utsk key found on the Apple TV page');
        return null;
      }
      this.value = match[1];
      this.save(this.value);
      return this.value;
    } catch (err) {
      log.debug(`Apple TV token fetch failed: ${err.message}`);
      return null;
    }
  }
}

export class TvCatalog {
  constructor({ storefront = 'us', cacheDir, artworkSize = 1024 } = {}) {
    this.storefront = String(storefront || 'us').toLowerCase();
    this.sf = STOREFRONTS[this.storefront] ?? STOREFRONTS.us;
    this.artworkSize = artworkSize;
    this.cacheFile = path.join(cacheDir, 'tv-catalog.json');
    this.tokens = new UtsTokenProvider(path.join(cacheDir, 'tv-token.json'), this.storefront);
    this.disk = this.loadDisk();
    this.memo = new Map();
    this.inflight = new Map();
  }

  /**
   * Loads the cache, dropping entries lookup() would refuse anyway. Nothing
   * pruned expired entries before, so the file only grew, and it is rewritten
   * whole every time a new show resolves.
   */
  loadDisk() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }

    const now = Date.now();
    const kept = {};
    let dropped = 0;
    for (const [key, entry] of Object.entries(raw ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (now - (entry.ts ?? 0) < ENTRY_TTL_MS) kept[key] = entry;
      else dropped += 1;
    }

    if (dropped) {
      log.debug(`Apple TV cache: dropped ${dropped} expired entries`);
      this.disk = kept;
      this.saveDisk();
    }
    return kept;
  }

  saveDisk() {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.disk));
    } catch (err) {
      log.debug(`Could not persist the TV catalog cache: ${err.message}`);
    }
  }

  /**
   * Resolve a TV.app item to artwork and a link. Keyed on the show (or the
   * film), not the episode: every episode of a series shares its art, so one
   * lookup covers a whole binge.
   */
  async lookup(item) {
    const term = item.isEpisode && item.show ? item.show : item.name;
    if (!term) return null;

    const season = item.isEpisode ? item.season : 0;
    const key = `${this.storefront}|${term.toLowerCase()}`;
    if (this.memo.has(key)) {
      const entry = this.memo.get(key);
      await this.ensureSeasonCover(entry, season, key);
      return this.withCurrentSize(entry, season);
    }

    const cached = this.disk[key];
    // 30 days, matching the music catalog cache.
    if (cached && Date.now() - cached.ts < ENTRY_TTL_MS) {
      this.memo.set(key, cached);
      await this.ensureSeasonCover(cached, season, key);
      return this.withCurrentSize(cached, season);
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = this.resolve(term, item)
      .then((result) => {
        // Cache misses too, so an obscure title is not searched every episode.
        const entry = result ?? { miss: true };
        entry.ts = Date.now();
        this.memo.set(key, entry);
        this.disk[key] = entry;
        this.saveDisk();
        return this.withCurrentSize(entry, season);
      })
      .catch((err) => {
        log.debug(`Apple TV lookup failed for "${term}": ${err.message}`);
        return null;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Re-derives the URL at the configured size, as the music catalog does, and
   * prefers the artwork for the season being watched. A season Apple has no
   * separate art for -- and every film -- falls back to the show's own.
   */
  withCurrentSize(entry, season = 0) {
    if (!entry || entry.miss) return null;
    const template = (season && entry.seasons?.[season]) || entry.artworkTemplate;
    return {
      ...entry,
      artworkUrl: tvArtworkAt(template, this.artworkSize),
      artworkScope:
        season && entry.seasons?.[season]
          ? `season ${season}`
          : entry.type === 'Movie'
            ? 'film'
            : 'show',
    };
  }

  async resolve(term, item) {
    const wantMovie = !item.isEpisode;
    let token = await this.tokens.get();
    if (!token) return null;

    let body = await this.search(term, token);
    // A rejected key is the one failure worth retrying, once, with a fresh one.
    if (body === 'unauthorized') {
      token = await this.tokens.get({ force: true });
      if (!token) return null;
      body = await this.search(term, token);
    }
    if (!body || body === 'unauthorized') return null;

    const shelves = body?.data?.canvas?.shelves ?? [];
    const candidates = [];
    for (const shelf of shelves) {
      for (const entry of shelf.items ?? []) {
        if (entry?.title && entry?.images) candidates.push(entry);
      }
    }
    if (!candidates.length) return null;

    const scored = candidates
      .map((c) => ({
        c,
        score:
          titleScore(c.title, term) +
          // A film should match a Movie, an episode a Show.
          (wantMovie ? (c.type === 'Movie' ? 0.25 : 0) : c.type === 'Show' ? 0.25 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0.8) return null;

    const images = best.c.images ?? {};
    // posterArt carries the title treatment; the others are untitled stills.
    const template =
      pickUrl(images.showPosterArt) ??
      pickUrl(images.posterArt) ??
      pickUrl(images.coverArt) ??
      pickUrl(images.shelfImage) ??
      pickUrl(images.contentImage);
    if (!template) return null;

    const entry = {
      title: best.c.title,
      id: best.c.id ?? '',
      type: best.c.type ?? '',
      artworkTemplate: template,
      url: best.c.id ? `${TV_WEB}/${this.storefront}/show/${encodeURIComponent(best.c.id)}` : '',
    };

    if (!wantMovie && entry.id) {
      entry.seasonIds = await this.seasonIds(entry.id, token).catch((err) => {
        log.debug(`Season list lookup failed: ${err.message}`);
        return null;
      });
      // Seed the covers for the season being watched; lookup() fills in any
      // other season on demand later.
      await this.ensureSeasonCover(entry, item.isEpisode ? item.season : 0);
    } else if (wantMovie && entry.id) {
      const poster = await this.movieCover(entry.id, token).catch((err) => {
        log.debug(`Movie artwork lookup failed: ${err.message}`);
        return null;
      });
      if (poster) entry.artworkTemplate = poster;
    }
    return entry;
  }

  /**
   * A film's poster, from the movie metadata route.
   *
   * Films have no square anywhere in Apple's catalog -- unlike a season, whose
   * `previewFrame` is a true 3000x3000. What they do have, at `v=100`, is the
   * titled 2:3 poster Apple moved to in iOS 26. It is preferred over the 16:9
   * shelf image the search returns for two reasons: matted into a square it
   * wastes 33% of the slot rather than 44%, and it carries the title, which a
   * production still does not -- an untitled frame is unidentifiable at the
   * size Discord renders.
   */
  async movieCover(movieId, token) {
    const body = await this.getJson(
      `${UTS_BASE}/movies/${encodeURIComponent(movieId)}/metadata?utsk=${encodeURIComponent(token)}` +
        `&caller=web&sf=${this.sf}&v=100&pfm=web&locale=en-US&utscf=OjAAAAAAAAA~`
    );
    const images = body?.data?.images ?? {};
    // Squares stay first in case Apple ever publishes one for a film.
    return (
      squareUrl(images.coverArt) ??
      squareUrl(images.previewFrame) ??
      pickUrl(images.coverArt2X3) ??
      null
    );
  }

  /**
   * The season list, `{ seasonNumber: seasonId }`, from the show endpoint's
   * `data.seasons` map. The map only appears when `utscf` is present --
   * without the flag the response has no seasons at all, which is why season
   * support looked unavailable at first.
   */
  async seasonIds(showId, token) {
    const body = await this.getJson(
      `${UTS_BASE}/shows/${encodeURIComponent(showId)}?utsk=${encodeURIComponent(token)}` +
        `&caller=web&sf=${this.sf}&v=80&pfm=web&locale=en-US&utscf=OjAAAAAAAAA~`
    );
    const seasons = body?.data?.seasons;
    if (!seasons || typeof seasons !== 'object') return null;

    const ids = {};
    for (const season of Object.values(seasons)) {
      if (Number.isInteger(season?.seasonNumber) && season?.id) ids[season.seasonNumber] = season.id;
    }
    return Object.keys(ids).length ? ids : null;
  }

  /**
   * Square covers from the per-season metadata route -- the assets the iTunes
   * Store showed per season, which Apple still publishes for every season of
   * every Original.
   *
   * The naming is a trap: the season's own 3000x3000 square sits under
   * `data.images.previewFrame`, while the key literally called `coverArt`
   * lives under `data.showImages` and belongs to the *show*. Grepping for
   * "coverArt" therefore finds the same image for every season and makes
   * per-season art look nonexistent -- which is exactly the mistake this
   * comment is here to prevent repeating.
   */
  async seasonCover(seasonId, token) {
    const body = await this.getJson(
      `${UTS_BASE}/seasons/${encodeURIComponent(seasonId)}/metadata?utsk=${encodeURIComponent(token)}` +
        `&caller=web&sf=${this.sf}&v=80&pfm=web&locale=en-US&utscf=OjAAAAAAAAA~`
    );
    if (!body) return null;

    const images = body?.data?.images ?? {};
    const showImages = body?.data?.showImages ?? {};
    return {
      season: squareUrl(images.coverArt) ?? squareUrl(images.previewFrame),
      show: squareUrl(showImages.coverArt) ?? squareUrl(showImages.previewFrame),
    };
  }

  /**
   * Fetches and memoises the covers for one season, on demand. Only the
   * season actually being watched costs a request, once, per thirty days; the
   * same response upgrades the show-level fallback from the 16:9 poster to
   * the show's own square.
   */
  async ensureSeasonCover(entry, season, cacheKey = null) {
    const ids = entry?.seasonIds;
    if (!ids || entry.miss) return;
    entry.seasons ??= {};

    const wantSeason = Boolean(season && ids[season]) && entry.seasons[season] === undefined;
    if (!wantSeason && entry.coverChecked) return;

    const token = await this.tokens.get();
    if (!token) return;

    const sid = (season && ids[season]) || Object.values(ids)[0];
    const covers = await this.seasonCover(sid, token).catch((err) => {
      log.debug(`Season cover lookup failed: ${err.message}`);
      return null;
    });
    if (!covers) return;

    // null is stored deliberately: it remembers that this season has no square
    // of its own, so it is not re-requested on every episode.
    if (season && ids[season]) entry.seasons[season] = covers.season ?? null;
    if (covers.show) entry.artworkTemplate = covers.show;
    entry.coverChecked = true;

    if (cacheKey) {
      this.disk[cacheKey] = entry;
      this.saveDisk();
    }
  }


  /**
   * Episode runtimes for a season, keyed `"season|episode"`.
   *
   * TV.app reports no duration at all for Apple TV+ streams -- the property is
   * absent, and reading it directly throws -- so without this there is nothing
   * to build a progress bar from. Purchased items do carry it locally, which
   * is why this is only consulted as a fallback.
   */
  async episodeDurations(showId, seasonId, token) {
    const body = await this.getJson(
      `${UTS_BASE}/shows/${encodeURIComponent(showId)}/episodes?utsk=${encodeURIComponent(token)}` +
        `&caller=web&sf=${this.sf}&v=80&pfm=web&locale=en-US&utscf=OjAAAAAAAAA~` +
        `&selectedSeasonId=${encodeURIComponent(seasonId)}`
    );
    const episodes = body?.data?.episodes ?? [];
    const out = {};
    for (const episode of episodes) {
      const s = episode?.seasonNumber;
      const e = episode?.episodeNumber;
      const seconds = Number(episode?.duration);
      // The response carries the neighbouring seasons too, so everything it
      // hands back is kept -- a binge then costs one request per season.
      if (Number.isInteger(s) && Number.isInteger(e) && seconds > 0) out[`${s}|${e}`] = seconds;
    }
    return out;
  }

  /**
   * Runtime in seconds for the episode being watched, or null. Cached with the
   * show entry, so one request covers the whole season.
   */
  async durationFor(item) {
    if (!item?.isEpisode) return null;
    const term = item.show || item.name;
    if (!term) return null;

    const key = `${this.storefront}|${term.toLowerCase()}`;
    const entry = this.memo.get(key) ?? this.disk[key];
    if (!entry || entry.miss || !entry.id) return null;

    const seasonId = entry.seasonIds?.[item.season];
    if (!seasonId) return null;

    entry.durations ??= {};
    const slot = `${item.season}|${item.episode}`;

    if (entry.durations[slot] === undefined) {
      const token = await this.tokens.get();
      if (!token) return null;
      const found = await this.episodeDurations(entry.id, seasonId, token).catch((err) => {
        log.debug(`Episode duration lookup failed: ${err.message}`);
        return null;
      });
      if (found) Object.assign(entry.durations, found);
      // null remembers a miss, so a runtime Apple does not publish is not
      // re-requested on every tick.
      entry.durations[slot] ??= null;
      this.disk[key] = entry;
      this.saveDisk();
    }

    return entry.durations[slot] ?? null;
  }

  async getJson(url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Origin: TV_WEB, Referer: `${TV_WEB}/` },
      signal: AbortSignal.timeout(12000),
    });
    return res.ok ? res.json() : null;
  }

  async search(term, token) {
    const url =
      `${UTS_BASE}/search?utsk=${encodeURIComponent(token)}&caller=web&sf=${this.sf}` +
      `&v=80&pfm=web&locale=en-US&searchTerm=${encodeURIComponent(term)}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Origin: TV_WEB, Referer: `${TV_WEB}/` },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 400) return 'unauthorized';
    if (!res.ok) return null;
    return res.json();
  }
}

/** The template URL, but only when the asset is genuinely square. */
function squareUrl(image) {
  const url = pickUrl(image);
  return url && image.width === image.height ? url : null;
}

function pickUrl(image) {
  const url = image?.url;
  return typeof url === 'string' && url.includes('{w}') ? url : null;
}

/**
 * How much a catalog title looks like the one we are searching for, 0..1.
 *
 * Containment alone is not enough, and the direction matters. A local title
 * carrying extra decoration is normal -- "Mythic Quest: Raven's Banquet" for
 * Apple's "Mythic Quest" -- so a candidate contained in what we searched for
 * is trustworthy. The reverse is not: a short generic title sits inside plenty
 * of unrelated shows, and treating that as a match put the wrong poster on the
 * card. Measured against Apple's own catalog, "Bad" matched *Bad Sisters*,
 * "Dark" matched *Dark Matter*, and "Friends" matched *Your Friends &
 * Neighbours*. No artwork is better than confidently wrong artwork.
 */
export function titleScore(candidateTitle, wantedTitle) {
  const candidate = norm(candidateTitle);
  const wanted = norm(wantedTitle);
  if (!candidate || !wanted) return 0;
  if (candidate === wanted) return 1;

  // What we searched for spells out more than Apple's title does.
  if (wanted.includes(candidate)) return 0.9;

  // Apple's title is the longer one. Only trust that when the two are nearly
  // the same length, so a one-word title cannot claim a longer show.
  if (candidate.includes(wanted) && wanted.length / candidate.length >= 0.8) return 0.85;

  return 0;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Apple's TV art is 16:9 and Discord's asset slot is square, so the crop code
 * decides what happens to the other 43% of the frame.
 *
 *   (none) / bb   ignore the square entirely and return 1024x576
 *   sr / cc / ve  fill the square by cropping — which eats the title treatment
 *   bf            fit the whole frame into the square on a matte
 *
 * `bf` is the one that loses nothing: the full 16:9 image, letterboxed, with
 * the show's wordmark intact. Cropping is the wrong trade here because the
 * wordmark is the only part still legible at the size Discord renders.
 */
export function tvArtworkAt(template, size) {
  if (!template) return null;
  return template
    // The crop slot is sometimes a literal code (`sr`, `CA.TVA23C01`) and
    // sometimes a `{c}` placeholder. Both are replaced outright. The lookahead
    // matters: a code like `CA.TVA23C01` contains dots, so the match has to
    // stop at the extension rather than at the first dot it meets.
    .replace(/\{w\}x\{h\}(?:\{c\}|[A-Za-z0-9.\-]*?)(?=\.\{f\})/, `${size}x${size}bf`)
    .replace('{f}', 'jpg');
}
