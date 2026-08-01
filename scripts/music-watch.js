#!/usr/bin/env osascript -l JavaScript
//
// Long-lived Music.app watcher. Emits one JSON object per line on stdout.
//
// Run under `osascript -l JavaScript`. Kept as a single persistent process
// rather than one osascript spawn per poll: spawning is ~15ms of process
// churn every tick, and a resident script keeps the Apple Event connection to
// Music.app warm.
//
// Environment:
//   YP_POLL_MS   poll interval in milliseconds (default 1000)
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

// Every property read is a separate Apple Event and any of them can fail for a
// given track kind (a radio stream has no album artist, a local file has no
// cloud status, and a track can vanish mid-read). Failing soft per-field keeps
// one missing property from dropping the whole tick.
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
  var music = Application('Music');

  // `.running()` is answered by the launch services registry, so it does not
  // start Music.app the way any other property access would.
  if (!safe(function () { return music.running(); }, false)) {
    return { state: 'closed' };
  }

  var state = normalizeState(safe(function () { return music.playerState(); }, 'unknown'));
  if (state !== 'playing' && state !== 'paused') {
    return { state: state };
  }

  // Read the position first: if the track changes right about now, a slightly
  // stale position self-corrects within a second via drift detection, whereas
  // mismatched metadata does not.
  var position = safe(function () { return music.playerPosition(); }, 0);

  // One Apple Event for the whole record. Reading name/artist/album as
  // separate events is NOT safe: `currentTrack` is a live specifier, so it
  // re-resolves per access, and a track change between two of them splices
  // fields from two different songs together -- "Flash Forward" by the artist
  // of the song that just started.
  var p = safe(function () { return music.currentTrack.properties(); }, null);
  if (!p || !p.name) return { state: 'stopped' };

  return {
    state: state,
    name: p.name,
    artist: p.artist || '',
    album: p.album || '',
    albumArtist: p.albumArtist || '',
    // Seconds, fractional.
    duration: p.duration || 0,
    position: position,
    // Stable within a library session; used to detect track changes even when
    // two tracks share a title.
    persistentId: p.persistentID || '',
    databaseId: p.databaseID || 0,
    // "Apple Music AAC audio file" for catalog streams, "Purchased AAC audio
    // file" / "MPEG audio file" / etc. for local library items.
    kind: p.kind || '',
    // Radio and some cloud items report mediaKind separately.
    mediaKind: p.mediaKind || '',
    year: p.year || 0,
    trackNumber: p.trackNumber || 0,
    discNumber: p.discNumber || 0,
    // Not part of the properties record; best-effort and non-critical, it only
    // gates the embedded-artwork fallback for local files.
    hasArtwork: safe(function () { return music.currentTrack.artworks.length > 0; }, false),
  };
}

var intervalMs = parseInt(env('YP_POLL_MS', '1000'), 10);
if (!isFinite(intervalMs) || intervalMs < 200) intervalMs = 1000;
var intervalSec = intervalMs / 1000;

// When Music.app is not running there is nothing to track, and waking every
// second to re-confirm that costs battery for no benefit -- which matters for
// an agent that runs from login and is idle most of the day. Music launching
// is not time-critical: playback starts after it opens, so noticing within a
// few seconds is fine.
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
