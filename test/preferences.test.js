import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PROJECT_ROOT, loadPreferences, savePreferences } from '../src/config.js';

/*
 * What the tray menu changes is written to preferences.json, never to
 * config.json: the config is hand-written and commented, and writing it back
 * would strip every comment. These pin down the file, and the order it is
 * merged in.
 */

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a choice from the tray is written, read back, and changed again', (t) => {
  const file = path.join(tmp(t), 'not-yet', 'preferences.json');
  assert.deepEqual(loadPreferences(file), {}, 'nothing saved yet');

  savePreferences({ artistPhoto: false }, file);
  assert.deepEqual(loadPreferences(file), { artistPhoto: false });

  savePreferences({ artistPhoto: true }, file);
  assert.deepEqual(loadPreferences(file), { artistPhoto: true });
});

test('only known preferences of the right type are read', (t) => {
  const file = path.join(tmp(t), 'preferences.json');

  fs.writeFileSync(file, JSON.stringify({ artistPhoto: 'no', clientId: '1', hosting: { mode: 'command' } }));
  assert.deepEqual(loadPreferences(file), {}, 'it cannot become a second config file');

  for (const garbage of ['{ not json', 'null', '[true]']) {
    fs.writeFileSync(file, garbage);
    assert.deepEqual(loadPreferences(file), {}, garbage);
  }
});

test("the tray's choice wins over config.json, and an old \"no badge\" carries over", (t) => {
  const read = (config, preferences) => {
    // A fresh home for every run, pointed at from each platform's variable,
    // so the real preferences file is never in reach.
    const dir = tmp(t);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const env = {
      ...process.env,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      XDG_CONFIG_HOME: dir,
      XDG_CACHE_HOME: dir,
      HOME: dir,
      USERPROFILE: dir,
      YANPRESENCE_CONFIG: file,
    };
    for (const key of Object.keys(env)) {
      if (key.startsWith('YANPRESENCE_') && key !== 'YANPRESENCE_CONFIG') delete env[key];
    }
    const script = [
      "import { PREFERENCES_FILE, loadConfig, savePreferences } from './src/config.js';",
      `if (!PREFERENCES_FILE.startsWith(${JSON.stringify(dir)})) throw new Error('not isolated: ' + PREFERENCES_FILE);`,
      preferences ? `savePreferences(${JSON.stringify(preferences)});` : '',
      'console.log(JSON.stringify(loadConfig().artistPhoto));',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  assert.equal(read({}), true, 'on by default');
  assert.equal(read({ artistPhoto: false }), false);
  assert.equal(read({ artistPhoto: false }, { artistPhoto: true }), true, 'the tray wins');
  assert.equal(read({ artistPhoto: true }, { artistPhoto: false }), false, 'either way');
  assert.equal(read({ showSmallImage: false }), false, 'someone who turned the old badge off gets none');
  assert.equal(
    read({ showSmallImage: true, smallImageKey: 'applemusic' }),
    true,
    'an --init config from before gets the photo'
  );
});
