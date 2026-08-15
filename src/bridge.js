import { EventEmitter } from 'node:events';
import http from 'node:http';

import log from './log.js';
import { classifyAppleUrl, webMusicSnapshot } from './webmedia.js';

const MAX_BODY_BYTES = 64 * 1024;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\//i;

/**
 * Loopback endpoint the companion browser extension posts playback state to.
 *
 * MPRIS can carry the same metadata without anything installed, but Chrome
 * publishes no page URL there, so nothing can tell Apple Music from any other
 * tab. The extension knows the URL because it runs *in* the page, and it also
 * reads the media element directly -- so position and duration are exact
 * rather than whatever the browser chose to forward.
 *
 * Emits `music` snapshots shaped exactly like Music.app's own.
 */
export class BridgeSource extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 8763, staleMs = 6000, token = '' } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.staleMs = staleMs;
    this.token = String(token || '');

    this.server = null;
    this.tabs = new Map(); // tabId -> { kind, state, media, at }
    this.sweeper = null;
    this.everReported = false;
  }

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(
          `Bridge port ${this.host}:${this.port} is already in use — another yanpresence is ` +
            'probably running. Set browser.bridge.port, or stop the other one.'
        );
      } else {
        log.error(`Bridge server error: ${err.message}`);
      }
      this.server?.close();
      this.server = null;
    });

    this.server.listen(this.port, this.host, () => {
      log.info(`Browser bridge listening on http://${this.host}:${this.port}`);
    });

    // A browser that quits, crashes or closes the tab stops posting without
    // saying goodbye, so silence has to expire on its own.
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.floor(this.staleMs / 2)));
    this.sweeper.unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.server?.close();
    this.server = null;
  }

  /** True once any extension has reported in, used by the source arbitration. */
  get connected() {
    return this.everReported && this.tabs.size > 0;
  }

  onRequest(req, res) {
    const origin = req.headers.origin;

    // An extension's own fetch carries its extension origin; a web page's
    // carries the site's. Only the former is allowed to drive the presence,
    // which is what stops any open tab from impersonating Apple Music.
    if (origin && !EXTENSION_ORIGIN.test(origin)) {
      reply(res, 403, { error: 'origin not allowed' }, origin);
      return;
    }

    if (req.method === 'OPTIONS') {
      reply(res, 204, null, origin);
      return;
    }

    const url = new URL(req.url, `http://${this.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      reply(res, 200, { ok: true, app: 'yanpresence', tabs: this.tabs.size }, origin);
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/state') {
      reply(res, 404, { error: 'not found' }, origin);
      return;
    }

    if (this.token && req.headers['x-yanpresence-token'] !== this.token) {
      reply(res, 401, { error: 'bad token' }, origin);
      return;
    }

    readBody(req)
      .then((body) => {
        const accepted = this.ingest(body);
        reply(res, accepted ? 200 : 400, { ok: accepted }, origin);
      })
      .catch((err) => {
        log.debug(`Bridge request failed: ${err.message}`);
        reply(res, 400, { error: err.message }, origin);
      });
  }

  /**
   * Takes one report from a tab. The site is decided from the URL here rather
   * than from whatever the payload claims to be, so a stray POST cannot label
   * itself Apple Music.
   */
  ingest(body) {
    if (!body || typeof body !== 'object') return false;

    const kind = classifyAppleUrl(body.url);
    if (!kind) {
      log.debug(`Bridge ignoring a report from ${body.url ?? 'an unknown URL'}`);
      return false;
    }

    const tabId = String(body.tabId ?? `${kind}:0`);
    const state = String(body.state ?? '').toLowerCase();

    if (state !== 'playing' && state !== 'paused') {
      this.tabs.delete(tabId);
    } else {
      this.tabs.set(tabId, {
        kind,
        state,
        at: Date.now(),
        media: {
          title: body.title,
          artist: body.artist,
          album: body.album,
          albumArtist: body.albumArtist,
          durationSec: Number(body.duration) || 0,
          positionSec: Number(body.position) || 0,
          artUrl: body.artwork,
          pageUrl: body.url,
          origin: `bridge:${tabId}`,
        },
      });
    }

    if (!this.everReported) {
      this.everReported = true;
      log.info('Browser extension connected');
    }

    this.publish();
    return true;
  }

  sweep() {
    const cutoff = Date.now() - this.staleMs;
    let dropped = false;
    for (const [tabId, entry] of this.tabs) {
      if (entry.at < cutoff) {
        this.tabs.delete(tabId);
        dropped = true;
        log.debug(`Bridge dropped stale tab ${tabId}`);
      }
    }
    if (dropped) this.publish();
  }

  publish() {
    const playing = this.pick();
    this.emit(
      'music',
      playing
        ? webMusicSnapshot({ state: playing.state, media: playing.media, receivedAt: Date.now() })
        : idle()
    );
  }

  /** A playing tab outranks a paused one left open in another window. */
  pick() {
    const tabs = [...this.tabs.values()];
    return (
      tabs.find((entry) => entry.state === 'playing') ??
      tabs.find((entry) => entry.state === 'paused') ??
      null
    );
  }
}

function idle() {
  return { state: 'closed', active: false, track: null, receivedAt: Date.now() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
  });
}

function reply(res, status, body, origin) {
  const headers = {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-yanpresence-token',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  res.end(json);
}
