import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import worker, { MAX_UPLOAD_BYTES, detectImageType } from '../worker/src/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const BASE_URL = 'https://images.example.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6T8AAAAASUVORK5CYII=', 'base64');

function environment() {
  const objects = new Map();
  const calls = { head: [], put: [], clientLimits: [], serviceLimits: [] };
  return {
    objects, calls,
    PUBLIC_BASE_URL: `${BASE_URL}/`,
    UPLOADS_ENABLED: 'true',
    UPLOAD_RATE_LIMITER: { async limit(value) { calls.clientLimits.push(value); return { success: true }; } },
    SERVICE_RATE_LIMITER: { async limit(value) { calls.serviceLimits.push(value); return { success: true }; } },
    ARTWORK_BUCKET: {
      async head(key) { calls.head.push(key); return objects.get(key) || null; },
      async put(key, bytes, options) {
        calls.put.push({ key, bytes, options });
        if (options.onlyIf.get('if-none-match') === '*' && objects.has(key)) return null;
        const stored = { bytes: Buffer.from(bytes), options };
        objects.set(key, stored);
        return stored;
      },
    },
  };
}

function request(body = PNG, overrides = {}) {
  const headers = new Headers({
    'content-type': 'image/png',
    'content-length': String(body.length),
    'cf-connecting-ip': '203.0.113.7',
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) if (value === null) headers.delete(key);
  return new Request('https://uploads.example.test/v1/artwork', { method: 'POST', headers, body });
}

test('shared gateway writes immutable content-addressed artwork without accepting a storage key', async () => {
  const env = environment();
  const result = await worker.fetch(request(), env);
  assert.equal(result.status, 200);
  const hash = createHash('sha256').update(PNG).digest('hex');
  const key = `shared/v1/${hash}.png`;
  assert.deepEqual(await result.json(), { url: `${BASE_URL}/${key}` });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(env.objects.get(key).bytes, PNG);
  const { options } = env.calls.put[0];
  assert.equal(options.onlyIf.get('if-none-match'), '*');
  assert.equal(options.httpMetadata.contentType, 'image/png');
  assert.equal(options.httpMetadata.cacheControl, 'public, max-age=31536000, immutable');
  assert.deepEqual(env.calls.clientLimits, [{ key: 'upload:203.0.113.7' }]);
  assert.deepEqual(env.calls.serviceLimits, [{ key: 'shared-artwork' }]);

  const duplicate = await worker.fetch(request(), env);
  assert.equal(duplicate.status, 200);
  assert.equal(env.calls.put.length, 1);
  assert.equal(env.objects.size, 1);
});

test('concurrent first uploads return the same URL and use conditional writes', async () => {
  const env = environment();
  // Simulate both requests seeing an absent key before either writes it.
  env.ARTWORK_BUCKET.head = async () => null;
  const responses = await Promise.all([worker.fetch(request(), env), worker.fetch(request(), env)]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(env.objects.size, 1);
  assert.equal(env.calls.put.length, 2);
  assert.ok(env.calls.put.every(({ options }) => options.onlyIf.get('if-none-match') === '*'));
});

test('rejects unsupported content, mismatched types, browser requests, encoding, and missing client IP before writes', async () => {
  for (const [body, headers, status] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { 'content-type': 'image/svg+xml' }, 415],
    [Buffer.from('<html>not artwork</html>'), {}, 415],
    [PNG, { 'content-type': 'image/jpeg' }, 415],
    [PNG, { origin: 'https://untrusted.example' }, 403],
    [PNG, { 'content-encoding': 'gzip' }, 415],
    [PNG, { 'cf-connecting-ip': null, 'x-forwarded-for': '203.0.113.1' }, 400],
  ]) {
    const env = environment();
    const result = await worker.fetch(request(body, headers), env);
    assert.equal(result.status, status);
    assert.equal(env.calls.put.length, 0);
    assert.equal(env.calls.head.length, 0);
  }
});

test('enforces declared and actual body sizes without touching storage', async () => {
  for (const [body, length, status] of [
    [PNG, null, 411],
    [PNG, 'invalid', 411],
    [PNG, '-1', 411],
    [PNG, String(MAX_UPLOAD_BYTES + 1), 413],
    [PNG, String(PNG.length - 1), 413],
    [PNG, String(PNG.length + 1), 400],
    [Buffer.alloc(0), '0', 400],
  ]) {
    const env = environment();
    const result = await worker.fetch(request(body, { 'content-length': length }), env);
    assert.equal(result.status, status, `length=${length}`);
    assert.equal(env.calls.head.length, 0);
    assert.equal(env.calls.put.length, 0);
  }
});

test('bounds a streamed body even if the caller understates its length', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(PNG.subarray(0, 10));
      controller.enqueue(PNG);
    },
    cancel() { cancelled = true; },
  });
  const req = new Request('https://uploads.example.test/v1/artwork', {
    method: 'POST', body, duplex: 'half',
    headers: { 'content-type': 'image/png', 'content-length': '20', 'cf-connecting-ip': '203.0.113.7' },
  });
  const env = environment();
  assert.equal((await worker.fetch(req, env)).status, 413);
  assert.equal(cancelled, true);
  assert.equal(env.calls.put.length, 0);
});

test('rate limit denial and limiter failure fail closed before reading or storing artwork', async () => {
  for (const binding of ['UPLOAD_RATE_LIMITER', 'SERVICE_RATE_LIMITER']) {
    const env = environment();
    env[binding].limit = async () => ({ success: false });
    const req = request();
    const limited = await worker.fetch(req, env);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(req.bodyUsed, false);
    assert.equal(env.calls.put.length, 0);
    env[binding].limit = async () => { throw new Error('secret internal detail'); };
    const failed = await worker.fetch(request(), env);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /secret internal/);
    assert.equal(env.calls.put.length, 0);
  }
});

test('caps concurrent buffering and releases the reservation after a failed stream', async () => {
  const env = environment();
  let signalRead;
  const startedReading = new Promise((resolve) => { signalRead = resolve; });
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  // A controllable request body keeps one maximum-size reservation active.
  const req = {
    url: 'https://uploads.example.test/v1/artwork', method: 'POST',
    headers: new Headers({
      'content-type': 'image/png', 'content-length': String(MAX_UPLOAD_BYTES),
      'cf-connecting-ip': '203.0.113.7',
    }),
    body: { getReader: () => ({
      async read() { signalRead(); return pendingRead; },
      releaseLock() {},
    }) },
  };
  const first = worker.fetch(req, env);
  await startedReading;
  assert.equal((await worker.fetch(request(), env)).status, 429);
  finishRead({ done: true });
  assert.equal((await first).status, 400);
  assert.equal((await worker.fetch(request(), env)).status, 200);
});

test('health and disabled/misconfigured service expose no credentials and reject uploads', async () => {
  const env = environment();
  const health = () => worker.fetch(new Request('https://uploads.example.test/health'), env);
  assert.deepEqual(await (await health()).json(), {
    ok: true, service: 'yanpresence-artwork', maxUploadBytes: MAX_UPLOAD_BYTES,
  });
  env.UPLOADS_ENABLED = 'false';
  assert.equal((await health()).status, 503);
  assert.equal((await worker.fetch(request(), env)).status, 503);
  env.UPLOADS_ENABLED = 'true';
  delete env.UPLOAD_RATE_LIMITER;
  assert.equal((await health()).status, 503);
  assert.equal((await worker.fetch(request(), env)).status, 503);
  env.UPLOAD_RATE_LIMITER = { limit: async () => ({ success: true }) };
  env.PUBLIC_BASE_URL = 'https://access:secret@images.example.test';
  const invalid = await health();
  assert.equal(invalid.status, 503);
  assert.doesNotMatch(await invalid.text(), /secret/);
  assert.equal(env.calls.put.length, 0);
});

test('does not expose arbitrary paths, query parameters, fetch, listing, deletion, or browser preflight', async () => {
  const env = environment();
  for (const [path, method, status] of [
    ['/v1/artwork?key=private.txt', 'POST', 404],
    ['/v1/artwork?url=https://example.test', 'POST', 404],
    ['/private.txt', 'GET', 404],
    ['/', 'GET', 404],
    ['/v1/artwork', 'GET', 405],
    ['/v1/artwork', 'DELETE', 405],
    ['/v1/artwork', 'OPTIONS', 405],
    ['/health', 'POST', 405],
  ]) {
    const result = await worker.fetch(new Request(`https://uploads.example.test${path}`, { method }), env);
    assert.equal(result.status, status, `${method} ${path}`);
  }
  assert.equal(env.calls.head.length, 0);
  assert.equal(env.calls.put.length, 0);
});

test('recognizes raster signatures including animated AVIF but rejects HEIC and malformed containers', () => {
  assert.equal(detectImageType(PNG), 'image/png');
  assert.equal(detectImageType(Buffer.from('474946383961010001008000003b', 'hex')), 'image/gif');
  assert.equal(detectImageType(Buffer.from('ffd8ffe00000ffd9', 'hex')), 'image/jpeg');
  const webp = Buffer.alloc(20);
  webp.write('RIFF', 0); webp.writeUInt32LE(12, 4); webp.write('WEBPVP8X', 8);
  assert.equal(detectImageType(webp), 'image/webp');
  webp.writeUInt32LE(5000, 4);
  assert.equal(detectImageType(webp), null);
  const avif = Buffer.alloc(24);
  avif.writeUInt32BE(24, 0); avif.write('ftypmif1', 4); avif.write('avif', 16);
  assert.equal(detectImageType(avif), 'image/avif');
  avif.write('avis', 16);
  assert.equal(detectImageType(avif), 'image/avif');
  avif.write('heic', 16);
  assert.equal(detectImageType(avif), null);
  avif.writeUInt32BE(999999, 0);
  assert.equal(detectImageType(avif), null);
  for (const bytes of [Buffer.alloc(0), PNG.subarray(0, 8), Buffer.from('GIF89a'), Buffer.from('<svg/>')]) {
    assert.equal(detectImageType(bytes), null);
  }
});

test('storage failures return generic unavailable responses', async () => {
  for (const method of ['head', 'put']) {
    const env = environment();
    env.ARTWORK_BUCKET[method] = async () => { throw new Error('account access token secret'); };
    const result = await worker.fetch(request(), env);
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /token|secret/);
  }
});
