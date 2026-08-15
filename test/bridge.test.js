import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { BridgeSource } from '../src/bridge.js';
import { setLevel } from '../src/log.js';

setLevel('error');

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const REPORT = {
  url: 'https://music.apple.com/ca/album/hungover/1234?i=5678',
  state: 'playing',
  title: 'Be Her',
  artist: 'Ella Langley',
  album: 'Hungover',
  artwork: 'https://is1-ssl.mzstatic.com/image/thumb/x/512x512bb.jpg',
  position: 64.2,
  duration: 191.5,
  tabId: '7:0',
};

/** A bridge on an ephemeral port, plus the helpers to talk to it. */
async function withBridge(run, options = {}) {
  const source = new BridgeSource({ port: 0, staleMs: 200, ...options });
  source.start();
  await once(source.server, 'listening');
  const port = source.server.address().port;

  const post = (body, { origin = EXTENSION, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      body: JSON.stringify(body),
    });

  const next = (kind) => once(source, kind).then(([snapshot]) => snapshot);

  try {
    return await run({ source, port, post, next });
  } finally {
    source.stop();
  }
}

test('a report from the extension becomes a music snapshot', async () => {
  await withBridge(async ({ post, next }) => {
    const snapshot = next('music');
    const res = await post(REPORT);
    assert.equal(res.status, 200);

    const { track, state, active } = await snapshot;
    assert.equal(active, true);
    assert.equal(state, 'playing');
    assert.equal(track.name, 'Be Her');
    assert.equal(track.artist, 'Ella Langley');
    assert.equal(track.album, 'Hungover');
    assert.equal(track.duration, 191.5);
    assert.equal(track.position, 64.2);
    // An https cover is used as-is; nothing needs hosting.
    assert.equal(track.artUrl, REPORT.artwork);
  });
});

test('a tv.apple.com report is refused', async () => {
  await withBridge(async ({ post, source }) => {
    // Apple TV runs through TV.app on macOS; a browser tab playing it is not
    // a source here, and quietly accepting it would be worse than saying no.
    const res = await post({
      ...REPORT,
      url: 'https://tv.apple.com/us/episode/man-city/umc.cmc.4vy',
      title: 'Man City',
    });
    assert.equal(res.status, 400);
    assert.equal(source.tabs.size, 0);
  });
});

test('a report from a web page origin is refused', async () => {
  await withBridge(async ({ post, source }) => {
    const res = await post(REPORT, { origin: 'https://music.apple.com' });
    assert.equal(res.status, 403);
    assert.equal(source.tabs.size, 0);
  });
});

test('a report about a site that is not Apple is refused', async () => {
  await withBridge(async ({ post, source }) => {
    const res = await post({ ...REPORT, url: 'https://www.youtube.com/watch?v=1' });
    assert.equal(res.status, 400);
    assert.equal(source.tabs.size, 0);
  });
});

test('the site is taken from the URL, not from what the payload claims', async () => {
  await withBridge(async ({ post, source, next }) => {
    const snapshot = next('music');
    // A payload that labels itself is not evidence; the URL is.
    await post({ ...REPORT, site: 'something-else', kind: 'nonsense' });
    const { active } = await snapshot;
    assert.equal(active, true);
    assert.equal([...source.tabs.values()][0].kind, 'music');
  });
});

test('a token, when set, is required', async () => {
  await withBridge(
    async ({ post }) => {
      assert.equal((await post(REPORT)).status, 401);
      assert.equal(
        (await post(REPORT, { headers: { 'X-YanPresence-Token': 'sesame' } })).status,
        200
      );
    },
    { token: 'sesame' }
  );
});

test('a tab that goes quiet is dropped and the presence goes with it', async () => {
  await withBridge(async ({ post, next }) => {
    await post(REPORT);
    const gone = next('music');
    const snapshot = await gone;
    // staleMs is 200ms here; the sweeper publishes the empty state itself.
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.state, 'closed');
  });
});

test('a stopped report retracts that tab immediately', async () => {
  await withBridge(
    async ({ post, source, next }) => {
      await post(REPORT);
      assert.equal(source.tabs.size, 1);
      const cleared = next('music');
      await post({ ...REPORT, state: 'stopped' });
      assert.equal((await cleared).active, false);
      assert.equal(source.tabs.size, 0);
    },
    { staleMs: 60_000 }
  );
});

test('two tabs: the playing one holds the presence', async () => {
  await withBridge(
    async ({ post, next }) => {
      await post({ ...REPORT, tabId: '1:0', state: 'paused', title: 'Paused Song' });
      const snapshot = next('music');
      await post({ ...REPORT, tabId: '2:0', state: 'playing', title: 'Playing Song' });
      assert.equal((await snapshot).track.name, 'Playing Song');
    },
    { staleMs: 60_000 }
  );
});

test('health answers the extension options page', async () => {
  await withBridge(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: EXTENSION } });
    const body = await res.json();
    assert.equal(body.app, 'yanpresence');
  });
});

test('a malformed body is rejected without taking the bridge down', async () => {
  await withBridge(async ({ port, post }) => {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: EXTENSION },
      body: 'not json at all',
    });
    assert.equal(res.status, 400);
    assert.equal((await post(REPORT)).status, 200);
  });
});
