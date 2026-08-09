import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import log from './log.js';

/**
 * Supervises a resident `osascript` watcher and emits `state` with a
 * normalized snapshot.
 *
 * Music.app and TV.app are scripted identically -- both descend from iTunes,
 * both answer `player state` / `player position` / `current track` -- so the
 * process lifecycle, the line framing and the watchdog are shared. Only the
 * script to run and the shape of the snapshot differ, and those are supplied
 * by the subclass.
 */
export class AppWatcher extends EventEmitter {
  constructor({ script, label, normalize, pollIntervalMs = 1000, idlePollIntervalMs = 5000 }) {
    super();
    this.script = script;
    this.label = label;
    this.normalize = normalize;
    this.pollIntervalMs = pollIntervalMs;
    this.idlePollIntervalMs = Math.max(pollIntervalMs, idlePollIntervalMs);
    this.child = null;
    this.buffer = '';
    this.stopped = false;
    this.lastLineAt = 0;
    this.watchdog = null;
    this.restartDelayMs = 1000;
  }

  start() {
    this.stopped = false;
    this.spawnWatcher();
    // The app can block on an Apple Event (an iCloud library refresh will do
    // it). The watcher then stops emitting without exiting, so silence -- not
    // process death -- is the signal we recover from.
    const timeoutMs = Math.max(15000, this.idlePollIntervalMs * 4, this.pollIntervalMs * 10);
    const checkMs = 5000;
    let lastCheckAt = Date.now();

    this.watchdog = setInterval(() => {
      const now = Date.now();
      const sinceCheck = now - lastCheckAt;
      lastCheckAt = now;

      if (this.stopped || !this.child) return;

      // Timers do not fire while the machine is asleep, so on wake `lastLineAt`
      // spans the whole suspension and looks exactly like a wedge. Our own
      // interval overrunning is the only signal that separates the two. Still
      // cycle the watcher -- its Apple Event connection may be stale after
      // sleep -- but do not report it as a fault.
      if (sinceCheck > checkMs * 3) {
        log.debug(`Resumed after ~${Math.round(sinceCheck / 1000)}s suspended; cycling the watcher`);
        this.lastLineAt = now;
        this.restart();
        return;
      }

      if (now - this.lastLineAt > timeoutMs) {
        log.warn(`${this.label} watcher silent for >${Math.round(timeoutMs / 1000)}s, restarting it`);
        this.restart();
      }
    }, checkMs);
    this.watchdog.unref?.();
  }

  spawnWatcher() {
    if (this.stopped) return;
    log.debug(`Spawning ${this.label} watcher`);

    this.buffer = '';
    this.lastLineAt = Date.now();

    this.child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', this.script], {
      env: {
        ...process.env,
        YP_POLL_MS: String(this.pollIntervalMs),
        YP_IDLE_POLL_MS: String(this.idlePollIntervalMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.trim();
      if (text) log.debug(`watcher stderr: ${text}`);
    });

    this.child.on('error', (err) => {
      log.error(`Failed to start ${this.label} watcher: ${err.message}`);
      this.scheduleRestart();
    });

    this.child.on('exit', (code, signal) => {
      if (this.stopped) return;
      log.warn(`${this.label} watcher exited (code=${code} signal=${signal}); restarting`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped) return;
    this.child = null;
    const delay = this.restartDelayMs;
    // Back off so a permissions failure does not turn into a spawn loop.
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30000);
    setTimeout(() => this.spawnWatcher(), delay).unref?.();
  }

  restart() {
    const child = this.child;
    this.child = null;
    if (child) {
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
    }
    this.spawnWatcher();
  }

  onData(chunk) {
    this.lastLineAt = Date.now();
    this.buffer += chunk;

    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        log.debug(`Ignoring unparseable watcher line: ${line.slice(0, 200)}`);
        continue;
      }

      if (payload.state === 'watcher-ready') {
        // A clean handshake means the script parsed and has automation
        // permission, so reset the backoff we may have accumulated.
        this.restartDelayMs = 1000;
        log.debug(`${this.label} watcher ready`);
        continue;
      }

      if (payload.state === 'error') {
        log.debug(`Watcher reported error: ${payload.error}`);
        continue;
      }

      this.emit('state', this.normalize(payload));
    }
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.child) {
      this.child.removeAllListeners('exit');
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}

export function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
