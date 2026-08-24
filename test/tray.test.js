import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Tray } from '../src/tray.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/*
 * The two halves of the tray icon that are Node's problem: reading what the
 * icon says back, and writing what it should show. The icon itself lives in a
 * PowerShell child running a WinForms message loop -- there is nothing to
 * assert about a picture in the notification area from here -- but the
 * protocol between the two is ordinary code, and it is the code that has to
 * work for Quit to mean anything.
 */

test('a quit line from the icon shuts the app down', () => {
  let quits = 0;
  const tray = new Tray({ onQuit: () => (quits += 1) });

  tray.onData('ready\n');
  assert.equal(quits, 0, 'the handshake is not a quit');

  tray.onData('quit\n');
  assert.equal(quits, 1);

  tray.stop();
});

test('a line split across two reads is still one line', () => {
  let quits = 0;
  const tray = new Tray({ onQuit: () => (quits += 1) });

  // The pipe splits where it likes; a Quit that arrives in two pieces has to
  // still be a Quit, or the menu item silently does nothing.
  tray.onData('qu');
  assert.equal(quits, 0);
  tray.onData('it\nrea');
  assert.equal(quits, 1);
  tray.onData('dy\n');
  assert.equal(quits, 1);

  tray.stop();
});

test('anything else the icon says is ignored, not acted on', () => {
  let quits = 0;
  const tray = new Tray({ onQuit: () => (quits += 1) });
  tray.onData('\n\nsomething unexpected\nquitting\n');
  assert.equal(quits, 0, 'only an exact "quit" counts');
  tray.stop();
});

test('the status file carries a tooltip and a menu line', () => {
  const tray = new Tray({ onQuit: () => {} });
  tray.setStatus('yanpresence — Be Her', 'Listening to Be Her');

  const written = fs.readFileSync(tray.statusFile, 'utf8');
  assert.deepEqual(written.split('\n').slice(0, 2), [
    'yanpresence — Be Her',
    'Listening to Be Her',
  ]);

  tray.stop();
  assert.equal(fs.existsSync(tray.statusFile), false, 'and is cleaned up on the way out');
});

test('an unchanged status is not rewritten', () => {
  const tray = new Tray({ onQuit: () => {} });
  tray.setStatus('a', 'b');
  const first = fs.statSync(tray.statusFile).mtimeMs;

  // render() runs on every state change, which during a scrub is several times
  // a second, and the icon polls this file. Rewriting it each time would be
  // pure churn.
  tray.setStatus('a', 'b');
  assert.equal(fs.statSync(tray.statusFile).mtimeMs, first);

  tray.setStatus('a', 'c');
  assert.notEqual(fs.readFileSync(tray.statusFile, 'utf8'), 'a\nb\n');

  tray.stop();
});
