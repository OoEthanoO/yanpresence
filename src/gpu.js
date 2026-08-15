import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import log from './log.js';

const DRM_CLASS = '/sys/class/drm';

const VENDORS = {
  '0x1002': 'amd',
  '0x10de': 'nvidia',
  '0x8086': 'intel',
};

/**
 * GPU encoding, and why it is off by default.
 *
 * This was built to hand the AV1 encode to a GPU -- VAAPI on an AMD or Intel
 * device, since Ada's NVENC cannot produce AV1-in-HEIF. It works, in the sense
 * that ffmpeg produces a file and ffprobe reads it back. It is nonetheless the
 * wrong thing to ship, because of the one consumer that matters:
 *
 *   Measured on Ubuntu 26.04, Radeon 780M (RDNA3), ffmpeg 8.0.1, Mesa VAAPI,
 *   against a 20.6s 2160x2160 master encoded to 1024px:
 *
 *     av1_vaapi output           Chromium REFUSES to decode it. Every variant
 *                                fails -- CQP, VBR, one tile, explicit level,
 *                                and a single still frame. Discord is Electron,
 *                                so the presence card renders the grey "?".
 *     libsvtav1 output           Decodes everywhere, including Discord.
 *
 *     Speed, which was the point: 1.5s hardware against 2.6s libsvtav1, and
 *     hardware *decode* on either GPU was slower than software (4.9s NVDEC,
 *     3.9s VAAPI, 2.9s software) -- initialising a vendor stack costs more
 *     than decoding twenty seconds of H.264 saves.
 *
 * So the fast path produces an image the only reader cannot open, to save a
 * second on a job that runs once per album and is then cached forever. The
 * encode stays on the CPU unless `hardware.mode` is set to "vaapi" by hand,
 * which is left in place for different hardware, a different driver, or a
 * consumer that is not Chromium.
 *
 * Nothing here is trusted blindly either way: every hardware attempt is
 * verified, and a failure falls back to the CPU encoder for the rest of the
 * run.
 */

/**
 * Render nodes on this machine, tagged with whose they are. `drmClass` exists
 * so this can be pointed at a fixture, or at an unusual sysfs layout.
 */
export function detectRenderNodes({ drmClass = DRM_CLASS } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(drmClass);
  } catch {
    return [];
  }

  const nodes = [];
  for (const entry of entries.sort()) {
    if (!/^renderD\d+$/.test(entry)) continue;
    let vendorId = '';
    try {
      vendorId = fs.readFileSync(path.join(drmClass, entry, 'device', 'vendor'), 'utf8').trim();
    } catch {
      continue;
    }
    nodes.push({
      node: `/dev/dri/${entry}`,
      vendor: VENDORS[vendorId.toLowerCase()] ?? 'unknown',
      vendorId,
    });
  }
  return nodes;
}

/**
 * The render node to give VAAPI.
 *
 * Picking `/dev/dri/renderD128` -- the usual hardcoded default -- is a coin
 * flip: on a laptop with a discrete NVIDIA card, renderD128 is frequently the
 * NVIDIA one, which has no VAAPI encoder at all. The vendor is what matters,
 * not the number.
 */
export function pickVaapiNode(nodes, preference = 'auto') {
  if (preference && preference.startsWith('/dev/')) {
    return nodes.find((n) => n.node === preference) ?? { node: preference, vendor: 'unknown' };
  }
  if (['amd', 'intel', 'nvidia'].includes(preference)) {
    return nodes.find((n) => n.vendor === preference) ?? null;
  }
  // AMD first, then Intel: both encode AV1 on current hardware, and neither is
  // the discrete card whose fans this does not need to spin up.
  return nodes.find((n) => n.vendor === 'amd') ?? nodes.find((n) => n.vendor === 'intel') ?? null;
}

/** True when the NVIDIA driver is loaded and usable by this user. */
export function hasNvidia() {
  return fs.existsSync('/dev/nvidiactl') || fs.existsSync('/dev/nvidia0');
}

/**
 * Which encoders and hwaccels this ffmpeg was built with. Asked once and
 * cached: it is two process spawns, and the answer cannot change under us.
 */
export async function probeFfmpegCapabilities(ffmpegPath) {
  const [encoders, hwaccels] = await Promise.all([
    runText(ffmpegPath, ['-hide_banner', '-encoders']),
    runText(ffmpegPath, ['-hide_banner', '-hwaccels']),
  ]);

  return {
    available: encoders !== null,
    encoders: new Set(parseEncoders(encoders ?? '')),
    hwaccels: new Set(
      (hwaccels ?? '')
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  };
}

/** ffmpeg lists encoders as " V....D av1_vaapi   AV1 (VAAPI)". */
export function parseEncoders(text) {
  const names = [];
  for (const line of text.split('\n')) {
    const match = /^\s*[VASFXBD.]{6}\s+([A-Za-z0-9_-]+)/.exec(line);
    if (match && match[1] !== '=') names.push(match[1]);
  }
  return names;
}

/**
 * How to encode AVIF on this machine, or null for "use the CPU".
 *
 * The returned pieces slot into the existing single-pass command: `input`
 * arguments go before -i, `filter` is appended to the scale chain, and
 * `output` replaces the codec arguments.
 */
export function planAvif({ capabilities, nodes, nvidia, config = {}, crf = 20 }) {
  const mode = String(config.mode ?? 'off').toLowerCase();
  // "auto" deliberately means the CPU here. See the note at the top of this
  // file: the hardware encoder's output does not render in Discord, so
  // choosing it automatically would be choosing a broken card.
  if (mode !== 'vaapi') return null;

  const node = pickVaapiNode(nodes, config.device ?? 'auto');

  if (!node || !capabilities.encoders.has('av1_vaapi')) {
    log.warn(
      !node
        ? 'animatedArtwork.hardware.mode is "vaapi" but no AMD or Intel render node was found'
        : 'animatedArtwork.hardware.mode is "vaapi" but this ffmpeg has no av1_vaapi encoder'
    );
    return null;
  }

  log.warn(
    'animatedArtwork.hardware.mode is "vaapi": the AV1 encode is going to the GPU. ' +
      'Discord could not render VAAPI-encoded AVIF when this was last measured — if the ' +
      'album art shows as a grey "?", that is why. Set it back to "off" and run ' +
      '--clear-cache to re-encode.'
  );

  return {
    label: `av1_vaapi on ${node.node} (${node.vendor})`,
    input: [
      // The VAAPI device is *named* and pinned as the filter device rather
      // than passed as `-vaapi_device`. With two GPUs in the machine that is
      // not a stylistic choice: any `-hwaccel` on the input side becomes the
      // default filter device, so `hwupload` would hand NVIDIA frames to the
      // AMD encoder and av1_vaapi fails with EINVAL and writes nothing.
      '-init_hw_device', `vaapi=va:${node.node}`,
      '-filter_hw_device', 'va',
      ...decodeArgs({ capabilities, nodes, nvidia, config }),
    ],
    filter: 'format=nv12,hwupload',
    output: [
      '-c:v', 'av1_vaapi',
      '-rc_mode', 'CQP',
      // `-qp` does not exist on av1_vaapi -- passing it is silently ignored,
      // which is how a quality setting turns into "whatever the driver felt
      // like" and a 19.8MB file. `-global_quality` is the knob that works.
      //
      // The factor is measured, not derived: on a 20.6s 2160x2160 master at
      // 1024px, global_quality 70 produced 10.7MB against libsvtav1 crf20's
      // 10.76MB. Sizes match at 3.5x, so that is the conversion.
      '-global_quality', String(globalQuality(config, crf)),
    ],
  };
}

/**
 * Hardware decode for the paths that encode on the CPU anyway (WebP, GIF, and
 * the AVIF fallback). Reading and scaling the master is most of the work there.
 */
export function planDecodeOnly({ capabilities, nodes, nvidia, config = {} }) {
  const args = decodeArgs({ capabilities, nodes, nvidia, config });
  if (!args.length) return null;
  return { label: args.includes('cuda') ? 'NVDEC decode' : 'VAAPI decode', input: args };
}

function globalQuality(config, crf) {
  const explicit = Number(config.globalQuality);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return Math.max(1, Math.min(255, Math.round(crf * 3.5)));
}

/**
 * `decode` is its own switch, independent of which encoder is chosen -- mode
 * governs the encode and nothing else. It is off by default because it was
 * measured, not assumed: on a 20.6s 2160x2160 master, software decode took
 * 2.9s against 4.9s on NVDEC and 3.9s on VAAPI. Initialising a vendor stack
 * costs more than decoding twenty seconds of H.264 saves.
 */
function decodeArgs({ capabilities, nodes = [], nvidia, config }) {
  if (config.decode !== true) return [];

  // No -hwaccel_output_format: frames come back to system memory, which is
  // what both the software filters and the VAAPI upload want.
  if (nvidia && capabilities.hwaccels.has('cuda')) return ['-hwaccel', 'cuda'];

  const node = pickVaapiNode(nodes, config.device ?? 'auto');
  if (node && capabilities.hwaccels.has('vaapi')) {
    return ['-hwaccel', 'vaapi', '-hwaccel_device', node.node];
  }
  return [];
}

/** A one-line summary for --doctor. */
export function describeHardware({ nodes, nvidia, capabilities }) {
  const parts = nodes.map((n) => `${n.node} (${n.vendor})`);
  if (nvidia) parts.push('nvidia driver loaded');
  const encoders = ['av1_vaapi', 'av1_nvenc', 'libsvtav1', 'libaom-av1'].filter((e) =>
    capabilities.encoders.has(e)
  );
  return {
    devices: parts.join(', ') || 'none found',
    encoders: encoders.join(', ') || 'none of the AV1 encoders',
  };
}

function runText(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout ?? ''));
    });
  });
}
