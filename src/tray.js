import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { POWERSHELL, psArgs } from './win.js';

const TRAY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tray.ps1');
const ICON = path.join(PROJECT_ROOT, 'assets', 'yanpresence.ico');

/**
 * The socket yanpresence.app handed this process, or null when it was not
 * started by the app.
 *
 * On macOS the menu bar icon is the app itself -- the process LaunchServices
 * started -- and this one is its child, so instead of spawning an icon it is
 * given one end of a socket on a descriptor named here. See
 * macos/yanpresence.swift for why the two swap places on that platform.
 */
export function menuBarChannel(env = process.env) {
  const fd = Number(env.YANPRESENCE_MENU_FD);
  return Number.isInteger(fd) && fd > 2 ? fd : null;
}

/**
 * Says something to yanpresence.app before there is a Tray to say it with:
 * why the app could not start. Synchronous, because the next thing that
 * happens is the process exiting.
 */
export function tellMenuBar(message, fd = menuBarChannel()) {
  if (fd === null) return;
  try {
    fs.writeSync(fd, `${JSON.stringify(message)}\n`);
  } catch {
    /* the app has gone too; its own dialog covers this */
  }
}

/**
 * A notification-area icon, and the only way to stop a hidden run.
 *
 * Started from a terminal, yanpresence is a normal foreground process and
 * Ctrl-C ends it. Started from the Start menu -- which is the point of the
 * Windows shortcut -- it has no console and no window, and a background
 * process a user cannot stop without Task Manager is not something to ship.
 * So this puts an icon in the tray whose menu has a Quit that shuts the app
 * down properly, clearing the presence with Discord on the way out. With no
 * window to hold settings, the menu also carries the one worth changing
 * without opening a config file: whether the card shows the artist's photo.
 *
 * On Windows the icon itself lives in a PowerShell child running a WinForms
 * message loop, because a message loop is not something Node can host. It
 * reports clicks back on stdout; the status text goes the other way through a
 * file it polls (see scripts/tray.ps1 for why not stdin).
 *
 * On macOS it is the menu bar icon of yanpresence.app, which is this
 * process's parent and is reached over `channel`, the socket it passed down
 * (see menuBarChannel). The clicks arrive as the same lines the Windows icon
 * prints, so both are read by onData; the status goes back over the socket,
 * as JSON, rather than through a file.
 */
export class Tray {
  constructor({ onQuit, onArtistPhoto, artistPhoto = true, logFile = '', channel = null } = {}) {
    this.onQuit = onQuit;
    this.onArtistPhoto = onArtistPhoto;
    // Kept current as the menu reports changes, so an icon started again
    // shows the switch where the user last left it.
    this.artistPhoto = artistPhoto;
    this.logFile = logFile;
    this.statusFile = path.join(os.tmpdir(), `yanpresence-tray-${process.pid}.txt`);
    // A descriptor, or an already-connected stream (which is how the tests
    // stand in for the app). Null means the Windows icon.
    this.channelSource = channel;
    this.channel = null;
    this.child = null;
    this.stopped = false;
    this.buffer = '';
    this.lastStatus = null;
  }

  start() {
    if (this.child || this.channel) return;
    this.stopped = false;
    if (this.channelSource !== null) {
      this.attach();
      return;
    }
    this.write('yanpresence', 'Starting…');

    this.child = spawn(
      POWERSHELL,
      // -STA because WinForms requires a single-threaded apartment. Windows
      // PowerShell already defaults to it, but the tray is the app's only
      // control surface and it is not worth leaving to a default.
      ['-STA', ...psArgs(TRAY_SCRIPT, '-ParentPid', String(process.pid), '-StatusFile', this.statusFile,
        ...(fs.existsSync(ICON) ? ['-IconFile', ICON] : []),
        ...(this.logFile ? ['-LogFile', this.logFile] : []),
        ...(this.onArtistPhoto ? ['-ArtistPhoto', this.artistPhoto ? 'on' : 'off'] : []))],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log.debug(`tray stderr: ${text}`);
    });

    this.child.on('error', (err) => {
      log.warn(`Could not start the tray icon: ${err.message}`);
      this.child = null;
    });

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      // The tray exiting on its own is the icon disappearing, which leaves no
      // way to quit. Say so rather than running on invisibly.
      log.warn(`The tray icon exited (code ${code}); there is no menu to quit from now.`);
    });
  }

  /** macOS: the icon already exists, in the parent; just open the line to it. */
  attach() {
    const socket =
      typeof this.channelSource === 'number'
        ? new net.Socket({ fd: this.channelSource, readable: true, writable: true })
        : this.channelSource;
    this.channel = socket;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => log.debug(`Menu bar channel: ${err.message}`));
    socket.on('close', () => {
      this.channel = null;
      if (this.stopped) return;
      // The reverse of the Windows icon watching its parent. The app is the
      // only sign this process exists -- no menu, no Quit, nothing in the
      // Dock -- so with it gone, clear the presence and follow it out.
      log.warn('The menu bar app went away; shutting down');
      this.onQuit?.();
    });

    // What the app cannot know without reading the config: whether the switch
    // starts ticked, and where "Open Log" should point. Null leaves the switch
    // out, as the Windows icon does when there is no handler for it.
    this.send({
      type: 'hello',
      logFile: this.logFile,
      artistPhoto: this.onArtistPhoto ? this.artistPhoto : null,
    });
  }

  send(message) {
    if (!this.channel || this.channel.destroyed) return;
    this.channel.write(`${JSON.stringify(message)}\n`);
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === 'ready') {
        log.debug('Tray icon ready');
      } else if (line === 'quit') {
        log.info('Quit from the tray icon');
        this.onQuit?.();
      } else if (line === 'artist-photo on' || line === 'artist-photo off') {
        this.artistPhoto = line === 'artist-photo on';
        this.onArtistPhoto?.(this.artistPhoto);
      }
    }
  }

  /**
   * What the icon says: `tooltip` on hover, `line` in the menu.
   *
   * Written whole and compared first -- this is called on every render, which
   * during a scrub is several times a second, and the tray polls the file.
   */
  setStatus(tooltip, line = tooltip) {
    const next = `${tooltip}\n${line}`;
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    this.write(tooltip, line);
  }

  write(tooltip, line) {
    if (this.channelSource !== null) {
      this.send({ type: 'status', tooltip, line });
      return;
    }
    try {
      fs.writeFileSync(this.statusFile, `${tooltip}\n${line}\n`, 'utf8');
    } catch (err) {
      log.debug(`Could not update the tray status: ${err.message}`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.channel) {
      this.channel.destroy();
      this.channel = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    fs.rmSync(this.statusFile, { force: true });
  }
}
