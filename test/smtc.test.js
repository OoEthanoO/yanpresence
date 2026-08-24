import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPLE_MUSIC_APP_ID,
  APPLE_TV_APP_ID,
  cleanTitle,
  normalize,
  normalizeMusic,
  normalizeTv,
  parseEpisode,
  readEpisodeCode,
} from '../src/smtc.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/*
 * Real shapes, as the watcher emits them. The Windows apps publish a System
 * Media Transport Controls session and nothing else -- there is no scripting
 * interface to ask a second question of -- so every one of these fields is
 * everything that is knowable about what is playing.
 */

const PLAYING = {
  channel: 'music',
  state: 'playing',
  name: 'Be Her',
  artist: 'Ella Langley',
  album: 'Hungover',
  albumArtist: 'Ella Langley',
  subtitle: '',
  duration: 191.4,
  position: 64.2,
  trackNumber: 3,
  trackCount: 14,
  genres: ['Country'],
  playbackType: 'Music',
  hasArtwork: true,
  appId: `${APPLE_MUSIC_APP_ID}_nzyj5cx40ttqa!App`,
};

test('a playing track comes out shaped like Music.app produces', () => {
  const snapshot = normalizeMusic(PLAYING);

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.state, 'playing');
  assert.equal(snapshot.track.name, 'Be Her');
  assert.equal(snapshot.track.artist, 'Ella Langley');
  assert.equal(snapshot.track.album, 'Hungover');
  assert.equal(snapshot.track.duration, 191.4);
  assert.equal(snapshot.track.position, 64.2);
  assert.equal(snapshot.track.hasArtwork, true);

  // Windows publishes no stable identifier for what is playing, so identity is
  // the metadata triple -- the same fallback a Music.app cloud track uses.
  assert.equal(snapshot.track.key, 'meta:Be Her\0Ella Langley\0Hungover');
  assert.equal(snapshot.track.albumKey, 'ella langley\0hungover');
});

test('a position past the end is clamped, not believed', () => {
  // The watcher extrapolates the playhead between the app's own timeline
  // updates, so it can overshoot a track that ended while nobody was looking.
  const snapshot = normalizeMusic({ ...PLAYING, position: 400 });
  assert.equal(snapshot.track.position, 191.4);
});

test('a track with no duration keeps a usable position', () => {
  const snapshot = normalizeMusic({ ...PLAYING, duration: 0, position: 12 });
  assert.equal(snapshot.track.duration, 0);
  assert.equal(snapshot.track.position, 12);
});

test('anything but playing or paused is inactive, with no track', () => {
  for (const state of ['stopped', 'closed', 'unknown']) {
    const snapshot = normalizeMusic({ ...PLAYING, state });
    assert.equal(snapshot.active, false, state);
    assert.equal(snapshot.track, null, state);
    assert.equal(snapshot.state, state);
  }
});

test('the channel decides which shape comes back', () => {
  assert.equal(normalize(PLAYING).channel, 'music');
  assert.ok(normalize(PLAYING).track);

  const tv = normalize({ ...PLAYING, channel: 'tv' });
  assert.equal(tv.channel, 'tv');
  assert.ok(tv.item);
  assert.equal(tv.track, undefined);

  // An unlabelled line is music: that is the channel that is always on, and
  // guessing "tv" would put a song on the wrong card.
  assert.equal(normalize({ ...PLAYING, channel: undefined }).channel, 'music');
});

/* ---------------------------------------------------------------- *
 * Apple TV, where the numbering has to be read out of free text
 * ---------------------------------------------------------------- */

test('an episode code is found wherever the app happens to put it', () => {
  assert.deepEqual(readEpisodeCode('S2E7'), { season: 2, episode: 7 });
  assert.deepEqual(readEpisodeCode('Season 2, Episode 7'), { season: 2, episode: 7 });
  assert.deepEqual(readEpisodeCode('Season 2 · Episode 7'), { season: 2, episode: 7 });
  assert.deepEqual(readEpisodeCode('2x07'), { season: 2, episode: 7 });
  assert.deepEqual(readEpisodeCode('S2, Ep7'), { season: 2, episode: 7 });

  // Half of it is still worth having: a show with no seasons still has
  // episodes, and the card renders "E7" perfectly well.
  assert.deepEqual(readEpisodeCode('Episode 7'), { season: 0, episode: 7 });
  assert.deepEqual(readEpisodeCode('Season 2'), { season: 2, episode: 0 });

  assert.deepEqual(readEpisodeCode('Man City'), { season: 0, episode: 0 });
  assert.deepEqual(readEpisodeCode(''), { season: 0, episode: 0 });
  assert.deepEqual(readEpisodeCode(undefined), { season: 0, episode: 0 });
});

test('a year in a title is not mistaken for an episode number', () => {
  assert.deepEqual(readEpisodeCode('Blade Runner 2049'), { season: 0, episode: 0 });
});

test('the numbering is stripped out of whatever field carried it', () => {
  assert.equal(cleanTitle('Ted Lasso — Season 2, Episode 7'), 'Ted Lasso');
  assert.equal(cleanTitle('Season 2'), '');
  assert.equal(cleanTitle('S2E7'), '');
  assert.equal(cleanTitle('Man City'), 'Man City');
});

test('a show, an episode and its numbering, out of three loose fields', () => {
  // The arrangement Apple ships today: the show in the artist slot, the
  // numbering alongside it in the album slot.
  const parsed = parseEpisode({
    name: 'Man City',
    artist: 'Ted Lasso',
    album: 'Season 2, Episode 7',
    subtitle: '',
  });

  assert.equal(parsed.show, 'Ted Lasso');
  assert.equal(parsed.name, 'Man City');
  assert.equal(parsed.season, 2);
  assert.equal(parsed.episode, 7);
});

test('the same reading works when the fields are swapped around', () => {
  // Which slot carries what is Apple's business and has moved before, so
  // neither is assumed: the show is whichever field is not the numbering.
  const parsed = parseEpisode({
    name: 'Man City',
    artist: 'S2E7',
    album: 'Ted Lasso',
    subtitle: '',
  });

  assert.equal(parsed.show, 'Ted Lasso');
  assert.equal(parsed.season, 2);
  assert.equal(parsed.episode, 7);
});

test('a film has no show, and is not given one', () => {
  const snapshot = normalizeTv({
    channel: 'tv',
    state: 'playing',
    name: 'Blade Runner 2049',
    artist: '',
    album: '',
    subtitle: '',
    duration: 9780,
    position: 1200,
    hasArtwork: true,
    appId: `${APPLE_TV_APP_ID}_nzyj5cx40ttqa!App`,
  });

  assert.equal(snapshot.item.name, 'Blade Runner 2049');
  assert.equal(snapshot.item.show, '');
  assert.equal(snapshot.item.isEpisode, false);
  assert.equal(snapshot.item.mediaKind, 'movie');
});

test('an episode is an episode, and keys on what actually varies', () => {
  const raw = {
    channel: 'tv',
    state: 'playing',
    name: 'Man City',
    artist: 'Ted Lasso',
    album: 'Season 2, Episode 7',
    subtitle: '',
    duration: 2872,
    position: 300,
    hasArtwork: false,
    appId: `${APPLE_TV_APP_ID}_nzyj5cx40ttqa!App`,
  };

  const snapshot = normalizeTv(raw);
  assert.equal(snapshot.item.isEpisode, true);
  assert.equal(snapshot.item.show, 'Ted Lasso');
  assert.equal(snapshot.item.season, 2);
  assert.equal(snapshot.item.episode, 7);
  assert.equal(snapshot.item.mediaKind, 'TV show');

  // The next episode of the same show must not look like the same thing.
  const next = normalizeTv({ ...raw, name: 'Midnight Train', album: 'Season 2, Episode 8' });
  assert.notEqual(next.item.key, snapshot.item.key);
});

test('a repeated line for the same episode keys identically', () => {
  const raw = {
    channel: 'tv',
    state: 'playing',
    name: 'Man City',
    artist: 'Ted Lasso',
    album: 'Season 2, Episode 7',
    duration: 2872,
    position: 300,
  };
  assert.equal(normalizeTv(raw).item.key, normalizeTv({ ...raw, position: 340 }).item.key);
});
