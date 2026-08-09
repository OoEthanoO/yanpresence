import log from './log.js';
import { episodeCode } from './tv.js';

const ACTIVITY_LISTENING = 2;
const ACTIVITY_WATCHING = 3;

// Discord's Status Display Type enum: which field is rendered on the one-line
// status under your name / in the member list.
const STATUS_DISPLAY = { name: 0, state: 1, details: 2 };

const LIMITS = {
  details: 128,
  state: 128,
  largeText: 128,
  smallText: 128,
  url: 256,
  asset: 313,
};

/**
 * Builds the SET_ACTIVITY payload.
 *
 * Layout mirrors Discord's first-party Spotify integration, with one
 * deliberate difference: Spotify puts the *artist* on the one-line status
 * (status_display_type = STATE) and we put the *song* there
 * (status_display_type = DETAILS).
 *
 *   Listening to Apple Music        <- header, from the application's name
 *   Bohemian Rhapsody               <- details, links to the song
 *   Queen                           <- state, links to the artist
 *   [album art]                     <- hover shows the album, links to it
 */
export function buildActivity({ track, state, catalog, artworkUrl, config, startedAt }) {
  const playing = state === 'playing';

  const songName = clamp(track.name, LIMITS.details);
  const artistName = clamp(track.artist || track.albumArtist || 'Unknown Artist', LIMITS.state);
  const albumName = track.album || catalog?.albumName || '';

  const activity = {
    type: ACTIVITY_LISTENING,
    // Discord renders the header from the application's name, so this exists
    // mainly for clients that echo the field back.
    name: config.activityName,
    status_display_type: STATUS_DISPLAY[config.statusDisplay] ?? STATUS_DISPLAY.details,
    details: songName,
    state: artistName,
    assets: {},
    instance: false,
  };

  // Discord rejects one-character details/state.
  if (activity.details.length < 2) activity.details = `${activity.details} `;
  if (activity.state.length < 2) activity.state = `${activity.state} `;

  // --- clickable text ---------------------------------------------------
  const songUrl = clampUrl(catalog?.songUrl);
  const artistUrl = clampUrl(catalog?.artistUrl);
  const albumUrl = clampUrl(catalog?.albumUrl);

  if (songUrl) activity.details_url = songUrl;
  if (artistUrl) activity.state_url = artistUrl;

  // --- artwork ----------------------------------------------------------
  // Something must always occupy the large image slot. Leaving it empty, or
  // pointing it at a URL Discord cannot resolve, renders as Discord's "?"
  // placeholder — so fall back to a transparent asset uploaded to the
  // Developer Portal. Portal assets are referenced by name and always
  // resolve, which an external URL is not guaranteed to do.
  if (artworkUrl && artworkUrl.length <= LIMITS.asset) {
    activity.assets.large_image = artworkUrl;
  } else if (config.placeholderImageKey) {
    activity.assets.large_image = config.placeholderImageKey;
    if (artworkUrl) {
      log.debug(`Artwork URL too long (${artworkUrl.length} chars); using the placeholder`);
    }
  }
  if (albumName) {
    activity.assets.large_text = clamp(albumName, LIMITS.largeText);
  }
  if (albumUrl) activity.assets.large_url = albumUrl;

  if (config.showSmallImage && config.smallImageKey) {
    activity.assets.small_image = config.smallImageKey;
    activity.assets.small_text = playing ? 'Apple Music' : 'Paused';
  }

  // --- progress ---------------------------------------------------------
  // Only while playing: a frozen bar reads as a stalled stream, and Discord
  // has no "paused" affordance of its own.
  if (playing && track.duration > 0 && startedAt) {
    const start = Math.round(startedAt);
    const end = start + Math.round(track.duration * 1000);
    activity.timestamps = { start, end };
  }

  // --- optional buttons -------------------------------------------------
  // details_url / state_url / large_url are comparatively new. Buttons are the
  // long-standing way to attach links, kept here as an opt-in fallback.
  if (config.linkButtons) {
    const buttons = [];
    if (songUrl) buttons.push({ label: 'Play on Apple Music', url: songUrl });
    if (albumUrl && buttons.length < 2) buttons.push({ label: 'View Album', url: albumUrl });
    else if (artistUrl && buttons.length < 2) buttons.push({ label: 'View Artist', url: artistUrl });
    if (buttons.length) activity.buttons = buttons;
  }

  if (!Object.keys(activity.assets).length) delete activity.assets;

  return activity;
}

/**
 * Builds the SET_ACTIVITY payload for TV.app.
 *
 *   Watching Apple TV              <- header, from the application's name
 *   Ted Lasso                      <- details: the show, not the episode
 *   S2E8 · Man City                <- state
 *   [artwork]                      <- placeholder; see below
 *
 * The show goes on the one-line status rather than the episode, which is the
 * opposite of the music layout and deliberate: "Watching Ted Lasso" means
 * something to a reader, "Watching Man City" does not.
 *
 * There is no album art equivalent. Apple retired TV content from the iTunes
 * Search API (every `media=tvShow` query returns zero), Apple TV+ streams
 * carry no embedded artwork, and the Apple TV backend refuses requests without
 * a session token. So the image slot gets the transparent portal placeholder,
 * the same fallback used when a track has no cover.
 */
export function buildWatchActivity({ item, state, artworkUrl, config, startedAt }) {
  const playing = state === 'playing';
  const code = episodeCode(item);

  // A film has no show to promote, so its own title takes the status line.
  const heading = item.isEpisode && item.show ? item.show : item.name;
  const subtitle = item.isEpisode
    ? [code, item.name].filter(Boolean).join(' · ')
    : [item.year || null, item.director || null].filter(Boolean).join(' · ');

  const activity = {
    type: ACTIVITY_WATCHING,
    name: config.tv?.activityName ?? 'Apple TV',
    status_display_type: STATUS_DISPLAY[config.statusDisplay] ?? STATUS_DISPLAY.details,
    details: clamp(heading, LIMITS.details),
    state: clamp(subtitle || (item.isEpisode ? 'Episode' : 'Film'), LIMITS.state),
    assets: {},
    instance: false,
  };

  if (activity.details.length < 2) activity.details = `${activity.details} `;
  if (activity.state.length < 2) activity.state = `${activity.state} `;

  if (artworkUrl && artworkUrl.length <= LIMITS.asset) {
    activity.assets.large_image = artworkUrl;
  } else if (config.placeholderImageKey) {
    activity.assets.large_image = config.placeholderImageKey;
  }
  // Hovering the art shows the episode title when the status line is the show.
  const hover = item.isEpisode && item.show ? [item.name, code].filter(Boolean).join(' · ') : '';
  if (hover) activity.assets.large_text = clamp(hover, LIMITS.largeText);

  if (config.tv?.showSmallImage && config.tv?.smallImageKey) {
    activity.assets.small_image = config.tv.smallImageKey;
    activity.assets.small_text = playing ? 'Apple TV' : 'Paused';
  }

  if (playing && item.duration > 0 && startedAt) {
    const start = Math.round(startedAt);
    activity.timestamps = { start, end: start + Math.round(item.duration * 1000) };
  }

  if (!Object.keys(activity.assets).length) delete activity.assets;

  return activity;
}

function clamp(value, max) {
  const s = String(value ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function clampUrl(url) {
  if (!url) return null;
  const s = String(url);
  if (!/^https?:\/\//i.test(s)) return null;
  if (s.length > LIMITS.url) {
    log.debug(`Dropping over-long URL (${s.length} chars): ${s.slice(0, 60)}…`);
    return null;
  }
  return s;
}

/** Compact single-line description used for logging. */
export function describe(activity) {
  const bits = [activity.details, activity.state].filter(Boolean);
  const art = activity.assets?.large_image;
  const animated = art && /\.(gif|webp|avif)(\?|$)/i.test(art);
  const kind = !art ? 'no art' : animated ? 'animated art' : 'static art';
  return `${bits.join(' — ')} [${kind}]`;
}
