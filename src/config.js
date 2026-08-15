import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');

// macOS keeps app data in one place; Linux splits it, and putting a cache under
// ~/.config is the kind of thing that gets it backed up forever.
export const SUPPORT_DIR =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'yanpresence')
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'yanpresence'
      );

export const CACHE_DIR =
  process.platform === 'darwin'
    ? path.join(SUPPORT_DIR, 'cache')
    : path.join(
        process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
        'yanpresence'
      );

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

  // Where playback state comes from.
  //
  //   "auto"       -- pick by platform: Music.app/TV.app on macOS, the browser
  //                   sources on Linux. Whatever is actually playing wins.
  //   "apple-apps" -- Music.app and TV.app over Apple Events (macOS only).
  //   "browser"    -- the Apple Music web player at music.apple.com, read
  //                   over the extension bridge and/or MPRIS. Audio only:
  //                   Apple TV is a TV.app source, so `tv` below is inert.
  //
  // "browser" works on Linux and on macOS: if you play in a browser there too,
  // set it explicitly.
  source: 'auto',

  // The Apple Music web player, read two ways. Both feed the same pipeline,
  // and both can be on at once -- the bridge wins when it has something,
  // because it knows exactly which site is playing and MPRIS often does not.
  //
  // tv.apple.com is not read. Apple TV runs through TV.app on macOS, which
  // reports the show, season and episode as fields; the web player offers an
  // episode title and little else, and half a card is worse than none.
  browser: {
    // Local HTTP endpoint the companion extension posts playback state to.
    // See browser/README.md. This is the only path that identifies the site
    // under Chrome, which publishes no page URL over MPRIS.
    bridge: {
      enabled: true,
      host: '127.0.0.1',
      port: 8763,
      // A tab that stops posting is treated as gone after this long. The
      // extension posts every second while playing.
      staleMs: 6000,
      // Optional shared secret. Leave empty to accept any request that comes
      // from a browser extension origin on the loopback interface; set it (and
      // paste the same value into the extension's options) to require it.
      token: '',
    },

    // MPRIS over the session bus: no install, but only useful where the
    // browser publishes the page URL. Firefox does; Chrome does not, and its
    // players are ignored unless you name them in `players` below.
    mpris: {
      enabled: true,
      busctlPath: 'busctl',
      // How often the bus is re-scanned for players appearing and disappearing.
      discoverIntervalMs: 5000,
      // Escape hatch for browsers that publish no xesam:url. Maps a fragment of
      // the MPRIS bus name (or of the player's Identity) to "music" (assume it
      // is Apple Music) or "ignore" (never report it).
      //   { "chromium.instance": "music" }
      //
      // This does NOT rescue Apple Music in Chrome. Apple Music publishes no
      // Media Session metadata to Chrome at all, so what arrives over MPRIS is
      // the tab title ("Top All - Playlist - Apple Music") with no artist and
      // no album -- mapping it would put that on your status line. Chrome
      // needs the extension bridge. Mapping is for a browser that does publish
      // usable metadata, and that you keep exclusively for Apple Music: with
      // no URL to check, EVERY tab in it counts, YouTube included.
      players: {},
    },
  },

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

  // How long a *pause* waits before the presence comes down, as opposed to a
  // stop. null means "ask the source", because the two disagree about how
  // trustworthy a pause is:
  //
  //   Music.app blips `paused` between tracks, so its pause needs the full
  //     clearDelayMs to tell a real one from a gap between songs.
  //   The web player does not: a track change arrives as its own state, and
  //     the extension reports the pause the instant it happens. Five seconds
  //     of "still listening" after you hit pause is simply wrong there, so it
  //     defaults to 1.5s.
  //
  // Raise it if you ever see the status blink between tracks.
  pauseClearDelayMs: null,

  // Which field Discord shows on the one-line status (member list, under your
  // name): "name" | "state" | "details". We put the song in `details`, so
  // "details" reproduces the Spotify layout with the song where Spotify puts
  // the artist.
  statusDisplay: 'details',

  // Apple TV, through TV.app on macOS. TV.app is scripted through the same
  // iTunes-descended dictionary as Music.app, so watching it costs one more
  // resident osascript and nothing else. Only one source holds the presence at
  // a time; whatever is actually playing wins, and video beats audio when both
  // are. Ignored when `source` resolves to "browser".
  tv: {
    enabled: false,

    // Discord builds the card header from the *application* name, and the
    // handshake binds one application per connection. Leave this empty and
    // TV shows are announced through the Apple Music application, so the
    // header reads "Watching Apple Music". Create a second Discord
    // application named "Apple TV" and paste its Application ID here to get
    // the right header; yanpresence reconnects as it switches between them.
    clientId: '',

    // Cosmetic: echoed back to clients that display it. The header itself
    // always comes from the application's name in the portal.
    activityName: 'Apple TV',

    // Apple publishes no artwork we can reach for TV: the iTunes Search API
    // returns nothing for TV media, Apple TV+ streams carry no embedded
    // cover, and the Apple TV backend needs a session token. The large image
    // slot therefore gets `placeholderImageKey`.
    showSmallImage: false,
    smallImageKey: 'appletv',
  },

  // Square pixel size requested from Apple's artwork CDN. 1024 matches the
  // asset size Discord's docs recommend, and the size animated artwork is
  // encoded at, so both paths deliver the same dimensions.
  artworkSize: 1024,

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
    // build shows it as a still image, switch to "webp" (needs img2webp:
    // `brew install webp`, or `sudo apt install webp`).
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
    //   "skip"    — refuse to compromise; fall back to the static cover.
    // Irrelevant when maxBytes is null, since nothing is ever over budget.
    onOversize: 'degrade',

    // Full-length high-resolution pulls are genuinely slow; this is generous.
    timeoutMs: 5 * 60 * 1000,

    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    img2webpPath: 'img2webp',

    // GPU encoding. Off, and not for want of trying -- see src/gpu.js for the
    // measurements. Short version: the AMD VAAPI AV1 encoder produces AVIF
    // that ffmpeg reads back happily and Chromium refuses to decode, and
    // Discord is Electron, so the card renders the grey "?" placeholder. Every
    // variant failed, down to a single still frame. It also saved about a
    // second on a job that runs once per album and is cached forever, and
    // hardware *decode* measured slower than software on both GPUs.
    //
    // mode: "off" (default, CPU) | "auto" (also the CPU -- see above) |
    //       "vaapi" (force the GPU: kept for other hardware, other drivers,
    //       or a consumer that is not Chromium. Warns loudly when used.)
    hardware: {
      mode: 'off',

      // Which VAAPI device: "auto" | "amd" | "intel" | "nvidia" | an explicit
      // /dev/dri/renderD* path. "auto" prefers AMD, then Intel -- and picks by
      // vendor, not by number, because renderD128 is the discrete NVIDIA card
      // on plenty of laptops and it has no VAAPI encoder at all.
      device: 'auto',

      // Hardware decode, for every format including the CPU-encoded ones.
      // Independent of `mode`, which governs the encode only. Measured slower
      // than software here (4.9s NVDEC / 3.9s VAAPI / 2.9s software on a 20.6s
      // master), so it is opt-in too.
      decode: false,

      // Override the CRF -> VAAPI global_quality conversion. null derives it
      // from `crf` at the measured 3.5x that matches libsvtav1's output size.
      globalQuality: null,
    },
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
  if (!['auto', 'apple-apps', 'browser'].includes(config.source)) {
    problems.push(`source must be one of auto|apple-apps|browser (got ${config.source})`);
  }
  if (config.source === 'apple-apps' && process.platform !== 'darwin') {
    problems.push(
      'source is "apple-apps", which drives Music.app over Apple Events and needs macOS. ' +
        'Use "browser" to read music.apple.com and tv.apple.com instead.'
    );
  }
  const port = Number(config.browser?.bridge?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`browser.bridge.port must be a port number (got ${config.browser?.bridge?.port})`);
  }
  if (!['auto', 'off', 'vaapi'].includes(config.animatedArtwork.hardware?.mode ?? 'auto')) {
    problems.push(
      `animatedArtwork.hardware.mode must be auto|off|vaapi (got ${config.animatedArtwork.hardware.mode})`
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

  if (config.tv?.enabled && config.tv.clientId && !/^\d{17,20}$/.test(String(config.tv.clientId))) {
    problems.push(
      `tv.clientId is malformed (got ${config.tv.clientId}). It is the Application ID of a ` +
        'second Discord application named "Apple TV". Leave it empty to announce TV through ' +
        'the Apple Music application instead.'
    );
  }

  // Unconfigured hosting is deliberately not a problem: we fall back to the
  // static cover at `artworkSize`. `--doctor` surfaces it as a hint.
  return problems;
}
