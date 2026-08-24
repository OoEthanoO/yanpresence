import test from 'node:test';
import assert from 'node:assert/strict';

import { TvUiaWatcher, parseSubtitle, toItem } from '../src/uia.js';
import { episodeCode } from '../src/tv.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/*
 * Real readings, captured live from Apple TV 1.1540 on Windows 11 with the
 * transport overlay on screen. The app publishes no media session at all, so
 * this tree is the only thing there is to read -- and unlike the media session
 * the Apple Music app publishes, the season, the episode and the episode title
 * arrive as separate labelled elements rather than as free text.
 */
const EPISODE = {
  channel: 'tv',
  state: 'paused',
  show: 'Trying',
  subtitle: 'S1, E1 · Nikki and Jason',
  position: 810.224,
  duration: 1867.324,
};

test('an episode reading becomes the item shape TV.app produces', () => {
  const item = toItem(EPISODE);

  assert.equal(item.show, 'Trying');
  assert.equal(item.name, 'Nikki and Jason');
  assert.equal(item.season, 1);
  assert.equal(item.episode, 1);
  assert.equal(item.isEpisode, true);
  assert.equal(item.mediaKind, 'TV show');
  assert.equal(item.duration, 1867.324);
  assert.equal(item.position, 810.224);
  assert.equal(episodeCode(item), 'S1E1');
});

test('the numbering is read in whatever way it is spelled', () => {
  for (const [subtitle, season, episode] of [
    ['S1, E1 · Nikki and Jason', 1, 1],
    ['S2, E7 · Man City', 2, 7],
    ['S10, E12 · Finale', 10, 12],
    ['Season 2, Episode 7 · Man City', 2, 7],
  ]) {
    const parsed = parseSubtitle(subtitle);
    assert.equal(parsed.season, season, subtitle);
    assert.equal(parsed.episode, episode, subtitle);
  }
});

test('an episode title containing a middle dot survives', () => {
  // Split once, not on every separator.
  assert.equal(parseSubtitle('S1, E4 · Best · Laid · Plans').name, 'Best · Laid · Plans');
});

test('a film is not given an episode title out of its own details', () => {
  // The same element carries "2016 · 1h 47m" for a film. Taking the text after
  // the separator would put "1h 47m" on the card as an episode name, so the
  // numbering is what licenses reading one at all.
  const item = toItem({ state: 'playing', show: 'Arrival', subtitle: '2016 · 1h 47m', position: 10, duration: 6420 });

  assert.equal(item.name, 'Arrival');
  assert.equal(item.show, '');
  assert.equal(item.isEpisode, false);
  assert.equal(item.mediaKind, 'movie');
  assert.equal(item.year, 2016);
});

test('a film with no subtitle at all still has a title', () => {
  const item = toItem({ state: 'playing', show: 'Arrival', subtitle: '', position: 10, duration: 6420 });
  assert.equal(item.name, 'Arrival');
  assert.equal(item.isEpisode, false);
});

/* ---------------------------------------------------------------- *
 * The overlay going away, which is most of the time
 * ---------------------------------------------------------------- */

function watcher() {
  // Constructed but never started: nothing here spawns a process.
  return new TvUiaWatcher({ pollIntervalMs: 1000 });
}

test('nothing seen yet, and nothing to show', () => {
  const w = watcher();
  const snapshot = w.toSnapshot({ state: 'hidden' });
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.item, null);
});

test('a hidden overlay carries the last reading forward, playing on', () => {
  const w = watcher();
  w.toSnapshot({ ...EPISODE, state: 'playing' });

  // Ten seconds later the overlay is gone, but the episode has not stopped.
  w.lastAt -= 10_000;
  const snapshot = w.toSnapshot({ state: 'hidden' });

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.state, 'playing');
  assert.equal(snapshot.item.name, 'Nikki and Jason');
  // Without this the progress bar would freeze the moment the overlay faded,
  // which is within seconds of pressing play.
  assert.ok(Math.abs(snapshot.item.position - (810.224 + 10)) < 0.5, snapshot.item.position);
});

test('a paused reading does not advance while hidden', () => {
  const w = watcher();
  w.toSnapshot(EPISODE); // paused
  w.lastAt -= 30_000;

  const snapshot = w.toSnapshot({ state: 'hidden' });
  assert.equal(snapshot.state, 'paused');
  assert.equal(snapshot.item.position, 810.224);
});

test('carrying forward stops at the end of the episode', () => {
  const w = watcher();
  w.toSnapshot({ ...EPISODE, state: 'playing' });

  // Long enough that the episode has certainly finished. Whatever is on screen
  // now is not what we were told about, so it is not worth guessing at.
  w.lastAt -= 2 * 1867.324 * 1000;
  const snapshot = w.toSnapshot({ state: 'hidden' });

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.item, null);
});

test('a reading long past its shelf life is dropped', () => {
  const w = watcher();
  w.toSnapshot({ ...EPISODE, state: 'paused', duration: 0 });

  // A paused reading never runs past its own duration, so without a shelf life
  // it would be carried forward for as long as the process lived.
  w.lastAt -= 5 * 60 * 60 * 1000;
  assert.equal(w.toSnapshot({ state: 'hidden' }).active, false);
});

test('the app closing clears what was being carried', () => {
  const w = watcher();
  w.toSnapshot({ ...EPISODE, state: 'playing' });

  assert.equal(w.toSnapshot({ state: 'closed' }).active, false);
  // And the next hidden line must not resurrect it.
  assert.equal(w.toSnapshot({ state: 'hidden' }).active, false);
});

test('a fresh reading replaces the one being carried', () => {
  const w = watcher();
  w.toSnapshot({ ...EPISODE, state: 'playing' });
  w.lastAt -= 10_000;

  const next = w.toSnapshot({
    ...EPISODE,
    state: 'playing',
    subtitle: 'S1, E2 · The Big Day',
    position: 12,
  });

  assert.equal(next.item.episode, 2);
  assert.equal(next.item.name, 'The Big Day');
  assert.equal(next.item.position, 12, 'the real position wins over the extrapolated one');
});
