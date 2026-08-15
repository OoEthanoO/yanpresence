/**
 * Runs in the page's own JavaScript context (manifest `world: "MAIN"`).
 *
 * Three ways to find out what is playing, in descending order of how much they
 * can be trusted:
 *
 *   1. MusicKit. music.apple.com is built on it, and it is the player itself --
 *      `nowPlayingItem` is the track, not a guess about the track. Reaching it
 *      is the whole reason this half runs in the page's context rather than an
 *      isolated one.
 *
 *   2. The Media Session API, which is what the browser forwards to the OS.
 *      Firefox gets this from Apple Music; Chrome does not -- there, the site
 *      publishes no Media Session metadata at all, which is why Chrome's own
 *      media controls show the *tab title* where the song should be. Nothing
 *      outside the page can fix that, and it is why this extension exists.
 *
 *   3. The media element, for the playhead when neither of the above has one.
 *
 * It cannot talk to yanpresence directly: the page's own CSP forbids it. So it
 * posts to the isolated content script, which relays to the service worker,
 * which does the request.
 */
(() => {
  const REPORT_MS = 1000;
  // Long enough that a stall or a buffering hiccup is not reported as a stop,
  // short enough that the presence does not linger after a tab goes quiet.
  const IDLE_REPORTS = 3;
  const ARTWORK_PX = 1024;

  let lastSerialized = '';
  let idleReports = 0;

  /* --- 1. the player itself ---------------------------------------- */

  function musicKitInstance() {
    try {
      return window.MusicKit?.getInstance?.() ?? null;
    } catch {
      // Present but not configured yet; the next tick will find it.
      return null;
    }
  }

  /**
   * MusicKit's playback states are finer-grained than "is it playing".
   * Seeking, waiting and stalled are all still a track in progress -- treating
   * them as stopped would blink the presence off every time a buffer runs dry.
   */
  function stateOf(playbackState) {
    const states = window.MusicKit?.PlaybackStates ?? {};
    if ([states.playing, states.seeking, states.waiting, states.stalled].includes(playbackState)) {
      return 'playing';
    }
    if (playbackState === states.paused) return 'paused';
    return 'stopped';
  }

  function artworkOf(item) {
    try {
      if (item.artwork && window.MusicKit?.formatArtworkURL) {
        return window.MusicKit.formatArtworkURL(item.artwork, ARTWORK_PX, ARTWORK_PX);
      }
    } catch {
      /* fall through to whatever the item already carries */
    }
    return item.artworkURL ?? '';
  }

  function fromMusicKit() {
    const player = musicKitInstance();
    const item = player?.nowPlayingItem;
    if (!item) return null;

    const title = item.title ?? '';
    if (!title) return null;

    return {
      state: stateOf(player.playbackState),
      title,
      artist: item.artistName ?? '',
      album: item.albumName ?? '',
      artwork: artworkOf(item),
      position: Number(player.currentPlaybackTime) || 0,
      // playbackDuration is milliseconds here, unlike everything else.
      duration: Number(item.playbackDuration) ? Number(item.playbackDuration) / 1000 : 0,
    };
  }

  /* --- 2 and 3. what the browser knows ------------------------------ */

  function playingElement() {
    const media = [...document.querySelectorAll('audio, video')];
    return (
      media.find((el) => !el.paused && !el.ended && el.readyState > 0) ??
      media.find((el) => el.currentTime > 0) ??
      null
    );
  }

  /** The biggest artwork on offer; Apple lists several sizes of the same image. */
  function mediaSessionArtwork(metadata) {
    const list = metadata?.artwork ?? [];
    let best = null;
    let bestArea = -1;
    for (const art of list) {
      if (!art?.src) continue;
      const [w, h] = String(art.sizes ?? '').split('x').map(Number);
      const area = Number.isFinite(w * h) ? w * h : 0;
      if (area >= bestArea) {
        bestArea = area;
        best = art.src;
      }
    }
    return best ?? '';
  }

  function fromBrowser() {
    const metadata = navigator.mediaSession?.metadata ?? null;
    const element = playingElement();

    // A frame with neither is a frame with nothing to say. Staying silent
    // matters: Apple's pages are full of iframes, and a chatty empty one would
    // fight with the frame that is actually playing.
    if (!metadata && !element) return null;

    let state = 'stopped';
    if (element) state = element.paused ? 'paused' : 'playing';
    else if (navigator.mediaSession?.playbackState === 'playing') state = 'playing';
    else if (navigator.mediaSession?.playbackState === 'paused') state = 'paused';

    const title = metadata?.title ?? '';
    if (!title) state = 'stopped';

    return {
      state,
      title,
      artist: metadata?.artist ?? '',
      album: metadata?.album ?? '',
      artwork: mediaSessionArtwork(metadata),
      position: element && Number.isFinite(element.currentTime) ? element.currentTime : 0,
      duration: element && Number.isFinite(element.duration) ? element.duration : 0,
    };
  }

  /* ------------------------------------------------------------------ */

  function snapshot() {
    const found = fromMusicKit() ?? fromBrowser();
    if (!found) return null;

    // The player knows the track but not always the playhead (a cast session,
    // an ad break); the element in the same page usually does.
    if (!found.position) {
      const element = playingElement();
      if (element && Number.isFinite(element.currentTime)) found.position = element.currentTime;
    }

    return { url: location.href, ...found };
  }

  function report() {
    const payload = snapshot();
    if (!payload) return;

    // Stopped is worth saying once -- it takes the presence down -- but not
    // forever after.
    if (payload.state === 'stopped') {
      if (idleReports >= IDLE_REPORTS) return;
      idleReports += 1;
    } else {
      idleReports = 0;
    }

    // The playhead moves every tick, so this is not a change filter; it only
    // collapses the truly identical repeats of a paused or stopped tab.
    const serialized = JSON.stringify(payload);
    if (serialized === lastSerialized && payload.state !== 'playing') return;
    lastSerialized = serialized;

    window.postMessage({ __yanpresence: 1, payload }, location.origin);
  }

  setInterval(report, REPORT_MS);
  document.addEventListener('visibilitychange', report);
  report();
})();
