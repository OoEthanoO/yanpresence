import { rm } from 'node:fs/promises';

import { AppleCatalog } from './catalog.js';
import { ArtworkHost } from './artwork.js';
import { CACHE_DIR } from './config.js';
import { DiscordRPC } from './discord.js';
import { buildActivity, buildWatchActivity, describe } from './presence.js';
import { createSources } from './sources.js';
import { episodeCode } from './tv.js';
import { TvCatalog } from './tvcatalog.js';
import log from './log.js';

export class YanPresence {
  constructor(config, { dryRun = false } = {}) {
    this.config = config;
    this.dryRun = dryRun;

    this.catalog = new AppleCatalog({
      storefront: config.storefront,
      cacheDir: CACHE_DIR,
      artworkSize: config.artworkSize,
    });
    this.artwork = new ArtworkHost({ config, cacheDir: CACHE_DIR });
    this.rpcClientId = config.clientId;
    this.rpc = new DiscordRPC({ clientId: this.rpcClientId });

    // Music.app and TV.app on macOS; the web players everywhere else. Both
    // hand back the same snapshots, so nothing below this line knows which.
    this.sources = createSources(config);
    this.watcher = this.sources.music;

    // Video is a second, independent source. Only one can hold the presence
    // at a time -- see pickSource().
    // Config may ask for TV on a platform whose source cannot serve it; what
    // decides is whether the source produced a channel.
    this.tvWatcher = this.sources.tv;
    this.tvEnabled = Boolean(config.tv?.enabled && this.tvWatcher);
    this.tvCatalog = this.tvEnabled
      ? new TvCatalog({
          storefront: config.storefront,
          cacheDir: CACHE_DIR,
          artworkSize: config.artworkSize,
        })
      : null;
    this.tvSnapshot = null;
    this.musicSnapshot = null;
    this.tvArtworkUrl = null;
    this.tvDuration = 0;
    this.source = null; // 'music' | 'tv' | null

    // Everything about the track Discord is currently being told about.
    this.currentKey = null;
    this.currentState = null;
    this.currentTrack = null;
    this.startedAt = null;
    this.catalogResult = null;
    this.artworkUrl = null;

    this.lastSentJson = null;
    this.lastSentAt = 0;
    this.flushTimer = null;
    this.clearTimer = null;
    this.hideTimer = null;
    this.pendingActivity = undefined;
  }

  start() {
    if (this.dryRun) {
      log.info('Dry run — building activity payloads without contacting Discord');
    } else {
      this.rpc.on('ready', () => {
        // A reconnect drops whatever we had set, so replay it.
        this.lastSentJson = null;
        this.render();
      });
      this.rpc.connect();
    }

    this.watcher.on('state', (snapshot) => this.onSnapshot(snapshot));
    this.watcher.start();

    if (this.tvWatcher) {
      this.tvWatcher.on('state', (snapshot) => this.onTvSnapshot(snapshot));
      this.tvWatcher.start();
    }

    log.info(this.sources.describe());
    if (!this.artwork.canHost) {
      log.info(
        `No artwork hosting configured — album art will be static ${this.config.artworkSize}x${this.config.artworkSize}. ` +
          'Set hosting.s3 (or hosting.command) to enable animated artwork.'
      );
    }
  }

  stop() {
    this.watcher.stop();
    this.tvWatcher?.stop();
    clearTimeout(this.flushTimer);
    clearTimeout(this.clearTimer);
    clearTimeout(this.hideTimer);
  }

  async shutdown() {
    this.stop();
    try {
      if (this.rpc.ready) await this.rpc.clearActivity();
    } catch {
      /* Discord may already be gone */
    }
    this.rpc.destroy();
  }

  /* ------------------------------------------------------------------ */

  /* ---- TV.app ------------------------------------------------------- */

  onTvSnapshot(snapshot) {
    this.tvSnapshot = snapshot;

    if (!snapshot.active) {
      if (this.tvKey !== null) {
        this.tvKey = null;
        this.tvItem = null;
        this.tvState = snapshot.state;
        this.tvStartedAt = null;
        // Music may be waiting to take over; if nothing is, the music clear
        // path takes the presence down.
        this.render();
      }
      return;
    }

    const { item, state, receivedAt } = snapshot;

    if (item.key !== this.tvKey) {
      const code = episodeCode(item);
      log.info(
        `Now ${state}: ${item.show ? `${item.show} — ` : ''}${item.name}${code ? ` (${code})` : ''}`
      );
      this.tvKey = item.key;
      this.tvItem = item;
      this.tvState = state;
      this.tvStartedAt = state === 'playing' ? receivedAt - item.position * 1000 : null;
      this.tvArtworkUrl = null;
      this.tvDuration = 0;
      this.cancelHide();
      this.render();
      this.enrichTv(item).catch((err) => log.debug(`TV enrichment failed: ${err.message}`));
      return;
    }

    this.tvItem = item;
    const stateChanged = state !== this.tvState;
    this.tvState = state;

    if (state === 'paused') {
      this.tvStartedAt = null;
      if (stateChanged) this.render();
      return;
    }

    const predicted = this.tvStartedAt === null ? null : (receivedAt - this.tvStartedAt) / 1000;
    const drifted =
      predicted === null || Math.abs(predicted - item.position) > this.config.seekToleranceSec;

    if (drifted) {
      this.tvStartedAt = receivedAt - item.position * 1000;
      this.render();
    } else if (stateChanged) {
      this.render();
    }
  }

  /**
   * Artwork for what TV.app is playing, from the backend behind tv.apple.com.
   * Keyed on the show, so a binge costs one lookup. Apple TV+ titles resolve;
   * Store purchases do not appear in that search and keep the placeholder.
   */
  async enrichTv(item) {
    if (!this.tvCatalog) return;
    const key = item.key;
    const result = await this.tvCatalog.lookup(item);
    if (this.tvKey !== key) return; // moved on while we were looking

    // Deliberately no page-artwork fallback here, unlike music: this method
    // only runs under the apple-apps source -- WebSources.tv is null -- and
    // TV.app items carry no artUrl for one to read. A show the catalog cannot
    // match keeps placeholderImageKey.
    if (result?.artworkUrl) {
      this.tvArtworkUrl = result.artworkUrl;
      log.debug(`TV artwork (${result.artworkScope}) for ${result.title}: ${result.artworkUrl}`);
      this.render();
    }

    // Apple TV+ streams report no duration through TV.app, so without this
    // there is no end timestamp and therefore no progress at all. Deliberately
    // outside the artwork branches: the two are independent, and returning
    // early once artwork resolved would leave every catalog-matched show
    // without progress.
    if (!item.duration) {
      const seconds = await this.tvCatalog.durationFor(item);
      if (seconds && this.tvKey === key) {
        this.tvDuration = seconds;
        log.debug(`TV runtime for ${item.name}: ${seconds}s (TV.app reported none)`);
        this.render();
      }
    }
  }

  /* ---- Music.app ---------------------------------------------------- */

  onSnapshot(snapshot) {
    this.musicSnapshot = snapshot;

    if (!snapshot.active) {
      this.onInactive(snapshot.state);
      return;
    }

    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }

    const { track, state, receivedAt } = snapshot;

    if (track.key !== this.currentKey) {
      this.onTrackChange(track, state, receivedAt);
      return;
    }

    this.currentTrack = track;

    const stateChanged = state !== this.currentState;
    this.currentState = state;

    if (state === 'paused') {
      // Freeze the playhead: on resume we rebase from the reported position.
      this.startedAt = null;
      if (stateChanged) this.render();
      return;
    }

    // Playing. Rebase the timeline whenever reality drifts from our prediction
    // — that covers resuming, scrubbing, and Music.app's own gapless quirks.
    const predicted = this.startedAt === null ? null : (receivedAt - this.startedAt) / 1000;
    const drifted =
      predicted === null || Math.abs(predicted - track.position) > this.config.seekToleranceSec;

    if (drifted) {
      this.startedAt = receivedAt - track.position * 1000;
      this.render();
    } else if (stateChanged) {
      this.render();
    }
  }

  onInactive(state) {
    // Already idle and already cleared: nothing to do.
    if (this.currentKey === null && this.lastSentJson === 'null') return;

    // Track transitions briefly report "stopped"; wait it out so the presence
    // does not flicker between songs.
    if (this.clearTimer) return;
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      this.currentKey = null;
      this.currentTrack = null;
      this.currentState = state;
      this.startedAt = null;
      this.catalogResult = null;
      this.artworkUrl = null;
      // TV.app may be holding the presence; Music going quiet must not pull it
      // out from under it.
      if (this.pickSource() === 'tv') {
        this.render();
        return;
      }
      log.info(`${this.sources.idleMessage(state)}; clearing presence`);
      this.queue(null);
    }, this.config.clearDelayMs);
    this.clearTimer.unref?.();
  }

  onTrackChange(track, state, receivedAt) {
    log.info(`Now ${state}: ${track.name} — ${track.artist}${track.album ? ` (${track.album})` : ''}`);

    this.cancelHide();
    this.currentKey = track.key;
    this.currentTrack = track;
    this.currentState = state;
    this.startedAt = state === 'playing' ? receivedAt - track.position * 1000 : null;
    this.catalogResult = null;
    this.artworkUrl = null;

    // Show something immediately; enrich with links and art as they arrive.
    this.render();
    this.enrich(track).catch((err) => log.debug(`Enrichment failed: ${err.message}`));
  }

  /**
   * Resolves catalog links and artwork for a track, re-rendering as each piece
   * lands. Bails out if the user skipped on to something else in the meantime.
   */
  async enrich(track) {
    const key = track.key;
    const stillCurrent = () => this.currentKey === key;

    const result = await this.catalog.lookup(track);
    if (!stillCurrent()) return;

    if (result) {
      this.catalogResult = result;
      this.artworkUrl = result.artworkUrl ?? null;
      log.debug(
        `Matched via ${result.source} (score ${result.score.toFixed(2)}): ${result.songUrl ?? 'no url'}`
      );
      this.render();
    } else {
      log.debug(`No catalog match for "${track.name}"`);
    }

    // Animated artwork: transcode + host. Slowest step by far, so it lands last.
    if (result?.animatedUrl) {
      const animated = await this.artwork.animatedFor({
        key: result.albumId ?? track.albumKey,
        m3u8Url: result.animatedUrl,
      });
      if (animated && stillCurrent()) {
        this.artworkUrl = animated;
        this.render();
        return;
      }
      if (!stillCurrent()) return;
    }

    // Nothing in the catalog matched, but the page it is playing on published
    // a cover of its own -- an mzstatic URL Discord can fetch directly, so it
    // needs no hosting of ours.
    if (!this.artworkUrl) {
      const fromPage = webArtwork(track, this.config.artworkSize);
      if (fromPage) {
        this.artworkUrl = fromPage;
        log.debug(`Artwork from the page: ${fromPage}`);
        this.render();
        return;
      }
    }

    // Artwork that only exists locally -- a library file's embedded cover, or
    // the copy a browser wrote out for MPRIS -- has to be hosted to be shown.
    if (!this.artworkUrl && track.hasArtwork && this.artwork.canHost) {
      const dumped = await this.sources.localArtworkFor(track);
      if (!dumped) return;
      try {
        if (!stillCurrent()) return;
        const hosted = await this.artwork.localArtwork({
          key: track.albumKey || track.key,
          file: dumped.file,
          format: dumped.format,
        });
        if (hosted && stillCurrent()) {
          this.artworkUrl = hosted;
          this.render();
        }
      } finally {
        await rm(dumped.file, { force: true }).catch(() => {});
      }
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Only one source can hold the presence. Whatever is actually playing wins,
   * and video beats audio when both are: you cannot really watch and listen at
   * the same time, so the picture is what you are doing.
   */
  pickSource() {
    const tvPlaying = this.tvSnapshot?.active && this.tvSnapshot.state === 'playing';
    const musicPlaying = this.musicSnapshot?.active && this.musicSnapshot.state === 'playing';
    if (tvPlaying) return 'tv';
    if (musicPlaying) return 'music';
    if (this.tvSnapshot?.active) return 'tv';
    if (this.musicSnapshot?.active) return 'music';
    return null;
  }

  render() {
    const source = this.pickSource();
    if (source === 'tv') return this.renderTv();
    return this.renderMusic();
  }

  renderTv() {
    if (!this.tvItem) return;

    if (this.tvState === 'paused' && !this.config.showWhenPaused) {
      this.scheduleHide();
      return;
    }
    this.cancelHide();

    this.queue(
      buildWatchActivity({
        // The runtime resolved from the catalog stands in when TV.app reports
        // none, which is every Apple TV+ stream.
        item: { ...this.tvItem, duration: this.tvItem.duration || this.tvDuration || 0 },
        state: this.tvState,
        artworkUrl: this.tvArtworkUrl ?? null,
        config: this.config,
        startedAt: this.tvStartedAt,
      })
    );
  }

  renderMusic() {
    if (!this.currentTrack) return;

    if (this.currentState === 'paused' && !this.config.showWhenPaused) {
      this.scheduleHide();
      return;
    }
    this.cancelHide();

    const activity = buildActivity({
      track: this.trackWithDuration(),
      state: this.currentState,
      catalog: this.catalogResult,
      artworkUrl: this.artworkUrl,
      config: this.config,
      startedAt: this.startedAt,
    });

    this.queue(activity);
  }

  /**
   * The web players report a playhead but not always a track length -- Firefox
   * publishes no `mpris:length` at all -- and without a length there is no
   * progress bar. The catalog knows how long the song is, so borrow it.
   */
  trackWithDuration() {
    const track = this.currentTrack;
    const known = this.catalogResult?.durationSec;
    if (track.duration > 0 || !known) return track;
    return { ...track, duration: known };
  }

  /**
   * Takes the presence down after a pause, once `clearDelayMs` has elapsed.
   *
   * The delay matters: Music.app briefly reports `paused` while moving between
   * tracks, so clearing the instant we see it would blink the status off and
   * straight back on between every song.
   */
  scheduleHide() {
    // Nothing is on screen (never sent, already cleared, or a fresh Discord
    // connection), so there is nothing to take down.
    if (this.hideTimer || this.lastSentJson === null || this.lastSentJson === 'null') return;
    // Remembered so the timer can tell "still the same paused source" from
    // "the other source started playing while we waited".
    this.pausedSource = this.pickSource();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      // The other source may have started while we were waiting to hide.
      if (this.pickSource() && this.pickSource() !== this.pausedSource) {
        this.render();
        return;
      }
      log.debug('Paused; hiding presence');
      this.queue(null);
    }, this.sources.pauseDelayMs(this.config));
    this.hideTimer.unref?.();
  }

  cancelHide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /**
   * Rate-limits SET_ACTIVITY. Discord throttles these server-side, and a
   * scrubbing user can otherwise generate a burst of updates.
   */
  queue(activity) {
    const json = JSON.stringify(activity);
    if (json === this.lastSentJson) {
      // Discord is already showing exactly this. Drop anything still queued --
      // it describes a state we have since moved back out of.
      this.pendingActivity = undefined;
      return;
    }

    this.pendingActivity = activity;

    if (this.flushTimer) return;

    const wait = Math.max(0, this.config.minUpdateIntervalMs - (Date.now() - this.lastSentAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  /**
   * Discord binds `client_id` at handshake, and the card's header comes from
   * that application's name -- which is the whole reason the Music app is
   * named "Apple Music". Showing "Watching Apple TV" therefore needs a second
   * application, and switching to it means reconnecting. Falls back to the one
   * client when `tv.clientId` is unset, in which case the header is wrong but
   * everything else works.
   */
  async ensureRpcFor(activity) {
    if (this.dryRun) return true;

    const wantId =
      activity?.type === 3 && this.config.tv?.clientId
        ? this.config.tv.clientId
        : this.config.clientId;

    if (wantId === this.rpcClientId) return this.rpc.ready;

    log.debug(`Switching Discord application to ${wantId}`);
    try {
      if (this.rpc.ready) await this.rpc.clearActivity();
    } catch {
      /* going away anyway */
    }
    this.rpc.destroy();

    this.rpcClientId = wantId;
    this.rpc = new DiscordRPC({ clientId: wantId });
    this.rpc.on('ready', () => {
      this.lastSentJson = null;
      this.render();
    });
    this.rpc.connect();
    // The pending activity is replayed by the `ready` handler.
    return false;
  }

  async flush() {
    if (this.pendingActivity === undefined) return;

    const activity = this.pendingActivity;
    this.pendingActivity = undefined;

    if (!(await this.ensureRpcFor(activity))) {
      // Reconnecting under a different application; `ready` will re-render.
      if (activity !== null) this.lastSentJson = null;
      return;
    }

    const json = JSON.stringify(activity);
    if (json === this.lastSentJson) return;

    if (this.dryRun) {
      this.lastSentJson = json;
      this.lastSentAt = Date.now();
      console.log(JSON.stringify(activity, null, 2));
      return;
    }

    if (!this.rpc.ready) {
      // Re-sent from the `ready` handler once we reconnect.
      log.debug('Discord not connected; holding the update');
      return;
    }

    try {
      await this.rpc.setActivity(activity);
      this.lastSentJson = json;
      this.lastSentAt = Date.now();
      log.debug(activity ? `Presence set: ${describe(activity)}` : 'Presence cleared');
    } catch (err) {
      log.warn(`SET_ACTIVITY failed: ${err.message}`);
      this.lastSentJson = null;
    }
  }
}

/**
 * The cover the page itself published, when it is a URL Discord can fetch.
 * Browsers hand MPRIS a `file://` copy instead, which is handled separately by
 * the hosting path.
 *
 * Apple's CDN URLs carry their dimensions in the filename, and what a page puts
 * in its Media Session metadata is sized for a media notification -- 512px at
 * best. Asking the same URL for the full size costs nothing and is the whole
 * difference between a crisp card and a soft one.
 */
function webArtwork(media, size = 1024) {
  const url = String(media?.artUrl ?? '');
  if (!/^https:\/\//i.test(url)) return null;
  const full = url.replace(/\/\d+x\d+((?:bb|bf|sr|cc)?\.(?:jpg|png|webp))$/i, `/${size}x${size}$1`);
  return full.length <= 313 ? full : null;
}
