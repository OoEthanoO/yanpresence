import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActivity } from '../src/presence.js';

/**
 * The activity payload is the whole product: Discord silently ignores a field
 * it dislikes rather than reporting an error, so the constraints encoded here
 * (length caps, the status_display_type mapping, the never-empty image slot)
 * only ever fail visibly, on someone's profile.
 */

const CONFIG = {
  activityName: 'Apple Music',
  statusDisplay: 'details',
  placeholderImageKey: 'blank',
  showSmallImage: true,
  smallImageKey: 'applemusic',
  linkButtons: false,
  artworkSize: 1024,
};

const TRACK = { name: 'Be Her', artist: 'Ella Langley', album: 'Dandelion', duration: 187 };

const build = (over = {}) =>
  buildActivity({
    track: TRACK,
    state: 'playing',
    catalog: null,
    artworkUrl: null,
    config: CONFIG,
    startedAt: Date.now(),
    ...over,
  });

test('the song goes on the status line, the artist underneath', () => {
  const a = build();
  assert.equal(a.details, 'Be Her');
  assert.equal(a.state, 'Ella Langley');
  assert.equal(a.status_display_type, 2, 'DETAILS -- "Listening to Be Her"');
});

test('statusDisplay selects which field Discord surfaces', () => {
  const at = (statusDisplay) => build({ config: { ...CONFIG, statusDisplay } }).status_display_type;
  assert.equal(at('name'), 0);
  assert.equal(at('state'), 1, 'what Spotify does -- shows the artist');
  assert.equal(at('details'), 2);
  assert.equal(at('nonsense'), 2, 'an unknown value falls back to the default');
});

test('the large image slot is never left empty', () => {
  // Empty renders as Discord's grey "?" placeholder, so a transparent portal
  // asset stands in instead.
  assert.equal(build().assets.large_image, 'blank');

  const tooLong = `https://example.com/${'a'.repeat(320)}.avif`;
  assert.ok(tooLong.length > 313);
  assert.equal(build({ artworkUrl: tooLong }).assets.large_image, 'blank');

  const ok = 'https://pub-abc.r2.dev/123.avif';
  assert.equal(build({ artworkUrl: ok }).assets.large_image, ok);
});

test('progress is shown while playing and withheld while paused', () => {
  const playing = build();
  assert.ok(playing.timestamps, 'a live progress bar');
  assert.equal(playing.timestamps.end - playing.timestamps.start, 187_000);

  // A frozen bar reads as a stalled stream.
  assert.equal(build({ state: 'paused' }).timestamps, undefined);
  assert.equal(build({ startedAt: null }).timestamps, undefined);
  assert.equal(
    build({ track: { ...TRACK, duration: 0 } }).timestamps,
    undefined,
    'no duration, no bar'
  );
});

test('single-character fields are padded, because Discord rejects them', () => {
  const a = build({ track: { ...TRACK, name: '4', artist: 'M' } });
  assert.ok(a.details.length >= 2, `details was ${JSON.stringify(a.details)}`);
  assert.ok(a.state.length >= 2, `state was ${JSON.stringify(a.state)}`);
});

test('links are attached only when they are usable', () => {
  const withUrls = build({
    catalog: {
      songUrl: 'https://music.apple.com/ca/song/1',
      artistUrl: 'https://music.apple.com/ca/artist/2',
      albumUrl: 'https://music.apple.com/ca/album/3',
    },
  });
  assert.equal(withUrls.details_url, 'https://music.apple.com/ca/song/1');
  assert.equal(withUrls.state_url, 'https://music.apple.com/ca/artist/2');
  assert.equal(withUrls.assets.large_url, 'https://music.apple.com/ca/album/3');

  const bad = build({
    catalog: {
      songUrl: 'javascript:alert(1)',
      artistUrl: `https://music.apple.com/${'x'.repeat(300)}`,
      albumUrl: null,
    },
  });
  assert.equal(bad.details_url, undefined, 'non-http is dropped');
  assert.equal(bad.state_url, undefined, 'over-long is dropped');
  assert.equal(bad.assets.large_url, undefined);
});

test('a missing artist still produces a valid payload', () => {
  const a = build({ track: { ...TRACK, artist: '', albumArtist: '' } });
  assert.equal(a.state, 'Unknown Artist');
});

test('the album is the hover text, and the small badge is opt-out', () => {
  assert.equal(build().assets.large_text, 'Dandelion');
  assert.equal(build().assets.small_image, 'applemusic');
  assert.equal(
    build({ config: { ...CONFIG, showSmallImage: false } }).assets.small_image,
    undefined
  );
});

test('a pause on the web player comes down fast; Music.app is given the benefit of the doubt', async () => {
  const { createSources } = await import('../src/sources.js');
  const { DEFAULTS } = await import('../src/config.js');

  const config = { ...DEFAULTS, clearDelayMs: 5000, pauseClearDelayMs: null };

  // Music.app blips `paused` between tracks, so it waits out clearDelayMs.
  const apple = createSources({ ...config, source: 'apple-apps' });
  assert.equal(apple.pauseDelayMs(config), 5000);

  // The web player says what it means, and the extension says it immediately.
  const web = createSources({ ...config, source: 'browser' });
  assert.equal(web.pauseDelayMs(config), 1500);

  // An explicit setting outranks both.
  const pinned = { ...config, pauseClearDelayMs: 250 };
  assert.equal(apple.pauseDelayMs(pinned), 250);
  assert.equal(web.pauseDelayMs(pinned), 250);
});
