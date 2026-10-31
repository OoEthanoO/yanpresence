# yanpresence

Apple Music → Discord Rich Presence, for macOS, Windows and Linux.

Watches the **Music** app over Apple Events on macOS, the **Apple Music** and
**Apple TV** apps on Windows, and the **web players** at
`music.apple.com` and `tv.apple.com` on Linux, and mirrors what you're playing
into Discord — laid out like Discord's own Spotify integration, with the song
name on your status line instead of the artist, full-size album art, and the
song, artist and album all clickable through to Apple Music.

In the member list and under your name on your profile — the one-line status
everyone sees at a glance:

```
  yanxu
  Listening to Be Her          ← the song, not the app, not the artist
```

And expanded, when someone clicks into your profile:

```
  Listening to Apple Music
  ┌────────────┐
  │            │   Be Her            ← clickable → the song on Apple Music
  │ album art  │   Ella Langley      ← clickable → the artist
  │  1024×1024 │   ▓▓▓▓▓░░░░░ 1:04   ← live progress
  └─────────(●)┘                     ← the artist's photo, clickable → the artist
     ↑ hover shows the album, click opens it
```

## What it does

- **Three ways in, one pipeline.** On macOS, playback state comes from Apple
  Events sent to `Music.app` and `TV.app`. On Windows, Apple Music publishes a
  System Media Transport Controls session — the record behind the flyout over
  the volume overlay — while Apple TV publishes nothing at all and is read off
  its own UI Automation tree. On Linux, it comes from
  the Apple Music web player in your browser — over a companion extension, over
  MPRIS on the session bus, or both. Everything past that point (catalog
  lookups, links, artwork, the card itself) is identical, because the sources
  hand back identical snapshots. Apple TV works on macOS and Windows and not in
  a browser; see [Windows](#windows) and
  [Linux and the web player](#linux-and-the-web-player).
- **The song name on the status line.** Discord's `status_display_type` picks
  which field lands on the one-line status under your name. Spotify sets it to
  `STATE`, which is why its status reads as the *artist*; this sets `DETAILS`,
  so yours reads **"Listening to Be Her"**.

  The expanded card's header is a separate thing, and it always comes from the
  application's name — Discord's docs are explicit that *"you can't set App Name
  when setting presence"*. The shared application is already named
  `Apple Music`, so the header reads "Listening to Apple Music" while the
  status line reads the song. No Developer Portal setup is needed.
- **1024×1024 album art**, pulled from Apple's artwork CDN at full square size —
  the asset size Discord's own docs recommend.
- **Animated album art** where Apple has published motion artwork — the *full*
  loop at source framerate, transcoded from Apple's HLS master to animated AVIF
  (see [Animated artwork](#animated-artwork)).
- **The artist's photo** in the small circle on the cover's corner, where
  Apple Music has one. It comes with the catalog match and is served straight
  from Apple's CDN. Switch it off from the menu bar on macOS or the tray menu
  on Windows, or with `artistPhoto: false`.
- **Four clickable links.** Song → `details_url`, artist → `state_url`,
  album → the artwork's `large_url`, and the artist again from the photo's
  `small_url`. All point at `music.apple.com`.
- **Live progress bar**, with seek detection — scrub the track and the bar
  follows.
- **Nothing shown while paused.** Pause and the status disappears, the same way
  Discord's Spotify integration behaves. Set `showWhenPaused: true` to keep it
  up instead.
- Survives Discord restarts, Music.app restarts, and sleep/wake.

## Install on Windows

[**Download the installer**](https://github.com/OoEthanoO/yanpresence/releases/latest/download/yanpresence-windows-x64-setup.exe)
(also on [the website](https://presence.ethanyanxu.com/#get)), run it, and
finish the installer. It is not code-signed yet, so Windows SmartScreen may
warn you: choose **More info → Run anyway**. It
includes Node.js, ffmpeg and ffprobe, installs for your Windows user without
administrator access, adds yanpresence to the Start menu, and starts it at login
by default. Leave **Launch yanpresence** checked on the final screen to start
immediately.

Open the Discord desktop app and play something in Apple Music or Apple TV.
yanpresence runs in the notification area; right-click its icon to switch the
artist photo, open the log, or quit. You do not need a terminal, a Discord
application, a cloud account, storage credentials, or a config file.

Every installer is on [GitHub releases](https://github.com/OoEthanoO/yanpresence/releases),
under two names with identical bytes: `yanpresence-<version>-windows-x64-setup.exe`,
and `yanpresence-windows-x64-setup.exe`, the version-less name the download link
above and the website point at. You can also build it yourself; see
[Build the Windows installer](#build-the-windows-installer) below.

## Install on macOS

Download the disk image for your Mac —
[**Apple silicon**](https://github.com/OoEthanoO/yanpresence/releases/latest/download/yanpresence-macos-arm64.dmg)
or [**Intel**](https://github.com/OoEthanoO/yanpresence/releases/latest/download/yanpresence-macos-x64.dmg)
(also on [the website](https://presence.ethanyanxu.com/#get)) — open it, and drag
**yanpresence** into **Applications**. It includes Node.js, ffmpeg and ffprobe,
needs macOS 13.5 or later, and needs no administrator access.

It is not notarized by Apple yet, so the first time you open it macOS says
**"yanpresence" Not Opened**. Choose **Done** — not **Move to Trash**, which is
the highlighted button — then open **System Settings → Privacy & Security**,
scroll down to **Security**, click **Open Anyway** beside the line saying
yanpresence was blocked, and confirm. That is once per version you download.

The first time Music or TV plays, macOS asks whether **yanpresence** may
control it. Choose **Allow**: that is how it reads what is playing.

yanpresence lives in the menu bar and has no Dock icon; click its notes to
switch the artist photo, open the log, or quit. It opens at login by default —
untick **Open at Login** in its menu to stop that. As on Windows, you do not
need a terminal, a Discord application, a cloud account, storage credentials,
or a config file. See [The macOS app](#the-macos-app) for how it works.

Coming from the source install? Remove its login agent first with
`npm run uninstall-agent`: two copies would fight over one presence. Your
config, caches and remembered settings carry over as they are.

The disk images are on GitHub releases next to the Windows installer, as
`yanpresence-<version>-macos-arm64.dmg` and `yanpresence-<version>-macos-x64.dmg`
and under the version-less names linked above. To build one yourself, see
[Build the macOS app](#build-the-macos-app).

### Shared services are ready to use

Fresh installs use the existing **Apple Music** and **Apple TV** Discord
applications and shared artwork storage. Application IDs are public identifiers;
no Discord login, bot token, or bucket key is distributed with the app.

Animated covers and embedded covers from local music files are uploaded through
an image-only gateway to the project's shared bucket. **Uploaded artwork is
public to anyone with its URL.** The gateway accepts artwork up to **25 MiB**
and applies upload rate limits. If it is unavailable, yanpresence falls back to
static catalog artwork where available. Your music and video files are not
uploaded.

Existing custom settings are preserved. You can keep using your own Discord
applications and storage; see [Advanced setup](#advanced-setup). To disable
uploads, set `animatedArtwork.enabled` and `uploadLocalArtwork` to `false`.

## Requirements

- One of:
  - **macOS** with the Music app (and TV.app for Apple TV); 13.5 or later for
    the app (tested on macOS 27.2, Apple silicon)
  - **Windows 10/11** with the Apple Music app (and the Apple TV app), both
    from the Microsoft Store (tested on Windows 11 26200, Apple Music 1.1540)
  - **Linux** with a browser for Apple Music (tested on Ubuntu 26.04,
    Chrome 151, Firefox 149)
- **Source installs only:** Node.js 18+ (developed on 26)
- The Discord **desktop** app running (the web client has no local IPC socket)
- **Source installs only:** `ffmpeg` and `ffprobe` for animated artwork (`brew install ffmpeg` /
  `sudo apt install ffmpeg` / `winget install Gyan.FFmpeg`)
- `webp` — only if you switch `animatedArtwork.format` to `"webp"`
  (`brew install webp` / `sudo apt install webp`); the default AVIF path needs
  just ffmpeg

On Windows, playback is read through **Windows PowerShell 5.1**, which ships
with Windows and needs no install. Not PowerShell 7: the media session is a
WinRT API, and `pwsh` cannot project WinRT types without the Windows SDK.

On Linux, `busctl` (part of systemd, already installed) is used for the MPRIS
source, and the companion extension in [`browser/`](browser/) is needed if you
play in Chrome — see below for why.

## Run from source

Linux uses the source install. macOS and Windows developers can use it too.
Install Node.js and ffmpeg for your platform, then:

```bash
git clone https://github.com/OoEthanoO/yanpresence.git
cd yanpresence
```

There are no npm runtime dependencies to install. Shared Discord applications
and artwork hosting work here too, without creating a config. To customize the
defaults, `node bin/yanpresence.js --init` writes a config to
`~/Library/Application Support/yanpresence/config.json` on macOS,
`%APPDATA%\yanpresence\config.json` on Windows, or
`~/.config/yanpresence/config.json` on Linux.

On Linux, also install the browser extension if you use Chrome:
`chrome://extensions` → **Developer mode** → **Load unpacked** → the
[`browser/`](browser/) directory. Firefox needs nothing.

### Check the setup

```bash
node bin/yanpresence.js --doctor
```

This verifies the playback source — Music.app on macOS, the Apple Music media
session and the Apple TV player's UI on Windows, the extension bridge and every
MPRIS player on Linux — plus the
Discord IPC socket (a named pipe on Windows), the Apple Music catalog lookup,
and the animated-artwork toolchain, and tells you exactly what's missing.

On macOS, the first run triggers the automation prompt — **allow your terminal
to control Music**. If you miss it, it's under *System Settings → Privacy &
Security → Automation*.

On Windows there is no permission prompt: a media session is public to the
session, so nothing has to be granted. Open the Apple Music app before running
`--doctor` — it registers its session as soon as it launches, so the check can
tell "not running" from "cannot see it".

On Linux, play something in a browser before running `--doctor`: it reports what
each player looks like from the outside, which is how you find out whether your
browser identifies itself (see below).

### Run it

```bash
node bin/yanpresence.js
```

Every example here spells out `node bin/yanpresence.js`, which always works from
the checkout. If you would rather type `yanpresence`, link it onto your PATH
once:

```bash
npm link
```

That is the only thing that puts the bare command there — there are no
dependencies to install, so an `npm install` alone does not do it. Undo it with
`npm unlink -g yanpresence`.

For a Windows source checkout, add a Start menu entry with:

```bash
npm run install-windows
```

This developer shortcut keeps using the checkout and your installed Node.js.
For a self-contained installation, use the Windows installer above — or, on a
Mac, the app.

To have it start at login:

```bash
npm run install-agent                    # macOS   — launchd
npm run install-service                  # Linux   — systemd user unit
npm run install-windows -- -Startup      # Windows — Startup folder shortcut
```

Logs go to `~/Library/Logs/yanpresence/` on macOS, to the journal on Linux
(`journalctl --user -u yanpresence -f`), and to
`%LOCALAPPDATA%\yanpresence\cache\yanpresence.log` on Windows. Remove any of
them with `npm run uninstall-agent` / `npm run uninstall-service` /
`npm run uninstall-windows`.

On Linux, running it as the user service is also the *reliable* way: a
snap-packaged browser only answers MPRIS queries from unconfined callers, and a
systemd user unit is unconfined. Launching yanpresence from inside another
sandboxed application's terminal is the usual way to see `Access denied` there.

### Build the Windows installer

On Windows, from a source checkout with Node.js and Windows PowerShell 5.1:

```powershell
npm run build:windows
```

The build downloads pinned packaging tools and runtimes, verifies their
checksums, and creates `dist/yanpresence-1.0.0-windows-x64-setup.exe`. It bundles
Node.js, ffmpeg and ffprobe. Give that file to another Windows user; they only
need Discord and the Apple apps installed. Build tools are needed on the
packaging machine, not on recipients' computers.

### Build the macOS app

On a Mac with the Xcode command line tools (`xcode-select --install`), from a
source checkout — no Node.js or ffmpeg needed:

```bash
npm run build:macos
```

Or `bash scripts/build-macos.sh`, which is all that runs. The build downloads
pinned Node.js and FFmpeg builds, verifies their checksums, compiles the menu
bar app from [`macos/yanpresence.swift`](macos/yanpresence.swift), and creates
`dist/yanpresence-<version>-macos-arm64.dmg` (or `-x64` on an Intel Mac; pass
`--arch x64` or `--arch arm64` to choose). It runs the bundled programs as a
check, so building for Intel on Apple silicon needs Rosetta.

```bash
npm run test:macos-package
```

builds a separately named copy, **yanpresence Smoke Test**, under its own
bundle identifier, and drives it through LaunchServices: installed to a path
with spaces, its Node swapped for a probe, crashed, quit, hung, opened twice and
upgraded in place. It never touches a real installation, its login item or its
permissions.

The icon is [`assets/yanpresence.icns`](assets/yanpresence.icns), drawn by
`npm run make-icon:macos` from the same geometry as the Windows icon and the
website's logo. Like the `.ico`, it is committed rather than redrawn per build.

### Publish a release

Bump `version` in `package.json`, commit, and push a matching tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The **Windows installer** and **macOS app** workflows build and test their
packages, then attach them to one **draft** release, each under its versioned
name and once under a version-less one: `yanpresence-windows-x64-setup.exe`,
`yanpresence-macos-arm64.dmg` and `yanpresence-macos-x64.dmg`. Review the draft
and publish it. The website's download buttons use `releases/latest/download/…`,
which GitHub resolves only to published releases. Until you publish, the buttons
keep serving the previous release; a platform that release does not include is
sent to the releases page instead.

## Advanced setup

### Use your own Discord applications

This is optional. Fresh installs use Apple Music application
`1533115403742740532` and Apple TV application `1536042928068235354`.

To use your own, create an application named **Apple Music** in the
[Discord Developer Portal](https://discord.com/developers/applications) and set
its Application ID as `clientId` in your config. For TV, create a second
application named **Apple TV** and set `tv.clientId`. Discord builds the card
header from these application names.

Under **Rich Presence → Art Assets**, upload [`assets/blank.png`](assets/blank.png)
as **`blank`** for the empty-cover fallback. Nothing else needs uploading: the
artist photo in the small badge comes from Apple's CDN.

### Use your own artwork storage

Set `hosting.mode` to `s3`, `command`, or `webhook` and configure that provider
as described below. Your credentials stay in your local config. To return to
the shared service, set `hosting.mode` to `shared`.

## Animated artwork

Apple publishes motion artwork for a lot of albums, but ships it as an **HLS
video stream** — and Discord's presence asset slot renders images, not video.
So there's a transcode step, and the result needs a public URL.

The path this takes: pull Apple's motion master with `ffmpeg`, encode the whole
loop as animated **AVIF**, and host it. Discord's docs are explicit that
external-URL assets support GIF, animated WebP and AVIF — assets *uploaded* to
the Developer Portal cannot animate at all, which is why this goes through a
hosted URL. Results are cached per album.

### `shared` — default, no setup

The built-in image gateway uploads covers to the shared bucket without giving
clients access to bucket credentials. The shared service has a **25 MiB per
artwork** limit and upload rate limits. Animated artwork is enabled by default;
static artwork remains the fallback when an encode or upload fails. Embedded
covers from local tracks use the same gateway and are also publicly accessible.

The following storage modes are optional alternatives for advanced setups.

> **`webhook` cannot serve presence assets.** The upload succeeds and the image
> is visible in the channel, but Discord will not render a `cdn.discordapp.com`
> attachment URL as a Rich Presence asset — those URLs carry a mandatory signed
> query string (`?ex=…&is=…&hm=…`), 404 without it, and come out as the grey "?"
> placeholder. Confirmed by bisecting: the *identical* JPEG renders from Apple's
> CDN and fails from Discord's. Use `shared`, `s3`, or `command` for presence.

### `s3` — your own bucket

Any S3-compatible bucket, signed natively — no `rclone` or `aws-cli` to install.
Built for **Cloudflare R2**, whose `pub-*.r2.dev` URLs are plain and unsigned,
which is the property that matters.

Setup, about five minutes:

1. Cloudflare dashboard → **R2** → **Create bucket** (say, `yanpresence`).
   R2's free tier covers this easily — 10 GB storage and no egress charges —
   but Cloudflare does require a payment method on the account to enable R2.
2. Bucket → **Settings** → **Public Development URL** → **Enable**. Copy the
   `https://pub-<hash>.r2.dev` URL it gives you. (Cloudflare used to call this
   section "Public access".) These r2.dev URLs are rate-limited and meant for
   development — fine here, since Discord's media proxy fetches each image once
   and caches it. Attach a custom domain instead if you'd rather.
3. R2 → **Overview** → the **Account Details** card on the right → **API
   Tokens** → **{ } Manage** → **Create API token** → *Object Read & Write*,
   scoped to that bucket. Copy the **Access Key ID** and **Secret Access Key**
   (the secret is shown once).
4. **Account ID** is in that same Account Details card — the endpoint is
   `https://<accountId>.r2.cloudflarestorage.com`.
5. Fill in the config:

```json
"hosting": {
  "mode": "s3",
  "s3": {
    "endpoint": "https://<accountId>.r2.cloudflarestorage.com",
    "bucket": "yanpresence",
    "accessKeyId": "...",
    "secretAccessKey": "...",
    "region": "auto",
    "publicBaseUrl": "https://pub-<hash>.r2.dev"
  }
}
```

Then `--clear-cache`, restart, and confirm with `--test-assets`.

Works with real S3, Backblaze B2, MinIO or anything else S3-compatible — just
point `endpoint`/`region` at it and make sure `publicBaseUrl` serves the objects
publicly *without* a signed query string.

### `command` — anything else

Hand the file to your own uploader and read the URL it prints:

```json
"hosting": {
  "mode": "command",
  "command": "rclone copyto {file} r2:art/{name} >&2 && echo https://pub-xxxx.r2.dev/{name}"
}
```

`{file}` and `{name}` are substituted; the last line printed is used as the URL.
Send the tool's own chatter to stderr so only the URL lands on stdout.

A GitHub repo works here too — `raw.githubusercontent.com` does serve
`Content-Type: image/avif` correctly. Be aware that every album becomes a
permanent commit of a multi-megabyte binary in a public repo's history, which is
why R2 is the recommendation.

### `webhook` — archival only

Posts to a Discord webhook you own. Fine if you just want the files kept
somewhere visible, but see the warning above — Discord will not render those
URLs as presence assets. Capped at 10 MB unboosted, 50 MB at Boost Level 2.

If your selected host is unconfigured or unavailable, everything else still
works — catalog covers fall back to static 1024×1024 art.

### Full loops at high quality

The defaults encode the **entire loop** (Apple's are ~20–24s) at **source
framerate**, at high quality, in **AVIF**. One measured cover is 3.7 MB; sizes
vary by album. Shared hosting allows 25 MiB, with larger encodes refitted or
skipped according to `onOversize`. Duration is never truncated by size retries.

That only works because of the format. The same full loop, measured on a real
Apple motion master at 30fps:

| format | px | full loop | encode |
|---|---:|---:|---:|
| **AVIF crf20** | **1024** | **3.7 MB** | 22s |
| AVIF crf26 | 2160 | 8.4 MB | 30s |
| AVIF crf20 | 2160 | 12.2 MB | 34s |
| AVIF crf14 | 2160 | 18.8 MB | 32s |
| WebP q92 | 2160 | 88.3 MB | 181s |
| GIF | 1000 | ~128 MB | — |

GIF is the entire reason full-length animation ever looked impossible. AVIF is
~35× smaller at comparable quality, so the constraint simply evaporates.

### Maximum everything

Apple's masters go to **2160×2160**. To take all of it at near-source quality,
lift the cap by hosting it yourself:

```json
"hosting": {
  "mode": "command",
  "command": "rclone copyto {file} r2:art/{name} >&2 && echo https://cdn.you.com/{name}"
},
"animatedArtwork": {
  "format": "avif", "size": 2160, "fps": 30,
  "maxDurationSec": null, "crf": 14, "maxBytes": null
}
```

With this `command` host, `maxBytes: null` disables the budget check, so no
encode is refitted. On a free webhook, `2160 / crf 26` (8.4 MB) gets you Apple's full
resolution and framerate within the 10 MB cap.

Uncapping is not a gamble on the `s3` path: **Discord's media proxy has been
verified to fetch and animate a 54.59 MB AVIF** (1024×1024, 16.7s @ 30fps,
57,241,567 bytes) served from a `pub-*.r2.dev` URL — it renders in the status
card like any other. The 10/50 MB numbers are Discord's *webhook upload* limits
and do not apply to an external URL, which is why `maxBytes` defaults to
unlimited under `s3` and `command`.

Worth knowing before you do: **Discord renders the presence asset far smaller
than 1024** — its own docs recommend 1024×1024 assets, and the media proxy
downscales whatever you give it. 2160 costs bytes and encode time without
looking better. It's available because you asked for max, not because it helps.

If you would rather have *no* animation than a compromised one, set
`"onOversize": "skip"` — an over-budget encode is abandoned and the static
1024×1024 cover is used instead of being re-encoded smaller.

### If it does go over budget

Output size varies with the artwork. Shared hosting allows 25 MiB per image;
webhook hosting defaults to a 9 MiB encode budget. When an encode exceeds its
budget, `onOversize` decides what happens:

- `"degrade"` (default) — re-encode to fit. Quality is spent **before**
  resolution, and the retry targets the budget by area rather than stepping down
  blindly, so it converges in one extra pass. Duration is never truncated.
- `"skip"` — refuse to compromise. The animation is abandoned and the static
  1024×1024 cover is used instead.

Setting `"maxBytes": null` uses the selected host's default budget: 25 MiB for
shared hosting, 9 MiB for webhook hosting, and no limit for `s3` or `command`.
The shared gateway's 25 MiB limit still applies if you set a larger custom budget.

### Hardware encoding, and which GPU path actually works

The AV1 encode can be handed to a GPU. Whether that is a good idea turns out to
depend entirely on which API you go through — and the only way to find out was
to check the output against the one reader that matters, because the Discord
desktop client is Electron and Chromium is fussy about AVIF.

**VAAPI on Linux: no.** Measured on Ubuntu 26.04 with a Radeon 780M (RDNA3) and
an RTX 4070, ffmpeg 8.0.1, on a 20.6s 2160×2160 master encoded to 1024px:

| | time | size | renders in Discord |
|---|---|---|---|
| `libsvtav1` (CPU) | 2.6s | 10.8 MB | **yes** |
| `av1_vaapi` (780M) | 1.5s | 10.2 MB | **no** — grey "?" |

Chromium refuses to decode the VAAPI encoder's AVIF. Every variant fails the
same way — CQP, VBR, a single tile, an explicit level, and even a single still
frame — so it is not the animation, the rate control or the container. ffmpeg
and ffprobe read the file back perfectly, which is exactly what makes it
dangerous: the encode *looks* like it worked.

**AMF on Windows: yes.** The same silicon, through AMD's own SDK rather than
Mesa, produces AVIF that Chromium reads. Measured on Windows 11 with that same
Radeon 780M, ffmpeg 9.0, on a 20s 2160×2160 master encoded to 1024px:

| | time | size | renders in Chromium 148 |
|---|---|---|---|
| `libsvtav1` (CPU) | 6.5s | 21.4 MB | **yes** |
| `av1_amf` (780M) | 5.7s | 19.6 MB | **yes** |

Structurally the two files are identical — a still cover image plus a 180-frame
animation track, same dimensions, same duration. So it was the driver's
bitstream packing that was the problem on Linux, not the hardware.

That is why `"auto"` means different things on the two platforms:

```jsonc
"animatedArtwork": {
  "hardware": {
    "mode": "auto",        // "auto" | "off" | "amf" | "vaapi"
    "device": "auto",      // "auto" | "amd" | "intel" | "nvidia" | "/dev/dri/renderD129"
    "decode": false,       // hardware decode; independent of mode
    "globalQuality": null  // override the CRF -> quantizer conversion
  }
}
```

`"auto"` hands the encode to **AMF** on Windows when there is an AMD adapter
and an ffmpeg built with `av1_amf`, and to the **CPU** everywhere else. Whatever
it picks is verified rather than trusted: an encode that writes a file ffprobe
cannot read counts as a failure, and the CPU encoder takes over for the rest of
the run.

AMF needs no device argument and no `hwupload`, unlike VAAPI. It takes software
frames and uploads them itself, and it enumerates only AMD devices — so on a
laptop with a discrete NVIDIA card as well, there is no wrong card for it to
pick. That is a real difference: VAAPI has to be told which render node to use
or it silently hands the wrong card's frames to the encoder.

`"vaapi"` is kept for different hardware, a newer driver, or a consumer that is
not Chromium. It warns when used. If you switch it on and the art goes grey,
switch back and run `--clear-cache` so the broken encode is replaced.

Two details worth keeping if you do use it. The device is chosen **by vendor,
not by number** — `/dev/dri/renderD128` is the usual hardcoded VAAPI default and
on this laptop it is the NVIDIA card, which has no VAAPI encoder at all. And the
VAAPI device is passed as `-init_hw_device` + `-filter_hw_device` rather than
`-vaapi_device`, because any `-hwaccel` on the input side otherwise becomes the
default filter device and `hwupload` hands NVIDIA frames to the AMD encoder,
which fails with `EINVAL` and writes nothing.

Hardware **decode** is a separate switch and stays off. Software decode of the
Linux master took 2.9s against 4.9s on NVDEC and 3.9s on VAAPI; on Windows,
`d3d11va` took the CPU-encoded run from 6.5s to 6.1s but pushed the AMF one
from 5.7s to **7.5s**, because the frames have to come back to system memory for
the scale filter and then go up again. Initialising a vendor's stack costs about
what decoding twenty seconds of H.264 saves. Turn it on with `"decode": true`
if your hardware disagrees.

NVENC is never used for AVIF. Ada does encode AV1, but AV1-in-HEIF out of NVENC
is not a combination anyone supports.

### Verifying what actually got hosted

```bash
node bin/yanpresence.js --cache
```

Lists every hosted asset with its format, pixel dimensions, loop length,
framerate and byte size, plus the URL — and shows the reason for any album that
failed. To check one independently:

```bash
ffprobe -v error -select_streams v:1 -show_entries stream=width,height,nb_frames -of default=nw=1 '<url>'
```

Note `-select_streams v:1`. An animated AVIF carries two streams: stream 0 is a
single-frame still cover, stream 1 is the animation. Probing `v:0` reports
`nb_frames=1` and looks alarming while the file is perfectly fine.

`--clear-cache` drops everything and forces a re-encode on the next play.

### Other notes

- Static artwork is always requested at 1024×1024 (`artworkSize`), independent
  of any of this.
- Discord attachment URLs are signed and expire after roughly 24 hours. The
  cache tracks each URL's expiry and re-uploads before it lapses. Command-hosted
  URLs don't expire and aren't re-uploaded.
- Changing any encode setting invalidates cached artwork automatically — the
  cache records the recipe each entry was produced with.
- The motion stream is downloaded and its duration checked against the
  playlist before encoding, with retries. ffmpeg exits 0 on a *truncated* HLS
  read — a dropped segment shows up only as "Stream ends prematurely" on
  stderr — so trusting the exit code silently yields a few seconds of a
  twenty-second loop. Encoding from the verified local file is also much
  faster, since a size retry no longer re-pulls the stream.
- `format: "webp"` needs `img2webp` (`brew install webp`); ffmpeg has no libwebp
  encoder in the common Homebrew build. AVIF and GIF are pure ffmpeg.

## Configuration

Config is read from the first of these that exists:

1. `$YANPRESENCE_CONFIG`
2. The platform config: `~/Library/Application Support/yanpresence/config.json`
   on macOS, `%APPDATA%\yanpresence\config.json` on Windows, or
   `~/.config/yanpresence/config.json` on Linux
3. `~/.config/yanpresence/config.json` (fallback on other platforms)
4. `config.json` in the application directory

A config file is optional: missing settings use the shared defaults. Cache and
encoded artwork go under `~/Library/Application Support/yanpresence/cache` on
macOS, `%LOCALAPPDATA%\yanpresence\cache` on Windows, and
`~/.cache/yanpresence` on Linux.

| Key | Default | |
|---|---|---|
| `clientId` | `"1533115403742740532"` | Shared Apple Music Discord application. Override to use your own. |
| `tv.enabled` | `true` | Apple TV presence on macOS and Windows. |
| `tv.clientId` | `"1536042928068235354"` | Shared Apple TV Discord application. |
| `activityName` | `"Apple Music"` | Keep in sync with the app's name in the portal. |
| `storefront` | `"us"` | Apple Music storefront for lookups and links. |
| `source` | `"auto"` | Where playback state comes from: `auto` (the Apple apps on macOS and Windows, the web player on Linux), `apple-apps`, `browser`. |
| `browser.bridge.enabled` | `true` | Loopback endpoint the companion extension posts to. Required for Chrome. |
| `browser.bridge.port` | `8763` | Port for that endpoint, on `127.0.0.1`. |
| `browser.bridge.token` | `""` | Optional shared secret; paste the same value into the extension's options. |
| `browser.mpris.enabled` | `true` | Read players off the session bus. Identifies Apple Music by itself in Firefox. |
| `browser.mpris.players` | `{}` | Map an MPRIS bus name fragment to `music` / `tv` / `ignore`, for browsers that publish no page URL. |
| `statusDisplay` | `"details"` | Which field lands on your status line: `details` (song), `state` (artist, Spotify's choice), `name`. |
| `windows.tray` | `false` | Windows: show a notification-area icon with Quit and the artist photo switch. The Start menu shortcut passes `--tray` itself. See [Windows](#windows). The macOS app always has its menu bar icon. |
| `windows.appIds.music` | `"AppleInc.AppleMusicWin"` | Windows: AUMID prefix of the app whose media session is Apple Music. |
| `windows.appIds.tv` | `"AppleInc.AppleTVWin"` | Windows: the same, for Apple TV — which has never answered, since that app publishes no session. Kept so a future version that does is noticed. |
| `windows.tvUiAutomation` | `true` | Windows: read the Apple TV app through UI Automation, the only way it can be read. See [Apple TV on Windows](#apple-tv-on-windows). |
| `artworkSize` | `1024` | Square px requested from Apple's CDN. |
| `artistPhoto` | `true` | The artist's photo in the small corner badge. No photo, no badge. The menu bar icon on macOS and the tray menu on Windows switch it, and remember the choice in `preferences.json` beside `config.json`, which wins over this value. The old `showSmallImage` and `smallImageKey` are ignored, except that `showSmallImage: false` still means no badge. |
| `placeholderImageKey` | `"blank"` | Portal asset shown when there's no album art. Shared applications include it; upload `assets/blank.png` only for your own application. `null` leaves the slot empty. |
| `linkButtons` | `false` | Also attach classic Rich Presence buttons — a fallback for older clients that don't render `details_url`/`state_url`/`large_url`. |
| `showWhenPaused` | `false` | Keep the presence up while paused. Off by default — a paused track isn't something you're listening to. When on, the progress bar is dropped. |
| `pollIntervalMs` | `1000` | How often the source is sampled. |
| `minUpdateIntervalMs` | `2500` | Floor between `SET_ACTIVITY` frames; Discord rate-limits these. |
| `seekToleranceSec` | `2` | Drift before a seek is assumed and the timeline is rebased. |
| `clearDelayMs` | `5000` | How long playback must be non-playing — paused, stopped or quit — before the presence clears. Music.app blips `paused` between tracks, so clearing instantly would flicker the status between every song. Lower it for a snappier hide. |
| `pauseClearDelayMs` | `null` | How long a *pause* waits, as opposed to a stop. `null` asks the source: `clearDelayMs` for the desktop apps, whose pause is ambiguous between tracks, and 1.5s for the web player, whose pause is not. |
| `hosting.mode` | `"shared"` | Shared artwork gateway, or your own `s3`, `command`, or archival `webhook` host. |
| `hosting.webhookUrl` | — | Discord webhook URL, for `webhook` mode. |
| `hosting.command` | — | Uploader command with `{file}` / `{name}`, for `command` mode. Must print the public URL. |
| `animatedArtwork.format` | `"avif"` | `avif` \| `webp` \| `gif`. |
| `animatedArtwork.size` | `1024` | Square px. Apple's masters go to 2160. |
| `animatedArtwork.fps` | `30` | Source framerate, so no frames are dropped. |
| `animatedArtwork.maxDurationSec` | `null` | `null` plays the whole loop. A number truncates. |
| `animatedArtwork.crf` | `20` | AVIF quality; lower is better. 14 ≈ source. |
| `animatedArtwork.quality` | `75` | WebP quality, when `format` is `webp`. |
| `animatedArtwork.maxBytes` | `null` | Uses the host budget: 25 MiB shared, 9 MiB webhook, unlimited S3/command. A number sets a custom encode ceiling. |
| `animatedArtwork.onOversize` | `"degrade"` | `degrade` refits to fit; `skip` falls back to static art rather than compromise. |
| `animatedArtwork.hardware.mode` | `"auto"` | GPU encoding: `auto` uses AMD's AMF encoder on Windows and the CPU elsewhere; `off` always uses the CPU; `amf` and `vaapi` force a specific one. See [Hardware encoding](#hardware-encoding-and-which-gpu-path-actually-works). |
| `animatedArtwork.hardware.device` | `"auto"` | `auto` \| `amd` \| `intel` \| `nvidia` \| a `/dev/dri/renderD*` path. VAAPI only, chosen by vendor rather than by number. AMF enumerates only AMD devices and ignores this. |
| `animatedArtwork.hardware.decode` | `false` | Hardware decode, independent of `mode`. Measured slower than software nearly everywhere. |
| `animatedArtwork.hardware.globalQuality` | `null` | Override the CRF → quantizer conversion (VAAPI `global_quality`, AMF `qp`). |
| `uploadLocalArtwork` | `true` | For local library files with no catalog entry, upload their embedded cover through the same host. |
| `logLevel` | `"info"` | `error` \| `warn` \| `info` \| `debug` |

Environment overrides: `YANPRESENCE_CLIENT_ID`, `YANPRESENCE_STOREFRONT`,
`YANPRESENCE_WEBHOOK_URL`, `YANPRESENCE_LOG_LEVEL`, `YANPRESENCE_CONFIG`.

## Commands

```bash
node bin/yanpresence.js              # run
node bin/yanpresence.js --doctor     # check the setup
node bin/yanpresence.js --watch      # print playback state, ignore Discord
node bin/yanpresence.js --dry-run    # full pipeline, print the payload instead of sending
node bin/yanpresence.js --verbose    # debug logging
node bin/yanpresence.js --smtc       # Windows: dump the raw media sessions
node bin/yanpresence.js --tray       # Windows: run with a notification-area icon
```

On macOS, `--tray` is what yanpresence.app passes to put Node behind its menu
bar icon; run from a terminal, it has no icon to attach to and is ignored.

`--dry-run` needs no `clientId` and is the fastest way to see exactly what
Discord would be told.

## Apple TV

Available on macOS and Windows, and not through a browser — see
[Apple TV on Windows](#apple-tv-on-windows) for how the Windows side differs.

On macOS, TV.app descends from the same iTunes scripting dictionary as Music.app
— it answers `player state`, `player position` and `current track` the same way
— so watching it costs one more resident `osascript` and nothing else. On
Windows it is read from the Apple TV player's UI Automation tree. It is enabled
by default. To turn it off, set `tv.enabled` to `false`.

What lands on Discord, for an episode:

```
  Watching Apple TV
  ┌────────────┐
  │            │   Ted Lasso           ← details: the show
  │ show art   │   S2E8 · Man City     ← state, hover shows the episode
  │  1024²     │   ▓▓▓▓▓░░░░░ 12:04    ← live progress
  └────────────┘
```

The **show** goes on the one-line status rather than the episode — the opposite
of the music layout, and deliberate: "Watching Ted Lasso" means something to a
reader, "Watching Man City" does not. Films use their own title, with the year
and director beneath. Only one source holds the presence at a time; whatever is
actually playing wins, and video beats audio when both are.

### The Apple TV application is already configured

The shared Apple TV application gives the card its **Watching Apple TV** header.
yanpresence reconnects under the matching application when you switch between
watching and listening. To use your own applications, see
[Advanced setup](#advanced-setup).

### Artwork

Two of the obvious routes are dead ends. The **iTunes Search API** has retired
TV content — `media=tvShow` and `media=movie` both return zero results for
everything, including titles plainly in the Store — and **Apple TV+ streams
carry no embedded artwork** (`artworks.length` is 0), unlike a downloaded
purchase.

What works is the backend behind tv.apple.com, which is where the Apple TV web
app gets its own art. It needs a `utsk` session key, obtained the same way
`catalog.js` obtains the music token: load the public page and read the key out
of it. `src/tvcatalog.js` caches the key for a week and refetches once on a
rejection.

**Every season of every Apple Original has a dedicated square cover** — the
titled 3000×3000 key art the iTunes Store used to show — and that is what gets
displayed, per season, with no cropping and no matting. It comes from the
per-season metadata route, where the naming is a trap: the season's own square
sits under `previewFrame`, while the key literally called `coverArt` belongs to
the *show* (`showImages`). Grepping for "coverArt" finds the same image for
every season and makes per-season art look nonexistent.

A season the metadata route has nothing for falls back to the show's own
square cover.

**Films have no square anywhere in Apple's catalog** — checked across both the
movie endpoint and its metadata route, where the only 1:1 assets are cast
headshots and the Apple TV+ channel logo. They use the titled 2:3 poster
(`coverArt2X3`, `v=100`) instead of the 16:9 shelf image the search returns:
matted into a square it wastes 33% of the slot rather than 44%, and it carries
the title, which a production still does not. Matting uses the `bf` crop code,
which fits the whole frame — every other code either eats the title treatment
(`sr`, `cc`, `ve`) or ignores the square entirely and returns 16:9 (`bb`,
plain).

Lookups are keyed on the **show** plus the season being watched: a binge costs
one search, one season-list call, and one metadata call per season you reach,
each cached for 30 days. A film costs one search and one metadata call.

**What does not resolve:** that search covers the Apple TV+ catalogue, not the
iTunes Store. A purchased or rented film returns no match and keeps the
`placeholderImageKey` fallback. Matching requires a title hit, so a near-miss
yields no artwork rather than the wrong artwork.

## The macOS app

The app is the source install made self-contained: the same Node app, with its
own Node.js, ffmpeg and ffprobe, behind a menu bar icon.

```
yanpresence.app/Contents/
  MacOS/yanpresence        the menu bar icon: a small native app, parent of the rest
  MacOS/node               Node.js, unmodified, still signed by the Node.js Foundation
  MacOS/ffmpeg, ffprobe    FFmpeg, unmodified, still signed by its builder
  Resources/app/           bin/, src/ and scripts/, as in this repository
```

On Windows the Node process is the app, and the tray icon is a PowerShell
child it starts. Here the two swap places: the menu bar icon is what macOS
starts, and Node runs as its child. That is not a matter of taste.

- **Permission belongs to the app macOS launched.** Music.app is read over
  Apple Events, by `osascript` watchers that Node starts. macOS attributes them
  to the process it holds *responsible*, which is the one LaunchServices
  started — so the prompt asks whether **yanpresence** may control Music, with
  the app's name and icon, and the answer is kept for the app. With Node on
  top it would ask on behalf of `node`, and a yes would extend to every copy of
  Node signed the same way.
- **LaunchServices knows the app is running only while its own process is.**
  That is what makes opening it a second time reach the running copy, Open at
  Login work, and logging out ask it to quit.
- **A run loop is not something Node can host**, any more than it can host the
  WinForms message loop on Windows.

The two talk over a socket the app hands Node as a fourth file descriptor.
What the menu says is the set of lines the Windows tray prints — `quit`,
`artist-photo on` and `artist-photo off` — so [`src/tray.js`](src/tray.js)
reads both the same way. What Node says back is JSON: what the card shows, and
why it could not start, if it could not.

### The menu bar icon

```
  ┌───────────────────────────────┐
  │ yanpresence                   │  ← greyed-out header
  │ Listening to Be Her — Ella …  │  ← what the card currently says
  │ Allow Control of Music…       │  ← only after you refused the prompt
  │ ───────────────────────────── │
  │ ✓ Show Artist Photo           │  ← the badge on the cover's corner
  │ ✓ Open at Login               │
  │ ───────────────────────────── │
  │ Open Log                      │
  │ About yanpresence             │
  │ ───────────────────────────── │
  │ Quit yanpresence           ⌘Q │
  └───────────────────────────────┘
```

**Show Artist Photo** works as on Windows, remembering the choice in
`~/Library/Application Support/yanpresence/preferences.json`. **Quit** — and
logging out, or anything else that asks the app to quit — clears the presence
with Discord before Node exits. A Node that has not exited 8 seconds later is
stopped, along with anything it started, so quitting never leaves an encode or
a watcher behind.

**Allow Control of Music…** appears only once the permission prompt has been
refused, because a refusal is otherwise invisible: the card simply never
appears. It opens **System Settings → Privacy & Security → Automation**, where
yanpresence has a switch for Music and one for TV.

If you cannot see the icon — behind the notch on a crowded menu bar, or hidden
under **System Settings → Menu Bar** — open yanpresence again from Applications
or Spotlight. The running copy puts its icon back and drops its menu open.

Node crashing does not take the app with it: it is restarted, as the source
install's launchd agent restarts it, unless it fails at start-up or keeps
failing. Then a dialog says why, with a button to the log.

### Open at Login

On by default, as the Windows installer's startup box is. It is switched on
the first time the app runs from Applications and never again, so unticking it
sticks. A copy run from anywhere else — a build folder, the disk image — is
left alone, since a login item would point at something about to move. The
same switch is under **System Settings → General → Login Items**.

### Installing, upgrading and removing

Opened straight off the disk image, the app first offers to move itself to
Applications, since it would otherwise vanish when the disk image is ejected.

To upgrade, drag the new version into Applications over the old one and open
it. Only one copy ever runs, and the one opened last wins: a running copy that
finds a newer version on disk hands over to it, and a second copy started from
anywhere else asks the first to quit. Either way the old one clears its
presence on the way out, as the Windows installer stops the running app before
it upgrades.

To remove it, untick **Open at Login**, quit it, and drag yanpresence from
Applications to the Trash. Your config, caches and log are kept.

### Not notarized, and what that costs

The app is signed ad hoc rather than with an Apple Developer ID, so Gatekeeper
asks once before the first launch of each version you download — the **Open
Anyway** step under [Install on macOS](#install-on-macos). Node.js, ffmpeg and
ffprobe keep their publishers' signatures and are notarized; only the small
menu bar program is not.

For the same reason, macOS ties the Automation permission to the exact build.
After an update it may ask again whether yanpresence can control Music.

### Where things go

| | |
|---|---|
| Installed app | `/Applications/yanpresence.app` (or `~/Applications`) |
| Config | `~/Library/Application Support/yanpresence/config.json` (optional) |
| Menu choices | `~/Library/Application Support/yanpresence/preferences.json` (written by the app) |
| Caches | `~/Library/Application Support/yanpresence/cache/` |
| Log | `~/Library/Logs/yanpresence/yanpresence.log` — **Open Log** shows it in Console |

The log is opened before the config is validated, as on Windows, and a
start-up failure raises a dialog rather than leaving nothing to see.

## Windows

Apple ships Apple Music and Apple TV as packaged Store apps with **no
automation surface at all** — there is no Windows equivalent of the iTunes
scripting dictionary, and nothing to send an Apple Event to. What they do
publish is a **System Media Transport Controls session** each: the record
behind the flyout that appears over the volume overlay, and behind the
play/pause key on your keyboard.

That record carries everything the presence card is built from — title, artist,
album, album artist, playback status, a timeline, and the cover art — and
reading it injects nothing into either app and needs no permission. Sessions
are identified by the publishing app's AUMID, which is how a session is known
to be Apple Music rather than Spotify or a browser tab.

```
Apple Music app ─┐
                 ├─► SMTC session ─► scripts/smtc-watch.ps1 ─► the same pipeline
Apple TV app ────┘                    (one resident PowerShell)
```

One watcher process serves both apps. On macOS they are two applications to be
scripted separately; here they are two entries in one list of sessions, so
asking twice would mean two PowerShell hosts polling the same API.

### Launching it from Windows Search

The Windows installer adds the Start menu entry automatically and enables
start at login by default. Press **Start**, type `yanpresence`, and press
Enter to launch it again. Uninstall it from Windows **Settings → Apps →
Installed apps**; your config and caches are kept.

For developers running a source checkout, `npm run install-windows` creates
a shortcut without packaging the app. Both installation methods use:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\yanpresence.lnk
```

For the source shortcut only, add `-- -Startup` to also run it at login;
`npm run uninstall-windows` removes those shortcuts and leaves your config and
caches alone.

The shortcut does not point at `node.exe` directly. Node is a console
application, so Windows would give it a console: a black window in your taskbar
for as long as the presence is running, which you cannot close without killing
the app. It points at [`windows/yanpresence-launch.ps1`](windows/yanpresence-launch.ps1)
instead, which starts node hidden and exits.

### The tray icon

A hidden background process you cannot stop is not a thing to ship, so the
launcher passes `--tray` and you get a notification-area icon:

```
  ┌─────────────────────────┐
  │ yanpresence             │  ← greyed-out header
  │ Listening to Be Her …   │  ← what the card currently says
  │ ─────────────────────── │
  │ ✓ Show artist photo     │  ← the badge on the cover's corner
  │ ─────────────────────── │
  │ Open log                │
  │ Quit yanpresence        │
  └─────────────────────────┘
```

**Show artist photo** puts the artist's photo in the badge on the cover's
corner, or takes it off. The card changes straight away, and the choice is
remembered in `%APPDATA%\yanpresence\preferences.json`, so it survives a
restart and wins over `artistPhoto` in `config.json`.

**Quit** shuts the app down properly — it clears the presence with Discord on
the way out rather than leaving a stale "Listening to…" behind. Hovering shows
the same line as a tooltip; double-clicking pops it as a balloon.

> **Windows 11 hides new tray icons by default.** Click the **^** arrow to the
> left of the clock to find it, and drag it onto the taskbar to keep it in
> view. This is Windows' behaviour for every new icon, not something the app
> can opt out of.

The icon lives in a PowerShell child running a WinForms message loop, because a
message loop is not something Node can host. It watches its parent and exits if
the app dies, so a crash cannot leave an orphan icon behind that quits nothing.

Running from a terminal, you do not need any of this — Ctrl-C works, and the
icon is off unless you ask for it with `--tray` or `windows.tray: true`.

### Only one at a time

Two copies would fight over one presence, each overwriting the other's activity
every couple of seconds — easy to do by accident once there is a Start menu
entry you can hit twice. A tray run claims a named pipe at startup and a second
one refuses to start, saying so. Windows releases the pipe when the holder
exits, however it exits, which a PID file could not promise.

### Where things go

| | |
|---|---|
| Installed app | `%LOCALAPPDATA%\Programs\yanpresence\` |
| Config | `%APPDATA%\yanpresence\config.json` (optional) |
| Tray menu choices | `%APPDATA%\yanpresence\preferences.json` (written by the app) |
| Caches | `%LOCALAPPDATA%\yanpresence\cache\` |
| Log | `%LOCALAPPDATA%\yanpresence\cache\yanpresence.log` |

The log exists because a hidden run has nowhere to print. It is opened *before*
the config is validated, so a malformed custom setting is recorded even when
there is no visible console. A start-up failure in tray mode also raises a dialog box,
since "nothing happened" is not an error message.

### The album arrives inside the artist field

Worth knowing about, because it is invisible until you look. The Windows Apple
Music app does not fill the media session's album field. It publishes
`"<artist> — <album>"` as the **artist**, and again as the album artist, and
leaves the album title empty:

```
Title       LOV3 (feat. Bryan Chase & Okasian)
Artist      Sik-K & Lil Moshpit — K-FLIP+     ← the album is in here
AlbumTitle  (empty)
```

Passed through, that puts `Sik-K & Lil Moshpit — K-FLIP+` on the card's artist
line and hands the catalog an artist who does not exist — which costs you the
links and the album art, not just a cosmetic slip. So it is split back apart on
the way in.

The empty album is the guard, and it is the part that cannot happen by
accident: a payload Apple filled in properly is passed through untouched, so
this heals itself if a future version of the app stops doing it. The separator
is a spaced **em dash**, which is not what Apple's own catalog titles use for
editorial suffixes (`" - Single"`, `" - EP"` are hyphens), so the two do not
collide.

### Apple TV on Windows

The Apple TV app publishes **no media session at all**. Not an empty one, not
one that appears when playback starts — none, ever. Verified over 150 seconds
of continuous playback, during which Apple Music, sitting *paused* in the
background, published one the entire time:

```
t=  0s  sessions=1  appleTV=no  [AppleInc.AppleMusicWin_nzyj5cx40ttqa!App]
t=  2s  sessions=1  appleTV=no  [AppleInc.AppleMusicWin_nzyj5cx40ttqa!App]
...
NO APPLE TV MEDIA SESSION appeared in 150s.
```

So it is read off its own **UI Automation** tree instead, which turns out to be
richer than a media session would have been. Where the Apple Music app packs
two fields into one and leaves the album empty, the player's UI hands over the
season, the episode number and the episode title as separate labelled elements,
and the scrubber reports the playhead and the runtime in seconds:

```
Text   'Trying'                    id=TitleTextBlock
Text   'S1, E1 · Nikki and Jason'  id=SubtitleTextBlock
Slider 'Playback position'         id=VideoPlayer_CurrentPositionScrubber  RANGE[810.2/1867.3]
Button 'Pause'                     id=VideoPlayer_PlayButton
```

The play button is labelled with the action it offers, so "Pause" is a playing
video and "Play" is a paused one — which is how pause is detected without a
session to ask.

**The catch, and it is a real one:** those elements exist only while the
transport overlay is on screen. Let it fade and the subtree is not stale, it is
*gone*. So the watcher reports `hidden` as its own state and the last real
reading is carried forward with the playhead advancing, the same way the Apple
Music playhead is advanced between the app's own timeline updates.

That works because of *when* the overlay comes back: starting something,
pausing, scrubbing — the events worth noticing are the events that redraw it.
A carried-forward reading is dropped once it runs past the end of the episode,
or after four hours, whichever comes first.

The one case it gets wrong: pausing from the keyboard alone, with the pointer
never moving, reads as still-playing until something redraws the overlay.

To see both what was read and what was made of it:

```bash
node bin/yanpresence.js --doctor
```

With the controls on screen that prints the elements next to the parsed show,
episode and numbering. With them hidden it says so, rather than pretending the
app is not running. If a future version of the app renames those
AutomationIds, that is the command that shows it instead of leaving you
guessing at a card that never appears — and `windows.tvUiAutomation: false`
turns the whole thing off if it ever starts reading things wrongly.

## Linux and the web player

There is no Music.app to script on Linux, so playback state comes from the
Apple Music web player at `music.apple.com`, in whatever browser you use.
Everything downstream is unchanged: the same catalog lookups, the same links,
the same 1024×1024 (and animated) artwork, the same card.

**Audio only.** Apple TV is a macOS source, driven through TV.app, which reports
the show, the season and the episode as fields; the web player offers an episode
title and little else, so `tv.apple.com` is not read at all and a tab playing it
is ignored.

The only hard problem is knowing *which page* is playing.

### Why there are two sources

Every browser on Linux publishes the page's Media Session metadata over MPRIS on
the session bus — title, artist, album, artwork, playhead. What it does not
always publish is the URL:

| | Media Session metadata | playhead | duration | page URL |
|---|---|---|---|---|
| Firefox 149 | yes | yes | no | **yes** (`xesam:url`) |
| Chrome 151 | **none from Apple Music** — the tab title arrives instead | yes | yes | **no** |

Chrome is the harder case in both columns. It publishes no page URL, so nothing
outside the page can tell Apple Music from any other tab — and for Apple Music
specifically the site sets no Media Session metadata in Chrome at all, so what
does arrive is the tab title (`Top All - Playlist - Apple Music`) with an empty
artist and album. Chrome's own media controls show the same thing. No amount of
D-Bus reading fixes that.

So:

- **Firefox** works with nothing installed. It publishes the URL, so
  `music.apple.com` and `tv.apple.com` are picked out automatically and
  everything else is ignored.
- **Chrome** (and Chromium, Edge, Brave) needs the companion extension in
  [`browser/`](browser/): `chrome://extensions` → **Developer mode** → **Load
  unpacked** → the `browser/` directory. It reads **MusicKit** — the player
  object the web app itself runs on — so it gets the track, the artist, the
  album, Apple's own artwork URL at full size and an exact playhead, none of
  which Chrome forwards on its own.

Both can run at once, and normally should. The extension wins whenever it has
something to say; MPRIS covers whatever it does not.

Firefox publishes no track length, so a Firefox-sourced track gets its duration
from the catalog lookup instead — which is what puts the progress bar under it.

### Pausing is quick here, deliberately

The extension reports a pause the moment it happens — it listens for MusicKit's
`playbackStateDidChange` and the media element's own `pause` event, rather than
waiting up to a second for the next poll — and the presence comes down 1.5s
later rather than after `clearDelayMs`.

That shorter wait is specific to this source. The five-second default exists
because Music.app reports `paused` while it moves between tracks, so a pause
there cannot be distinguished from a gap between songs without waiting one out.
The web player has no such quirk: a track change arrives as its own state.
Raise `pauseClearDelayMs` if you ever do see the status blink between tracks.

### The `players` escape hatch

`browser.mpris.players` maps a fragment of an MPRIS bus name (or of the player's
`Identity`) onto what that player is assumed to be showing:

```jsonc
"browser": {
  "mpris": {
    "players": { "chromium.instance": "music" }   // or "tv", or "ignore"
  }
}
```

**This is not a way to skip the extension in Chrome.** Apple Music gives Chrome
no metadata to forward, so mapping it would put `Top All - Playlist - Apple
Music` on your status line with no artist. It is for a browser that does publish
usable metadata and that you keep exclusively for Apple Music — with no URL to
check, *every* tab in it counts, including the YouTube one. `"ignore"` is the
other direction: never report this player, whatever it says.

### Snap-packaged browsers

Snap confines its own MPRIS interface and only answers callers that are
unconfined. Running yanpresence from a normal terminal or as the systemd user
service is unconfined and works; running it from inside another sandboxed
application's terminal gets `Access denied`, which `--doctor` will tell you
about by name.

### Discord

The IPC socket is found at `$XDG_RUNTIME_DIR/discord-ipc-N`, and also inside the
Flatpak (`app/com.discordapp.Discord/`) and snap (`snap.discord/`) runtime
directories, so all three packagings work without configuration.

## Tests

```bash
npm test
```

Node's built-in runner, no dependencies. Covers the activity payload's
constraints (the `status_display_type` mapping, length caps, the never-empty
image slot), artwork cache invalidation, the watcher's watchdog, the Windows
media session's normalizers — including unpicking the album from the artist
field the Apple Music app packs them both into — the Apple TV reader's parsing
and its carry-forward when the player's controls are off screen, the tray
icon's protocol — on Windows, and over the socket to the macOS app — and the
Linux path end to end: MPRIS
parsing and classification against real captured `busctl` replies, the bridge's
HTTP contract, the extension's own scripts run against stubbed browser APIs,
and GPU encoder selection on both the VAAPI and AMF paths, including the
fall-back-to-CPU behaviour. Nothing touches Music.app, Discord, a GPU or the
network, so it runs anywhere — though the watchdog cases wait on a real 5s
interval, which puts the suite at ~20s.

A handful of cases skip on Windows, and say so when they do. They stand in for
a program the source shells out to (`busctl`, `ffmpeg`) by writing a
`#!/usr/bin/env node` file and setting the execute bit; Windows has neither,
and a `.cmd` shim cannot be spawned without `shell: true`, which the code under
test rightly does not pass. Both programs are Linux-only concerns, so the
coverage lost is coverage of code that cannot run there anyway. Elsewhere they
need `node` on `PATH` for that shebang, which a Mac running only the app does
not have.

## How it works

```
macOS:
Music.app ──Apple Events──> scripts/music-watch.js  (resident osascript, JXA)
                                     │ JSON lines
                                     ▼
                              src/music.js     ────┐  normalize, watchdog, respawn
                                                   │
Windows:                                           │
Apple Music ──media session──> scripts/smtc-watch.ps1   (resident PowerShell, WinRT)
                              src/smtc.js      ────┤  normalize, unpick artist/album
Apple TV ─────UI Automation──> scripts/tv-uia-watch.ps1 (resident PowerShell, UIA)
                              src/uia.js       ────┤  normalize, carry the gaps
                                                   │
Linux:                                             │
music.apple.com ──extension──> src/bridge.js   ────┤  loopback HTTP, reads MusicKit
   in a browser  ──MPRIS─────> src/mpris.js    ────┤  busctl, identifies by page URL
                                     │             │
                              src/sources.js  ─────┘  one snapshot shape either way
                                     ▼
                              src/index.js          track/seek/pause state machine
                                ├──> src/catalog.js links + artwork URL + motion artwork
                                ├──> src/artwork.js ffmpeg transcode + hosting
                                └──> src/presence.js activity payload
                                             ▼
                                     src/discord.js  IPC framing over discord-ipc-N
                                                     (a named pipe on Windows)
```

A few decisions worth calling out:

- **The watcher is a resident process, not one `osascript` per poll.** Spawning
  costs ~15ms of process churn every tick, and a long-lived script keeps the
  Apple Event connection to Music.app warm. A watchdog restarts it if it goes
  quiet — Music.app can block on an Apple Event during an iCloud library
  refresh, which stalls the script without killing it. The Windows watcher is
  the same idea and shares the same supervisor: a long-lived PowerShell host
  is far too expensive to spawn per tick, and the process lifecycle, the line
  framing and the watchdog are identical whatever is on the far end.
- **Catalog metadata comes from `amp-api`**, the backend music.apple.com's own
  web player uses, authenticated with the anonymous token from its JS bundle.
  That's the only route to `editorialVideo` (motion artwork) — the public
  MusicKit API doesn't expose it. If that path fails for any reason, it falls
  back to the unauthenticated iTunes Search API, which still yields links and
  1024×1024 art, just no animation.
- **Matching is fuzzy and scored.** Local titles and catalog titles rarely agree
  character-for-character (`Song (feat. X) - Remastered 2011` vs `Song`), so
  editorial decoration is stripped before comparing, and title/artist/album/
  duration are weighted together. Below a confidence threshold it shows no
  links rather than wrong ones.
- **Discord IPC is spoken directly** — no `discord-rpc` dependency. The whole
  project has zero npm dependencies.
- **The browser sources hand back the same snapshots the Apple apps do**, which
  is why nothing below `src/sources.js` knows or cares which platform it is on.
  The one thing that genuinely differs is identification: an Apple Event can
  only have come from Music.app, while a browser tab has to prove which site it
  is — see [Linux and the web player](#linux-and-the-web-player).
- **The two Windows apps have nothing in common but their vendor.** Apple Music
  publishes a media session — the same record the volume flyout and your
  keyboard's play key already use — and packs the artist and the album into one
  field of it. Apple TV publishes no session at all and has to be read off its
  own UI, which only exists while its controls are on screen. Both end up
  producing the snapshots macOS produces, which is the only reason two
  mechanisms this unalike can sit behind one source.
- **On macOS the menu bar app is Node's parent, not its child** — the reverse
  of the Windows tray icon. macOS asks for Automation permission on behalf of
  the app it launched, so that has to be yanpresence.app, not `node`; see
  [The macOS app](#the-macos-app).
- **GPU work is verified, not assumed** — and then measured, which is how VAAPI
  turned out to produce files Discord cannot render at all while AMF, on the
  same silicon, produces files it renders fine. Both facts came from checking,
  and `"auto"` differs by platform because of them.

## Troubleshooting

**Nothing appears in Discord.** Discord hides your own activity from yourself in
some views — check your profile popout, or ask someone else. Also confirm
*Settings → Activity Privacy → Share your detected activities* is on.

**`--doctor` says no response from the watcher.** macOS is blocking automation.
*System Settings → Privacy & Security → Automation* → allow your terminal (or
`node`) to control Music.

**macOS: "yanpresence" Not Opened.** The app is not notarized. Choose **Done**,
then *System Settings → Privacy & Security* → **Open Anyway**; see
[Install on macOS](#install-on-macos).

**macOS: the app runs, but nothing reaches Discord and its menu says Allow
Control of Music….** The permission prompt was refused. Choose that item, and
switch on Music (and TV) under yanpresence.

**macOS: I cannot find the menu bar icon.** Open yanpresence again from
Applications or Spotlight: the running copy puts its icon back and drops its
menu open. On a crowded menu bar, icons past the notch are not drawn at all.

**Windows: `--doctor` says Apple Music is not running when it is.** The app
registers its media session when it launches, so this means the session is not
being seen rather than not existing. Run `node bin/yanpresence.js --smtc` to
list what *is* published — if Apple Music appears there under a different
identifier than `AppleInc.AppleMusicWin`, put that prefix in
`windows.appIds.music`.

**Windows: the Start menu shortcut does nothing.** It runs hidden, so a failure
to start is invisible by design. Look at
`%LOCALAPPDATA%\yanpresence\cache\yanpresence.log`, which is written before
the config is even validated. A start-up failure also raises a dialog box; if
you got neither, rerun the installer to restore the bundled runtime. Source
installs also check `PATH` and usual Node.js install locations, and show a
message box if Node.js cannot be found.

**Windows: I cannot find the tray icon.** Windows 11 hides new notification-area
icons behind the **^** arrow next to the clock. Click it, then drag the icon
onto the taskbar to keep it visible.

**Windows: "yanpresence is already running".** A tray run claims a named pipe so
two copies cannot fight over one presence. Quit the first from its tray icon —
or, if it is orphaned, `Get-Process node | Stop-Process`.

**The status line shows "Listening to Apple Music" instead of the song.** That
means your Discord build isn't honouring `status_display_type`. It's part of the
Activity object and is what puts the song on the status line; if your client
ignores it, there's no workaround — the header text always comes from the
application name, which can't be set per-track. Update Discord, and check
`--dry-run` shows `"status_display_type": 2` with the song in `"details"`.

**Links aren't clickable.** `details_url` / `state_url` / `large_url` need a
reasonably current Discord build. Set `"linkButtons": true` for the classic
button fallback.

**A grey "?" where the album art should be.** That is Discord's placeholder for
an asset it could not resolve — the field was sent, but the image did not load.
The shared applications already include the `blank` fallback asset. If you
use your own application, upload `assets/blank.png` as `blank`. Then run:

```bash
node bin/yanpresence.js --test-assets
```

That cycles a portal asset, a plain external URL, a signed external URL and an
animated one through your presence, 15s each, so you can see which kinds your
client actually renders. Discord reports nothing back about asset resolution,
so looking is the only way to tell.

**No album art at all.** Check `--dry-run` output for `large_image`. If the
track is a local file that isn't in Apple's catalog, its embedded cover uses
the shared gateway by default. Check the log for an upload error or rate limit;
custom hosts must also be configured and reachable. On Windows that cover comes
from the thumbnail the app hands the media session.

**Windows: the Apple TV card shows the wrong show, or the numbering is missing.**
The season and episode are read out of free text there rather than from
properties — see [Apple TV on Windows](#apple-tv-on-windows). Run
`node bin/yanpresence.js --smtc` while it is playing: it prints the raw fields
next to what was made of them, which turns a guess into a diff.

**Animated art never shows.** Most albums simply don't have motion artwork.
Run with `--verbose`: you'll see `Hosted animated artwork for …` when one does.
The shared gateway can reject oversized or rate-limited uploads; static catalog
art remains available while the animated cover cannot be hosted.

## Website

<https://presence.ethanyanxu.com> is [`docs/index.html`](docs/index.html),
served from **finprint-host**, the home Windows laptop, by the Caddy instance
that already serves the other co-hosted sites. It used to be on Vercel, until
Vercel disabled the deployment.

The host deploys the site itself, the way Vercel did: a scheduled task,
`yanpresence-site-deploy`, fetches `main` every two minutes as SYSTEM. When
`docs/` has changed, it unpacks `docs/` at that commit into a new release
directory, adds `version.txt` with the commit, and points Caddy at it. Only
files are published. Nothing from the repository runs on the host, so the
deploy scripts change only when you re-run the installer.

A release counts as live only once `https://presence.ethanyanxu.com/version.txt`,
fetched through Caddy with a publicly trusted certificate, returns its commit.
A release that is not served within 30 seconds is switched back to the
previous one, and that version of `docs/` is not tried again until `docs/`
changes.

### Set up the host

Once, in an **Administrator PowerShell on finprint-host**, from the root of a
copy of this repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1
```

It creates `C:\ProgramData\yanpresence`, which only SYSTEM and Administrators
can write to because SYSTEM's Caddy loads configuration from it. It clones the
repository there, registers the task, and runs one deploy pass. Re-running it
is safe, and is how a newer version of the deploy scripts is installed.

DNS for `ethanyanxu.com` is on Cloudflare. `presence` must be a **DNS-only**
`CNAME` to `finprint.ethanyanxu.com`, TTL 60, so it follows that record when
the home IP changes. Until it is, the zone's wildcard sends the name to Vercel,
and the task waits. It adds the site to Caddy only once public resolvers answer
`presence` exactly as they answer `finprint`. Adding it earlier would make
Caddy ask Let's Encrypt for a certificate that cannot validate, which counts
against Let's Encrypt's limit of 5 failed validations per hour and puts Caddy
on a retry backoff that stretches to hours.

To change the domain, add the new name's `CNAME` and re-run the installer with
`-Domain <new name>`. The same rule applies: the site keeps answering on the
old name until the new one resolves here, then moves and gets its certificate.
Delete the old name's record afterwards.

### Operations

Run the offline deployment regression checks on Windows from the repository
root with `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/test.ps1`.
They check DNS gating, interrupted deploy recovery, rollback, and Caddy edits
without connecting to the host or changing any live configuration.

| Task | Command (on finprint-host, elevated) |
|---|---|
| Which commit is live | `curl.exe -s https://presence.ethanyanxu.com/version.txt` |
| Deploy now, or see why nothing changed | `powershell -ExecutionPolicy Bypass -File C:\ProgramData\yanpresence\ops\deploy.ps1` |
| What the task did | `Get-Content C:\ProgramData\yanpresence\logs\deploy.log -Tail 20` |
| Pin a commit | `Disable-ScheduledTask yanpresence-site-deploy`, then `deploy.ps1 -Ref <sha>` |
| Retry a rolled-back version | `deploy.ps1 -Retry` |

The task logs a condition when it changes, not on every pass. Re-running
finprint's `setup.ps1` regenerates its Caddyfile without the co-hosted sites'
import blocks; the next pass puts this one back.

To remove the site: `Unregister-ScheduledTask yanpresence-site-deploy`, delete
the `# BEGIN yanpresence (managed)` block from
`C:\Users\ethan\finprint\scripts\selfhost\Caddyfile`, reload Caddy, and delete
`C:\ProgramData\yanpresence`.

## License

MIT
