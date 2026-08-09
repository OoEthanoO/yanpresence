#!/usr/bin/env osascript -l JavaScript
//
// Long-lived TV.app watcher. Emits one JSON object per line on stdout.
//
// TV.app descends from the same iTunes scripting dictionary as Music.app, so
// this mirrors scripts/music-watch.js almost exactly -- `player state`,
// `player position` and a single `current track` properties read. What differs
// is the metadata: a show, a season and an episode number instead of an artist
// and an album.
//
// Environment:
//   YP_POLL_MS       poll interval in milliseconds (default 1000)
//   YP_IDLE_POLL_MS  poll interval while TV.app is closed (default 5000)
//
'use strict';

ObjC.import('Foundation');

var stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function write(line) {
  var str = $.NSString.alloc.initWithUTF8String(line + '\n');
  var data = str.dataUsingEncoding($.NSUTF8StringEncoding);
  // writeData throws on a closed pipe (parent died); let it kill the script.
  stdout.writeData(data);
}

function env(key, fallback) {
  try {
    var value = $.NSProcessInfo.processInfo.environment.objectForKey(key);
    if (!value || value.isNil()) return fallback;
    return ObjC.unwrap(value);
  } catch (e) {
    return fallback;
  }
}

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function normalizeState(raw) {
  var s = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
  if (s.indexOf('playing') !== -1) return 'playing';
  if (s.indexOf('paused') !== -1) return 'paused';
  if (s.indexOf('stopped') !== -1) return 'stopped';
  if (s.indexOf('forward') !== -1 || s.indexOf('rewind') !== -1) return 'playing';
  return s || 'unknown';
}

function snapshot() {
  var tv = Application('TV');

  // `.running()` is answered by the launch services registry, so it does not
  // start TV.app the way any other property access would.
  if (!safe(function () { return tv.running(); }, false)) {
    return { state: 'closed' };
  }

  var state = normalizeState(safe(function () { return tv.playerState(); }, 'unknown'));
  if (state !== 'playing' && state !== 'paused') {
    return { state: state };
  }

  var position = safe(function () { return tv.playerPosition(); }, 0);

  // One Apple Event for the whole record, for the same reason as Music:
  // `currentTrack` is a live specifier that re-resolves on every access, so
  // reading fields separately can splice two different episodes together.
  var p = safe(function () { return tv.currentTrack.properties(); }, null);
  if (!p || !p.name) return { state: 'stopped' };

  return {
    state: state,
    name: p.name,
    show: p.show || '',
    seasonNumber: p.seasonNumber || 0,
    episodeNumber: p.episodeNumber || 0,
    episodeId: p.episodeID || '',
    // "TV show" for episodes, "movie" for films. Decides the layout.
    mediaKind: String(p.mediaKind || ''),
    duration: p.duration || 0,
    position: position,
    persistentId: p.persistentID || '',
    databaseId: p.databaseID || 0,
    kind: p.kind || '',
    year: p.year || 0,
    director: p.director || '',
    description: p.description || '',
    // Apple TV+ streams carry no embedded artwork; downloaded purchases can.
    hasArtwork: safe(function () { return tv.currentTrack.artworks.length > 0; }, false),
  };
}

var intervalMs = parseInt(env('YP_POLL_MS', '1000'), 10);
if (!isFinite(intervalMs) || intervalMs < 200) intervalMs = 1000;
var intervalSec = intervalMs / 1000;

var idleMs = parseInt(env('YP_IDLE_POLL_MS', '5000'), 10);
if (!isFinite(idleMs) || idleMs < intervalMs) idleMs = Math.max(intervalMs, 5000);
var idleSec = idleMs / 1000;

write(JSON.stringify({ state: 'watcher-ready', intervalMs: intervalMs, idleMs: idleMs }));

while (true) {
  var payload;
  try {
    payload = snapshot();
  } catch (e) {
    payload = { state: 'error', error: String(e) };
  }
  write(JSON.stringify(payload));
  $.NSThread.sleepForTimeInterval(payload.state === 'closed' ? idleSec : intervalSec);
}
