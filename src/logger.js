'use strict';
// Zero-dependency structured logger.
//   - Levels: debug < info < warn < error  (LOG_LEVEL, default 'info')
//   - Output: JSON lines to console AND a daily file logs/app-YYYY-MM-DD.log
//     (disable file with LOG_TO_FILE=0)
//   - Redacts secrets (passwords, tokens, cookies) anywhere in the fields.
//   - logger.child({...}) returns a logger that stamps those fields on every line.
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const TO_FILE = process.env.LOG_TO_FILE !== '0';
const dir = path.join(__dirname, '..', 'logs');

let stream = null;
let streamDate = null;
function ensureStream() {
  const date = new Date().toISOString().slice(0, 10);
  if (streamDate !== date) {
    if (stream) { try { stream.end(); } catch (e) { /* ignore */ } }
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, `app-${date}.log`), { flags: 'a' });
    streamDate = date;
  }
  return stream;
}

const SENSITIVE = /(pass(word)?|password_hash|token|secret|cookie|authorization|sid)/i;

// Deep-clone fields with secret redaction, Error serialisation, depth/cycle guards.
function sanitize(value, seen, depth) {
  if (value == null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return String(value);
  if (depth > 5) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitize(v, seen, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : sanitize(value[k], seen, depth + 1);
  }
  return out;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const rec = { ts: new Date().toISOString(), level, msg: String(msg) };
  if (fields) Object.assign(rec, sanitize(fields, new WeakSet(), 0));
  const line = JSON.stringify(rec);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  if (TO_FILE) { try { ensureStream().write(line + '\n'); } catch (e) { /* never throw from logging */ } }
}

function make(base) {
  const merge = (fields) => (base ? Object.assign({}, base, fields) : fields);
  return {
    debug: (msg, fields) => write('debug', msg, merge(fields)),
    info: (msg, fields) => write('info', msg, merge(fields)),
    warn: (msg, fields) => write('warn', msg, merge(fields)),
    error: (msg, fields) => write('error', msg, merge(fields)),
    child: (extra) => make(merge(extra)),
  };
}

module.exports = make(null);
