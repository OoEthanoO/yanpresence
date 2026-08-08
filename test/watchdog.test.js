import test from 'node:test';
import assert from 'node:assert/strict';

import { MusicWatcher } from '../src/music.js';

/**
 * The watchdog distinguishes "this machine was asleep" from "the watcher
 * wedged". Getting that wrong is not cosmetic: before it did, every wake from
 * sleep logged a spurious fault, which drowns out the real ones.
 *
 * These drive the real MusicWatcher but never spawn osascript -- the watchdog
 * only tests `child` for truthiness -- so they need neither Music.app nor
 * automation permission.
 */

const TICK_MS = 5000; // the watchdog's own interval, hardcoded in start()
const SETTLE_MS = TICK_MS + 1500; // long enough for exactly one tick

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
  const watcher = new MusicWatcher({ pollIntervalMs: 1000, idlePollIntervalMs: 5000 });
  // Enough of a ChildProcess for the watchdog (truthiness) and stop() (cleanup).
  watcher.spawnWatcher = () => {
    watcher.child = { pid: -1, removeAllListeners() {}, kill() {} };
  };

  const restarts = [];
  watcher.restart = () => restarts.push(Date.now());

  // log.warn goes to console.error; anything below `info` is filtered out
  // before it reaches us, so this captures exactly the reported faults.
  const warnings = [];
  const realError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));

  return {
    watcher,
    restarts,
    warnings,
    done() {
      console.error = realError;
      watcher.stop();
    },
  };
}

test('a suspended process is not reported as a wedged watcher', async () => {
  const h = harness();
  h.watcher.start();

  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + 600_000; // ten minutes of "sleep"
  try {
    await wait(SETTLE_MS);
  } finally {
    Date.now = realNow;
    h.done();
  }

  assert.deepEqual(h.warnings, [], 'a wake must not be logged as a fault');
  assert.equal(h.restarts.length, 1, 'the watcher is still cycled, just quietly');
});

test('a genuinely silent watcher is still reported and restarted', async () => {
  const h = harness();
  h.watcher.start();

  // Clock untouched: the watcher simply stopped emitting a minute ago.
  h.watcher.lastLineAt = Date.now() - 60_000;

  try {
    await wait(SETTLE_MS);
  } finally {
    h.done();
  }

  assert.equal(h.restarts.length, 1, 'a wedge must still be recovered from');
  assert.equal(h.warnings.length, 1, 'and must still be reported');
  assert.match(h.warnings[0], /silent for/);
});

test('a healthy watcher is left alone', async () => {
  const h = harness();
  h.watcher.start();

  // Emitting normally: lastLineAt keeps advancing.
  const beat = setInterval(() => {
    h.watcher.lastLineAt = Date.now();
  }, 500);

  try {
    await wait(SETTLE_MS);
  } finally {
    clearInterval(beat);
    h.done();
  }

  assert.deepEqual(h.warnings, [], 'no fault for a watcher that is working');
  assert.equal(h.restarts.length, 0, 'and no needless restart');
});
