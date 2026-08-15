import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MprisSource, unwrap } from '../src/mpris.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/* Real busctl --json=short replies, captured on Ubuntu 26.04. */

const FIREFOX_METADATA = `{"type":"a{sv}","data":{"mpris:trackid":{"type":"o","data":"/org/mpris/MediaPlayer2/firefox"},"xesam:title":{"type":"s","data":"Jaded"},"xesam:album":{"type":"s","data":"Jaded - Single"},"xesam:artist":{"type":"as","data":["Koe Wetzel & Ella Langley"]},"mpris:artUrl":{"type":"s","data":"file:///home/u/.mozilla/firefox-mpris/14851_0.png"},"xesam:url":{"type":"s","data":"https://music.apple.com/library/playlist/p.XMrmp4bsObp2AQ2"}}}`;

// Chrome 151 publishes no xesam:url at all -- the reason the extension exists.
const CHROME_METADATA = `{"type":"a{sv}","data":{"mpris:artUrl":{"type":"s","data":"file:///tmp/.com.google.Chrome.MfvPSs"},"mpris:length":{"type":"x","data":30000000},"mpris:trackid":{"type":"o","data":"/org/chromium/MediaPlayer2/TrackList/Track27CA"},"xesam:album":{"type":"s","data":"Hungover"},"xesam:artist":{"type":"as","data":["Ella Langley"]},"xesam:title":{"type":"s","data":"Be Her"}}}`;

const FIREFOX_TV_METADATA = `{"type":"a{sv}","data":{"xesam:title":{"type":"s","data":"Man City"},"xesam:artist":{"type":"as","data":["Ted Lasso"]},"xesam:album":{"type":"s","data":"Season 2"},"mpris:length":{"type":"x","data":2872000000},"xesam:url":{"type":"s","data":"https://tv.apple.com/us/episode/man-city/umc.cmc.4vy"}}}`;

/**
 * A stand-in for busctl that answers from a fixture file. The source shells
 * out for everything it knows, so this exercises the argument handling, the
 * GVariant unwrapping and the classification exactly as they run for real.
 */
function fakeBusctl(players) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanpresence-mpris-'));
  const script = path.join(dir, 'busctl');
  const fixture = path.join(dir, 'players.json');

  fs.writeFileSync(fixture, JSON.stringify(players));
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const players = require(${JSON.stringify(fixture)});
const args = process.argv.slice(2);
if (args.includes('list')) {
  process.stdout.write(Object.keys(players).map((n) => n + ' 1 x y z').join('\\n') + '\\n');
  process.exit(0);
}
const name = args[3];
const player = players[name];
if (!player) { process.stderr.write('Failed to get property\\n'); process.exit(1); }
if (args.includes('Identity')) {
  process.stdout.write(JSON.stringify({ type: 's', data: player.identity ?? '' }) + '\\n');
  process.exit(0);
}
if (player.denied) { process.stderr.write('Access denied\\n'); process.exit(1); }
process.stdout.write(
  [player.metadata,
   JSON.stringify({ type: 's', data: player.status }),
   JSON.stringify({ type: 'x', data: player.positionUs ?? 0 })].join('\\n') + '\\n'
);
`,
    { mode: 0o755 }
  );

  return { script, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** One poll, with the source's own scheduling kept out of it. */
async function pollOnce(players, options = {}) {
  const { script, cleanup } = fakeBusctl(players);
  const source = new MprisSource({ busctlPath: script, ...options });
  const seen = {};
  source.on('music', (snapshot) => (seen.music = snapshot));
  try {
    await source.poll();
    return seen;
  } finally {
    source.stop();
    cleanup();
  }
}

test('unwraps busctl GVariant envelopes, including nested arrays', () => {
  assert.deepEqual(unwrap(JSON.parse(FIREFOX_METADATA)), {
    'mpris:trackid': '/org/mpris/MediaPlayer2/firefox',
    'xesam:title': 'Jaded',
    'xesam:album': 'Jaded - Single',
    'xesam:artist': ['Koe Wetzel & Ella Langley'],
    'mpris:artUrl': 'file:///home/u/.mozilla/firefox-mpris/14851_0.png',
    'xesam:url': 'https://music.apple.com/library/playlist/p.XMrmp4bsObp2AQ2',
  });
});

test('picks up Apple Music from a browser that publishes the page URL', async () => {
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.firefox.instance_1_131': {
      identity: 'Mozilla firefox_firefox',
      metadata: FIREFOX_METADATA,
      status: 'Playing',
      positionUs: 89_000_000,
    },
  });

  assert.equal(seen.music.active, true);
  assert.equal(seen.music.track.name, 'Jaded');
  assert.equal(seen.music.track.position, 89);
});

test('ignores a browser that publishes no page URL', async () => {
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.chromium.instance65074': {
      identity: 'Chrome',
      metadata: CHROME_METADATA,
      status: 'Playing',
      positionUs: 7_000_000,
    },
  });

  // Chrome is playing *something*, and nothing about it says Apple Music.
  // Reporting it anyway is how you end up announcing YouTube as Apple Music.
  assert.equal(seen.music.active, false);
  assert.equal(seen.music.state, 'closed');
});

test('an explicit player mapping overrides the missing URL', async () => {
  const seen = await pollOnce(
    {
      'org.mpris.MediaPlayer2.chromium.instance65074': {
        identity: 'Chrome',
        metadata: CHROME_METADATA,
        status: 'Playing',
        positionUs: 7_000_000,
      },
    },
    { players: { 'chromium.instance': 'music' } }
  );

  assert.equal(seen.music.active, true);
  assert.equal(seen.music.track.name, 'Be Her');
  assert.equal(seen.music.track.duration, 30);
});

test('a mapping of "ignore" keeps a player out even when it identifies itself', async () => {
  const seen = await pollOnce(
    {
      'org.mpris.MediaPlayer2.firefox.instance_1_131': {
        identity: 'Mozilla firefox_firefox',
        metadata: FIREFOX_METADATA,
        status: 'Playing',
      },
    },
    { players: { firefox: 'ignore' } }
  );

  assert.equal(seen.music.active, false);
});

test('a tv.apple.com tab is ignored, even though it identifies itself', async () => {
  // Apple TV is a TV.app source. A browser playing it is not half a source.
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.firefox.instance_1_2': {
      metadata: FIREFOX_TV_METADATA,
      status: 'Playing',
      positionUs: 61_000_000,
    },
  });

  assert.equal(seen.music.active, false);
});

test('a playing tab wins over a paused one on the same channel', async () => {
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.firefox.instance_1_1': {
      metadata: FIREFOX_METADATA,
      status: 'Paused',
    },
    'org.mpris.MediaPlayer2.chromium.instance2': {
      metadata: FIREFOX_METADATA.replace('Jaded"', 'Something Else"'),
      status: 'Playing',
    },
  });

  assert.equal(seen.music.state, 'playing');
  assert.equal(seen.music.track.name, 'Something Else');
});

test('a stopped player reports nothing playing', async () => {
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.firefox.instance_1_131': {
      metadata: FIREFOX_METADATA,
      status: 'Stopped',
    },
  });
  assert.equal(seen.music.active, false);
});

test('a player that refuses the query is skipped, not fatal', async () => {
  const seen = await pollOnce({
    'org.mpris.MediaPlayer2.firefox.instance_1_1': { denied: true, metadata: FIREFOX_METADATA },
    'org.mpris.MediaPlayer2.firefox.instance_1_2': {
      metadata: FIREFOX_METADATA,
      status: 'Playing',
    },
  });

  assert.equal(seen.music.active, true);
  assert.equal(seen.music.track.name, 'Jaded');
});

test('a missing busctl reports idle instead of throwing', async () => {
  const source = new MprisSource({ busctlPath: '/nonexistent/busctl' });
  const seen = {};
  source.on('music', (snapshot) => (seen.music = snapshot));
  await source.poll();
  source.stop();

  assert.equal(seen.music.active, false);
  assert.equal(source.available, false);
});
