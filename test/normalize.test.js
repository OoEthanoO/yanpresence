import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLoose, normalizeTitle, artworkAt } from '../src/catalog.js';

/**
 * Normalization decides whether a Music.app track finds its catalog entry at
 * all. It fails silently in both directions: too strict and a track gets no
 * links or artwork, too loose and it gets someone else's.
 */

test('Latin diacritics fold to their base letters', () => {
  assert.equal(normalizeLoose('Beyoncé'), 'beyonce');
  assert.equal(normalizeLoose('Sigur Rós'), 'sigur ros');
  assert.equal(normalizeLoose('naïve'), 'naive');
  assert.equal(normalizeLoose('Motörhead'), 'motorhead');
});

test('typographic punctuation is folded to ASCII', () => {
  assert.equal(normalizeLoose('I’m Spent'), "i'm spent");
  assert.equal(normalizeLoose('Salt & Pepper'), 'salt and pepper');
  assert.equal(normalizeLoose('A  B'), 'a b', 'runs of separators collapse');
});

test('non-Latin scripts survive normalization', () => {
  // Reducing these to "" made `lookup()` treat the track as unsearchable and
  // skip it, so the song got no links and no animated artwork.
  assert.equal(normalizeLoose('Дискотека'), 'дискотека');
  assert.equal(normalizeLoose('춤'), '춤');
  assert.equal(normalizeLoose('中文歌'), '中文歌');
});

test('Japanese voicing marks are preserved, not stripped or split', () => {
  // NFKD splits ダ into タ + U+3099. Dropping the mark would turn "dansu" into
  // "tansu"; letting it fall through as a separator would split the word.
  assert.equal(normalizeLoose('ダンス'), 'ダンス');
  assert.equal(normalizeLoose('パン'), 'パン');
  assert.notEqual(
    normalizeLoose('ダンス'),
    normalizeLoose('タンス'),
    'voiced and unvoiced are different words'
  );
});

test('a wholly non-Latin track produces a searchable key', () => {
  // Mirrors the guard in lookup(): an all-empty key means "skip this track".
  const key = [normalizeTitle('춤'), normalizeLoose('베이비몬스터'), normalizeLoose('춤')].join('|');
  assert.ok(key.replace(/\|/g, '').trim(), 'must not be treated as unsearchable');
});

test('editorial decoration is stripped from titles', () => {
  assert.equal(normalizeTitle('Song (feat. X)'), 'song');
  assert.equal(normalizeTitle('Song - Remastered 2011'), 'song');
  assert.equal(normalizeTitle('Song (Deluxe Edition)'), 'song');
  assert.equal(normalizeTitle('Song - Radio Edit'), 'song');
});

test('meaningful parentheticals are kept', () => {
  // "(Live)" is part of the identity of a recording, not decoration.
  assert.equal(normalizeTitle('Song (Live)'), 'song live');
});

test('artwork templates are resized', () => {
  assert.equal(
    artworkAt('https://is1.mzstatic.com/img/{w}x{h}{c}.{f}', 1024),
    'https://is1.mzstatic.com/img/1024x1024bb.jpg'
  );
  // iTunes Search hands back a concrete small size instead of a template.
  assert.equal(
    artworkAt('https://is1.mzstatic.com/img/source/100x100bb.jpg', 1024),
    'https://is1.mzstatic.com/img/source/1024x1024bb.jpg'
  );
  assert.equal(artworkAt(null, 1024), null);
});
