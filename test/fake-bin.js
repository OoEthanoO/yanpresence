import fs from 'node:fs';
import path from 'node:path';

/**
 * Why some tests do not run on Windows.
 *
 * Several tests stand in for a program the source shells out to -- busctl,
 * ffmpeg -- by writing a `#!/usr/bin/env node` file and setting the execute
 * bit, so that the argument handling and the output parsing are exercised for
 * real rather than mocked away. Windows has neither shebangs nor an execute
 * bit, and the obvious workaround does not work either: a .cmd shim cannot be
 * spawned at all without `shell: true`, which Node has required since the
 * BatBadBut fix and which the code under test quite rightly does not pass.
 *
 * Skipping is the honest answer rather than a defeat. Both programs being
 * faked here are Linux-only concerns -- busctl is the session bus, av1_vaapi
 * is Mesa -- so the coverage being lost on Windows is coverage of code that
 * cannot run on Windows. The Windows source is tested directly instead, in
 * test/smtc.test.js, where the parsing is pure functions and there is nothing
 * to spawn.
 */
export const NO_FAKE_BIN =
  process.platform === 'win32'
    ? 'needs a spawnable fake executable, which Windows will not do for a script'
    : false;

/** Writes a fake executable that runs a snippet of Node. POSIX only. */
export function writeFakeBin(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return file;
}
