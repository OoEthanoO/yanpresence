// Public, narrowly scoped artwork ingestion. Cloudflare supplies bucket access
// through a binding; no storage credentials are sent to desktop clients.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const KEY_PREFIX = 'shared/v1/';
// A Worker isolate has a shared memory ceiling. Bound concurrent buffering as
// well as individual uploads; otherwise several valid large uploads exhaust it.
let bufferedUploadBytes = 0;
const TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function publicBaseUrl(env) {
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid public artwork URL');
  }
  return url.href.replace(/\/+$/, '');
}

function checkBindings(env) {
  if (!env.ARTWORK_BUCKET?.head || !env.ARTWORK_BUCKET?.put ||
      !env.UPLOAD_RATE_LIMITER?.limit || !env.SERVICE_RATE_LIMITER?.limit) {
    throw new Error('Missing storage or rate limit binding');
  }
  return publicBaseUrl(env);
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

// Raster signatures only: never accept HTML or SVG as hosted artwork. These
// checks establish the container type, not the provenance/content of an image.
export function detectImageType(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 &&
      bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' &&
      bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 &&
      view.getUint32(8) === 13 && ascii(bytes, 12, 16) === 'IHDR') {
    return 'image/png';
  }
  if (bytes.length >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    return 'image/jpeg';
  }
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) &&
      bytes.at(-1) === 0x3b) {
    return 'image/gif';
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' &&
      ascii(bytes, 8, 12) === 'WEBP' && view.getUint32(4, true) === bytes.length - 8 &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16))) {
    return 'image/webp';
  }
  if (bytes.length >= 24 && ascii(bytes, 4, 8) === 'ftyp') {
    const boxSize = view.getUint32(0);
    if (boxSize >= 24 && boxSize <= Math.min(bytes.length, 4096) && boxSize % 4 === 0) {
      // Both avif (still) and avis (animated) are AVIF brands. Inspect major
      // and compatible brands, skipping the minor-version field at offset 12.
      if (['avif', 'avis'].includes(ascii(bytes, 8, 12))) return 'image/avif';
      for (let offset = 16; offset < boxSize; offset += 4) {
        if (['avif', 'avis'].includes(ascii(bytes, offset, offset + 4))) return 'image/avif';
      }
    }
  }
  return null;
}

async function readBody(request, expectedLength) {
  if (!request.body) throw new UploadError(400, 'Artwork body is required.');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(expectedLength);
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expectedLength) {
        await reader.cancel();
        throw new UploadError(413, 'Artwork exceeds the declared upload size.');
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expectedLength) throw new UploadError(400, 'Artwork size does not match Content-Length.');
  return bytes;
}

async function upload(request, env, baseUrl) {
  if (env.UPLOADS_ENABLED !== 'true') throw new UploadError(503, 'Shared artwork uploads are temporarily paused.');
  // Desktop Node requests do not send Origin. This prevents drive-by browser
  // uploads, while the public endpoint still relies on limits for abuse control.
  if (request.headers.has('origin')) throw new UploadError(403, 'Browser uploads are not supported.');
  if (request.headers.has('content-encoding')) throw new UploadError(415, 'Encoded request bodies are not supported.');
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.has(contentType)) throw new UploadError(415, 'Supported artwork types: PNG, JPEG, GIF, WebP, AVIF.');
  const declaredLength = request.headers.get('content-length');
  if (!declaredLength || !/^[0-9]+$/.test(declaredLength)) {
    throw new UploadError(411, 'Content-Length is required.');
  }
  const length = Number(declaredLength);
  if (!Number.isSafeInteger(length) || length > MAX_UPLOAD_BYTES) throw new UploadError(413, 'Artwork must be at most 25 MiB.');
  if (length === 0) throw new UploadError(400, 'Artwork body is empty.');

  // CF-Connecting-IP is supplied by Cloudflare at the public Worker edge.
  // Never trust a client-selected installation ID or forwarded-for header.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) throw new UploadError(400, 'Cloudflare client address is required.');
  const clientLimit = await env.UPLOAD_RATE_LIMITER.limit({ key: `upload:${ip}` });
  if (!clientLimit.success) throw new UploadError(429, 'Too many artwork uploads. Retry in a minute.');
  const serviceLimit = await env.SERVICE_RATE_LIMITER.limit({ key: 'shared-artwork' });
  if (!serviceLimit.success) throw new UploadError(429, 'Shared artwork uploads are busy. Retry in a minute.');

  if (bufferedUploadBytes + length > MAX_UPLOAD_BYTES) {
    throw new UploadError(429, 'Shared artwork uploads are busy. Retry in a minute.');
  }
  bufferedUploadBytes += length;
  try {
    const bytes = await readBody(request, length);
    if (detectImageType(bytes) !== contentType) throw new UploadError(415, 'Artwork bytes do not match a supported image type.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const key = `${KEY_PREFIX}${hash}.${TYPES.get(contentType)}`;
    // head avoids unnecessary writes for repeated songs. The conditional put
    // handles concurrent first uploads without replacing immutable objects.
    if (!await env.ARTWORK_BUCKET.head(key)) {
      await env.ARTWORK_BUCKET.put(key, bytes, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: {
          contentType,
          cacheControl: 'public, max-age=31536000, immutable',
          contentDisposition: `inline; filename="${hash}.${TYPES.get(contentType)}"`,
        },
      });
    }
    return json({ url: `${baseUrl}/${key}` });
  } finally {
    bufferedUploadBytes -= length;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The client cannot supply a storage key, source URL, or deletion target.
    if (url.search || !['/health', '/v1/artwork'].includes(url.pathname)) {
      return json({ error: 'Not found.' }, 404);
    }
    const method = url.pathname === '/health' ? 'GET' : 'POST';
    if (request.method !== method) return json({ error: 'Method not allowed.' }, 405, { allow: method });
    try {
      const baseUrl = checkBindings(env);
      if (url.pathname === '/health') {
        const enabled = env.UPLOADS_ENABLED === 'true';
        return json({ ok: enabled, service: 'yanpresence-artwork', maxUploadBytes: MAX_UPLOAD_BYTES }, enabled ? 200 : 503);
      }
      return await upload(request, env, baseUrl);
    } catch (error) {
      if (error instanceof UploadError) {
        return json({ error: error.message }, error.status, error.status === 429 ? { 'retry-after': '60' } : {});
      }
      // Storage/configuration errors may include account information. Keep them
      // out of public responses and avoid logging uploaded artwork or IPs.
      return json({ error: 'Shared artwork service is temporarily unavailable.' }, 503);
    }
  },
};
