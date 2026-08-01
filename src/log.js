const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let current = LEVELS.info;

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

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  // Interactively the date is just noise. In a log file that spans days it is
  // the difference between being able to read the history and guessing.
  if (useColor) return time;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

function emit(level, args) {
  if (LEVELS[level] > current) return;
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${tag}${RESET}` : tag;
  const line = `${stamp()} ${head}`;
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
