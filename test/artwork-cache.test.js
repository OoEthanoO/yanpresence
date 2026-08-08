import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArtworkHost } from '../src/artwork.js';

/**
 * Cache entries are only reusable if both *how* the file was encoded and
 * *where* it was hosted still match the current configuration. Nothing on the
 * s3 path expires, so an entry that survives a hosting change is served
 * forever -- pointing at a bucket we no longer publish to.
 */

const BASE = 'https://pub-abc123.r2.dev';

function hostWith({ publicBaseUrl = BASE, mode = 's3', entries = {}, opts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-cache-test-'));
  fs.writeFileSync(path.join(dir, 'artwork.json'), JSON.stringify(entries));

  const config = {
    animatedArtwork: {
      enabled: true,
      format: 'avif',
      size: 1024,
      fps: 30,
      maxDurationSec: null,
      quality: 75,
      crf: 20,
      ...opts,
    },
    hosting: {
      mode,
      s3: { endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto', publicBaseUrl },
      command: mode === 'command' ? 'echo hi' : '',
      webhookUrl: '',
    },
    uploadLocalArtwork: true,
  };

  return new ArtworkHost({ config, cacheDir: dir });
}

/** An entry as `put()` would have written it, hosted under `base`. */
function entry(base, overrides = {}) {
  const host = hostWith({ publicBaseUrl: base });
  return {
    'anim:123': {
      url: `${base}/123-deadbeef.avif`,
      expiresAt: 0,
      kind: 'animated',
      recipe: host.recipe(),
      format: 'avif',
      width: 1024,
      height: 1024,
      ts: Date.now(),
      ...overrides,
    },
  };
}

test('an entry hosted under the current base is reused', () => {
  const host = hostWith({ entries: entry(BASE) });
  assert.ok(host.getCached('anim:123'), 'must not force a needless re-encode');
});

test('an entry hosted under a different base is discarded', () => {
  const host = hostWith({ entries: entry('https://pub-oldbucket.r2.dev') });
  assert.equal(host.getCached('anim:123'), null, 'a stale bucket URL must not be served');
});

test('a trailing slash on publicBaseUrl is not treated as a change', () => {
  const host = hostWith({ publicBaseUrl: `${BASE}/`, entries: entry(BASE) });
  assert.ok(host.getCached('anim:123'));
});

test('a prefix that is not a path boundary does not count as a match', () => {
  // `https://pub-abc123.r2.dev.evil.test/...` starts with the base string but
  // is a different host entirely.
  const host = hostWith({ entries: entry(`${BASE}.evil.test`) });
  assert.equal(host.getCached('anim:123'), null);
});

test('command hosting is exempt, since its URLs are arbitrary', () => {
  const host = hostWith({ mode: 'command', entries: entry('https://cdn.example.com') });
  assert.ok(host.getCached('anim:123'), 'we cannot validate what the command prints');
});

test('an encode-settings change still invalidates', () => {
  const host = hostWith({ entries: entry(BASE), opts: { crf: 30 } });
  assert.equal(host.getCached('anim:123'), null);
});

test('a recent failure is remembered, an old one is retried', () => {
  const fresh = hostWith({ entries: { 'anim:123': { miss: true, ts: Date.now() } } });
  assert.deepEqual(fresh.getCached('anim:123'), { miss: true }, 'do not retry every play');

  const stale = hostWith({
    entries: { 'anim:123': { miss: true, ts: Date.now() - 2 * 60 * 60 * 1000 } },
  });
  assert.equal(stale.getCached('anim:123'), null, 'a transient failure gets another go');
});
