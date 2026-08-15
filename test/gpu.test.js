import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectRenderNodes,
  parseEncoders,
  pickVaapiNode,
  planAvif,
  planDecodeOnly,
} from '../src/gpu.js';
import { ArtworkHost } from '../src/artwork.js';
import { DEFAULTS } from '../src/config.js';
import { setLevel } from '../src/log.js';

setLevel('error');

/* A stand-in for /sys/class/drm. The real one is read the same way. */
function fakeDrm(nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanpresence-drm-'));
  for (const [name, vendor] of Object.entries(nodes)) {
    fs.mkdirSync(path.join(dir, name, 'device'), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'device', 'vendor'), `${vendor}\n`);
  }
  // Card nodes sit alongside the render nodes and must be ignored.
  fs.mkdirSync(path.join(dir, 'card1'), { recursive: true });
  return dir;
}

// The layout on the machine this was developed on: the discrete NVIDIA card is
// renderD128 and the AMD iGPU is renderD129 -- the opposite of what hardcoding
// "renderD128" for VAAPI assumes.
const LAPTOP = { renderD128: '0x10de', renderD129: '0x1002' };

const CAPABILITIES = (...encoders) => ({
  available: true,
  encoders: new Set(encoders),
  hwaccels: new Set(['vaapi', 'cuda', 'vulkan']),
});

test('render nodes are read with the vendor that owns them', () => {
  const drmClass = fakeDrm(LAPTOP);
  const nodes = detectRenderNodes({ drmClass });

  assert.deepEqual(
    nodes.map((n) => [n.node, n.vendor]),
    [
      ['/dev/dri/renderD128', 'nvidia'],
      ['/dev/dri/renderD129', 'amd'],
    ]
  );
  fs.rmSync(drmClass, { recursive: true, force: true });
});

test('VAAPI goes to the AMD device even when NVIDIA is renderD128', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  assert.equal(pickVaapiNode(nodes).node, '/dev/dri/renderD129');
  assert.equal(pickVaapiNode(nodes).vendor, 'amd');
});

test('an explicit device preference is honoured', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  assert.equal(pickVaapiNode(nodes, 'nvidia').node, '/dev/dri/renderD128');
  assert.equal(pickVaapiNode(nodes, '/dev/dri/renderD129').node, '/dev/dri/renderD129');
  assert.equal(pickVaapiNode([], 'amd'), null);
});

test('Intel is used when there is no AMD device', () => {
  const nodes = detectRenderNodes({
    drmClass: fakeDrm({ renderD128: '0x8086', renderD129: '0x10de' }),
  });
  assert.equal(pickVaapiNode(nodes).vendor, 'intel');
});

test("ffmpeg's encoder listing is parsed into names", () => {
  const listing = `Encoders:
 V..... = Video
 ------
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V..... av1_vaapi            AV1 (VAAPI) (codec av1)
 V....D libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder
 A....D aac                  AAC (Advanced Audio Coding)
`;
  const names = parseEncoders(listing);
  assert.ok(names.includes('av1_vaapi'));
  assert.ok(names.includes('av1_nvenc'));
  assert.ok(names.includes('libsvtav1'));
  assert.ok(!names.includes('='));
});

test('the GPU is never chosen on its own, however capable it looks', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  const capabilities = CAPABILITIES('av1_vaapi', 'av1_nvenc', 'libsvtav1');

  // Measured: Chromium refuses to decode av1_vaapi's AVIF, and Discord is
  // Electron. A faster encoder that produces an unreadable card is not a
  // default, so "auto" means the CPU.
  assert.equal(planAvif({ capabilities, nodes, nvidia: true, crf: 20 }), null);
  assert.equal(planAvif({ capabilities, nodes, nvidia: true, config: { mode: 'auto' }, crf: 20 }), null);
});

test('AVIF goes to the VAAPI device when explicitly asked for', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  const plan = planAvif({
    capabilities: CAPABILITIES('av1_vaapi', 'av1_nvenc', 'libsvtav1'),
    nodes,
    nvidia: true,
    config: { mode: 'vaapi' },
    crf: 20,
  });

  assert.ok(plan);
  assert.ok(plan.input.join(' ').includes('/dev/dri/renderD129'), 'uses the AMD node');
  assert.deepEqual(plan.output.slice(0, 2), ['-c:v', 'av1_vaapi']);
  // av1_vaapi has no -qp option at all; passing one is silently ignored.
  assert.ok(!plan.output.includes('-qp'));
  assert.equal(plan.output[plan.output.indexOf('-global_quality') + 1], '70');
  assert.equal(plan.filter, 'format=nv12,hwupload');

  // The device is named and pinned as the filter device. With a second GPU in
  // the machine, a bare -vaapi_device lets any -hwaccel win the filter chain
  // and the encoder is handed frames from the wrong vendor.
  assert.ok(!plan.input.includes('-vaapi_device'));
  assert.equal(plan.input[plan.input.indexOf('-init_hw_device') + 1], 'vaapi=va:/dev/dri/renderD129');
  assert.equal(plan.input[plan.input.indexOf('-filter_hw_device') + 1], 'va');
});

test('NVENC is never used for AVIF, even when forced', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm({ renderD128: '0x10de' }) });
  const plan = planAvif({
    capabilities: CAPABILITIES('av1_nvenc', 'libsvtav1'),
    nodes,
    nvidia: true,
    config: { mode: 'vaapi' },
    crf: 20,
  });
  // AV1-in-HEIF out of NVENC is not a supported combination; the CPU encoder
  // is correct here, not clever.
  assert.equal(plan, null);
});

test('no AV1 VAAPI encoder means no hardware plan', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  assert.equal(
    planAvif({ capabilities: CAPABILITIES('libsvtav1'), nodes, nvidia: false, config: { mode: 'vaapi' } }),
    null
  );
});

test('hardware can be turned off outright', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  const capabilities = CAPABILITIES('av1_vaapi');
  assert.equal(planAvif({ capabilities, nodes, nvidia: true, config: { mode: 'off' } }), null);
  assert.equal(planDecodeOnly({ capabilities, nodes, nvidia: true, config: { decode: false } }), null);
  assert.equal(
    planAvif({ capabilities, nodes, nvidia: true, config: { mode: 'vaapi', globalQuality: 120 }, crf: 20 })
      .output.at(-1),
    '120'
  );
});

test('hardware decode is opt-in, and prefers the discrete card when asked for', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  const capabilities = CAPABILITIES('av1_vaapi');

  // Measured to be a pessimisation on this workload, so it stays off unless
  // asked for by name.
  assert.equal(planDecodeOnly({ capabilities, nodes, nvidia: true }), null);

  assert.deepEqual(planDecodeOnly({ capabilities, nodes, nvidia: true, config: { decode: true } }).input, [
    '-hwaccel',
    'cuda',
  ]);
  assert.deepEqual(planDecodeOnly({ capabilities, nodes, nvidia: false, config: { decode: true } }).input, [
    '-hwaccel',
    'vaapi',
    '-hwaccel_device',
    '/dev/dri/renderD129',
  ]);
});

/* ---------------------------------------------------------------- *
 * The part that matters: a hardware encoder that does not work
 * ---------------------------------------------------------------- */

/** A fake ffmpeg that answers probes, and fails whichever encoder is named. */
function fakeFfmpeg({ failOn }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanpresence-ffmpeg-'));
  const calls = path.join(dir, 'calls.log');
  const ffmpeg = path.join(dir, 'ffmpeg');

  fs.writeFileSync(
    ffmpeg,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');

if (args.includes('-encoders')) {
  process.stdout.write('Encoders:\\n V..... av1_vaapi AV1 (VAAPI)\\n V....D libsvtav1 SVT-AV1\\n');
  process.exit(0);
}
if (args.includes('-hwaccels')) {
  process.stdout.write('Hardware acceleration methods:\\nvaapi\\ncuda\\n');
  process.exit(0);
}
if (args.some((a) => a.includes(${JSON.stringify(failOn)}))) {
  process.stderr.write('Function not implemented\\n');
  process.exit(1);
}
fs.writeFileSync(args[args.length - 1], 'encoded');
process.exit(0);
`,
    { mode: 0o755 }
  );

  const ffprobe = path.join(dir, 'ffprobe');
  fs.writeFileSync(ffprobe, `#!/usr/bin/env node\nprocess.stdout.write('20.6\\n');\n`, {
    mode: 0o755,
  });

  return { dir, ffmpeg, ffprobe, calls: () => fs.readFileSync(calls, 'utf8') };
}

function hostWith({ ffmpeg, ffprobe, drmClass }) {
  return new ArtworkHost({
    config: {
      animatedArtwork: {
        ...DEFAULTS.animatedArtwork,
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        hardware: { ...DEFAULTS.animatedArtwork.hardware, mode: 'vaapi', drmClass },
      },
      hosting: DEFAULTS.hosting,
      uploadLocalArtwork: false,
    },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'yanpresence-cache-')),
  });
}

test('AVIF is encoded on the GPU when the GPU can do it', async () => {
  const fake = fakeFfmpeg({ failOn: 'nothing-fails-here' });
  const host = hostWith({ ...fake, drmClass: fakeDrm(LAPTOP) });
  const out = path.join(fake.dir, 'out.avif');

  await host.encodeAvif({ input: 'in.mp4', out, size: 1024, crf: 20 });

  const log = fake.calls();
  assert.ok(log.includes('av1_vaapi'), 'used the hardware encoder');
  assert.ok(log.includes('/dev/dri/renderD129'), 'on the AMD device');
  assert.ok(!log.includes('libsvtav1'), 'did not also run the CPU encoder');
});

test('a hardware encoder that fails falls back to the CPU, once', async () => {
  const fake = fakeFfmpeg({ failOn: 'av1_vaapi' });
  const host = hostWith({ ...fake, drmClass: fakeDrm(LAPTOP) });
  const out = path.join(fake.dir, 'out.avif');

  await host.encodeAvif({ input: 'in.mp4', out, size: 1024, crf: 20 });

  assert.equal(fs.readFileSync(out, 'utf8'), 'encoded', 'the CPU encoder produced the file');
  assert.ok(fake.calls().includes('libsvtav1'));
  assert.equal(host.hwGaveUp, true);

  // The second track must not pay for the same discovery again.
  const before = fake.calls().split('\n').length;
  await host.encodeAvif({ input: 'in.mp4', out, size: 1024, crf: 20 });
  const after = fake.calls().split('\n');
  assert.equal(after.length - before, 1, 'exactly one more ffmpeg run');
  assert.ok(!after.at(-2).includes('av1_vaapi'), 'and it was not the hardware one');
});

test('this machine, whatever it is, is described without crashing', () => {
  // Not an assertion about the hardware -- just that reading the real sysfs
  // never throws, on a laptop with two GPUs or a VM with none.
  const nodes = detectRenderNodes();
  assert.ok(Array.isArray(nodes));
  for (const node of nodes) {
    assert.match(node.node, /^\/dev\/dri\/renderD\d+$/);
    assert.ok(typeof node.vendor === 'string');
  }
});
