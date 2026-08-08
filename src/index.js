import { rm } from 'node:fs/promises';

import { AppleCatalog } from './catalog.js';
import { ArtworkHost } from './artwork.js';
import { CACHE_DIR } from './config.js';
import { DiscordRPC } from './discord.js';
import { MusicWatcher, dumpCurrentArtwork, isCatalogTrack } from './music.js';
import { buildActivity, describe } from './presence.js';
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
    this.rpc = new DiscordRPC({ clientId: config.clientId });
    this.watcher = new MusicWatcher({
      pollIntervalMs: config.pollIntervalMs,
      idlePollIntervalMs: config.idlePollIntervalMs,
    });

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

    log.info('Watching Music.app');
    if (!this.artwork.canHost) {
      log.info(
        `No artwork hosting configured — album art will be static ${this.config.artworkSize}x${this.config.artworkSize}. ` +
          'Set hosting.s3 (or hosting.command) to enable animated artwork.'
      );
    }
  }

  stop() {
    this.watcher.stop();
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

  onSnapshot(snapshot) {
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
      log.info(`Music.app is ${state}; clearing presence`);
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

    // Local library file with no catalog entry: host its embedded artwork so
    // there is still an album cover.
    if (!this.artworkUrl && track.hasArtwork && !isCatalogTrack(track) && this.artwork.canHost) {
      const dumped = await dumpCurrentArtwork();
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

  render() {
    if (!this.currentTrack) return;

    if (this.currentState === 'paused' && !this.config.showWhenPaused) {
      this.scheduleHide();
      return;
    }
    this.cancelHide();

    const activity = buildActivity({
      track: this.currentTrack,
      state: this.currentState,
      catalog: this.catalogResult,
      artworkUrl: this.artworkUrl,
      config: this.config,
      startedAt: this.startedAt,
    });

    this.queue(activity);
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
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      log.debug('Paused; hiding presence');
      this.queue(null);
    }, this.config.clearDelayMs);
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

  async flush() {
    if (this.pendingActivity === undefined) return;

    const activity = this.pendingActivity;
    this.pendingActivity = undefined;

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
