import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import log from './log.js';

/**
 * Apple ships motion ("animated") album artwork as an HLS video stream, which
 * Discord's presence asset slot cannot render -- it renders images. So we
 * transcode the loop to an animated image and host it somewhere public.
 *
 * Format matters far more than anything else here. Measured on a real Apple
 * motion master (20.6s loop, 1000x1000, 24fps):
 *
 *   GIF        ~128 MB   (extrapolated; 5s alone is 15.6 MB)
 *   WebP q75      6.3 MB
 *   WebP q60      4.2 MB
 *   AVIF crf32    1.2 MB
 *
 * GIF is why full-length full-resolution animation looked impossible. With
 * WebP or AVIF the whole loop at full resolution fits inside even the smallest
 * upload limit, so nothing has to be truncated or downscaled.
 *
 * Discord's docs are explicit that *external URL* assets support GIF, animated
 * WebP and AVIF (uploaded portal assets cannot animate at all), which is why
 * everything here goes through a hosted URL.
 */

const FORMATS = {
  webp: { ext: 'webp', mime: 'image/webp' },
  avif: { ext: 'avif', mime: 'image/avif' },
  gif: { ext: 'gif', mime: 'image/gif' },
};

export class ArtworkHost {
  constructor({ config, cacheDir }) {
    this.opts = config.animatedArtwork;
    this.hosting = config.hosting;
    this.uploadLocalArtwork = config.uploadLocalArtwork;
    this.cacheFile = path.join(cacheDir, 'artwork.json');
    this.cache = this.loadCache();
    this.inflight = new Map();
    this.toolChecks = new Map();
  }

  get canHost() {
    if (this.hosting.mode === 'command') return Boolean(this.hosting.command);
    if (this.hosting.mode === 's3') {
      const c = this.hosting.s3 ?? {};
      return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey && c.publicBaseUrl);
    }
    return Boolean(this.hosting.webhookUrl);
  }

  get animatedEnabled() {
    return this.opts.enabled && this.canHost;
  }

  get format() {
    return FORMATS[this.opts.format] ? this.opts.format : 'webp';
  }

  /**
   * Byte ceiling for an upload. `null` means unlimited, which is the point of
   * command hosting -- your own storage has no Discord-imposed cap.
   */
  get byteBudget() {
    if (this.opts.maxBytes != null) return this.opts.maxBytes;
    // Only Discord's webhook imposes a cap. Your own storage does not, so
    // nothing needs refitting and full quality is kept by default.
    return this.hosting.mode === 'webhook' ? 9 * 1024 * 1024 : null;
  }

  loadCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveCache() {
    // Written immediately, not debounced. Entries here cost seconds of
    // download and encoding to reproduce, and a debounced write on an unref'd
    // timer is simply lost if the process exits before it fires. This runs
    // once per album, so the write is free by comparison.
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    } catch (err) {
      log.debug(`Could not persist artwork cache: ${err.message}`);
    }
  }

  getCached(key) {
    const entry = this.cache[key];
    if (!entry) return null;
    if (entry.miss) {
      // Short enough that a transient failure -- a dropped HLS segment, a
      // flaky upload -- gets another go on the next play, long enough that a
      // genuinely broken album is not retried on every repeat.
      return Date.now() - entry.ts < 60 * 60 * 1000 ? { miss: true } : null;
    }
    // Re-encoding after a settings change would otherwise need a manual purge.
    if (entry.recipe && entry.recipe !== this.recipe()) return null;
    // Refresh an hour early rather than serving a URL that expires mid-song.
    if (entry.expiresAt && entry.expiresAt - 60 * 60 * 1000 < Date.now()) return null;
    return entry;
  }

  /** Identifies the encode settings a cache entry was produced with. */
  recipe() {
    const o = this.opts;
    return [this.format, o.size, o.fps, o.maxDurationSec ?? 'full', o.quality, o.crf].join('/');
  }

  put(key, value) {
    this.cache[key] = { ...value, ts: Date.now() };
    this.saveCache();
  }

  /**
   * Returns a hosted animated artwork URL for the album, or null. Never throws.
   * Deduplicates concurrent requests for the same album.
   */
  async animatedFor({ key, m3u8Url }) {
    if (!this.animatedEnabled || !m3u8Url || !key) return null;

    const cached = this.getCached(`anim:${key}`);
    if (cached) return cached.miss ? null : cached.url;

    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = this.buildAnimated(key, m3u8Url)
      .catch((err) => {
        log.warn(`Animated artwork failed for ${key}: ${err.message}`);
        this.put(`anim:${key}`, { miss: true, reason: err.message });
        return null;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async buildAnimated(key, m3u8Url) {
    const format = this.format;
    const spec = FORMATS[format];

    await this.requireTools(format);

    const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yanpresence-'));
    const out = path.join(workdir, `artwork.${spec.ext}`);

    try {
      // Pull the HLS stream down first and check we actually got all of it.
      // ffmpeg exits 0 on a truncated HLS read, so encoding straight from the
      // URL can silently produce a few seconds of a twenty-second loop.
      const source = await this.fetchSource(m3u8Url, workdir);

      let size = this.opts.size;
      let quality = this.opts.quality;
      let crf = this.opts.crf;
      const budget = this.byteBudget;

      let bytes = 0;
      let encodedSec = 0;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = Date.now();
        await this.encode({ input: source.file, workdir, out, format, size, quality, crf });
        ({ size: bytes } = await fsp.stat(out));

        // Report a short encode but keep it: a slightly clipped loop still
        // beats no animation, and the source fetch above is where a genuinely
        // truncated stream gets caught and retried.
        encodedSec = await this.probeDuration(out);
        if (source.durationSec && encodedSec && encodedSec < source.durationSec * 0.9) {
          log.warn(
            `Encode produced ${encodedSec.toFixed(1)}s of a ${source.durationSec.toFixed(1)}s loop`
          );
        }

        log.debug(
          `Encoded ${key} as ${format} ${size}px/${this.opts.fps}fps/${encodedSec.toFixed(1)}s -> ` +
            `${(bytes / 1048576).toFixed(2)}MB in ${((Date.now() - started) / 1000).toFixed(1)}s`
        );

        if (!budget || bytes <= budget) break;

        // "skip" means the artwork is worth having only at full fidelity:
        // rather than quietly shipping a degraded encode, give up and let the
        // caller fall back to the static 1000x1000 cover.
        if (this.opts.onOversize === 'skip') {
          throw new Error(
            `${format} is ${(bytes / 1048576).toFixed(1)}MB, over the ${(budget / 1048576).toFixed(0)}MB ` +
              `budget, and onOversize is "skip" — not degrading it. Use hosting.mode "command" ` +
              `with maxBytes null to lift the cap entirely.`
          );
        }

        if (attempt === 2) {
          throw new Error(`${format} still ${(bytes / 1048576).toFixed(1)}MB after 3 attempts`);
        }

        // Spend quality before resolution. The whole point of moving off GIF
        // was to keep the full loop at full size, so shrinking the canvas is
        // the last resort, not the first.
        if (attempt === 0 && format !== 'gif') {
          quality = Math.max(45, quality - 18);
          crf = Math.min(52, crf + 10);
          log.debug(`Over budget, retrying at ${format === 'avif' ? `crf ${crf}` : `q${quality}`}`);
          continue;
        }

        // Bytes track pixel area, so aim straight at the budget rather than
        // stepping down blindly -- every retry is another full encode.
        const ratio = Math.sqrt(budget / bytes) * 0.92;
        const next = Math.max(256, Math.round((size * ratio) / 2) * 2);
        if (next >= size) break;
        size = next;
        log.debug(`Still over budget, retrying at ${size}px`);
      }

      const buffer = await fsp.readFile(out);
      const url = await this.upload(buffer, `${sanitize(key)}.${spec.ext}`, spec.mime);
      this.put(`anim:${key}`, {
        url,
        expiresAt: expiryOf(url),
        kind: 'animated',
        recipe: this.recipe(),
        // Recorded so `--cache` can show what is actually hosted.
        format,
        width: size,
        height: size,
        fps: this.opts.fps,
        durationSec: Number(encodedSec.toFixed(2)),
        bytes,
      });
      log.info(
        `Hosted animated artwork for ${key} — ${format} ${size}x${size}, ` +
          `${encodedSec.toFixed(1)}s @ ${this.opts.fps}fps, ${(buffer.length / 1048576).toFixed(1)}MB`
      );
      return url;
    } finally {
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ *
   * Source acquisition
   * ------------------------------------------------------------------ */

  /**
   * Downloads the HLS loop to a local file and confirms it is complete.
   *
   * This exists because ffmpeg returns exit status 0 for a truncated HLS read:
   * a dropped segment surfaces only as "Stream ends prematurely" on stderr,
   * and you silently get four seconds of a twenty-second loop. Comparing the
   * playlist's advertised duration against what actually landed is the only
   * reliable check, so short reads are retried rather than shipped.
   */
  /**
   * Picks one media playlist out of Apple's master playlist.
   *
   * Handing ffmpeg the master is not safe: Apple lists trick-play
   * (`EXT-X-I-FRAME-STREAM-INF`) variants alongside the real ones, and ffmpeg
   * can end up interleaving segments across variants — which shows up as
   * `Invalid NAL unit size` and a stream that simply stops early. Choosing the
   * variant ourselves also means we fetch the resolution we actually want
   * instead of whatever ffmpeg picks.
   */
  async selectVariant(masterUrl, targetSize) {
    let text;
    try {
      const res = await fetch(masterUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return masterUrl;
      text = await res.text();
    } catch {
      return masterUrl;
    }

    if (!text.includes('#EXT-X-STREAM-INF')) return masterUrl;

    const lines = text.split('\n').map((l) => l.trim());
    const variants = [];

    for (let i = 0; i < lines.length; i += 1) {
      // Note the trailing colon: this deliberately does not match
      // #EXT-X-I-FRAME-STREAM-INF, whose URI is inline in the tag anyway.
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;

      const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
      const bandwidth = /[^-]BANDWIDTH=(\d+)/.exec(lines[i]);

      let uri = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j] || lines[j].startsWith('#')) continue;
        uri = lines[j];
        break;
      }
      if (!uri) continue;

      variants.push({
        width: resolution ? Number(resolution[1]) : 0,
        bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
        url: new URL(uri, masterUrl).toString(),
      });
    }

    if (!variants.length) return masterUrl;

    // Smallest variant that still meets the target, else the largest there is.
    // Ties on resolution go to the higher bitrate.
    variants.sort((a, b) => a.width - b.width || a.bandwidth - b.bandwidth);
    const atLeastTarget = variants.filter((v) => v.width >= targetSize);
    const chosen = atLeastTarget.length
      ? atLeastTarget.filter((v) => v.width === atLeastTarget[0].width).pop()
      : variants[variants.length - 1];

    log.debug(
      `Selected ${chosen.width}px variant from ${variants.length} ` +
        `(target ${targetSize}px, ladder tops out at ${variants[variants.length - 1].width}px)`
    );
    return chosen.url;
  }

  /**
   * Downloads an HLS media playlist by fetching its segments directly.
   *
   * ffmpeg's HLS demuxer mishandles Apple's byte-range playlists — the ones
   * where every `#EXTINF` is an `#EXT-X-BYTERANGE` into a single .mp4. It
   * reads the first range and stops, which looks exactly like a 5-second loop
   * that should have been 20. Collecting the distinct URIs in playlist order
   * and concatenating them sidesteps the demuxer entirely, and covers all
   * three layouts: byte-range (one URI, fetched whole), fMP4 with a separate
   * init segment, and plain MPEG-TS.
   *
   * Returns true if it wrote something, false if this is not a media playlist.
   */
  async downloadSegments(playlistUrl, outFile) {
    let text;
    try {
      const res = await fetch(playlistUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return false;
      text = await res.text();
    } catch {
      return false;
    }

    if (!text.includes('#EXTINF')) return false;

    const seen = new Set();
    const urls = [];
    const add = (uri) => {
      const absolute = new URL(uri, playlistUrl).toString();
      if (seen.has(absolute)) return;
      seen.add(absolute);
      urls.push(absolute);
    };

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/.exec(line);
        if (uri) add(uri[1]);
      } else if (line && !line.startsWith('#')) {
        add(line);
      }
    }

    if (!urls.length) return false;

    const handle = await fsp.open(outFile, 'w');
    try {
      for (const url of urls) {
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`segment ${res.status}`);
        await handle.write(Buffer.from(await res.arrayBuffer()));
      }
    } finally {
      await handle.close();
    }

    log.debug(`Downloaded ${urls.length} segment file(s) directly`);
    return true;
  }

  async fetchSource(m3u8Url, workdir) {
    const file = path.join(workdir, 'source.mp4');
    const variantUrl = await this.selectVariant(m3u8Url, this.opts.size);
    const advertised = await this.probeDuration(variantUrl);
    const wanted = this.opts.maxDurationSec
      ? Math.min(this.opts.maxDurationSec, advertised || Infinity)
      : advertised;

    // Preferred path: fetch segments ourselves, bypassing ffmpeg's HLS demuxer.
    const raw = path.join(workdir, 'raw.bin');
    if (await this.downloadSegments(variantUrl, raw).catch(() => false)) {
      const rawSec = await this.probeDuration(raw);
      if (rawSec > 0 && (!wanted || rawSec >= wanted * 0.98)) {
        // The playlist, not the file, defines the loop. A byte-range playlist
        // points at ranges inside a larger .mp4 -- fetching that file whole can
        // hand back well over what the playlist actually references (one album
        // here: an 18.7s file for an 8.67s loop). Trim to the advertised
        // duration so we encode the intended loop and nothing more.
        const limit = Number.isFinite(wanted) && wanted > 0 ? ['-t', String(wanted)] : this.durationArgs();
        await this.runFfmpeg([...limit, '-i', raw, '-map', '0:v:0', '-c', 'copy', file]).catch(() => {});

        const got = await this.probeDuration(file);
        if (got > 0) {
          log.debug(`Fetched ${got.toFixed(1)}s loop via direct segment download`);
          return { file, durationSec: got };
        }
      }
      log.debug(`Direct segment download gave ${rawSec.toFixed(1)}s; falling back to ffmpeg`);
    }

    let best = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.runFfmpeg([
        // HLS segments are individual HTTP requests; without these a single
        // transient failure ends the read early.
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_delay_max', '5',
        ...this.durationArgs(),
        '-i', m3u8Url,
        '-map', '0:v:0',
        '-c', 'copy',
        file,
      ]).catch((err) => {
        log.debug(`Source fetch attempt ${attempt + 1} errored: ${err.message}`);
      });

      const got = await this.probeDuration(file);
      best = Math.max(best, got);

      if (!wanted || !Number.isFinite(wanted)) {
        if (got > 0) return { file, durationSec: got };
      } else if (got >= wanted * 0.98) {
        log.debug(`Fetched full ${got.toFixed(1)}s loop`);
        return { file, durationSec: got };
      }

      log.debug(
        `Short read: got ${got.toFixed(1)}s of ${Number(wanted).toFixed(1)}s ` +
          `(attempt ${attempt + 1}/3)`
      );
    }

    if (best <= 0) throw new Error('could not download the motion artwork stream');

    // Better a complete-as-we-could-get loop than no animation at all, but say
    // so rather than quietly shipping a clip.
    log.warn(
      `Motion artwork stream kept truncating; using ${best.toFixed(1)}s ` +
        `of ${Number(wanted).toFixed(1)}s`
    );
    return { file, durationSec: best };
  }

  /** Duration in seconds via ffprobe, or 0 if it cannot be determined. */
  async probeDuration(input) {
    return new Promise((resolve) => {
      const child = spawn(
        this.opts.ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      timer.unref?.();
      child.on('error', () => {
        clearTimeout(timer);
        resolve(0);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        const value = parseFloat(out.trim().split('\n')[0]);
        resolve(Number.isFinite(value) ? value : 0);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Encoders
   * ------------------------------------------------------------------ */

  encode({ input, workdir, out, format, size, quality, crf }) {
    if (format === 'avif') return this.encodeAvif({ input, out, size, crf });
    if (format === 'gif') return this.encodeGif({ input, out, size });
    return this.encodeWebp({ input, workdir, out, size, quality });
  }

  /** Duration arguments. Empty when playing the loop in full. */
  durationArgs() {
    const seconds = this.opts.maxDurationSec;
    return seconds ? ['-t', String(seconds)] : [];
  }

  scaleFilter(size) {
    return (
      `fps=${this.opts.fps},` +
      `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${size}:${size}`
    );
  }

  /** Single ffmpeg pass. Smallest output by a wide margin. */
  encodeAvif({ input, out, size, crf }) {
    return this.runFfmpeg([
      '-i', input,
      '-an',
      '-vf', this.scaleFilter(size),
      '-c:v', 'libsvtav1',
      '-crf', String(crf),
      // Keyframe roughly every 2s: the loop still seeks cheaply.
      '-g', String(this.opts.fps * 2),
      '-pix_fmt', 'yuv420p',
      out,
    ]);
  }

  /**
   * ffmpeg here has no libwebp encoder, so frames go to disk and img2webp
   * assembles them. JPEG intermediates rather than PNG: a full-length 1024px
   * loop is ~500 frames, and lossless PNGs would mean gigabytes of scratch for
   * an output that is lossy anyway.
   */
  async encodeWebp({ input, workdir, out, size, quality }) {
    const framedir = path.join(workdir, 'frames');
    await fsp.mkdir(framedir, { recursive: true });

    await this.runFfmpeg([
      '-i', input,
      '-an',
      '-vf', this.scaleFilter(size),
      '-q:v', '2',
      path.join(framedir, '%05d.jpg'),
    ]);

    const frames = (await fsp.readdir(framedir)).filter((f) => f.endsWith('.jpg')).sort();
    if (!frames.length) throw new Error('ffmpeg produced no frames');

    const frameDelayMs = Math.max(1, Math.round(1000 / this.opts.fps));
    const args = [
      '-loop', '0',
      '-lossy',
      '-q', String(quality),
      '-m', '4',
      '-d', String(frameDelayMs),
      ...frames.map((f) => path.join(framedir, f)),
      '-o', out,
    ];

    await this.run(this.opts.img2webpPath, args, 'img2webp');
    await fsp.rm(framedir, { recursive: true, force: true }).catch(() => {});
  }

  /** Legacy fallback. Kept because every client renders GIF. */
  encodeGif({ input, out, size }) {
    const filter =
      `${this.scaleFilter(size)},split[a][b];` +
      `[a]palettegen=max_colors=160:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`;

    return this.runFfmpeg([
      '-i', input,
      '-an',
      '-vf', filter,
      '-loop', '0',
      out,
    ]);
  }

  runFfmpeg(args) {
    return this.run(this.opts.ffmpegPath, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', ...args], 'ffmpeg');
  }

  run(bin, args, label) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => (stderr += d));

      // Full-length pulls at high resolution are genuinely slow.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${label} timed out`));
      }, this.opts.timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`${label}: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Exit status alone does not mean the read was complete -- a
        // truncated HLS pull still exits 0. Callers verify duration
        // separately; see fetchSource().
        if (code === 0) resolve();
        else reject(new Error(`${label} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Hosting
   * ------------------------------------------------------------------ */

  async upload(buffer, filename, contentType) {
    if (this.hosting.mode === 'command') return this.uploadViaCommand(buffer, filename);
    if (this.hosting.mode === 's3') return this.uploadViaS3(buffer, filename, contentType);
    return this.uploadViaWebhook(buffer, filename, contentType);
  }

  /**
   * PUTs to any S3-compatible bucket, signed with AWS SigV4.
   *
   * Exists mainly for Cloudflare R2, whose `pub-*.r2.dev` URLs are plain and
   * unsigned — which is the property that matters, since Discord will not
   * render an asset URL carrying a signed query string. Doing the signing here
   * rather than shelling out means no rclone/aws-cli install.
   */
  async uploadViaS3(buffer, filename, contentType) {
    const { endpoint, bucket, accessKeyId, secretAccessKey, region, publicBaseUrl } =
      this.hosting.s3;

    for (const [name, value] of Object.entries({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl })) {
      if (!value) throw new Error(`hosting.s3.${name} is not set`);
    }

    const origin = new URL(endpoint).origin;
    const host = new URL(endpoint).host;
    const key = filename.split('/').map(encodeURIComponent).join('/');
    const canonicalUri = `/${bucket}/${key}`;

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(buffer);

    // Header order matters: the canonical form requires them sorted by name.
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256hex(canonicalRequest),
    ].join('\n');

    let signingKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
    for (const part of [region, 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
    const signature = hmac(signingKey, stringToSign).toString('hex');

    const res = await fetch(`${origin}${canonicalUri}`, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: buffer,
      signal: AbortSignal.timeout(180000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 upload -> ${res.status} ${text.slice(0, 200)}`);
    }

    return `${publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }

  async uploadViaWebhook(buffer, filename, contentType) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: null, allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([buffer], { type: contentType }), filename);

    const url = new URL(this.hosting.webhookUrl);
    url.searchParams.set('wait', 'true');

    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook upload -> ${res.status} ${text.slice(0, 200)}`);
    }

    const body = await res.json();
    const attachment = body?.attachments?.[0];
    if (!attachment?.url) throw new Error('webhook response had no attachment URL');
    return attachment.url;
  }

  /**
   * Hands the file to a user-supplied command and reads the resulting public
   * URL from its stdout. This is the escape hatch from Discord's upload cap:
   * point it at R2, S3, scp, rclone, or anything else that ends up on an
   * HTTPS URL.
   *
   *   {file} -> absolute path to the encoded artwork
   *   {name} -> the filename we chose
   */
  async uploadViaCommand(buffer, filename) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yanpresence-up-'));
    const file = path.join(dir, filename);

    try {
      await fsp.writeFile(file, buffer);

      const command = this.hosting.command
        .replaceAll('{file}', shellQuote(file))
        .replaceAll('{name}', shellQuote(filename));

      const stdout = await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('upload command timed out'));
        }, this.opts.timeoutMs);
        timer.unref?.();

        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`upload command exited ${code}: ${err.trim().slice(0, 200)}`));
        });
      });

      // Last non-empty line, so the command is free to be chatty.
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();

      if (!line || !/^https?:\/\//i.test(line)) {
        throw new Error(`upload command did not print a URL (got: ${String(line).slice(0, 120)})`);
      }
      return line;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Hosts artwork extracted from a local library file (no catalog entry, so no
   * Apple CDN URL exists for it).
   */
  async localArtwork({ key, file, format }) {
    if (!this.uploadLocalArtwork || !this.canHost || !key) return null;

    const cached = this.getCached(`local:${key}`);
    if (cached) return cached.miss ? null : cached.url;

    try {
      const buffer = await fsp.readFile(file);
      const isPng = /png/i.test(format) || (buffer[0] === 0x89 && buffer[1] === 0x50);
      const ext = isPng ? 'png' : 'jpg';
      const url = await this.upload(buffer, `${sanitize(key)}.${ext}`, `image/${isPng ? 'png' : 'jpeg'}`);
      this.put(`local:${key}`, { url, expiresAt: expiryOf(url), kind: 'local' });
      log.info(`Hosted embedded artwork for ${key}`);
      return url;
    } catch (err) {
      log.warn(`Embedded artwork upload failed for ${key}: ${err.message}`);
      this.put(`local:${key}`, { miss: true });
      return null;
    }
  }

  /* ------------------------------------------------------------------ */

  async requireTools(format) {
    const needed = [[this.opts.ffmpegPath, 'ffmpeg']];
    if (format === 'webp') needed.push([this.opts.img2webpPath, 'img2webp']);

    for (const [bin, label] of needed) {
      if (!(await this.hasTool(bin))) {
        throw new Error(
          label === 'img2webp'
            ? `img2webp not found at "${bin}" — install it with \`brew install webp\`, or set animatedArtwork.format to "avif"`
            : `ffmpeg not found at "${bin}" — install it with \`brew install ffmpeg\``
        );
      }
    }
  }

  async hasTool(bin) {
    if (this.toolChecks.has(bin)) return this.toolChecks.get(bin);
    const promise = new Promise((resolve) => {
      const child = spawn(bin, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      // img2webp exits non-zero for -version but still runs; spawning at all
      // is the signal we actually care about.
      child.on('exit', () => resolve(true));
    });
    this.toolChecks.set(bin, promise);
    return promise;
  }

  /** Reports which encoders are usable, for `--doctor`. */
  async toolStatus() {
    return {
      ffmpeg: await this.hasTool(this.opts.ffmpegPath),
      img2webp: await this.hasTool(this.opts.img2webpPath),
    };
  }
}

/** Discord attachment URLs carry `?ex=<hex unix seconds>` -- their expiry. */
function expiryOf(url) {
  try {
    const ex = new URL(url).searchParams.get('ex');
    if (!ex) return 0;
    const seconds = parseInt(ex, 16);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sanitize(key) {
  const slug = key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) || 'artwork';
  return `${slug}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
}
