import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCommon } from '../src/catalog.js';

/**
 * The noise strip that lets "Album (Deluxe Edition)" match "Album" also makes
 * different *editions* of an album tie at identical scores, leaving search
 * order to pick which edition's artwork and links land on the card. The
 * exact-name bonus resolves that toward whichever edition the player says is
 * playing. TIE_EPSILON in preferAlbumWithMotion is 0.02; the bonus has to
 * clear it or the motion tie-break can switch editions right back.
 */

const TIE_EPSILON = 0.02;

// What the catalog search returns: same song on two editions of the album.
const onPlain = { name: 'Dreams', artist: 'Fleetwood Mac', album: 'Greatest Hits', durationSec: 257 };
const onDeluxe = {
  name: 'Dreams',
  artist: 'Fleetwood Mac',
  album: 'Greatest Hits (Deluxe Edition)',
  durationSec: 257,
};

test('the edition the player reports wins the tie outright', () => {
  const track = { name: 'Dreams', artist: 'Fleetwood Mac', album: 'Greatest Hits', duration: 257 };
  const plain = scoreCommon(onPlain, track);
  const deluxe = scoreCommon(onDeluxe, track);
  assert.ok(plain > deluxe, 'exact album name outscores the noise-stripped match');
  assert.ok(plain - deluxe > TIE_EPSILON, 'by more than TIE_EPSILON, so motion cannot switch back');
});

test('playing the deluxe edition prefers the deluxe edition', () => {
  const track = {
    name: 'Dreams',
    artist: 'Fleetwood Mac',
    album: 'Greatest Hits (Deluxe Edition)',
    duration: 257,
  };
  assert.ok(scoreCommon(onDeluxe, track) - scoreCommon(onPlain, track) > TIE_EPSILON);
});

test('clean/explicit variants share the album name and still tie', () => {
  // The motion-artwork tie-break exists for exactly this case; the bonus must
  // not separate two candidates whose album names are identical.
  const track = { name: 'Song', artist: 'Artist', album: 'Album', duration: 200 };
  const clean = scoreCommon({ name: 'Song', artist: 'Artist', album: 'Album', durationSec: 200 }, track);
  const explicit = scoreCommon({ name: 'Song', artist: 'Artist', album: 'Album', durationSec: 200 }, track);
  assert.equal(clean, explicit);
});

test('no album from the player means no bonus for anyone', () => {
  const track = { name: 'Dreams', artist: 'Fleetwood Mac', album: '', duration: 257 };
  assert.equal(scoreCommon(onPlain, track), scoreCommon(onDeluxe, track));
});
