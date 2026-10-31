import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Tray, menuBarChannel, tellMenuBar } from '../src/tray.js';
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

test('the artist photo switch reports where it was left', () => {
  const seen = [];
  const tray = new Tray({ onQuit: () => {}, onArtistPhoto: (on) => seen.push(on), artistPhoto: true });

  tray.onData('artist-photo off\n');
  tray.onData('artist-photo on\nartist-photo off\n');
  assert.deepEqual(seen, [false, true, false]);
  // Kept, so an icon started again shows the switch where it was left rather
  // than where the app started.
  assert.equal(tray.artistPhoto, false);

  // Only the two exact lines count.
  tray.onData('artist-photo\nartist-photo maybe\n');
  assert.deepEqual(seen, [false, true, false]);

  tray.stop();
});

test('without a handler the switch is ignored, not fatal', () => {
  const tray = new Tray({ onQuit: () => {} });
  assert.doesNotThrow(() => tray.onData('artist-photo off\n'));
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

/*
 * macOS. There the icon is yanpresence.app, which is this process's parent
 * rather than its child, and the two talk over a socket it hands down. The
 * clicks arrive as the same lines the Windows icon prints; what goes back is
 * JSON. A real socket stands in for the app: the framing is the thing being
 * tested, and a socket splits writes the way the real one does.
 */

let pairs = 0;

async function menuBarPair(t) {
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\yanpresence-menu-test-${process.pid}-${(pairs += 1)}`
      : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yp-menu-')), 'channel');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(address, resolve));
  const accepted = new Promise((resolve) => server.once('connection', resolve));
  const node = net.connect(address);
  const app = await accepted;
  app.setEncoding('utf8');

  // What the app has been told, one parsed message per line.
  const heard = [];
  let partial = '';
  app.on('data', (chunk) => {
    partial += chunk;
    let index;
    while ((index = partial.indexOf('\n')) !== -1) {
      heard.push(JSON.parse(partial.slice(0, index)));
      partial = partial.slice(index + 1);
    }
  });

  t.after(() => {
    node.destroy();
    app.destroy();
    server.close();
    if (process.platform !== 'win32') fs.rmSync(path.dirname(address), { recursive: true, force: true });
  });
  return { node, app, heard };
}

/** Lets a socket write cross to the other end. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test('the menu bar app is told where the switch stands and where the log is', async (t) => {
  const { node, heard } = await menuBarPair(t);
  const tray = new Tray({
    channel: node,
    onQuit: () => {},
    onArtistPhoto: () => {},
    artistPhoto: false,
    logFile: '/tmp/yanpresence.log',
  });
  tray.start();
  await settle();

  assert.deepEqual(heard, [{ type: 'hello', logFile: '/tmp/yanpresence.log', artistPhoto: false }]);
  tray.stop();
});

test('without a handler the menu bar app is told to leave the switch out', async (t) => {
  const { node, heard } = await menuBarPair(t);
  const tray = new Tray({ channel: node, onQuit: () => {} });
  tray.start();
  await settle();

  assert.equal(heard[0].artistPhoto, null);
  tray.stop();
});

test("the menu bar app's clicks are read like the Windows icon's", async (t) => {
  const { node, app } = await menuBarPair(t);
  let quits = 0;
  const seen = [];
  const tray = new Tray({ channel: node, onQuit: () => (quits += 1), onArtistPhoto: (on) => seen.push(on) });
  tray.start();

  app.write('ready\nartist-photo off\nqu');
  await settle();
  assert.equal(quits, 0, 'half a quit is not a quit');
  app.write('it\n');
  await settle();

  assert.deepEqual(seen, [false]);
  assert.equal(quits, 1);
  tray.stop();
});

test('the status goes back over the socket, and only when it changes', async (t) => {
  const { node, heard } = await menuBarPair(t);
  const tray = new Tray({ channel: node, onQuit: () => {} });
  tray.start();

  tray.setStatus('yanpresence — Be Her', 'Listening to Be Her');
  tray.setStatus('yanpresence — Be Her', 'Listening to Be Her');
  tray.setStatus('yanpresence', 'Nothing playing');
  await settle();

  assert.deepEqual(
    heard.filter((m) => m.type === 'status'),
    [
      { type: 'status', tooltip: 'yanpresence — Be Her', line: 'Listening to Be Her' },
      { type: 'status', tooltip: 'yanpresence', line: 'Nothing playing' },
    ]
  );
  assert.equal(fs.existsSync(tray.statusFile), false, 'no status file on this path');
  tray.stop();
});

test('the menu bar app going away shuts the app down; stopping does not', async (t) => {
  {
    const { node, app } = await menuBarPair(t);
    let quits = 0;
    const tray = new Tray({ channel: node, onQuit: () => (quits += 1) });
    tray.start();

    // Quit, force quit or a crash: the socket closes however the app goes.
    app.destroy();
    await settle();
    assert.equal(quits, 1);
    tray.stop();
  }
  {
    const { node } = await menuBarPair(t);
    let quits = 0;
    const tray = new Tray({ channel: node, onQuit: () => (quits += 1) });
    tray.start();

    // The app's own shutdown closes the socket on the way out. That is not
    // the app going away, and must not start a second shutdown.
    tray.stop();
    await settle();
    assert.equal(quits, 0);
  }
});

test('the descriptor the app hands down is read from the environment', () => {
  assert.equal(menuBarChannel({ YANPRESENCE_MENU_FD: '3' }), 3);
  assert.equal(menuBarChannel({}), null, 'not started by the app');
  assert.equal(menuBarChannel({ YANPRESENCE_MENU_FD: '' }), null);
  assert.equal(menuBarChannel({ YANPRESENCE_MENU_FD: '1' }), null, 'never stdio');
  assert.equal(menuBarChannel({ YANPRESENCE_MENU_FD: 'three' }), null);
});

test('a failure to start reaches the app as one line, written at once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-fatal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'channel');
  const fd = fs.openSync(file, 'w');

  tellMenuBar({ type: 'fatal', message: 'clientId is malformed.\n\nThe full log is at:\n/x' }, fd);
  fs.closeSync(fd);

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 2, 'newlines inside the message stay escaped');
  assert.deepEqual(JSON.parse(lines[0]), {
    type: 'fatal',
    message: 'clientId is malformed.\n\nThe full log is at:\n/x',
  });

  assert.doesNotThrow(() => tellMenuBar({ type: 'fatal', message: 'x' }, null), 'no app, no-op');
});
