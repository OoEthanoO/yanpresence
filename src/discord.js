import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import log from './log.js';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/**
 * Minimal Discord local RPC client, speaking the IPC framing directly.
 *
 * The desktop client listens on a unix socket named `discord-ipc-N` in the
 * user's temp dir. Frames are [op:int32le][len:int32le][json].
 */
export class DiscordRPC extends EventEmitter {
  constructor({ clientId }) {
    super();
    this.clientId = clientId;
    this.socket = null;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.stopped = false;
    this.reconnectDelayMs = 1000;
    this.reconnectTimer = null;
    this.user = null;
  }

  static candidateSockets() {
    const bases = [
      process.env.XDG_RUNTIME_DIR,
      process.env.TMPDIR,
      process.env.TMP,
      process.env.TEMP,
      '/tmp',
      os.tmpdir(),
    ].filter(Boolean);

    const paths = [];
    for (const base of [...new Set(bases)]) {
      for (let i = 0; i < 10; i += 1) {
        paths.push(path.join(base, `discord-ipc-${i}`));
      }
    }
    return [...new Set(paths)];
  }

  connect() {
    this.stopped = false;
    this.attempt();
  }

  attempt() {
    if (this.stopped || this.socket) return;

    const candidates = DiscordRPC.candidateSockets().filter((p) => {
      try {
        return fs.statSync(p).isSocket();
      } catch {
        return false;
      }
    });

    if (!candidates.length) {
      this.scheduleReconnect('no Discord IPC socket found (is Discord running?)');
      return;
    }

    this.tryEach(candidates, 0);
  }

  tryEach(candidates, index) {
    if (this.stopped) return;
    if (index >= candidates.length) {
      this.scheduleReconnect('could not connect to any Discord IPC socket');
      return;
    }

    const target = candidates[index];
    const socket = net.createConnection(target);
    let settled = false;

    const fail = (reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      log.debug(`IPC ${target}: ${reason}`);
      this.tryEach(candidates, index + 1);
    };

    socket.once('error', (err) => fail(err.message));
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('error');
      this.bind(socket, target);
    });
  }

  bind(socket, target) {
    log.debug(`Connected to Discord IPC at ${target}`);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => {
      log.debug(`IPC socket error: ${err.message}`);
      this.teardown('socket error');
    });
    socket.on('close', () => this.teardown('socket closed'));

    this.send(OP_HANDSHAKE, { v: 1, client_id: String(this.clientId) });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) break;

      const payload = this.buffer.subarray(8, 8 + length).toString('utf8');
      this.buffer = this.buffer.subarray(8 + length);

      let data;
      try {
        data = payload ? JSON.parse(payload) : {};
      } catch {
        log.debug(`Unparseable IPC payload: ${payload.slice(0, 200)}`);
        continue;
      }
      this.handleFrame(op, data);
    }
  }

  handleFrame(op, data) {
    if (op === OP_PING) {
      this.send(OP_PONG, data);
      return;
    }
    if (op === OP_CLOSE) {
      log.warn(`Discord closed the connection: ${data.message ?? data.code ?? 'no reason given'}`);
      this.teardown('closed by Discord');
      return;
    }
    if (op !== OP_FRAME) return;

    if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
      this.ready = true;
      this.reconnectDelayMs = 1000;
      this.user = data.data?.user ?? null;
      const tag = this.user
        ? this.user.username + (this.user.discriminator && this.user.discriminator !== '0' ? `#${this.user.discriminator}` : '')
        : 'unknown user';
      log.info(`Connected to Discord as ${tag}`);
      this.emit('ready', this.user);
      return;
    }

    if (data.nonce && this.pending.has(data.nonce)) {
      const { resolve, reject, timer } = this.pending.get(data.nonce);
      this.pending.delete(data.nonce);
      clearTimeout(timer);
      if (data.evt === 'ERROR') {
        reject(new Error(`${data.data?.code ?? '?'}: ${data.data?.message ?? 'unknown RPC error'}`));
      } else {
        resolve(data.data);
      }
    }
  }

  send(op, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    try {
      this.socket.write(Buffer.concat([header, json]));
      return true;
    } catch (err) {
      log.debug(`IPC write failed: ${err.message}`);
      this.teardown('write failed');
      return false;
    }
  }

  request(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('not connected to Discord'));
        return;
      }
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`${cmd} timed out`));
      }, 10000);
      timer.unref?.();

      this.pending.set(nonce, { resolve, reject, timer });
      if (!this.send(OP_FRAME, { cmd, args, nonce })) {
        this.pending.delete(nonce);
        clearTimeout(timer);
        reject(new Error('failed to write to Discord'));
      }
    });
  }

  setActivity(activity) {
    return this.request('SET_ACTIVITY', { pid: process.pid, activity: activity ?? null });
  }

  clearActivity() {
    return this.setActivity(null);
  }

  teardown(reason) {
    const wasReady = this.ready;
    this.ready = false;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    for (const [nonce, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('connection lost'));
      this.pending.delete(nonce);
    }

    if (wasReady) {
      log.warn(`Lost the Discord connection (${reason})`);
      this.emit('disconnected', reason);
    }
    this.scheduleReconnect(reason);
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    // 'error' and 'close' both land here for a single dropped socket; without
    // this guard each one starts its own reconnect chain and we end up with
    // duplicate connections.
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    log.debug(`Reconnecting to Discord in ${delay}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attempt();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  destroy() {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}
