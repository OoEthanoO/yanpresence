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
 * GPU encoding: on through AMF, off through VAAPI, and the difference is
 * measured rather than assumed.
 *
 * The job is to hand the AV1 encode to a GPU, since Ada's NVENC cannot produce
 * AV1-in-HEIF and that leaves the AMD and Intel paths. Both produce a file
 * ffmpeg and ffprobe read back happily. Only one of them produces a file the
 * consumer that matters can open, and the consumer that matters is Chromium,
 * because Discord is Electron.
 *
 *   VAAPI, on Ubuntu 26.04, Radeon 780M (RDNA3), ffmpeg 8.0.1, Mesa, against a
 *   20.6s 2160x2160 master encoded to 1024px:
 *
 *     av1_vaapi output           Chromium REFUSES to decode it. Every variant
 *                                fails -- CQP, VBR, one tile, explicit level,
 *                                and a single still frame. The presence card
 *                                renders the grey "?".
 *     libsvtav1 output           Decodes everywhere, including Discord.
 *
 *   AMF, on Windows 11, the same Radeon 780M, ffmpeg 9.0, against a 20s
 *   2160x2160 master encoded to 1024px:
 *
 *     av1_amf output             Chromium 148 decodes it. Structurally
 *                                identical to the CPU encode -- a still cover
 *                                image plus a 180-frame animation track, same
 *                                dimensions, same duration.
 *     Speed and size             5.7s / 19.6MB hardware against 6.5s / 21.4MB
 *                                libsvtav1 crf20. Modestly faster, slightly
 *                                smaller, same quality target.
 *
 * So it is the driver's bitstream packing that was the problem on Linux, not
 * the silicon: the same chip through AMD's own SDK produces AVIF Chromium
 * reads. "auto" therefore means the GPU on Windows where an AMD adapter and
 * av1_amf are both present, and means the CPU on Linux, where choosing the
 * hardware encoder would be choosing a broken card.
 *
 * Hardware *decode* is a separate switch and stays off on both. Measured:
 * 4.9s NVDEC / 3.9s VAAPI / 2.9s software on Linux, and on Windows 6.1s with
 * d3d11va against 6.5s without for the CPU encode -- but 7.5s against 5.7s
 * for the AMF one, where the frames have to come back to system memory for the
 * scale filter and then go up again. Initialising a vendor stack costs about
 * what decoding twenty seconds of H.264 saves.
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
export function planAvif({ capabilities, nodes, nvidia, config = {}, crf = 20, platform = process.platform }) {
  const mode = String(config.mode ?? 'auto').toLowerCase();
  if (mode === 'off') return null;

  // AMF is the one hardware encoder measured to produce AVIF Chromium will
  // open, so it is the only one "auto" is willing to pick on its own.
  if (mode === 'amf' || (mode === 'auto' && platform === 'win32')) {
    return planAmf({ capabilities, nodes, config, crf, explicit: mode === 'amf' });
  }

  // "auto" means the CPU everywhere else. See the note at the top of this
  // file: VAAPI's output does not render in Discord, so choosing it
  // automatically would be choosing a broken card.
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
 * The AMD path on Windows: AV1 through AMF.
 *
 * No `-init_hw_device` and no `hwupload`, unlike VAAPI. AMF takes software
 * frames directly and uploads them itself, which is not just less code -- it
 * is what makes this work on a laptop with two GPUs. VAAPI has to be told
 * which render node to use or it silently hands the wrong card's frames to the
 * encoder; AMF is AMD's own SDK and enumerates only AMD devices, so there is
 * no wrong card for it to pick.
 */
function planAmf({ capabilities, nodes, config, crf, explicit }) {
  const amd = nodes.find((n) => n.vendor === 'amd');
  const encoder = capabilities.encoders.has('av1_amf');

  if (!amd || !encoder) {
    // Only worth saying out loud when the user asked for this by name. Under
    // "auto" on a machine with no AMD GPU, falling through to the CPU is the
    // expected outcome, not a misconfiguration.
    if (explicit) {
      log.warn(
        !amd
          ? 'animatedArtwork.hardware.mode is "amf" but no AMD display adapter was found'
          : 'animatedArtwork.hardware.mode is "amf" but this ffmpeg has no av1_amf encoder'
      );
    }
    return null;
  }

  const qp = amfQp(config, crf);
  return {
    label: `av1_amf on ${amd.name || amd.node}`,
    input: [],
    // AMF accepts nv12 straight from the software filter chain.
    filter: 'format=nv12',
    output: [
      '-c:v', 'av1_amf',
      '-rc', 'cqp',
      // Both frame types get the same quantizer: this is a short seamless loop
      // where every frame is equally on screen, so there is no reason to spend
      // the bit budget unevenly.
      '-qp_i', String(qp),
      '-qp_p', String(qp),
      '-quality', 'high_quality',
    ],
  };
}

/**
 * crf -> AV1 quantizer index. The same 3.5x the VAAPI path uses, and it lands
 * in the same place: crf 20 (21.4MB on libsvtav1) against qp 70 (19.6MB) on a
 * 20s 2160px master.
 */
function amfQp(config, crf) {
  const explicit = Number(config.globalQuality);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return Math.max(1, Math.min(255, Math.round(crf * 3.5)));
}

/**
 * Hardware decode for the paths that encode on the CPU anyway (WebP, GIF, and
 * the AVIF fallback). Reading and scaling the master is most of the work there.
 */
export function planDecodeOnly({ capabilities, nodes, nvidia, config = {}, platform = process.platform }) {
  const args = decodeArgs({ capabilities, nodes, nvidia, config, platform });
  if (!args.length) return null;
  const api = args[args.indexOf('-hwaccel') + 1];
  const LABELS = { cuda: 'NVDEC decode', vaapi: 'VAAPI decode', d3d11va: 'D3D11VA decode' };
  return { label: LABELS[api] ?? `${api} decode`, input: args };
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
function decodeArgs({ capabilities, nodes = [], nvidia, config, platform = process.platform }) {
  if (config.decode !== true) return [];

  // D3D11VA is the vendor-neutral one on Windows: it serves the AMD iGPU, the
  // discrete NVIDIA card and Intel graphics through the same interface, so
  // there is no device to pick and nothing to get wrong.
  if (platform === 'win32') {
    return capabilities.hwaccels.has('d3d11va') ? ['-hwaccel', 'd3d11va'] : [];
  }

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
  const parts = nodes.map((n) => `${n.name || n.node} (${n.vendor})`);
  if (nvidia) parts.push('nvidia driver loaded');
  const encoders = ['av1_amf', 'av1_vaapi', 'av1_qsv', 'av1_nvenc', 'libsvtav1', 'libaom-av1'].filter(
    (e) => capabilities.encoders.has(e)
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
