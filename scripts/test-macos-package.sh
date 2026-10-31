#!/bin/bash
# Exercises the built disk image the way a Mac would run it: mounted, the app
# copied out to a folder whose path has spaces, opened through LaunchServices.
#
# It installs a separate identity, "yanpresence Smoke Test", under its own
# bundle identifier, so it never touches the real app, its login item, its
# Automation permission or its settings. Node's entry point is swapped for a
# probe -- as the Windows package test does -- so the menu bar app's wiring is
# checked without Discord, Music or a presence to fight over.
#
# Usage: scripts/test-macos-package.sh [--arch arm64|x64] [--skip-build]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
skip_build=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="${2:-}"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

name="yanpresence Smoke Test"
version="$(plutil -extract version raw -o - "$repo/package.json")"
dmg="$repo/dist/$name-$version-macos-$arch.dmg"
[ "$skip_build" = 1 ] || "$repo/scripts/build-macos.sh" --arch "$arch" --smoke-test-identity
[ -f "$dmg" ] || { echo "Missing test disk image: $dmg" >&2; exit 1; }

root="$repo/.build/Package Smoke $(uuidgen)"
mount="$root/mount"
results="$root/results"
app="$root/Apps With Spaces/$name.app"
second="$root/Second Copy/$name.app"
mkdir -p "$mount" "$results" "$(dirname "$app")" "$(dirname "$second")"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# The smoke test identity's own settings, which AppKit writes for it.
defaults_domain=com.ethanyanxu.yanpresence.smoke-test
defaults delete "$defaults_domain" 2>/dev/null || true

cleanup() {
  # Whatever a failed run left behind, found by where it runs from.
  pkill -9 -f "$root/" 2>/dev/null || true
  hdiutil detach -quiet "$mount" 2>/dev/null || true
  "$lsregister" -u "$app" 2>/dev/null || true
  "$lsregister" -u "$second" 2>/dev/null || true
  defaults delete "$defaults_domain" 2>/dev/null || true
  echo "Package test files: $root"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  for log in "$results"/*.log; do [ -f "$log" ] && { echo "--- $log" >&2; cat "$log" >&2; }; done
  exit 1
}

wait_for() {
  local seconds="$1" what="$2" deadline
  shift 2
  deadline=$((SECONDS + seconds))
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || fail "timed out after ${seconds}s waiting for $what"
    sleep 0.2
  done
}

alive() { kill -0 "$1" 2>/dev/null; }
gone() { ! kill -0 "$1" 2>/dev/null; }
exists() { [ -f "$1" ]; }
heard() { grep -q "\"$2\"" "$results/$1-heard.json" 2>/dev/null; }
logged() { grep -q "$1" "$results/app.log" 2>/dev/null; }
field() { plutil -extract "$2" raw -o - "$results/$1-started.json"; }
parent_of() { ps -o ppid= -p "$1" | tr -d ' '; }

expect() {
  local actual="$1" expected="$2" what="$3"
  [ "$actual" = "$expected" ] || fail "$what: expected '$expected', got '$actual'"
}

# --- the disk image ----------------------------------------------------------

hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg"
[ -d "$mount/$name.app" ] || fail "the disk image has no $name.app"
expect "$(readlink "$mount/Applications")" /Applications "the disk image's Applications link"
codesign --verify --strict --deep "$mount/$name.app" || fail "the app on the disk image is not validly signed"
ditto "$mount/$name.app" "$app"
hdiutil detach -quiet "$mount"
[ ! -e "$app/Contents/Resources/app/config.json" ] || fail "the app includes a private config.json"
for file in MacOS/yanpresence MacOS/node MacOS/ffmpeg MacOS/ffprobe Resources/yanpresence.icns \
  Resources/app/bin/yanpresence.js Resources/app/scripts/music-watch.js Resources/app/scripts/tv-watch.js \
  Resources/app/runtime/ffmpeg/LICENSE.txt Resources/app/THIRD-PARTY-NOTICES.txt; do
  [ -e "$app/Contents/$file" ] || fail "missing from the app: $file"
done
"$app/Contents/MacOS/node" "$app/Contents/Resources/app/bin/yanpresence.js" --help >/dev/null \
  || fail "the installed app did not run"

# --- the probe ---------------------------------------------------------------

# Stands in for Node's real entry point. It records how it was started, talks
# to the menu bar app the way src/tray.js does, and starts a child of its own
# -- a stand-in for an osascript watcher or an ffmpeg encode -- that it never
# stops itself: the app must not leave it running however the probe goes.
cat > "$app/Contents/Resources/app/bin/yanpresence.js" <<'PROBE'
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Beside the folders the copies are installed in, found from here rather than
// passed in: a copy the app relaunches itself gets no environment from the test.
const dir = path.resolve(fileURLToPath(import.meta.url), '../../../../../../../results');
const tag = process.env.YP_SMOKE_TAG || 'relaunched';
const record = (what, value) => fs.writeFileSync(path.join(dir, `${tag}-${what}.json`), JSON.stringify(value));
const which = (name) => spawnSync('/usr/bin/which', [name], { encoding: 'utf8' }).stdout.trim();

const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const heard = [];
const channel = new net.Socket({ fd: Number(process.env.YANPRESENCE_MENU_FD), readable: true, writable: true });
channel.setEncoding('utf8');
let buffer = '';
channel.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    heard.push(line);
    record('heard', heard);
    if (line === 'quit' && !fs.existsSync(path.join(dir, 'hang'))) process.exit(0);
  }
});

const logFile = path.join(dir, 'app.log');
fs.appendFileSync(logFile, '');
channel.write(`${JSON.stringify({ type: 'hello', logFile, artistPhoto: true })}\n`);
channel.write(`${JSON.stringify({ type: 'status', tooltip: 'smoke', line: 'Smoke test' })}\n`);
record('started', {
  pid: process.pid,
  helperPid: helper.pid,
  execPath: process.execPath,
  argv: process.argv,
  cwd: process.cwd(),
  menuFd: process.env.YANPRESENCE_MENU_FD,
  ffmpeg: which('ffmpeg'),
  ffprobe: which('ffprobe'),
  ffmpegStatus: spawnSync('ffmpeg', ['-version']).status,
  ffprobeStatus: spawnSync('ffprobe', ['-version']).status,
});
setInterval(() => {}, 1000);
PROBE
# Re-sealed after the swap, so the copy is as valid as a real installation.
codesign --force --sign - "$app" 2>/dev/null
ditto "$app" "$second"

launch() {
  local tag="$1" bundle="$2"
  open -n --env "YP_SMOKE_TAG=$tag" "$bundle"
  wait_for 30 "the app to start Node ($tag)" exists "$results/$tag-started.json"
}

# --- started the way Finder starts it ----------------------------------------

launch a "$app"
node_pid="$(field a pid)"
helper_pid="$(field a helperPid)"
app_pid="$(parent_of "$node_pid")"
expect "$(ps -o comm= -p "$app_pid")" "$app/Contents/MacOS/yanpresence" "Node's parent"
expect "$(field a execPath)" "$app/Contents/MacOS/node" "the Node runtime"
expect "$(field a argv.1)" "$app/Contents/Resources/app/bin/yanpresence.js" "the entry point"
expect "$(field a argv.2)" --tray "tray mode"
expect "$(field a cwd)" "$app/Contents/Resources/app" "the working directory"
expect "$(field a menuFd)" 3 "the menu bar channel"
expect "$(field a ffmpeg)" "$app/Contents/MacOS/ffmpeg" "ffmpeg on PATH"
expect "$(field a ffprobe)" "$app/Contents/MacOS/ffprobe" "ffprobe on PATH"
expect "$(field a ffmpegStatus)/$(field a ffprobeStatus)" 0/0 "the bundled ffmpeg and ffprobe"
wait_for 10 "the menu bar app to answer hello" heard a ready

# --- Node crashing is survived -----------------------------------------------

rm "$results/a-started.json"
kill -9 "$node_pid"
wait_for 20 "Node to be restarted" exists "$results/a-started.json"
[ "$(field a pid)" != "$node_pid" ] || fail "Node was not restarted"
expect "$(parent_of "$(field a pid)")" "$app_pid" "the restarted Node's parent"
wait_for 10 "the crashed Node's child to be stopped" gone "$helper_pid"
logged "restarting it in 1s" || fail "the restart was not logged"

# --- quitting clears up everything -------------------------------------------

node_pid="$(field a pid)"
helper_pid="$(field a helperPid)"
kill -TERM "$app_pid"
wait_for 15 "the app to quit" gone "$app_pid"
heard a quit || fail "the app quit without asking Node to"
gone "$node_pid" || fail "quitting the app left Node running"
wait_for 5 "Node's child to be stopped" gone "$helper_pid"
# AppKit remembers a hidden status item across launches; a quit that hid the
# icon would leave the next launch without one.
if defaults read "$defaults_domain" 2>/dev/null | grep -q 'NSStatusItem Visible.* = 0'; then
  fail "quitting left the menu bar icon hidden for the next launch"
fi

# --- a Node that will not quit is stopped anyway -----------------------------

touch "$results/hang"
launch b "$app"
node_pid="$(field b pid)"
helper_pid="$(field b helperPid)"
app_pid="$(parent_of "$node_pid")"
wait_for 10 "the menu bar app to answer hello (b)" heard b ready
kill -TERM "$app_pid"
wait_for 20 "the app to stop a hung Node and quit" gone "$app_pid"
gone "$node_pid" || fail "a hung Node outlived the app"
wait_for 5 "the hung Node's child to be stopped" gone "$helper_pid"
logged "did not stop within 8s" || fail "stopping a hung Node was not logged"
rm "$results/hang"

# --- the copy opened last takes over -----------------------------------------

launch c "$app"
first_node="$(field c pid)"
first_app="$(parent_of "$first_node")"
wait_for 10 "the first copy to answer hello" heard c ready
launch d "$second"
second_node="$(field d pid)"
second_app="$(parent_of "$second_node")"
expect "$(ps -o comm= -p "$second_app")" "$second/Contents/MacOS/yanpresence" "the second copy's parent"
wait_for 15 "the first copy to give way" gone "$first_app"
heard c quit || fail "the first copy was not asked to quit"
gone "$first_node" || fail "the first copy's Node is still running"
alive "$second_node" || fail "the second copy's Node did not keep running"

# --- opened again after an upgrade, the new version takes over ----------------

# What dragging a newer version over the running one from a new disk image
# leaves: the bundle on disk is not the version in memory. Opening it reaches
# the running copy, which starts the new one in its place.
plutil -replace CFBundleVersion -string "${version%.*}.$((${version##*.} + 1))" "$second/Contents/Info.plist"
codesign --force --sign - "$second" 2>/dev/null
rm "$results/d-started.json"
open "$second"
# The relaunched copy may or may not inherit the old one's environment, and so
# its tag; either file means it started.
relaunched() { exists "$results/d-started.json" || exists "$results/relaunched-started.json"; }
wait_for 30 "the upgraded copy to start" relaunched
tag=d
exists "$results/d-started.json" || tag=relaunched
wait_for 15 "the old version to give way" gone "$second_app"
gone "$second_node" || fail "the old version's Node is still running"
upgraded_node="$(field "$tag" pid)"
upgraded_app="$(parent_of "$upgraded_node")"
expect "$(ps -o comm= -p "$upgraded_app")" "$second/Contents/MacOS/yanpresence" "the upgraded copy"
kill -TERM "$upgraded_app"
wait_for 15 "the upgraded copy to quit" gone "$upgraded_app"

echo "PASS: disk image, bundled runtime and tools, paths with spaces, menu bar channel, restart after a crash, quit, a hung Node, the newest copy taking over, and an upgrade in place."
