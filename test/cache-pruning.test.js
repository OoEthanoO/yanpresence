import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppleCatalog } from '../src/catalog.js';
import { TvCatalog } from '../src/tvcatalog.js';

/**
 * Both on-disk caches are rewritten in full, synchronously, whenever something
 * new resolves -- on the playback path. Nothing used to remove expired
 * entries, so the file only ever grew and every one of those writes got a
 * little larger, carrying entries that can never be read again.
 *
 * Pruning is safe precisely because it is unobservable: the read paths already
 * refuse anything past its TTL.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-prune-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(contents));
  }
  return dir;
}

test('the music cache keeps live entries and drops expired ones', () => {
  const now = Date.now();
  const dir = fixture({
    'catalog.json': {
      'live|hit': { ts: now - DAY, result: { songUrl: 'x' } },
      'dead|hit': { ts: now - 31 * DAY, result: { songUrl: 'x' } },
      // Misses expire far sooner, so a lookup that failed this morning is
      // still worth remembering while one from yesterday is not.
      'live|miss': { ts: now - HOUR, result: null },
      'dead|miss': { ts: now - 7 * HOUR, result: null },
    },
  });

  const catalog = new AppleCatalog({ storefront: 'ca', cacheDir: dir, artworkSize: 1024 });
  assert.deepEqual(Object.keys(catalog.disk).sort(), ['live|hit', 'live|miss']);

  // Rewritten immediately, so the saving is real even for someone who never
  // plays anything unfamiliar again.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['live|hit', 'live|miss']);
});

test('the Apple TV cache prunes on the same terms', () => {
  const now = Date.now();
  const dir = fixture({
    'tv-catalog.json': {
      'ca|live': { ts: now - DAY, title: 'Live', id: 'a' },
      'ca|dead': { ts: now - 31 * DAY, title: 'Dead', id: 'b' },
    },
  });

  const catalog = new TvCatalog({ storefront: 'ca', cacheDir: dir, artworkSize: 1024 });
  assert.deepEqual(Object.keys(catalog.disk), ['ca|live']);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'tv-catalog.json'), 'utf8'))),
    ['ca|live']
  );
});

test('a cache with nothing expired is left alone', () => {
  const now = Date.now();
  const dir = fixture({ 'catalog.json': { 'a|b': { ts: now, result: { songUrl: 'x' } } } });
  const before = fs.statSync(path.join(dir, 'catalog.json')).mtimeMs;

  const catalog = new AppleCatalog({ storefront: 'ca', cacheDir: dir, artworkSize: 1024 });
  assert.deepEqual(Object.keys(catalog.disk), ['a|b']);
  assert.equal(
    fs.statSync(path.join(dir, 'catalog.json')).mtimeMs,
    before,
    'no needless write at startup'
  );
});

test('a corrupt or missing cache is survivable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-prune-'));
  // Missing entirely.
  assert.deepEqual(new AppleCatalog({ cacheDir: dir, artworkSize: 1024 }).disk, {});

  // Present but not JSON, and present but holding junk entries.
  fs.writeFileSync(path.join(dir, 'catalog.json'), 'not json at all');
  assert.deepEqual(new AppleCatalog({ cacheDir: dir, artworkSize: 1024 }).disk, {});

  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ a: null, b: 'string', c: 7 }));
  assert.deepEqual(new AppleCatalog({ cacheDir: dir, artworkSize: 1024 }).disk, {});
});
