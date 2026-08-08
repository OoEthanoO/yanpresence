# yanpresence

Apple Music → Discord Rich Presence, for macOS.

Watches the **Music** app over Apple Events and mirrors what you're playing into
Discord, laid out like Discord's own Spotify integration — with the song name on
your status line instead of the artist, full-size album art, and the song,
artist and album all clickable through to Apple Music.

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
  └────────────┘
     ↑ hover shows the album, click opens it
```

## What it does

- **macOS + Music.app only.** Playback state comes from Apple Events sent to
  `Music.app`; nothing else triggers it.
- **The song name on the status line.** Discord's `status_display_type` picks
  which field lands on the one-line status under your name. Spotify sets it to
  `STATE`, which is why its status reads as the *artist*; this sets `DETAILS`,
  so yours reads **"Listening to Be Her"**.

  The expanded card's header is a separate thing, and it always comes from the
  application's name — Discord's docs are explicit that *"you can't set App Name
  when setting presence"*. That's why step 1 of setup is naming the application
  `Apple Music`: the header reads "Listening to Apple Music" while the status
  line reads the song.
- **1024×1024 album art**, pulled from Apple's artwork CDN at full square size —
  the asset size Discord's own docs recommend.
- **Animated album art** where Apple has published motion artwork — the *full*
  loop at source framerate, transcoded from Apple's HLS master to animated AVIF
  (see [Animated artwork](#animated-artwork)).
- **Three clickable links.** Song → `details_url`, artist → `state_url`,
  album → the artwork's `large_url`. All point at `music.apple.com`.
- **Live progress bar**, with seek detection — scrub the track and the bar
  follows.
- **Nothing shown while paused.** Pause and the status disappears, the same way
  Discord's Spotify integration behaves. Set `showWhenPaused: true` to keep it
  up instead.
- Survives Discord restarts, Music.app restarts, and sleep/wake.

## Requirements

- macOS with the Music app
- Node.js 18+ (developed on 26)
- The Discord **desktop** app running (the web client has no local IPC socket)
- `ffmpeg` — only for animated artwork (`brew install ffmpeg`)
- `webp` — only if you switch `animatedArtwork.format` to `"webp"`
  (`brew install webp`); the default AVIF path needs just ffmpeg

## Setup

### 1. Create a Discord application

Go to <https://discord.com/developers/applications> → **New Application**.

**Name it `Apple Music`.** Discord builds the "Listening to …" header from the
application's name — not from anything the client sends — so the name you pick
here is the name everyone sees.

Copy the **Application ID** from *General Information*.

While you're there, open **Rich Presence → Art Assets** and upload two images:

- **`blank`** — upload [`assets/blank.png`](assets/blank.png), a fully
  transparent 1024×1024 PNG. This is the fallback for when there's no album art
  to show. Without it, an empty large-image slot renders as Discord's grey "?"
  placeholder; with it, the slot just reads as blank. Configured via
  `placeholderImageKey`.
- **`applemusic`** *(optional)* — an Apple Music glyph, shown as the small badge
  in the corner of the album art. Skip it and set `showSmallImage: false`.

### 2. Configure

```bash
cd ~/yanpresence
node bin/yanpresence.js --init
```

That writes `~/Library/Application Support/yanpresence/config.json`. Open it and
paste your Application ID into `clientId`.

### 3. Check the setup

```bash
node bin/yanpresence.js --doctor
```

This verifies the Music.app connection, the Discord IPC socket, the Apple Music
catalog lookup, and the animated-artwork toolchain, and tells you exactly what's
missing.

The first run triggers macOS's automation prompt — **allow your terminal to
control Music**. If you miss it, it's under *System Settings → Privacy &
Security → Automation*.

### 4. Run it

```bash
node bin/yanpresence.js
```

To have it start at login:

```bash
npm run install-agent
```

Logs go to `~/Library/Logs/yanpresence/`. Remove it with `npm run uninstall-agent`.

## Animated artwork

Apple publishes motion artwork for a lot of albums, but ships it as an **HLS
video stream** — and Discord's presence asset slot renders images, not video.
So there's a transcode step, and the result needs a public URL.

The path this takes: pull Apple's motion master with `ffmpeg`, encode the whole
loop as animated **AVIF**, and host it. Discord's docs are explicit that
external-URL assets support GIF, animated WebP and AVIF — assets *uploaded* to
the Developer Portal cannot animate at all, which is why this goes through a
hosted URL. Results are cached per album.

Hosting has three modes.

> **`webhook` cannot serve presence assets.** The upload succeeds and the image
> is visible in the channel, but Discord will not render a `cdn.discordapp.com`
> attachment URL as a Rich Presence asset — those URLs carry a mandatory signed
> query string (`?ex=…&is=…&hm=…`), 404 without it, and come out as the grey "?"
> placeholder. Confirmed by bisecting: the *identical* JPEG renders from Apple's
> CDN and fails from Discord's. Use `s3`.

### `s3` — recommended

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

With neither configured, everything still works — you just get static 1024×1024
art. Animation is opt-in, not required.

### Nothing is truncated, shrunk, or degraded

The defaults encode the **entire loop** (Apple's are ~20–24s) at **source
framerate**, at high quality, in **AVIF** — about 3.7 MB, which fits inside even
a free Discord webhook. No clipping, no downscaling, no quality ladder.

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

`maxBytes: null` disables the budget check altogether, so no encode is ever
refit. On a free webhook, `2160 / crf 26` (8.4 MB) gets you Apple's full
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

With the defaults it never will — 3.7 MB against a 9 MB budget. But if you push
the settings up on webhook hosting, `onOversize` decides what happens:

- `"degrade"` (default) — re-encode to fit. Quality is spent **before**
  resolution, and the retry targets the budget by area rather than stepping down
  blindly, so it converges in one extra pass. Duration is never truncated.
- `"skip"` — refuse to compromise. The animation is abandoned and the static
  1024×1024 cover is used instead.

Setting `"maxBytes": null` disables the check entirely, which is the right thing
with `command` hosting.

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
2. `~/Library/Application Support/yanpresence/config.json`
3. `~/.config/yanpresence/config.json`
4. `./config.json`

| Key | Default | |
|---|---|---|
| `clientId` | — | **Required.** Discord Application ID. |
| `activityName` | `"Apple Music"` | Keep in sync with the app's name in the portal. |
| `storefront` | `"us"` | Apple Music storefront for lookups and links. |
| `statusDisplay` | `"details"` | Which field lands on your status line: `details` (song), `state` (artist, Spotify's choice), `name`. |
| `artworkSize` | `1024` | Square px requested from Apple's CDN. |
| `showSmallImage` | `true` | Small corner badge. |
| `smallImageKey` | `"applemusic"` | Name of the Art Asset uploaded in the portal. |
| `placeholderImageKey` | `"blank"` | Portal asset shown when there's no album art, so the slot never renders as Discord's "?". Upload `assets/blank.png`. `null` leaves the slot empty. |
| `linkButtons` | `false` | Also attach classic Rich Presence buttons — a fallback for older clients that don't render `details_url`/`state_url`/`large_url`. |
| `showWhenPaused` | `false` | Keep the presence up while paused. Off by default — a paused track isn't something you're listening to. When on, the progress bar is dropped. |
| `pollIntervalMs` | `1000` | How often Music.app is sampled. |
| `minUpdateIntervalMs` | `2500` | Floor between `SET_ACTIVITY` frames; Discord rate-limits these. |
| `seekToleranceSec` | `2` | Drift before a seek is assumed and the timeline is rebased. |
| `clearDelayMs` | `5000` | How long playback must be non-playing — paused, stopped or quit — before the presence clears. Music.app blips `paused` between tracks, so clearing instantly would flicker the status between every song. Lower it for a snappier hide. |
| `hosting.mode` | `"webhook"` | `webhook` (Discord-hosted, capped) or `command` (your own storage, uncapped). |
| `hosting.webhookUrl` | — | Discord webhook URL, for `webhook` mode. |
| `hosting.command` | — | Uploader command with `{file}` / `{name}`, for `command` mode. Must print the public URL. |
| `animatedArtwork.format` | `"avif"` | `avif` \| `webp` \| `gif`. |
| `animatedArtwork.size` | `1024` | Square px. Apple's masters go to 2160. |
| `animatedArtwork.fps` | `30` | Source framerate, so no frames are dropped. |
| `animatedArtwork.maxDurationSec` | `null` | `null` plays the whole loop. A number truncates. |
| `animatedArtwork.crf` | `20` | AVIF quality; lower is better. 14 ≈ source. |
| `animatedArtwork.quality` | `75` | WebP quality, when `format` is `webp`. |
| `animatedArtwork.maxBytes` | `9437184` | Encode ceiling. `null` disables the check. |
| `animatedArtwork.onOversize` | `"degrade"` | `degrade` refits to fit; `skip` falls back to static art rather than compromise. |
| `uploadLocalArtwork` | `true` | For local library files with no catalog entry, upload their embedded cover through the same host. |
| `logLevel` | `"info"` | `error` \| `warn` \| `info` \| `debug` |

Environment overrides: `YANPRESENCE_CLIENT_ID`, `YANPRESENCE_STOREFRONT`,
`YANPRESENCE_WEBHOOK_URL`, `YANPRESENCE_LOG_LEVEL`, `YANPRESENCE_CONFIG`.

## Commands

```bash
node bin/yanpresence.js              # run
node bin/yanpresence.js --doctor     # check the setup
node bin/yanpresence.js --watch      # print Music.app state, ignore Discord
node bin/yanpresence.js --dry-run    # full pipeline, print the payload instead of sending
node bin/yanpresence.js --verbose    # debug logging
```

`--dry-run` needs no `clientId` and is the fastest way to see exactly what
Discord would be told.

## How it works

```
Music.app ──Apple Events──> scripts/music-watch.js  (resident osascript, JXA)
                                     │ JSON lines
                                     ▼
                              src/music.js          normalize, watchdog, respawn
                                     ▼
                              src/index.js          track/seek/pause state machine
                                ├──> src/catalog.js links + artwork URL + motion artwork
                                ├──> src/artwork.js ffmpeg transcode + hosting
                                └──> src/presence.js activity payload
                                             ▼
                                     src/discord.js  IPC framing over discord-ipc-N
```

A few decisions worth calling out:

- **The watcher is a resident process, not one `osascript` per poll.** Spawning
  costs ~15ms of process churn every tick, and a long-lived script keeps the
  Apple Event connection to Music.app warm. A watchdog restarts it if it goes
  quiet — Music.app can block on an Apple Event during an iCloud library
  refresh, which stalls the script without killing it.
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

## Troubleshooting

**Nothing appears in Discord.** Discord hides your own activity from yourself in
some views — check your profile popout, or ask someone else. Also confirm
*Settings → Activity Privacy → Share your detected activities* is on.

**`--doctor` says no response from the watcher.** macOS is blocking automation.
*System Settings → Privacy & Security → Automation* → allow your terminal (or
`node`) to control Music.

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
Upload `assets/blank.png` as a portal asset named `blank` so the fallback has
somewhere to land, then run:

```bash
node bin/yanpresence.js --test-assets
```

That cycles a portal asset, a plain external URL, a signed external URL and an
animated one through your presence, 15s each, so you can see which kinds your
client actually renders. Discord reports nothing back about asset resolution,
so looking is the only way to tell.

**No album art at all.** Check `--dry-run` output for `large_image`. If the
track is a local file that isn't in Apple's catalog, artwork needs
`hosting.webhookUrl` (or `hosting.command`) set so its embedded cover can be
hosted.

**Animated art never shows.** Most albums simply don't have motion artwork.
Run with `--verbose`: you'll see `Hosted animated artwork for …` when one does.

## License

MIT
