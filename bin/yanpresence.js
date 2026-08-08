#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { AppleCatalog } from '../src/catalog.js';
import { ArtworkHost } from '../src/artwork.js';
import { CACHE_DIR, PROJECT_ROOT, SUPPORT_DIR, configPaths, loadConfig, validateConfig } from '../src/config.js';
import { DiscordRPC } from '../src/discord.js';
import { MusicWatcher } from '../src/music.js';
import { YanPresence } from '../src/index.js';
import log, { setLevel } from '../src/log.js';

const USAGE = `
yanpresence — Apple Music rich presence for Discord (macOS)

Usage:
  yanpresence                 Start the presence daemon
  yanpresence --doctor        Check the setup and exit
  yanpresence --watch         Print Music.app state without touching Discord
  yanpresence --dry-run       Run the full pipeline, print the activity JSON
                              instead of sending it (no clientId needed)
  yanpresence --init          Write a starter config and print its path
  yanpresence --cache         List hosted artwork: format, dimensions, length, size
  yanpresence --clear-cache   Drop cached artwork and lookups, forcing a re-encode
  yanpresence --test-assets   Cycle candidate large_image values through your
                              presence so you can see which ones Discord renders
  yanpresence --help

Options:
  --verbose                   Shorthand for --log-level debug
  --log-level <level>         error | warn | info | debug
  --config <path>             Use a specific config file
`;

function parseArgs(argv) {
  const flags = { logLevel: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--doctor':
        flags.doctor = true;
        break;
      case '--watch':
        flags.watch = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--init':
        flags.init = true;
        break;
      case '--cache':
        flags.cache = true;
        break;
      case '--clear-cache':
        flags.clearCache = true;
        break;
      case '--test-assets':
        flags.testAssets = true;
        break;
      case '--verbose':
      case '-v':
        flags.logLevel = 'debug';
        break;
      case '--log-level':
        flags.logLevel = argv[++i];
        break;
      case '--config':
        process.env.YANPRESENCE_CONFIG = path.resolve(argv[++i]);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error(USAGE);
        process.exit(2);
    }
  }
  return flags;
}

function requireMac() {
  if (process.platform !== 'darwin') {
    console.error('yanpresence only runs on macOS — it drives Music.app over Apple Events.');
    process.exit(1);
  }
}

async function cmdInit() {
  const target = path.join(SUPPORT_DIR, 'config.json');
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });

  if (fs.existsSync(target)) {
    console.log(`Config already exists: ${target}`);
    return;
  }

  const example = fs.readFileSync(path.join(PROJECT_ROOT, 'config.example.json'), 'utf8');
  fs.writeFileSync(target, example);
  console.log(`Wrote ${target}`);
  console.log('Fill in "clientId" with your Discord application ID, then run: yanpresence');
}

function cmdCache() {
  const file = path.join(CACHE_DIR, 'artwork.json');
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log('No artwork has been hosted yet.');
    return;
  }

  const entries = Object.entries(cache);
  if (!entries.length) {
    console.log('No artwork has been hosted yet.');
    return;
  }

  console.log('');
  for (const [key, entry] of entries) {
    const age = Math.round((Date.now() - (entry.ts ?? 0)) / 60000);
    if (entry.miss) {
      console.log(`  ✗ ${key}  (${age}m ago)`);
      if (entry.reason) console.log(`      ${entry.reason}`);
      continue;
    }
    const dims = entry.width ? `${entry.width}x${entry.height}` : '?';
    const len = entry.durationSec ? `${entry.durationSec.toFixed(1)}s @ ${entry.fps}fps` : '';
    const mb = entry.bytes ? `${(entry.bytes / 1048576).toFixed(2)}MB` : '';
    console.log(`  ✓ ${key}`);
    console.log(`      ${[entry.format, dims, len, mb].filter(Boolean).join('  ·  ')}`);
    console.log(`      ${entry.url}`);
  }
  console.log('');
  console.log('  Verify any of these independently with:');
  console.log('    ffprobe -v error -show_entries stream=width,height,nb_frames \\');
  console.log('      -show_entries format=duration -of default=nw=1 \'<url>\'');
  console.log('');
}

function cmdClearCache() {
  let removed = 0;
  for (const name of ['artwork.json', 'catalog.json']) {
    const file = path.join(CACHE_DIR, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed += 1;
      console.log(`Removed ${file}`);
    }
  }
  if (!removed) console.log('Nothing cached.');
  console.log('Artwork will be re-encoded and re-uploaded on the next play.');
}

/**
 * Discord gives no feedback on whether it could resolve an asset -- a bad one
 * simply renders as "?". So the only way to find out which kinds work is to
 * set each in turn and look. Candidates are chosen to isolate one variable at
 * a time: portal asset vs external URL, plain URL vs signed query string, and
 * static vs animated format.
 */
async function cmdTestAssets(config) {
  const { ArtworkHost } = await import('../src/artwork.js');
  const host = new ArtworkHost({ config, cacheDir: CACHE_DIR });

  const APPLE_JPG =
    'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/31/3a/3f/' +
    '313a3fbc-bb8f-80c7-b5a2-e226869a38cd/24UMGIM51924.rgb.jpg/1000x1000bb.jpg';

  const candidates = [];
  if (config.placeholderImageKey) {
    candidates.push([`portal asset "${config.placeholderImageKey}"`, config.placeholderImageKey]);
  }

  // Control: a plain external URL, known to render.
  candidates.push(['plain external URL', APPLE_JPG]);

  // Same image, same host, only a query string added. Discord CDN URLs carry a
  // mandatory signature in their query string and do not render as assets, so
  // this establishes whether query strings are the reason -- which decides
  // what a self-hosted URL is allowed to look like.
  candidates.push(['external URL + query string', `${APPLE_JPG}?probe=1`]);

  if (host.canHost) {
    const animated = Object.values(host.cache).find((e) => !e.miss && e.url);
    if (animated) candidates.push([`hosted ${animated.format ?? 'image'}`, animated.url]);
  }

  const rpc = new DiscordRPC({ clientId: config.clientId });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    rpc.once('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });
    rpc.connect();
  });
  if (!ready) {
    console.error('Could not connect to Discord.');
    process.exit(1);
  }

  const HOLD_MS = 15000;
  console.log('\n  Open your Discord profile and watch the album art.');
  console.log(`  Each candidate is held for ${HOLD_MS / 1000}s. Note which ones show an image.\n`);

  for (const [label, image] of candidates) {
    await rpc.setActivity({
      type: 2,
      name: config.activityName,
      status_display_type: 2,
      details: label,
      state: 'asset test',
      assets: { large_image: image, large_text: label },
      instance: false,
    });
    console.log(`  → ${label}`);
    await new Promise((r) => setTimeout(r, HOLD_MS));
  }

  await rpc.clearActivity().catch(() => {});
  rpc.destroy();
  console.log('\n  Done — presence cleared.');
}

async function cmdDoctor(config) {
  const rows = [];
  const ok = (label, detail) => rows.push(['ok', label, detail]);
  const warn = (label, detail) => rows.push(['warn', label, detail]);
  const bad = (label, detail) => rows.push(['fail', label, detail]);

  ok('platform', `${process.platform} ${process.arch}, node ${process.version}`);

  rows.push(['info', 'config', config.__source ?? `none found (using defaults)`]);
  if (!config.__source) {
    warn('config', `looked in:\n      ${configPaths().join('\n      ')}`);
  }

  const problems = validateConfig(config);
  if (problems.length) problems.forEach((p) => bad('config', p));
  else ok('clientId', String(config.clientId));

  // --- Music.app -------------------------------------------------------
  const music = await new Promise((resolve) => {
    const watcher = new MusicWatcher({ pollIntervalMs: 500 });
    const timer = setTimeout(() => {
      watcher.stop();
      resolve(null);
    }, 12000);
    watcher.on('state', (snapshot) => {
      clearTimeout(timer);
      watcher.stop();
      resolve(snapshot);
    });
    watcher.start();
  });

  if (!music) {
    bad(
      'Music.app',
      'no response from the watcher. macOS may be waiting on an automation prompt — check\n' +
        '      System Settings › Privacy & Security › Automation and allow your terminal to control Music.'
    );
  } else if (music.state === 'closed') {
    warn('Music.app', 'not running (that is fine — start it and presence will follow)');
  } else if (music.active) {
    ok('Music.app', `${music.state}: ${music.track.name} — ${music.track.artist}`);
  } else {
    ok('Music.app', `running, player state "${music.state}"`);
  }

  // --- Discord ---------------------------------------------------------
  const sockets = DiscordRPC.candidateSockets().filter((p) => {
    try {
      return fs.statSync(p).isSocket();
    } catch {
      return false;
    }
  });
  if (!sockets.length) bad('Discord', 'no IPC socket found — is the Discord desktop app running?');
  else ok('Discord', `IPC socket at ${sockets[0]}`);

  if (sockets.length && !problems.length) {
    const rpc = new DiscordRPC({ clientId: config.clientId });
    const user = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      rpc.once('ready', (u) => {
        clearTimeout(timer);
        resolve(u);
      });
      rpc.connect();
    });
    rpc.destroy();
    if (user) ok('Discord handshake', `authorized as ${user.username}`);
    else bad('Discord handshake', 'no READY frame — check that clientId is a real application ID');
  }

  // --- Catalog ---------------------------------------------------------
  const catalog = new AppleCatalog({
    storefront: config.storefront,
    cacheDir: CACHE_DIR,
    artworkSize: config.artworkSize,
  });
  const probe = await catalog
    .lookup({ name: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', duration: 200 })
    .catch(() => null);
  if (probe) {
    ok('Apple Music catalog', `${probe.source} lookup works (${probe.artworkUrl ? 'artwork ok' : 'no artwork'})`);
    if (probe.source === 'itunes') {
      warn(
        'Apple Music catalog',
        'using the iTunes Search fallback — animated artwork is unavailable on this path'
      );
    }
  } else {
    bad('Apple Music catalog', 'lookup failed — check network access');
  }

  // --- Artwork hosting -------------------------------------------------
  const artwork = new ArtworkHost({ config, cacheDir: CACHE_DIR });
  const format = artwork.format;
  const tools = await artwork.toolStatus();

  if (!config.animatedArtwork.enabled) {
    rows.push(['info', 'animated artwork', 'disabled in config']);
  } else if (!artwork.canHost) {
    warn(
      'artwork hosting',
      config.hosting.mode === 's3'
        ? 'hosting.mode is "s3" but the s3 block is incomplete (needs endpoint, bucket,\n' +
          '      accessKeyId, secretAccessKey, publicBaseUrl) — album art will be static.'
        : config.hosting.mode === 'command'
          ? 'hosting.mode is "command" but hosting.command is empty — album art will be static.'
          : 'no hosting.webhookUrl — album art will be static.'
    );
  } else if (!tools.ffmpeg) {
    bad('animated artwork', `ffmpeg not found at "${config.animatedArtwork.ffmpegPath}" (brew install ffmpeg)`);
  } else if (format === 'webp' && !tools.img2webp) {
    bad(
      'animated artwork',
      `img2webp not found at "${config.animatedArtwork.img2webpPath}" (brew install webp),\n` +
        '      or set animatedArtwork.format to "avif"'
    );
  } else {
    const duration = config.animatedArtwork.maxDurationSec
      ? `${config.animatedArtwork.maxDurationSec}s clip`
      : 'full loop';
    ok(
      'animated artwork',
      `${format} · ${config.animatedArtwork.size}px · ${config.animatedArtwork.fps}fps · ${duration}`
    );
    if (config.hosting.mode === 's3') {
      // Prove the credentials by actually round-tripping a small object: a
      // config that merely looks complete tells you nothing.
      const probe = await artwork
        .uploadViaS3(Buffer.from('yanpresence'), 'doctor-probe.txt', 'text/plain')
        .then(async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
          return { url, readable: Boolean(res?.ok) };
        })
        .catch((err) => ({ error: err.message }));

      if (probe.error) {
        bad('artwork hosting', `s3 upload failed — ${probe.error}`);
      } else if (!probe.readable) {
        bad(
          'artwork hosting',
          `s3 upload worked but ${probe.url} is not publicly readable.\n` +
            '      Enable the bucket\'s Public Development URL, and check publicBaseUrl.'
        );
      } else {
        ok('artwork hosting', `s3 — uploaded and publicly readable at ${new URL(probe.url).host}`);
      }
    } else if (config.hosting.mode === 'command') {
      ok('artwork hosting', `command: ${config.hosting.command.slice(0, 60)}`);
    } else {
      warn(
        'artwork hosting',
        'webhook — the upload works, but Discord will NOT render cdn.discordapp.com\n' +
          '      attachment URLs as presence assets: they carry a mandatory signed query\n' +
          '      string, and the asset resolves to the grey "?" placeholder.\n' +
          '      Use hosting.mode "s3" (or "command") with a host serving plain URLs.\n' +
          '      Verify either way with: yanpresence --test-assets'
      );
    }
  }

  // --- report ----------------------------------------------------------
  const icon = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  const color = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', info: '\x1b[90m' };
  const reset = process.stdout.isTTY ? '\x1b[0m' : '';
  console.log('');
  for (const [level, label, detail] of rows) {
    const c = process.stdout.isTTY ? color[level] : '';
    console.log(`  ${c}${icon[level]}${reset} ${label.padEnd(20)} ${detail}`);
  }
  console.log('');

  const failed = rows.some(([level]) => level === 'fail');
  process.exit(failed ? 1 : 0);
}

async function cmdWatch(config) {
  const watcher = new MusicWatcher({ pollIntervalMs: config.pollIntervalMs });
  watcher.on('state', (snapshot) => {
    if (!snapshot.active) {
      console.log(`[${snapshot.state}]`);
      return;
    }
    const t = snapshot.track;
    console.log(
      `[${snapshot.state}] ${t.name} — ${t.artist} · ${t.album} ` +
        `(${t.position.toFixed(1)}/${t.duration.toFixed(1)}s) kind="${t.kind}"`
    );
  });
  watcher.start();
  process.on('SIGINT', () => {
    watcher.stop();
    process.exit(0);
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  requireMac();

  if (flags.init) return cmdInit();
  if (flags.cache) return cmdCache();
  if (flags.clearCache) return cmdClearCache();

  const config = loadConfig();
  setLevel(flags.logLevel ?? config.logLevel);

  if (flags.doctor) return cmdDoctor(config);
  if (flags.testAssets) return cmdTestAssets(config);
  if (flags.watch) return cmdWatch(config);

  if (!flags.dryRun) {
    const problems = validateConfig(config);
    if (problems.length) {
      for (const problem of problems) log.error(problem);
      log.error('Run `yanpresence --init` to create a config, then `yanpresence --doctor` to verify it.');
      process.exit(1);
    }
  }

  const app = new YanPresence(config, { dryRun: Boolean(flags.dryRun) });
  app.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, clearing presence and exiting`);
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    log.error(`Unhandled rejection: ${err?.stack ?? err}`);
  });
}

main().catch((err) => {
  log.error(err?.stack ?? String(err));
  process.exit(1);
});
