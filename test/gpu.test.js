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
import { NO_FAKE_BIN } from './fake-bin.js';

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

test('VAAPI is never chosen on its own, however capable it looks', () => {
  const nodes = detectRenderNodes({ drmClass: fakeDrm(LAPTOP) });
  const capabilities = CAPABILITIES('av1_vaapi', 'av1_nvenc', 'libsvtav1');
  const linux = { platform: 'linux' };

  // Measured: Chromium refuses to decode av1_vaapi's AVIF, and Discord is
  // Electron. A faster encoder that produces an unreadable card is not a
  // default, so "auto" means the CPU here.
  assert.equal(planAvif({ capabilities, nodes, nvidia: true, crf: 20, ...linux }), null);
  assert.equal(
    planAvif({ capabilities, nodes, nvidia: true, config: { mode: 'auto' }, crf: 20, ...linux }),
    null
  );
});

/* ---------------------------------------------------------------- *
 * AMF, which is the one hardware encoder that produces a readable card
 * ---------------------------------------------------------------- */

const AMD_ADAPTER = { node: 'AMD Radeon 780M Graphics', vendor: 'amd', name: 'AMD Radeon 780M Graphics' };
const NVIDIA_ADAPTER = { node: 'NVIDIA GeForce RTX 4070 Laptop GPU', vendor: 'nvidia', name: 'RTX 4070' };

test('AMF is chosen on its own on Windows, where the output does decode', () => {
  const plan = planAvif({
    capabilities: CAPABILITIES('av1_amf', 'av1_nvenc', 'libsvtav1'),
    nodes: [NVIDIA_ADAPTER, AMD_ADAPTER],
    nvidia: false,
    config: { mode: 'auto' },
    crf: 20,
    platform: 'win32',
  });

  assert.ok(plan);
  assert.deepEqual(plan.output.slice(0, 2), ['-c:v', 'av1_amf']);
  assert.equal(plan.output[plan.output.indexOf('-rc') + 1], 'cqp');
  // The same 3.5x the VAAPI path uses: crf 20 lands on qp 70.
  assert.equal(plan.output[plan.output.indexOf('-qp_i') + 1], '70');
  assert.equal(plan.output[plan.output.indexOf('-qp_p') + 1], '70');

  // No device to name and no hwupload: AMF enumerates only AMD devices and
  // takes software frames itself, which is what makes it safe on a machine
  // that also has an NVIDIA card.
  assert.deepEqual(plan.input, []);
  assert.equal(plan.filter, 'format=nv12');
  assert.ok(plan.label.includes('780M'), 'names the adapter it picked');
});

test('AMF falls through to the CPU without an AMD card or the encoder', () => {
  const windows = { nvidia: false, config: { mode: 'auto' }, crf: 20, platform: 'win32' };

  assert.equal(
    planAvif({ capabilities: CAPABILITIES('av1_amf', 'libsvtav1'), nodes: [NVIDIA_ADAPTER], ...windows }),
    null,
    'an NVIDIA-only machine gets no AMF plan'
  );
  assert.equal(
    planAvif({ capabilities: CAPABILITIES('libsvtav1'), nodes: [AMD_ADAPTER], ...windows }),
    null,
    'nor does an ffmpeg built without av1_amf'
  );
});

test('"off" still means off on Windows, and globalQuality still overrides', () => {
  const capabilities = CAPABILITIES('av1_amf', 'libsvtav1');
  const nodes = [AMD_ADAPTER];

  assert.equal(
    planAvif({ capabilities, nodes, nvidia: false, config: { mode: 'off' }, crf: 20, platform: 'win32' }),
    null
  );
  const forced = planAvif({
    capabilities,
    nodes,
    nvidia: false,
    config: { mode: 'amf', globalQuality: 120 },
    crf: 20,
    platform: 'win32',
  });
  assert.equal(forced.output[forced.output.indexOf('-qp_i') + 1], '120');
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
  // Stated rather than inherited from the host: this describes the Linux
  // choice between NVDEC and VAAPI, and Windows makes a different one.
  const linux = { platform: 'linux' };

  // Measured to be a pessimisation on this workload, so it stays off unless
  // asked for by name.
  assert.equal(planDecodeOnly({ capabilities, nodes, nvidia: true, ...linux }), null);

  assert.deepEqual(
    planDecodeOnly({ capabilities, nodes, nvidia: true, config: { decode: true }, ...linux }).input,
    ['-hwaccel', 'cuda']
  );
  assert.deepEqual(
    planDecodeOnly({ capabilities, nodes, nvidia: false, config: { decode: true }, ...linux }).input,
    ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129']
  );
});

test('Windows decodes through D3D11VA, whichever card is in the machine', () => {
  const capabilities = CAPABILITIES('av1_amf');
  capabilities.hwaccels = new Set(['d3d11va', 'cuda', 'qsv']);
  const nodes = [{ node: 'AMD Radeon 780M Graphics', vendor: 'amd', name: 'AMD Radeon 780M Graphics' }];
  const windows = { platform: 'win32' };

  assert.equal(planDecodeOnly({ capabilities, nodes, nvidia: false, ...windows }), null);

  // D3D11VA and no device argument: it is the vendor-neutral interface, so
  // there is nothing to pick and nothing to get wrong.
  const plan = planDecodeOnly({ capabilities, nodes, nvidia: true, config: { decode: true }, ...windows });
  assert.deepEqual(plan.input, ['-hwaccel', 'd3d11va']);
  assert.equal(plan.label, 'D3D11VA decode');
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

test('AVIF is encoded on the GPU when the GPU can do it', { skip: NO_FAKE_BIN }, async () => {
  const fake = fakeFfmpeg({ failOn: 'nothing-fails-here' });
  const host = hostWith({ ...fake, drmClass: fakeDrm(LAPTOP) });
  const out = path.join(fake.dir, 'out.avif');

  await host.encodeAvif({ input: 'in.mp4', out, size: 1024, crf: 20 });

  const log = fake.calls();
  assert.ok(log.includes('av1_vaapi'), 'used the hardware encoder');
  assert.ok(log.includes('/dev/dri/renderD129'), 'on the AMD device');
  assert.ok(!log.includes('libsvtav1'), 'did not also run the CPU encoder');
});

test('a hardware encoder that fails falls back to the CPU, once', { skip: NO_FAKE_BIN }, async () => {
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
