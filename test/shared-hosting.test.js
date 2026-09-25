import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArtworkHost } from '../src/artwork.js';
import { DEFAULTS, PROJECT_ROOT, validateConfig } from '../src/config.js';

const service = {
  endpoint: 'https://uploads.example.test',
  publicBaseUrl: 'https://art.example.test',
  maxBytes: 1024,
};

function host(t, override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-shared-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = structuredClone(DEFAULTS);
  config.hosting = { mode: 'shared', shared: { ...service, ...override } };
  return new ArtworkHost({ config, cacheDir: dir });
}

test('fresh defaults provide both Discord applications without credentials', () => {
  assert.match(DEFAULTS.clientId, /^\d{17,20}$/);
  assert.match(DEFAULTS.tv.clientId, /^\d{17,20}$/);
  assert.equal(DEFAULTS.tv.enabled, true);
  assert.equal(DEFAULTS.hosting.mode, 'shared');
  assert.equal(DEFAULTS.hosting.s3.accessKeyId, '');
  assert.equal(DEFAULTS.hosting.s3.secretAccessKey, '');
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test('optional config preserves custom storage and IDs; old blank IDs use shared app', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, XDG_CACHE_HOME: dir, YANPRESENCE_CONFIG: file };
  for (const key of Object.keys(env)) {
    if (key.startsWith('YANPRESENCE_') && key !== 'YANPRESENCE_CONFIG') delete env[key];
  }
  const read = config => {
    fs.writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {loadConfig} from './src/config.js'; console.log(JSON.stringify(loadConfig()))"],
    { cwd: PROJECT_ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const custom = read({ clientId: '123456789012345678', tv: { enabled: false }, hosting: { mode: 's3', s3: { bucket: 'mine' } } });
  assert.equal(custom.clientId, '123456789012345678');
  assert.equal(custom.hosting.mode, 's3');
  assert.equal(custom.hosting.s3.bucket, 'mine');
  assert.equal(custom.tv.enabled, false);
  assert.equal(read({ clientId: '' }).clientId, DEFAULTS.clientId);
  assert.equal(read({}).hosting.mode, 'shared');
});

test('shared upload sends only image bytes and accepts the trusted public URL', async t => {
  const artwork = host(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://uploads.example.test/v1/artwork');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'image/png');
    assert.equal(options.headers['Content-Length'], '3');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.toString(), 'png');
    return Response.json({ url: 'https://art.example.test/shared/v1/hash.png' });
  });
  assert.equal(await artwork.upload(Buffer.from('png'), 'private-title.png', 'image/png'),
    'https://art.example.test/shared/v1/hash.png');
});

test('gateway failures and unexpected returned URLs are refused', async t => {
  const artwork = host(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(artwork.uploadViaShared(Buffer.from('x'), 'image/png'), /429/);
  for (const url of ['https://art.example.test.evil.test/a.png', 'http://art.example.test/a.png',
    'https://art.example.test/a.png?signature=secret', 'https://user@art.example.test/a.png', 'not a URL']) {
    fetch.mock.mockImplementation(async () => Response.json({ url }));
    await assert.rejects(artwork.uploadViaShared(Buffer.from('x'), 'image/png'));
  }
});

test('shared ceiling cannot be bypassed by custom maxBytes; oversize never uploads', async t => {
  const artwork = host(t);
  artwork.opts.maxBytes = 99999;
  assert.equal(artwork.byteBudget, 1024);
  artwork.opts.maxBytes = 512;
  assert.equal(artwork.byteBudget, 512);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not upload'); });
  await assert.rejects(artwork.uploadViaShared(Buffer.alloc(1025), 'image/png'), /limit/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('shared cache invalidates URLs from another bucket', t => {
  const artwork = host(t);
  artwork.put('anim:test', { url: 'https://old.example.test/test.avif', recipe: artwork.recipe() });
  assert.equal(artwork.getCached('anim:test'), null);
  artwork.put('anim:test', { url: 'https://art.example.test/shared/v1/test.avif', recipe: artwork.recipe() });
  assert.ok(artwork.getCached('anim:test'));
});

test('shared upload failures keep the normal static-artwork fallback', async t => {
  const artwork = host(t);
  t.mock.method(artwork, 'buildAnimated', async () => {
    throw new Error('Shared artwork upload failed (429)');
  });
  assert.equal(await artwork.animatedFor({ key: 'album', m3u8Url: 'https://example.test/motion.m3u8' }), null);
  assert.deepEqual(artwork.getCached('anim:album'), { miss: true });
});
