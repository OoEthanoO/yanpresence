import test from 'node:test';
import assert from 'node:assert/strict';

import { episodeCode, isEpisode } from '../src/tv.js';
import { tvArtworkAt } from '../src/tvcatalog.js';
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

test('TV artwork is requested as a real square', () => {
  // Apple's TV art is 16:9. A plain 1024x1024 request returns a letterboxed
  // 1024x576; the `sr` crop code is what actually yields a square, which is
  // what Discord's asset slot wants.
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}.{f}', 1024),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/1024x1024sr.jpg'
  );
  // Some templates already carry a crop code; it must be replaced, not appended.
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}sr.{f}', 512),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/512x512sr.jpg'
  );
  assert.equal(
    tvArtworkAt('https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.{f}', 512),
    'https://is1-ssl.mzstatic.com/image/thumb/abc/512x512sr.jpg'
  );
  assert.equal(tvArtworkAt(null, 1024), null);
});

test('resolved artwork replaces the placeholder', () => {
  const url = 'https://is1-ssl.mzstatic.com/image/thumb/abc/1024x1024sr.jpg';
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
