import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureHelper, helperPath, HELPER_NAME, LOADER, normalizeNowPlaying } from '../src/nowplaying.js';
import { mergeTvSnapshots, TvWatcher } from '../src/tv.js';

// What the helper printed for the first streamed episode it was tried on (2026-11-15).
const STREAMING = {
  state: 'playing',
  bundle: 'com.apple.TV',
  title: 'I’m Robbing the House on Christmas Eve While the Family’s at Mass',
  album: '12 12 12',
  artist: '',
  duration: 3720.672001,
  position: 237.347212414,
  mediaType: 'kMRMediaRemoteNowPlayingInfoTypeVideo',
  contentId: '0DF3D290-671D-4DEB-AA7B-D29BACFDD3FA',
};

test('a streamed episode becomes a TV snapshot: title is the episode, album the show', () => {
  const s = normalizeNowPlaying(STREAMING);
  assert.equal(s.active, true);
  assert.equal(s.state, 'playing');
  assert.equal(s.item.name, STREAMING.title);
  assert.equal(s.item.show, '12 12 12');
  assert.equal(s.item.isEpisode, true);
  assert.equal(s.item.duration, 3720.672001);
  assert.equal(s.item.position, 237.347212414);
  assert.equal(s.item.key, `meta:12 12 12\0${STREAMING.title}\x000\x000`);
});

test('a film has no album and is not an episode', () => {
  const s = normalizeNowPlaying({ ...STREAMING, title: 'Wolfs', album: '' });
  assert.equal(s.item.isEpisode, false);
  assert.equal(s.item.mediaKind, 'movie');
});

test('paused stays active; another app, nothing at all, or no title is inactive', () => {
  assert.equal(normalizeNowPlaying({ ...STREAMING, state: 'paused' }).active, true);
  assert.equal(normalizeNowPlaying({ ...STREAMING, bundle: 'com.apple.Music' }).active, false);
  assert.equal(normalizeNowPlaying({ state: 'none' }).active, false);
  assert.equal(normalizeNowPlaying({ state: 'none', bundle: 'com.apple.TV' }).active, false);
  assert.equal(normalizeNowPlaying({ ...STREAMING, title: '  ' }).active, false);
});

test('a position past the end is held to the duration', () => {
  assert.equal(normalizeNowPlaying({ ...STREAMING, position: 9999 }).item.position, 3720.672001);
});

const idle = (state) => ({ state, active: false, item: null, receivedAt: 1 });
const live = (name) => ({ state: 'playing', active: true, item: { name }, receivedAt: 2 });

test('merge: Apple Events win when they see something, Now Playing fills in when they do not', () => {
  assert.equal(mergeTvSnapshots(live('download'), live('stream')).item.name, 'download');
  assert.equal(mergeTvSnapshots(idle('stopped'), live('stream')).item.name, 'stream');
  assert.equal(mergeTvSnapshots(idle('closed'), idle('stopped')).state, 'closed');
  assert.equal(mergeTvSnapshots(null, live('stream')).item.name, 'stream');
  assert.equal(mergeTvSnapshots(null, null).active, false);
});

class FakeWatcher extends EventEmitter {
  constructor() { super(); this.started = 0; this.stopped = 0; }
  start() { this.started++; }
  stop() { this.stopped++; }
}

test('the combined watcher emits the merged view as either source reports', () => {
  const ae = new FakeWatcher();
  const np = new FakeWatcher();
  const tv = new TvWatcher({}, { appleEvents: ae, nowPlaying: np });
  const seen = [];
  tv.on('state', (s) => seen.push(s));
  tv.start();
  assert.equal(ae.started, 1);
  assert.equal(np.started, 1);

  ae.emit('state', idle('stopped'));            // TV.app streaming: Apple Events see nothing
  np.emit('state', normalizeNowPlaying(STREAMING));
  ae.emit('state', idle('stopped'));            // the next Apple Events tick must not clear it
  assert.deepEqual(seen.map((s) => s.active), [false, true, true]);
  assert.equal(seen[2].item.show, '12 12 12');

  np.emit('state', normalizeNowPlaying({ state: 'none', bundle: 'com.apple.TV' }));
  assert.equal(seen.at(-1).active, false);

  tv.stop();
  assert.equal(ae.stopped, 1);
  assert.equal(np.stopped, 1);
});

test('without a helper the combined watcher runs on Apple Events alone', async () => {
  const ae = new FakeWatcher();
  const tv = new TvWatcher({}, { appleEvents: ae, helper: async () => null });
  tv.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(tv.nowPlaying, null);
  ae.emit('state', idle('closed'));
  tv.stop();
});

test('inside the app bundle the helper is in Contents/Frameworks', () => {
  const root = path.join('/Applications', 'yanpresence.app', 'Contents', 'Resources', 'app');
  assert.equal(helperPath(root), path.join('/Applications', 'yanpresence.app', 'Contents', 'Frameworks', HELPER_NAME));
  assert.equal(helperPath('/src/yanpresence'), path.join('/src/yanpresence', '.build', 'nowplaying', HELPER_NAME));
});

test('the helper builds, loads into /usr/bin/perl, and reports', { skip: process.platform !== 'darwin' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-np-'));
  fs.mkdirSync(path.join(root, 'macos'));
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'macos', 'nowplaying.m'), path.join(root, 'macos', 'nowplaying.m'));
  const helper = await ensureHelper(root);
  assert.ok(helper && fs.existsSync(helper), 'the helper compiled');
  assert.equal(await ensureHelper(root), helper, 'a current build is reused');

  const child = spawn('/usr/bin/perl', ['-e', LOADER, helper],
    { env: { ...process.env, YP_POLL_MS: '300', YP_IDLE_POLL_MS: '300' } });
  // Five readings, so a helper that answers once and then goes quiet fails here: each unanswered request
  // costs a two-second wait, and five of them cannot fit in the time allowed.
  const started = Date.now();
  const lines = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`too few lines in 6 s: ${buf}`)); }, 6000);
    child.stdout.on('data', (d) => {
      buf += d;
      const got = buf.split('\n').filter(Boolean);
      if (got.length >= 6) { clearTimeout(t); child.kill(); resolve(got.map((l) => JSON.parse(l))); }
    });
  });
  assert.equal(lines[0].state, 'watcher-ready');
  for (const line of lines.slice(1)) assert.match(line.state, /^(none|playing|paused)$/);
  assert.ok(Date.now() - started < 6000);
  fs.rmSync(root, { recursive: true, force: true });
});
