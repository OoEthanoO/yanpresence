import test from 'node:test';
import assert from 'node:assert/strict';

import { episodeCode, isEpisode } from '../src/tv.js';
import os from 'node:os';

import { tvArtworkAt, TvCatalog } from '../src/tvcatalog.js';
import { buildWatchActivity } from '../src/presence.js';
import { DEFAULTS } from '../src/config.js';
import { YanPresence } from '../src/index.js';

const CONFIG = {
  ...DEFAULTS,
  clientId: '1533115403742740532',
  statusDisplay: 'details',
  placeholderImageKey: 'blank',
  tv: { ...DEFAULTS.tv, enabled: true },
};

const EPISODE = {
  name: 'Man City',
  show: 'Ted Lasso',
  season: 2,
  episode: 8,
  duration: 2872,
  year: 2021,
  director: '',
  mediaKind: 'TV show',
  kind: '',
  isEpisode: true,
};

const FILM = {
  name: 'Blade Runner 2049',
  show: '',
  season: 0,
  episode: 0,
  duration: 9840,
  year: 2017,
  director: 'Denis Villeneuve',
  mediaKind: 'movie',
  kind: '',
  isEpisode: false,
};

test('episode numbering is formatted, and degrades when partial', () => {
  assert.equal(episodeCode({ season: 2, episode: 8 }), 'S2E8');
  assert.equal(episodeCode({ season: 0, episode: 8 }), 'E8');
  assert.equal(episodeCode({ season: 2, episode: 0 }), 'S2');
  assert.equal(episodeCode({ season: 0, episode: 0 }), '');
});

test('a show name identifies an episode; a film has none', () => {
  assert.equal(isEpisode({ show: 'Ted Lasso', mediaKind: '', kind: '' }), true);
  // A downloaded file can leave mediaKind blank, so the show name leads.
  assert.equal(isEpisode({ show: '', mediaKind: 'TV show', kind: '' }), true);
  assert.equal(isEpisode({ show: '', mediaKind: 'movie', kind: '' }), false);
});

test('an episode puts the show on the status line, not the episode title', () => {
  // "Watching Ted Lasso" means something to a reader; "Watching Man City"
  // does not. This is deliberately the opposite of the music layout.
  const a = buildWatchActivity({
    item: EPISODE,
    state: 'playing',
    artworkUrl: null,
    config: CONFIG,
    startedAt: Date.now(),
  });
  assert.equal(a.type, 3, 'Watching, not Listening');
  assert.equal(a.details, 'Ted Lasso');
  assert.equal(a.state, 'S2E8 · Man City');
  assert.equal(a.assets.large_text, 'Man City · S2E8', 'hover carries the episode');
  assert.ok(a.timestamps, 'progress while playing');
});

test('a film uses its own title, with year and director beneath', () => {
  const a = buildWatchActivity({
    item: FILM,
    state: 'playing',
    artworkUrl: null,
    config: CONFIG,
    startedAt: Date.now(),
  });
  assert.equal(a.details, 'Blade Runner 2049');
  assert.equal(a.state, '2017 · Denis Villeneuve');
  assert.equal(a.assets.large_text, undefined, 'no episode to put on hover');
});

test('the image slot falls back to the placeholder, since TV art is unreachable', () => {
  const a = buildWatchActivity({
    item: EPISODE,
    state: 'playing',
    artworkUrl: null,
    config: CONFIG,
    startedAt: Date.now(),
  });
  assert.equal(a.assets.large_image, 'blank');
});

test('progress is withheld while paused', () => {
  const a = buildWatchActivity({
    item: EPISODE,
    state: 'paused',
    artworkUrl: null,
    config: CONFIG,
    startedAt: null,
  });
  assert.equal(a.timestamps, undefined);
});

test('TV artwork is squared without cropping the frame', () => {
  // Apple's TV art is 16:9. A plain 1024x1024 request returns 1024x576, and
  // the crop codes that do fill a square (sr/cc/ve) eat the title treatment.
  // `bf` fits the whole frame onto a matte instead, losing nothing.
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}.{f}', 1024),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/1024x1024bf.jpg'
  );
  // Some templates already carry a crop code; it must be replaced, not appended.
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}sr.{f}', 512),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/512x512bf.jpg'
  );
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.{f}', 512),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/512x512bf.jpg'
  );
  assert.equal(tvArtworkAt(null, 1024), null);
});

test('the season being watched gets its own artwork, with a show-level fallback', () => {
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  const entry = {
    title: 'Ted Lasso',
    artworkTemplate: 'https://x/thumb/SHOW/{w}x{h}.{f}',
    seasons: { 1: 'https://x/thumb/S1/{w}x{h}CA.TVA23C01.{f}', 2: 'https://x/thumb/S2/{w}x{h}{c}.{f}' },
  };
  assert.match(cat.withCurrentSize(entry, 2).artworkUrl, /thumb\/S2\/1024x1024bf\.jpg$/);
  assert.equal(cat.withCurrentSize(entry, 2).artworkScope, 'season 2');
  // A season Apple has no separate art for falls back rather than showing none.
  assert.match(cat.withCurrentSize(entry, 9).artworkUrl, /thumb\/SHOW\//);
  assert.equal(cat.withCurrentSize(entry, 9).artworkScope, 'show');
  // Films have no season at all.
  assert.match(cat.withCurrentSize(entry, 0).artworkUrl, /thumb\/SHOW\//);
});

test('the season square is read from previewFrame, not the show-level coverArt', async () => {
  // The trap this pins: `data.showImages.coverArt` is the SHOW's square and is
  // identical for every season, while the season's own square sits under
  // `data.images.previewFrame`. Reading the key named "coverArt" yields the
  // same image for every season and makes per-season art look nonexistent.
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  cat.getJson = async () => ({
    data: {
      images: {
        coverArt16X9: { url: 'https://x/thumb/WIDE/{w}x{h}.{f}', width: 3840, height: 2160 },
        previewFrame: { url: 'https://x/thumb/SEASON/{w}x{h}.{f}', width: 3000, height: 3000 },
      },
      showImages: {
        coverArt: { url: 'https://x/thumb/SHOW/{w}x{h}.{f}', width: 3000, height: 3000 },
      },
    },
  });

  const covers = await cat.seasonCover('umc.cmc.whatever', 'token');
  assert.match(covers.season, /thumb\/SEASON\//, 'the season square, not the show one');
  assert.match(covers.show, /thumb\/SHOW\//);
});

test('a non-square season asset is refused rather than matted', async () => {
  // Seasons whose only art is 16:9 fall back to the show square, so the slot
  // is never filled with something that needs black bars.
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  cat.getJson = async () => ({
    data: {
      images: { previewFrame: { url: 'https://x/thumb/WIDE/{w}x{h}.{f}', width: 3840, height: 2160 } },
      showImages: { coverArt: { url: 'https://x/thumb/SHOW/{w}x{h}.{f}', width: 3000, height: 3000 } },
    },
  });

  const covers = await cat.seasonCover('umc.cmc.whatever', 'token');
  assert.equal(covers.season, null, 'a 16:9 asset is not a square');
  assert.match(covers.show, /thumb\/SHOW\//);
});

test('a season miss is remembered so it is not refetched every episode', async () => {
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  let calls = 0;
  cat.getJson = async () => {
    calls += 1;
    return {
      data: {
        images: {},
        showImages: { coverArt: { url: 'https://x/thumb/SHOW/{w}x{h}.{f}', width: 3000, height: 3000 } },
      },
    };
  };

  const entry = { id: 'umc.cmc.show', artworkTemplate: 'https://x/thumb/OLD/{w}x{h}.{f}', seasonIds: { 2: 'umc.cmc.s2' } };
  await cat.ensureSeasonCover(entry, 2);
  await cat.ensureSeasonCover(entry, 2);

  assert.equal(calls, 1, 'the miss is cached, not re-requested');
  assert.equal(entry.seasons[2], null);
  assert.match(entry.artworkTemplate, /thumb\/SHOW\//, 'show fallback upgraded to the square');
});

test('episode runtime is recovered when TV.app reports none', async () => {
  // Apple TV+ streams expose no duration through TV.app at all, and without a
  // runtime there is no end timestamp, so Discord shows no progress whatsoever.
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  let calls = 0;
  cat.getJson = async () => {
    calls += 1;
    return {
      data: {
        episodes: [
          { seasonNumber: 3, episodeNumber: 5, duration: 2940 },
          { seasonNumber: 3, episodeNumber: 6, duration: 3780 },
          // Neighbouring seasons ride along in the same response.
          { seasonNumber: 2, episodeNumber: 1, duration: 1800 },
        ],
      },
    };
  };
  cat.memo.set('ca|ted lasso', { id: 'umc.cmc.show', seasonIds: { 2: 'umc.cmc.s2', 3: 'umc.cmc.s3' } });

  const item = { isEpisode: true, show: 'Ted Lasso', name: 'Sunflowers', season: 3, episode: 6 };
  assert.equal(await cat.durationFor(item), 3780);

  // Everything in the response is kept, so a second episode is free.
  assert.equal(await cat.durationFor({ ...item, episode: 5, name: 'Signs' }), 2940);
  assert.equal(calls, 1, 'one request covers the season');

  // An episode Apple has no runtime for is remembered as a miss.
  assert.equal(await cat.durationFor({ ...item, episode: 99 }), null);
  assert.equal(calls, 2, 'one retry for the unknown episode, then cached');
  assert.equal(await cat.durationFor({ ...item, episode: 99 }), null);
  assert.equal(calls, 2);
});

test('a film, or a show with no season id, asks for no runtime', async () => {
  const cat = new TvCatalog({ storefront: 'ca', cacheDir: os.tmpdir(), artworkSize: 1024 });
  cat.getJson = async () => assert.fail('should not have made a request');
  assert.equal(await cat.durationFor({ isEpisode: false, name: 'Ghosted' }), null);
  cat.memo.set('ca|ted lasso', { id: 'umc.cmc.show', seasonIds: { 1: 'umc.cmc.s1' } });
  assert.equal(
    await cat.durationFor({ isEpisode: true, show: 'Ted Lasso', season: 7, episode: 1 }),
    null
  );
});

test('resolved artwork replaces the placeholder', () => {
  const url = 'https://is1-ssl.mzstatic.com/image/thumb/abc/1024x1024bf.jpg';
  const a = buildWatchActivity({
    item: EPISODE,
    state: 'playing',
    artworkUrl: url,
    config: CONFIG,
    startedAt: Date.now(),
  });
  assert.equal(a.assets.large_image, url);
});

test('source arbitration: whatever is playing wins, video breaks the tie', () => {
  const app = new YanPresence(CONFIG, { dryRun: true });
  const playing = { active: true, state: 'playing' };
  const paused = { active: true, state: 'paused' };
  const off = { active: false, state: 'closed' };

  const pick = (music, tv) => {
    app.musicSnapshot = music;
    app.tvSnapshot = tv;
    return app.pickSource();
  };

  assert.equal(pick(off, off), null, 'nothing playing anywhere');
  assert.equal(pick(playing, off), 'music');
  assert.equal(pick(off, playing), 'tv');
  assert.equal(pick(playing, playing), 'tv', 'video beats audio');
  assert.equal(pick(playing, paused), 'music', 'a paused show does not steal it');
  assert.equal(pick(paused, playing), 'tv');
  assert.equal(pick(paused, paused), 'tv', 'both idle: video still leads');
  assert.equal(pick(paused, off), 'music');

  app.stop();
});
