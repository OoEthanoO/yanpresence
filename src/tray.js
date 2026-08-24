import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './config.js';
import log from './log.js';
import { POWERSHELL, psArgs } from './win.js';

const TRAY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tray.ps1');
const ICON = path.join(PROJECT_ROOT, 'assets', 'yanpresence.ico');

/**
 * A notification-area icon, and the only way to stop a hidden run.
 *
 * Started from a terminal, yanpresence is a normal foreground process and
 * Ctrl-C ends it. Started from the Start menu -- which is the point of the
 * Windows shortcut -- it has no console and no window, and a background
 * process a user cannot stop without Task Manager is not something to ship.
 * So this puts an icon in the tray whose menu has a Quit that shuts the app
 * down properly, clearing the presence with Discord on the way out.
 *
 * The icon itself lives in a PowerShell child running a WinForms message loop,
 * because a message loop is not something Node can host. It reports the click
 * back on stdout; the status text goes the other way through a file it polls
 * (see scripts/tray.ps1 for why not stdin).
 */
export class Tray {
  constructor({ onQuit, logFile = '' } = {}) {
    this.onQuit = onQuit;
    this.logFile = logFile;
    this.statusFile = path.join(os.tmpdir(), `yanpresence-tray-${process.pid}.txt`);
    this.child = null;
    this.stopped = false;
    this.buffer = '';
    this.lastStatus = null;
  }

  start() {
    if (this.child) return;
    this.stopped = false;
    this.write('yanpresence', 'Starting…');

    this.child = spawn(
      POWERSHELL,
      // -STA because WinForms requires a single-threaded apartment. Windows
      // PowerShell already defaults to it, but the tray is the app's only
      // control surface and it is not worth leaving to a default.
      ['-STA', ...psArgs(TRAY_SCRIPT, '-ParentPid', String(process.pid), '-StatusFile', this.statusFile,
        ...(fs.existsSync(ICON) ? ['-IconFile', ICON] : []),
        ...(this.logFile ? ['-LogFile', this.logFile] : []))],
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
    try {
      fs.writeFileSync(this.statusFile, `${tooltip}\n${line}\n`, 'utf8');
    } catch (err) {
      log.debug(`Could not update the tray status: ${err.message}`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    fs.rmSync(this.statusFile, { force: true });
  }
}
