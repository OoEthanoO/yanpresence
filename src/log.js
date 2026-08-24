import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let current = LEVELS.info;
let file = null;

const COLOR = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function setLevel(name) {
  if (name in LEVELS) current = LEVELS[name];
}

/**
 * Also write every line to a file, and keep it from growing without bound.
 *
 * Not a nicety on Windows: started from the Start menu the process has no
 * console, so anything printed goes nowhere and a failure to reach Discord is
 * completely silent. The file is what the tray icon's "Open log" opens.
 */
export function setLogFile(target, { maxBytes = 1024 * 1024 } = {}) {
  if (!target) {
    file = null;
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // One rotation, no more. This is a diagnostic aid, not an audit trail --
    // what matters is the last session, and the one before it for comparison.
    const size = fs.statSync(target).size;
    if (size > maxBytes) fs.renameSync(target, `${target}.1`);
  } catch {
    /* no such file yet, or the rename lost a race; either way, carry on */
  }

  try {
    file = fs.openSync(target, 'a');
    return target;
  } catch (err) {
    file = null;
    // Deliberately through console: the log file is exactly what is unavailable.
    console.error(`Could not open the log file at ${target}: ${err.message}`);
    return null;
  }
}

function stamp(withDate = !useColor) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  // Interactively the date is just noise. In a log file that spans days it is
  // the difference between being able to read the history and guessing.
  if (!withDate) return time;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

function emit(level, args) {
  if (LEVELS[level] > current) return;
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${tag}${RESET}` : tag;
  const line = `${stamp()} ${head}`;

  if (file !== null) {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    try {
      // Synchronous, so a crash still has its last line on disk -- which is
      // the one worth having.
      fs.writeSync(file, `${stamp()} ${tag} ${text}\n`);
    } catch {
      /* the disk filled, or the handle went away; not worth a second failure */
    }
  }

  if (level === 'error' || level === 'warn') console.error(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};

export default log;
