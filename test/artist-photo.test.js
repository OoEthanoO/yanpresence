import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppleCatalog } from '../src/catalog.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/*
 * The badge is the artist's photo, and it rides along with the song search the
 * catalog already makes. These pin down the two ways that could quietly go
 * wrong: costing a request per song after all, and songs cached before the
 * upgrade never getting a photo until their entries aged out a month later.
 */

function catalogIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-photo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, catalog: new AppleCatalog({ storefront: 'us', cacheDir: dir, artworkSize: 1024 }) };
}

const TRACK = { name: 'Looks Can Kill', artist: 'IVE', album: 'Looks Can Kill - Single', duration: 171 };

// The shape amp-api answers `include[songs]=albums,artists` with: the artist
// arrives with its own artwork attached.
const SEARCH = {
  results: {
    songs: {
      data: [
        {
          id: '1',
          attributes: {
            name: 'Looks Can Kill',
            artistName: 'IVE',
            albumName: 'Looks Can Kill - Single',
            durationInMillis: 171_000,
            url: 'https://music.apple.com/us/song/1',
            artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/cover.jpg/{w}x{h}bb.jpg' },
          },
          relationships: {
            albums: { data: [{ id: '2', attributes: { url: 'https://music.apple.com/us/album/2' } }] },
            artists: {
              data: [
                {
                  id: '3',
                  attributes: {
                    url: 'https://music.apple.com/us/artist/3',
                    artwork: {
                      url: 'https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages221/ive.png/{w}x{h}bb.jpg',
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
};

test('the artist photo comes with the song search, at badge size', async (t) => {
  const { catalog } = catalogIn(t);
  t.mock.method(catalog.tokens, 'get', async () => 'token');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).includes('/search?')) return Response.json(SEARCH);
    return new Response('', { status: 404 }); // the album's motion artwork
  });

  const result = await catalog.lookup(TRACK);
  assert.equal(
    result.artistArtworkUrl,
    'https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages221/ive.png/512x512bb.jpg'
  );
  assert.equal(result.artworkUrl.endsWith('/1024x1024bb.jpg'), true, 'the cover keeps its own size');
  assert.deepEqual(
    requests.filter((url) => url.includes('/artists/')),
    [],
    'no request of its own'
  );
});

test('an artist with no photo is recorded as having none', async (t) => {
  const { catalog } = catalogIn(t);
  t.mock.method(catalog.tokens, 'get', async () => 'token');
  const noPhoto = structuredClone(SEARCH);
  delete noPhoto.results.songs.data[0].relationships.artists.data[0].attributes.artwork;
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/search?') ? Response.json(noPhoto) : new Response('', { status: 404 })
  );

  const result = await catalog.lookup(TRACK);
  // null rather than missing: missing is what marks an entry from before the
  // photo existed, and that gets looked up again.
  assert.equal(result.artistArtworkUrl, null);
  assert.ok('artistArtworkUrl' in result);
});

test("Apple's album-cover stand-in for an artist with no photo is not used", async (t) => {
  const { catalog } = catalogIn(t);
  t.mock.method(catalog.tokens, 'get', async () => 'token');
  // What Apple returns for an artist with no photo: one of their covers on a
  // plain backdrop, from the album artwork store, under the "ac" crop code.
  const standIn = structuredClone(SEARCH);
  standIn.results.songs.data[0].relationships.artists.data[0].attributes.artwork = {
    url: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/55/28/ee/mzi.cxaniyve.jpg/{w}x{h}ac.jpg',
    defaultCropCode: 'ac',
  };
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/search?') ? Response.json(standIn) : new Response('', { status: 404 })
  );

  assert.equal((await catalog.lookup(TRACK)).artistArtworkUrl, null);
});

test('a match cached before the photo existed is looked up again, and kept if that fails', async (t) => {
  const { dir, catalog } = catalogIn(t);
  const key = catalog.cacheKey(TRACK);
  const old = { songUrl: 'https://music.apple.com/us/song/1', artworkUrl: 'https://example.com/old.jpg' };
  catalog.disk[key] = { ts: Date.now(), result: old };

  // Failing: the match it already had is still served, and left on disk to be
  // tried again rather than traded for a miss.
  const resolve = t.mock.method(catalog, 'resolve', async () => null);
  assert.equal((await catalog.lookup(TRACK)).songUrl, old.songUrl);
  assert.deepEqual(catalog.disk[key].result, old);

  // Succeeding: replaced by a match that has the photo.
  resolve.mock.mockImplementation(async () => ({ ...old, artistArtworkUrl: 'https://example.com/ive.jpg' }));
  assert.equal((await catalog.lookup(TRACK)).artistArtworkUrl, 'https://example.com/ive.jpg');
  assert.equal(resolve.mock.callCount(), 2);

  // And from then on it is an ordinary cache hit, in this run and the next.
  const next = new AppleCatalog({ storefront: 'us', cacheDir: dir, artworkSize: 1024 });
  t.mock.method(next, 'resolve', async () => {
    throw new Error('should not be looked up again');
  });
  assert.equal((await next.lookup(TRACK)).artistArtworkUrl, 'https://example.com/ive.jpg');
});
