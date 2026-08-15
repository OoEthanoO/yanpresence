import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAppleUrl, webMusicSnapshot } from '../src/webmedia.js';

/* ---------------------------------------------------------------- *
 * Which site is this
 * ---------------------------------------------------------------- */

test('classifies the Apple Music web player by host', () => {
  assert.equal(classifyAppleUrl('https://music.apple.com/library/playlist/p.XMrmp4b'), 'music');
  assert.equal(classifyAppleUrl('https://beta.music.apple.com/ca/album/1'), 'music');
});

test('the Apple TV web player is not a source', () => {
  // Apple TV is read from TV.app on macOS, where the show, season and episode
  // arrive as fields. A tv.apple.com tab is simply not ours.
  assert.equal(classifyAppleUrl('https://tv.apple.com/us/episode/x/umc.cmc.4vy'), null);
  assert.equal(classifyAppleUrl('https://tv.apple.com/us/movie/x/umc.cmc.1'), null);
});

test('classifies everything else as neither', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=1',
    'https://open.spotify.com/track/1',
    // The suffix trick: a host ending in the real one must not pass.
    'https://music.apple.com.evil.example/x',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(classifyAppleUrl(url), null, `${url} should not classify`);
  }
});

/* ---------------------------------------------------------------- *
 * Music
 * ---------------------------------------------------------------- */

// Captured verbatim from Firefox's MPRIS metadata while music.apple.com was
// playing: an artist array, no mpris:length, a file:// cover.
const FIREFOX_MEDIA = {
  title: 'Jaded',
  artist: ['Koe Wetzel & Ella Langley'],
  album: 'Jaded - Single',
  durationSec: 0,
  positionSec: 89,
  artUrl: 'file:///home/u/snap/firefox/common/.mozilla/firefox/firefox-mpris/14851_0.png',
  pageUrl: 'https://music.apple.com/library/playlist/p.XMrmp4bsObp2AQ2',
};

test('normalizes a web track into the Music.app snapshot shape', () => {
  const snapshot = webMusicSnapshot({ state: 'playing', media: FIREFOX_MEDIA });

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.state, 'playing');
  assert.equal(snapshot.track.name, 'Jaded');
  assert.equal(snapshot.track.artist, 'Koe Wetzel & Ella Langley');
  assert.equal(snapshot.track.album, 'Jaded - Single');
  assert.equal(snapshot.track.position, 89);
  // Firefox publishes no length; the catalog fills this in later.
  assert.equal(snapshot.track.duration, 0);
  assert.equal(snapshot.track.hasArtwork, true);
  assert.equal(snapshot.track.key, 'meta:Jaded\0Koe Wetzel & Ella Langley\0Jaded - Single');
  assert.equal(snapshot.track.albumKey, 'koe wetzel & ella langley\0jaded - single');
});

test('a web track is never mistaken for a local library file', async () => {
  const { isCatalogTrack } = await import('../src/music.js');
  const { track } = webMusicSnapshot({ state: 'playing', media: FIREFOX_MEDIA });
  // Otherwise the artwork path would try to pull a cover out of Music.app,
  // which does not exist on the platform this snapshot came from.
  assert.equal(isCatalogTrack(track), true);
});

test('a position past the end of a known duration is clamped', () => {
  const { track } = webMusicSnapshot({
    state: 'playing',
    media: { ...FIREFOX_MEDIA, durationSec: 100, positionSec: 140 },
  });
  assert.equal(track.position, 100);
});

test('stopped and closed states carry no track', () => {
  for (const state of ['stopped', 'closed']) {
    const snapshot = webMusicSnapshot({ state, media: FIREFOX_MEDIA });
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.track, null);
  }
});
