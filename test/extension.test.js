import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { BridgeSource } from '../src/bridge.js';
import { setLevel } from '../src/log.js';

setLevel('error');

const BROWSER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser');
const read = (name) => fs.readFileSync(path.join(BROWSER_DIR, name), 'utf8');

/**
 * Chrome will not load an unpacked extension from the command line any more,
 * so the extension's own files are run here instead, against stubs of the two
 * APIs they actually use: the page's DOM and `chrome.*`. What Chrome does in
 * between -- injecting them -- is the only part not covered.
 */

/* MusicKit's own enum, read off music.apple.com. */
const PLAYBACK_STATES = {
  none: 0,
  loading: 1,
  playing: 2,
  paused: 3,
  stopped: 4,
  ended: 5,
  seeking: 6,
  waiting: 8,
  stalled: 9,
  completed: 10,
};

/**
 * A stand-in for the MusicKit the Apple web players expose. Shapes match the
 * real thing: `playbackDuration` in milliseconds, `currentPlaybackTime` in
 * seconds, artwork through `formatArtworkURL`.
 */
function fakeMusicKit({ item, playbackState, currentPlaybackTime = 0 }) {
  return {
    PlaybackStates: PLAYBACK_STATES,
    formatArtworkURL: (artwork, w, h) => String(artwork.url).replace('{w}', w).replace('{h}', h),
    getInstance: () => ({ nowPlayingItem: item, playbackState, currentPlaybackTime }),
  };
}

function runPageScript({ metadata, media, playbackState = 'none', href, musicKit }) {
  const posted = [];
  const listeners = [];

  const context = {
    MusicKit: musicKit,
    location: { href, origin: new URL(href).origin, hostname: new URL(href).hostname },
    navigator: { mediaSession: { metadata, playbackState } },
    document: {
      querySelectorAll: () => media,
      addEventListener: (type, fn) => listeners.push([type, fn]),
    },
    // The script reports on a timer; the immediate first call is what is
    // examined here, so the timer itself is a no-op.
    setInterval: () => 0,
    JSON,
    URL,
    console,
  };
  context.window = context;
  context.window.postMessage = (message) => posted.push(message);

  vm.runInNewContext(read('page.js'), context);
  return { posted, replay: () => listeners.forEach(([, fn]) => fn()) };
}

const METADATA = {
  title: 'Be Her',
  artist: 'Ella Langley',
  album: 'Hungover',
  artwork: [
    { src: 'https://is1-ssl.mzstatic.com/small/100x100bb.jpg', sizes: '100x100' },
    { src: 'https://is1-ssl.mzstatic.com/large/512x512bb.jpg', sizes: '512x512' },
  ],
};

const playingElement = (over = {}) => ({
  paused: false,
  ended: false,
  readyState: 4,
  currentTime: 64.2,
  duration: 191.5,
  ...over,
});

test('the page script reports what Apple Music is playing', () => {
  const { posted } = runPageScript({
    metadata: METADATA,
    media: [playingElement()],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
  });

  assert.equal(posted.length, 1);
  const { payload } = posted[0];
  assert.equal(payload.state, 'playing');
  assert.equal(payload.title, 'Be Her');
  assert.equal(payload.artist, 'Ella Langley');
  assert.equal(payload.album, 'Hungover');
  assert.equal(payload.position, 64.2);
  assert.equal(payload.duration, 191.5);
  assert.equal(payload.url, 'https://music.apple.com/ca/album/hungover/1?i=2');
  // The biggest artwork on offer, since the card renders it large.
  assert.equal(payload.artwork, 'https://is1-ssl.mzstatic.com/large/512x512bb.jpg');
});

test('a paused element is reported as paused', () => {
  const { posted } = runPageScript({
    metadata: METADATA,
    media: [playingElement({ paused: true })],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
  });
  assert.equal(posted[0].payload.state, 'paused');
});

test('a frame with nothing playing says nothing at all', () => {
  // Apple's pages are full of iframes; a silent one must not fight with the
  // frame that is actually playing.
  const { posted } = runPageScript({
    metadata: null,
    media: [],
    href: 'https://music.apple.com/ca/browse',
  });
  assert.equal(posted.length, 0);
});

test('media with no metadata yet is reported as stopped, not as a blank track', () => {
  const { posted } = runPageScript({
    metadata: null,
    media: [playingElement()],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
  });
  assert.equal(posted[0].payload.state, 'stopped');
  assert.equal(posted[0].payload.title, '');
});

test('a stopped tab stops repeating itself', () => {
  const { posted, replay } = runPageScript({
    metadata: null,
    media: [playingElement()],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
  });
  for (let i = 0; i < 10; i += 1) replay();
  // Three reports at most: enough to take the presence down, not a heartbeat.
  assert.ok(posted.length <= 3, `expected at most 3 reports, got ${posted.length}`);
});

test('MusicKit is preferred over the browser, which Chrome leaves empty', () => {
  const { posted } = runPageScript({
    // What Chrome actually publishes for Apple Music: no Media Session
    // metadata at all, so the tab title ends up where the song should be.
    metadata: null,
    media: [playingElement({ currentTime: 12, duration: 0 })],
    href: 'https://music.apple.com/us/playlist/top-all/pl.1',
    musicKit: fakeMusicKit({
      playbackState: PLAYBACK_STATES.playing,
      currentPlaybackTime: 64.2,
      item: {
        title: 'Be Her',
        artistName: 'Ella Langley',
        albumName: 'Hungover',
        artwork: { url: 'https://is1-ssl.mzstatic.com/a/{w}x{h}bb.jpg' },
        playbackDuration: 191_500,
      },
    }),
  });

  const { payload } = posted[0];
  assert.equal(payload.state, 'playing');
  assert.equal(payload.title, 'Be Her');
  assert.equal(payload.artist, 'Ella Langley');
  assert.equal(payload.album, 'Hungover');
  assert.equal(payload.position, 64.2);
  // Milliseconds there, seconds here.
  assert.equal(payload.duration, 191.5);
  assert.equal(payload.artwork, 'https://is1-ssl.mzstatic.com/a/1024x1024bb.jpg');
});

test('buffering is not reported as a stop', () => {
  for (const state of ['seeking', 'waiting', 'stalled']) {
    const { posted } = runPageScript({
      metadata: null,
      media: [],
      href: 'https://music.apple.com/us/playlist/top-all/pl.1',
      musicKit: fakeMusicKit({
        playbackState: PLAYBACK_STATES[state],
        currentPlaybackTime: 3,
        item: { title: 'Be Her', artistName: 'Ella Langley', playbackDuration: 191_500 },
      }),
    });
    assert.equal(posted[0].payload.state, 'playing', `${state} should still read as playing`);
  }
});

test('MusicKit with nothing queued falls through to the browser', () => {
  const { posted } = runPageScript({
    metadata: METADATA,
    media: [playingElement()],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
    musicKit: fakeMusicKit({ playbackState: PLAYBACK_STATES.none, item: null }),
  });

  assert.equal(posted[0].payload.title, 'Be Her');
  assert.equal(posted[0].payload.position, 64.2);
});

test('a paused MusicKit item is reported as paused', () => {
  const { posted } = runPageScript({
    metadata: null,
    media: [],
    href: 'https://music.apple.com/ca/album/hungover/1?i=2',
    musicKit: fakeMusicKit({
      playbackState: PLAYBACK_STATES.paused,
      currentPlaybackTime: 400,
      item: { title: 'Be Her', artistName: 'Ella Langley', playbackDuration: 191_500 },
    }),
  });

  const { payload } = posted[0];
  assert.equal(payload.state, 'paused');
  assert.equal(payload.title, 'Be Her');
  assert.equal(payload.duration, 191.5);
});

test('the content script relays only its own page-world messages', () => {
  const sent = [];
  const context = {
    chrome: { runtime: { sendMessage: (message) => sent.push(JSON.parse(JSON.stringify(message))) } },
    console,
  };
  context.window = context;
  context.addEventListener = (type, fn) => {
    if (type === 'message') context.__handler = fn;
  };

  const sandbox = vm.createContext(context);
  vm.runInContext(read('content.js'), sandbox);

  // Dispatched from inside the sandbox so that `event.source === window` means
  // there what it means in a real page -- the identity check is the point.
  vm.runInContext(
    `__handler({ source: window, data: { __yanpresence: 1, payload: { title: 'ok' } } });
     __handler({ source: window, data: { hello: 'from some other script' } });
     __handler({ source: {}, data: { __yanpresence: 1, payload: { title: 'another frame' } } });`,
    sandbox
  );

  assert.deepEqual(sent, [{ type: 'yanpresence-state', payload: { title: 'ok' } }]);
});

test('the service worker posts a report through to yanpresence', async () => {
  const bridge = new BridgeSource({ port: 0, staleMs: 60_000 });
  bridge.start();
  await once(bridge.server, 'listening');
  const port = bridge.server.address().port;

  const handlers = {};
  const context = {
    fetch,
    JSON,
    console,
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (handlers.message = fn) } },
      tabs: { onRemoved: { addListener: (fn) => (handlers.removed = fn) } },
      storage: { local: { get: async (defaults) => ({ ...defaults, port }) } },
    },
  };
  vm.runInNewContext(read('background.js'), context);

  const arrived = once(bridge, 'music');
  handlers.message(
    {
      type: 'yanpresence-state',
      payload: {
        url: 'https://music.apple.com/ca/album/hungover/1?i=2',
        state: 'playing',
        title: 'Be Her',
        artist: 'Ella Langley',
        album: 'Hungover',
        position: 12,
        duration: 191.5,
      },
    },
    { tab: { id: 7 }, frameId: 0 }
  );

  const [snapshot] = await arrived;
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.track.name, 'Be Her');

  // Closing the tab retracts it without waiting for the timeout.
  const cleared = once(bridge, 'music');
  handlers.removed(7);
  assert.equal((await cleared)[0].active, false);

  bridge.stop();
});
