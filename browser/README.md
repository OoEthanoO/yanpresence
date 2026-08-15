# yanpresence bridge (browser extension)

Tells yanpresence what the Apple Music web player is playing.

## Why this exists

On Linux, playback state comes off the session bus over MPRIS — every browser
publishes the page's Media Session metadata there, which is title, artist,
album, artwork and playhead. What it does not always publish is *which page*:

| | Media Session metadata | playhead | page URL |
|---|---|---|---|
| Firefox | yes | yes | **yes** (`xesam:url`) |
| Chrome 151 | **none from Apple Music** — the tab title instead | yes | **no** |

Without the URL there is nothing separating Apple Music from any other tab, and
guessing would announce YouTube as Apple Music. Chrome is worse off still: Apple
Music publishes no Media Session metadata to it, so what reaches the bus is the
tab title — `Top All - Playlist - Apple Music`, no artist, no album. Chrome's
own media controls show exactly that. So Firefox works with nothing installed,
and **Chrome needs this extension**.

It is also the better source either way. It reads **MusicKit**, the player
object the web app itself runs on, so the track, artist, album, playhead and
Apple's own full-size artwork URL come from the player rather than from whatever
the browser chose to forward.

It does not touch `tv.apple.com`. Apple TV is a macOS source in yanpresence,
driven through TV.app, which reports the show, season and episode as fields the
web player does not offer.

## Install

### Chrome, Edge, Brave, and other Chromium browsers

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `browser/` directory.

Leave the directory where it is — the browser loads it from that path at every
start. (Chrome no longer accepts `--load-extension` on the command line, so
this is the supported route.)

### Firefox

Firefox needs nothing: it publishes the page URL over MPRIS, so yanpresence
identifies Apple Music on its own. To use the extension anyway, open
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`manifest.json` here. Temporary add-ons are dropped at browser restart, which
is why MPRIS is the better fit there.

## Check it is working

`yanpresence --doctor` reports whether anything has reported in. Or open the
extension's **Options** page and press **Test connection**.

The defaults match a stock config (`127.0.0.1:8763`). Change them only if you
changed `browser.bridge` in yanpresence's config; if you set
`browser.bridge.token`, paste the same value into Options.

## What it sends, and where

Only on `music.apple.com`, once a second while a tab is playing, to
`http://127.0.0.1:8763/state` on your own machine:

```json
{
  "url": "https://music.apple.com/ca/album/hungover/1?i=2",
  "state": "playing",
  "title": "Be Her",
  "artist": "Ella Langley",
  "album": "Hungover",
  "artwork": "https://is1-ssl.mzstatic.com/.../512x512bb.jpg",
  "position": 64.2,
  "duration": 191.5
}
```

Nothing leaves the machine, there is no remote endpoint, and no other site is
touched. yanpresence refuses reports that do not come from an extension origin,
and decides for itself whether the URL is Apple — a page cannot claim to be
Apple Music by saying so.

## The pieces

| file | runs where | does |
|---|---|---|
| `page.js` | the page's own JS context | reads MusicKit, falling back to Media Session and the media element |
| `content.js` | isolated content script | relays those to the service worker |
| `background.js` | service worker | posts them to yanpresence |
| `options.js` | options page | host, port, token, and a connection test |

The split exists because the page's Content Security Policy blocks a request to
`127.0.0.1`, and the service worker cannot see into the page. Each half does the
one thing the other cannot.
