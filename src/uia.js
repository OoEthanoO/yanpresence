import { execFile } from 'node:child_process';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import { readEpisodeCode } from './smtc.js';
import { AppWatcher, str } from './watcher.js';
import { POWERSHELL, psArgs } from './win.js';

const WATCHER = path.join(PROJECT_ROOT, 'scripts', 'tv-uia-watch.ps1');

/**
 * How long a carried-forward reading stays believable once the overlay is
 * gone. Past this, "the overlay has been hidden for a while" stops meaning
 * "still watching" -- the app may have been left on a menu, or the episode may
 * have ended into something we never got to see.
 */
const STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Watches the Apple TV app on Windows through UI Automation.
 *
 * Necessary because that app publishes no media session -- see the header of
 * scripts/tv-uia-watch.ps1 for how that was established. The UIA tree carries
 * more than a session would have, but only while the transport overlay is
 * drawn, so this class is mostly about the gaps: the watcher reports `hidden`
 * when it can see nothing, and the last real reading is carried forward with
 * the playhead advanced, exactly as the media-session watcher advances its own
 * between the app's timeline updates.
 *
 * That is not a guess about what is happening off-screen so much as a bet on
 * when the overlay comes back, and the overlay comes back on precisely the
 * events that matter: starting something, pausing it, scrubbing it. A pause
 * driven entirely from the keyboard, with the pointer never moving, is the one
 * case that reads as still-playing until something redraws the overlay.
 */
export class TvUiaWatcher extends AppWatcher {
  constructor({ pollIntervalMs, idlePollIntervalMs } = {}) {
    super({
      script: WATCHER,
      label: 'Apple TV',
      normalize: null,
      pollIntervalMs,
      idlePollIntervalMs,
      command: POWERSHELL,
      args: psArgs(WATCHER),
    });

    // The last thing actually seen, and when. AppWatcher hands each line to
    // `normalize`, so the carry-forward lives behind that call rather than
    // beside it.
    this.last = null;
    this.lastAt = 0;
    this.normalize = (raw) => this.toSnapshot(raw);
  }

  toSnapshot(raw) {
    const receivedAt = Date.now();

    if (raw.state === 'hidden') return this.carryForward(receivedAt);

    if (raw.state !== 'playing' && raw.state !== 'paused') {
      // The app closed, or said something we do not understand. Either way
      // there is nothing to carry.
      this.last = null;
      return { state: raw.state ?? 'unknown', active: false, item: null, receivedAt };
    }

    this.last = raw;
    this.lastAt = receivedAt;
    return { state: raw.state, active: true, item: toItem(raw), receivedAt };
  }

  /**
   * A snapshot built from the last reading, with the playhead moved on.
   *
   * Without this the presence would flicker off every time the overlay faded,
   * which is within seconds of playback starting and then continuously.
   */
  carryForward(receivedAt) {
    const idle = { state: 'stopped', active: false, item: null, receivedAt };
    if (!this.last) return idle;

    const elapsed = (receivedAt - this.lastAt) / 1000;
    if (receivedAt - this.lastAt > STALE_MS) {
      this.last = null;
      return idle;
    }

    // A paused reading stays exactly where it was; only a playing one moves.
    const position = this.last.state === 'playing' ? this.last.position + elapsed : this.last.position;
    const duration = Number(this.last.duration) || 0;

    // Ran past the end. The episode finished while we could not see, and
    // whatever is on screen now is not what we were told about.
    if (duration > 0 && position > duration + 1) {
      this.last = null;
      return idle;
    }

    return {
      state: this.last.state,
      active: true,
      item: toItem({ ...this.last, position }),
      receivedAt,
    };
  }
}

/**
 * One reading from the Apple TV app, for `--doctor`.
 *
 * Waits past the first few `hidden` lines rather than reporting the first
 * thing it sees, because "hidden" is the normal state of a player nobody is
 * touching and reporting it as the answer would be reporting the weather.
 */
export function readTvOnce({ timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    // execFile rather than spawn, and its own timeout rather than a kill of
    // ours: the watcher loops forever, so something has to stop it, and doing
    // that by hand from --doctor -- which exits the moment it has printed --
    // races libuv's teardown and trips an assertion in async.c on Windows.
    const child = execFile(
      POWERSHELL,
      psArgs(WATCHER),
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, YP_POLL_MS: '600' },
      },
      () => {
        /* the timeout killing it is the expected ending */
      }
    );

    let buffer = '';
    let last = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(last);
    };

    child.on('error', () => finish());
    child.on('exit', () => finish());

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.state === 'watcher-ready') continue;
        last = payload;
        // A real reading is worth stopping for; "closed" is a final answer
        // too. Only "hidden" is worth waiting out.
        if (payload.state !== 'hidden') finish();
      }
    });

    setTimeout(finish, timeoutMs).unref?.();
  });
}

/**
 * One reading to the item shape TV.app produces, so that presence.js and
 * tvcatalog.js cannot tell which platform they are serving.
 */
export function toItem(raw) {
  const duration = positive(raw.duration);
  const position = Math.max(0, Math.min(positive(raw.position), duration || Infinity));
  const show = str(raw.show);
  const { season, episode, name, year } = parseSubtitle(raw.subtitle);

  const item = {
    // A film puts its title in the same element a show puts its name in, and
    // carries no numbering to say otherwise.
    name: name || show,
    show: season || episode ? show : '',
    season,
    episode,
    episodeId: '',
    duration,
    position,
    persistentId: '',
    databaseId: 0,
    kind: 'Apple TV for Windows',
    mediaKind: season || episode ? 'TV show' : 'movie',
    year,
    director: '',
    description: str(raw.subtitle),
    // The app draws its own artwork and offers none through UI Automation, so
    // there is nothing local to fall back on. The catalog covers Apple TV+.
    hasArtwork: false,
    origin: 'AppleTV.exe (UI Automation)',
  };

  item.isEpisode = item.season > 0 || item.episode > 0 || Boolean(item.show);
  item.key = `meta:${item.show}\0${item.name}\0${item.season}\0${item.episode}`;

  return item;
}

/**
 * "S1, E1 · Nikki and Jason" -> season 1, episode 1, "Nikki and Jason".
 *
 * The numbering is read with the same function the media-session path uses, so
 * both platforms understand the same spellings. What differs is that here the
 * episode title is genuinely a separate field rather than something to be
 * recovered -- it is simply whatever follows the separator.
 */
export function parseSubtitle(subtitle) {
  const text = str(subtitle);
  if (!text) return { season: 0, episode: 0, name: '', year: 0 };

  const { season, episode } = readEpisodeCode(text);
  const year = readYear(text);

  // The numbering is what licenses reading an episode title out of the rest.
  // A film fills this same element with its own details -- "2016 · 1h 47m" --
  // and taking the text after the separator there would put "1h 47m" on the
  // card as the name of an episode that does not exist.
  if (!season && !episode) return { season: 0, episode: 0, name: '', year };

  // Everything after the first separator is the episode's own title. Split
  // once, so a title containing a middle dot survives intact.
  const at = text.indexOf('·');
  const name = at === -1 ? '' : text.slice(at + 1).trim();

  return { season, episode, name, year };
}

function readYear(text) {
  const m = String(text ?? '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
