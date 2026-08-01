import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SUPPORT_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'yanpresence'
);
export const CACHE_DIR = path.join(SUPPORT_DIR, 'cache');

export const DEFAULTS = {
  // Discord application ID (Developer Portal -> your app -> Application ID).
  // Name the application "Apple Music" -- Discord renders the header as
  // "Listening to <application name>".
  clientId: '',

  // Sent as the activity's `name`. Discord renders the "Listening to ..."
  // header from the application's name in the Developer Portal, so keep the
  // two in sync.
  activityName: 'Apple Music',

  // Apple Music storefront used for catalog lookups and the links we attach.
  storefront: 'us',

  // How often the Music.app watcher reports state, in milliseconds.
  pollIntervalMs: 1000,

  // Slower poll used while Music.app is not running. Nothing can change until
  // it launches, so waking every second is wasted battery for an agent that
  // runs from login. Playback only starts after the app opens, so a few
  // seconds' delay in noticing costs nothing.
  idlePollIntervalMs: 5000,

  // Minimum gap between two SET_ACTIVITY frames. Discord rate-limits these.
  minUpdateIntervalMs: 2500,

  // Seconds of drift between predicted and real playhead before we treat it
  // as a seek and re-send timestamps.
  seekToleranceSec: 2,

  // Keep the presence up while playback is paused. Off by default: a paused
  // track is not something you are listening to, and Discord's own Spotify
  // integration drops the status on pause too.
  showWhenPaused: false,

  // Milliseconds playback must be non-playing -- paused, stopped or quit --
  // before the presence is cleared. Music.app blips `paused` between tracks,
  // so clearing instantly would flicker the status between every song.
  clearDelayMs: 5000,

  // Which field Discord shows on the one-line status (member list, under your
  // name): "name" | "state" | "details". We put the song in `details`, so
  // "details" reproduces the Spotify layout with the song where Spotify puts
  // the artist.
  statusDisplay: 'details',

  // Square pixel size requested from Apple's artwork CDN.
  artworkSize: 1000,

  // Small badge in the corner of the album art. This one is a Rich Presence
  // art asset uploaded in the Developer Portal, referenced by its name.
  showSmallImage: true,
  smallImageKey: 'applemusic',

  // Shown when there is no album art to display. An empty large image slot,
  // or one pointing at something Discord cannot resolve, renders as Discord's
  // "?" placeholder -- so this points at a fully transparent 1024x1024 asset
  // instead, which reads as blank.
  //
  // Upload assets/blank.png in the Developer Portal under
  // Rich Presence -> Art Assets, named "blank". Portal assets are referenced
  // by name and always resolve. Set to null to leave the slot empty.
  placeholderImageKey: 'blank',

  // details_url / state_url / large_url make the song, artist and album text
  // clickable on current Discord builds. Turn this on to *also* attach classic
  // Rich Presence buttons, which older clients understand.
  linkButtons: false,

  // Where encoded artwork gets hosted so Discord has a URL to fetch.
  //
  //   "webhook" — post to a Discord webhook you own; the file lands on
  //               cdn.discordapp.com. Easiest, but subject to Discord's
  //               per-file upload cap (10MB unboosted / 50MB Boost 2).
  //   "command" — hand the file to your own command and read the resulting
  //               URL from its stdout. No Discord involvement, no cap.
  //               {file} and {name} are substituted.
  //
  // Example command (Cloudflare R2 via rclone):
  //   "rclone copyto {file} r2:art/{name} >&2 && echo https://cdn.example.com/{name}"
  hosting: {
    // "s3" | "command" | "webhook"
    //
    // NOTE: "webhook" cannot serve Rich Presence assets. The upload works and
    // the file is visible in the channel, but cdn.discordapp.com attachment
    // URLs carry a mandatory signed query string and Discord will not render
    // them as an asset -- you get the grey "?" placeholder. Use "s3" or
    // "command" with a host that serves plain, unsigned URLs.
    mode: 's3',

    // S3-compatible storage, signed natively (no rclone or aws-cli needed).
    // For Cloudflare R2:
    //   endpoint      https://<accountId>.r2.cloudflarestorage.com
    //   publicBaseUrl https://pub-<hash>.r2.dev   (from the bucket's public
    //                 r2.dev subdomain, or your own custom domain)
    //   region        "auto"
    s3: {
      endpoint: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      region: 'auto',
      publicBaseUrl: '',
    },

    // Escape hatch: any command that takes {file}/{name} and prints a URL.
    command: '',

    webhookUrl: '',
  },

  // Animated (motion) album artwork. Apple ships these as HLS video, which
  // Discord cannot render, so we transcode to an animated image format.
  //
  // Format is the whole ballgame. Measured on a real Apple motion master --
  // the FULL 20.6s loop, no truncation, at source framerate:
  //
  //   1024px 30fps  AVIF crf20    3.7 MB   22s
  //   2160px 30fps  AVIF crf26    8.4 MB   30s
  //   2160px 30fps  AVIF crf20   12.2 MB   34s
  //   2160px 30fps  AVIF crf14   18.8 MB   32s
  //   2160px 30fps  WebP q92     88.3 MB  181s
  //   1000px 24fps  GIF        ~128   MB   (extrapolated)
  //
  // GIF is why full-length full-resolution animation ever looked impossible.
  // With AVIF the entire loop at full resolution and high quality fits inside
  // even a free Discord webhook, so nothing has to be cut, shrunk or degraded.
  animatedArtwork: {
    enabled: true,

    // "avif" | "webp" | "gif". Discord's docs state external-URL assets
    // support all three, with animation (uploaded portal assets cannot animate
    // at all). AVIF is the default: smallest by a wide margin, best quality
    // per byte, single ffmpeg pass, and no extra tooling. If your Discord
    // build shows it as a still image, switch to "webp" (needs `brew install
    // webp` for img2webp).
    format: 'avif',

    // Square pixels. 1024 matches Discord's own recommended asset size, and
    // the presence art is rendered far smaller than that, so going higher
    // costs bytes and encode time without looking any better. Apple's masters
    // do go to 2160 if you want it anyway.
    size: 1024,

    // 30 is the source framerate, so this drops no frames.
    fps: 30,

    // null plays the entire loop. Set a number of seconds only to truncate.
    maxDurationSec: null,

    // AVIF constant-rate factor -- lower is better quality. 20 is visually
    // transparent at this size; 14 is close to the source master.
    crf: 20,

    // WebP quality (0-100), used only when format is "webp".
    quality: 75,

    // Encode-size ceiling before we do something about it. null means "decide
    // from the hosting mode": 9MB for a Discord webhook, uncapped for s3 and
    // command hosting, where nothing is imposing a limit. Set a number to
    // pin it yourself.
    maxBytes: null,

    // What to do when an encode exceeds maxBytes:
    //   "degrade" — re-encode at lower quality, then smaller, to fit.
    //   "skip"    — refuse to compromise; fall back to static 1000x1000 art.
    // Irrelevant when maxBytes is null, since nothing is ever over budget.
    onOversize: 'degrade',

    // Full-length high-resolution pulls are genuinely slow; this is generous.
    timeoutMs: 5 * 60 * 1000,

    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    img2webpPath: 'img2webp',
  },

  // Upload embedded artwork from local library files (not in Apple's catalog)
  // through the same webhook so they still get album art. Needs a webhook URL.
  uploadLocalArtwork: true,

  logLevel: 'info',
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function configPaths() {
  return [
    process.env.YANPRESENCE_CONFIG,
    path.join(SUPPORT_DIR, 'config.json'),
    path.join(os.homedir(), '.config', 'yanpresence', 'config.json'),
    path.join(PROJECT_ROOT, 'config.json'),
  ].filter(Boolean);
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // Tolerate comments so the shipped example can stay annotated.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped);
}

function fromEnv() {
  const env = {};
  if (process.env.YANPRESENCE_CLIENT_ID) env.clientId = process.env.YANPRESENCE_CLIENT_ID;
  if (process.env.YANPRESENCE_STOREFRONT) env.storefront = process.env.YANPRESENCE_STOREFRONT;
  if (process.env.YANPRESENCE_LOG_LEVEL) env.logLevel = process.env.YANPRESENCE_LOG_LEVEL;
  if (process.env.YANPRESENCE_WEBHOOK_URL) {
    env.hosting = { mode: 'webhook', webhookUrl: process.env.YANPRESENCE_WEBHOOK_URL };
  }
  return env;
}

export function loadConfig() {
  let loaded = {};
  let source = null;
  for (const file of configPaths()) {
    if (!fs.existsSync(file)) continue;
    try {
      loaded = readJson(file);
      source = file;
      break;
    } catch (err) {
      throw new Error(`Failed to parse config at ${file}: ${err.message}`);
    }
  }

  const config = deepMerge(deepMerge(DEFAULTS, loaded), fromEnv());
  config.__source = source;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return config;
}

export function validateConfig(config) {
  const problems = [];
  if (!/^\d{17,20}$/.test(String(config.clientId || ''))) {
    problems.push(
      'clientId is missing or malformed. Create an application at ' +
        'https://discord.com/developers/applications, name it "Apple Music", ' +
        'and copy its Application ID into your config.'
    );
  }
  if (!['name', 'state', 'details'].includes(config.statusDisplay)) {
    problems.push(`statusDisplay must be one of name|state|details (got ${config.statusDisplay})`);
  }
  if (!['s3', 'command', 'webhook'].includes(config.hosting.mode)) {
    problems.push(`hosting.mode must be "s3", "command" or "webhook" (got ${config.hosting.mode})`);
  }
  if (!['webp', 'avif', 'gif'].includes(config.animatedArtwork.format)) {
    problems.push(
      `animatedArtwork.format must be "webp", "avif" or "gif" (got ${config.animatedArtwork.format})`
    );
  }

  // Unconfigured hosting is deliberately not a problem: we fall back to static
  // 1000x1000 artwork. `--doctor` surfaces it as a hint.
  return problems;
}
