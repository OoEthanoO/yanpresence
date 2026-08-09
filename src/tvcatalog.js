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

  loadDisk() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
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

    const key = `${this.storefront}|${term.toLowerCase()}`;
    if (this.memo.has(key)) return this.withCurrentSize(this.memo.get(key));

    const cached = this.disk[key];
    // 30 days, matching the music catalog cache.
    if (cached && Date.now() - cached.ts < 30 * 24 * 60 * 60 * 1000) {
      this.memo.set(key, cached);
      return this.withCurrentSize(cached);
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
        return this.withCurrentSize(entry);
      })
      .catch((err) => {
        log.debug(`Apple TV lookup failed for "${term}": ${err.message}`);
        return null;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  /** Re-derives the URL at the configured size, as the music catalog does. */
  withCurrentSize(entry) {
    if (!entry || entry.miss) return null;
    return { ...entry, artworkUrl: tvArtworkAt(entry.artworkTemplate, this.artworkSize) };
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

    const wanted = norm(term);
    const scored = candidates
      .map((c) => ({
        c,
        score:
          (norm(c.title) === wanted ? 1 : norm(c.title).includes(wanted) ? 0.8 : 0) +
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

    return {
      title: best.c.title,
      id: best.c.id ?? '',
      type: best.c.type ?? '',
      artworkTemplate: template,
      url: best.c.id ? `${TV_WEB}/${this.storefront}/show/${encodeURIComponent(best.c.id)}` : '',
    };
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

function pickUrl(image) {
  const url = image?.url;
  return typeof url === 'string' && url.includes('{w}') ? url : null;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Apple's TV art is 16:9, and Discord's asset slot is square. `sr` is the crop
 * code that returns a real square rather than the letterboxed 16:9 that a
 * plain `{w}x{h}` request yields even when both are equal.
 */
export function tvArtworkAt(template, size) {
  if (!template) return null;
  return template
    .replace(/\{w\}x\{h\}([a-z]{0,4})/i, `${size}x${size}sr`)
    .replace('{f}', 'jpg');
}
