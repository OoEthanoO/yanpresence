#!/bin/bash
# Build the self-contained macOS app and its disk image. Run on macOS, from any
# directory, with the Xcode command line tools for swiftc; no globally
# installed Node or FFmpeg is required.
#
# Usage: scripts/build-macos.sh [--arch arm64|x64] [--version X.Y.Z]
#                               [--stage-only] [--smoke-test-identity]
#
#   --arch                 arm64 (Apple silicon) or x64 (Intel). Defaults to
#                          this Mac's. The bundled programs are run as a check,
#                          so building for Intel on Apple silicon needs Rosetta.
#   --version              Defaults to package.json's.
#   --stage-only           Stop at the .app in .build/, without a disk image.
#   --smoke-test-identity  Build "yanpresence Smoke Test.app" under its own
#                          bundle identifier, for scripts/test-macos-package.sh.
#                          It can never be mistaken for, or replace, a real
#                          installation, its login item or its permissions.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$repo/.build"
downloads="$build/downloads"
dist="$repo/dist"
manifest="$repo/installer/macos-dependencies.json"

case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
version=""
stage_only=0
app_name="yanpresence"
bundle_id="com.ethanyanxu.yanpresence"
suffix=""

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --stage-only) stage_only=1; shift ;;
    --smoke-test-identity)
      app_name="yanpresence Smoke Test"
      bundle_id="com.ethanyanxu.yanpresence.smoke-test"
      suffix="-smoke-test"
      shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$arch" in
  arm64) triple="arm64-apple-macos13.5" ;;
  x64) triple="x86_64-apple-macos13.5" ;;
  *) echo "--arch must be arm64 or x64 (got $arch)" >&2; exit 2 ;;
esac

manifest_value() { plutil -extract "$1" raw -o - "$manifest"; }

[ -n "$version" ] || version="$(plutil -extract version raw -o - "$repo/package.json")"
# CFBundleVersion is at most three integers.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "App versions must have three numeric components (got $version)." >&2
  exit 2
fi

# Downloads once into .build/downloads, under a name of our choosing -- every
# FFmpeg build is called ffmpeg.zip -- and refuses anything whose SHA-256 is
# not the pinned one.
verified_download() {
  local key="$1" name="$2" url sha actual
  url="$(manifest_value "$key.url")"
  sha="$(manifest_value "$key.sha256")"
  mkdir -p "$downloads"
  if [ ! -f "$downloads/$name" ]; then
    echo "Downloading $url" >&2
    curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
      --output "$downloads/$name.part" "$url"
    mv "$downloads/$name.part" "$downloads/$name"
  fi
  actual="$(shasum -a 256 "$downloads/$name" | awk '{print $1}')"
  if [ "$actual" != "$sha" ]; then
    echo "SHA-256 mismatch for $downloads/$name. Remove that download and retry." >&2
    echo "Expected $sha, received $actual." >&2
    return 1
  fi
  printf '%s\n' "$downloads/$name"
}

# The only recursive deletes here. Resolved paths outside .build/ are refused:
# no argument must ever turn a clean build into data loss.
reset_dir() {
  case "$1" in
    "$build"/?*) ;;
    *) echo "Refusing to clean a directory outside $build: $1" >&2; exit 1 ;;
  esac
  rm -rf "$1"
  mkdir -p "$1"
}

# Runs a bundled program for the architecture being built.
run_bundled() {
  if [ "$arch" = x64 ] && [ "$(uname -m)" = arm64 ]; then
    arch -x86_64 "$@"
  else
    "$@"
  fi
}

node_version="$(manifest_value node.version)"
ffmpeg_version="$(manifest_value ffmpeg.version)"
node_root="$(manifest_value "node.$arch.root")"
node_archive="$(verified_download "node.$arch" "node-v$node_version-darwin-$arch.tar.gz")"
ffmpeg_zip="$(verified_download "ffmpeg.$arch.ffmpeg" "ffmpeg-$ffmpeg_version-macos-$arch.zip")"
ffprobe_zip="$(verified_download "ffmpeg.$arch.ffprobe" "ffprobe-$ffmpeg_version-macos-$arch.zip")"
ffmpeg_build_info="$(verified_download "ffmpeg.$arch.buildInfo" "ffmpeg-$ffmpeg_version-macos-$arch-versions.txt")"
ffmpeg_license="$(verified_download ffmpeg.license "ffmpeg-$ffmpeg_version-COPYING.GPLv3")"

stage="$build/macos-$arch$suffix"
unpack="$build/unpack-$arch$suffix"
app="$stage/$app_name.app"
contents="$app/Contents"
payload="$contents/Resources/app"
reset_dir "$stage"
reset_dir "$unpack"
mkdir -p "$contents/MacOS" "$payload/scripts" "$payload/runtime/ffmpeg"

echo "Compiling the menu bar app for $triple"
xcrun swiftc -O -swift-version 5 -target "$triple" \
  -o "$contents/MacOS/yanpresence" "$repo/macos/yanpresence.swift"

# An allowlist keeps config.json, .env files, credentials, worker deployments,
# tests, and build caches out of the app even in a developer checkout. -X:
# without extended attributes, which codesign refuses to seal.
for folder in bin src assets browser; do
  cp -RX "$repo/$folder" "$payload/"
done
for file in package.json config.example.json README.md; do
  cp -X "$repo/$file" "$payload/"
done
for helper in music-watch.js tv-watch.js dump-artwork.applescript; do
  cp -X "$repo/scripts/$helper" "$payload/scripts/"
done
cp -X "$repo/installer/THIRD-PARTY-NOTICES-macos.txt" "$payload/THIRD-PARTY-NOTICES.txt"

# The runtime. Executables go in Contents/MacOS, where a bundle's code belongs
# and where codesign and Gatekeeper look for it; src/config.js finds ffmpeg
# there. Each keeps its publisher's own signature.
tar -xzf "$node_archive" -C "$unpack" "$node_root/bin/node" "$node_root/LICENSE"
mv "$unpack/$node_root/bin/node" "$contents/MacOS/node"
mv "$unpack/$node_root/LICENSE" "$payload/runtime/NODE-LICENSE.txt"
unzip -q "$ffmpeg_zip" ffmpeg -d "$unpack"
unzip -q "$ffprobe_zip" ffprobe -d "$unpack"
mv "$unpack/ffmpeg" "$unpack/ffprobe" "$contents/MacOS/"
cp -X "$ffmpeg_license" "$payload/runtime/ffmpeg/LICENSE.txt"
cp -X "$ffmpeg_build_info" "$payload/runtime/ffmpeg/BUILD.txt"
cp -X "$manifest" "$payload/runtime/dependencies.json"
rm -rf "$unpack"

sed -e "s/@APP_NAME@/$app_name/g" -e "s/@BUNDLE_ID@/$bundle_id/g" -e "s/@VERSION@/$version/g" \
  "$repo/macos/Info.plist" > "$contents/Info.plist"
plutil -lint "$contents/Info.plist" >/dev/null
printf 'APPL????' > "$contents/PkgInfo"
cp -X "$repo/assets/yanpresence.icns" "$contents/Resources/yanpresence.icns"

# Fail here if an upstream archive lacks our default CPU AV1 encoder, rather
# than shipping an app whose artwork silently fails.
echo "Checking the bundled runtime"
if ! run_bundled "$contents/MacOS/node" --version; then
  if [ "$arch" = x64 ] && [ "$(uname -m)" = arm64 ]; then
    echo "Building for Intel on Apple silicon runs the bundled programs under Rosetta:" >&2
    echo "  softwareupdate --install-rosetta" >&2
  fi
  echo "The bundled Node runtime did not start." >&2
  exit 1
fi
if ! run_bundled "$contents/MacOS/ffmpeg" -hide_banner -encoders 2>&1 | grep -qw libsvtav1; then
  echo "Bundled FFmpeg must include libsvtav1." >&2
  exit 1
fi
run_bundled "$contents/MacOS/ffprobe" -version | head -n 1
run_bundled "$contents/MacOS/node" "$payload/bin/yanpresence.js" --help >/dev/null
# The app must reach its own ffmpeg without PATH: --doctor run against the
# installed app from a terminal has no launcher to set PATH for it.
resolved="$(run_bundled "$contents/MacOS/node" -e \
  "import(require('node:url').pathToFileURL(process.argv[1]).href).then((m) => console.log(m.DEFAULTS.animatedArtwork.ffmpegPath))" \
  "$payload/src/config.js")"
if [ "$resolved" != "$contents/MacOS/ffmpeg" ]; then
  echo "The app resolves ffmpeg to $resolved, not its bundled copy." >&2
  exit 1
fi

# Ad-hoc: there is no Developer ID to sign with, so the app is not notarized
# and Gatekeeper asks once before it first opens (see the README). Signing
# still seals the bundle, and Apple silicon runs nothing unsigned.
xattr -cr "$app"
codesign --force --sign - "$app"
codesign --verify --strict --deep "$app"
echo "Signed $app"

if [ "$stage_only" = 1 ]; then
  echo "Staged application: $app"
  exit 0
fi

# The disk image: the app beside a link to Applications, which is the whole
# installer -- drag one onto the other.
dmg_root="$build/dmg-$arch$suffix"
reset_dir "$dmg_root"
ditto "$app" "$dmg_root/$app_name.app"
ln -s /Applications "$dmg_root/Applications"
mkdir -p "$dist"
output="$dist/$app_name-$version-macos-$arch.dmg"
rm -f "$output"
# hdiutil fails now and then on a busy CI machine with "Resource busy"; a
# retry is the known remedy.
attempt=1
until hdiutil create -quiet -volname "$app_name" -srcfolder "$dmg_root" -fs HFS+ -format ULMO "$output"; do
  if [ "$attempt" -ge 3 ]; then
    echo "hdiutil could not create $output" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  echo "hdiutil failed; retrying" >&2
  sleep 5
done
rm -rf "$dmg_root"
hdiutil verify -quiet "$output"

hash="$(shasum -a 256 "$output" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$(basename "$output")" > "$output.sha256"
echo "Disk image: $output"
echo "SHA-256: $hash"
