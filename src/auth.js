'use strict';
// Authentication: scrypt password hashing, cookie-backed sessions, guards.
const crypto = require('crypto');
const db = require('./db');

const SCRYPT_N = 16384; // CPU/memory cost
const KEYLEN = 64;
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 8);
const COOKIE = 'sid';

// ---- password hashing (salted, one-way) ----
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, nStr, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(String(plain), salt, expected.length, { N: Number(nStr) });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---- cookies ----
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function setSessionCookie(res, token, maxAgeSec) {
  // Secure: served over HTTPS; HttpOnly: not readable by JS; SameSite=Lax.
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---- sessions ----
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  await db.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
    [token, userId, expires]
  );
  return { token, maxAgeSec: SESSION_TTL_HOURS * 3600 };
}
async function destroySession(token) {
  if (token) await db.query(`DELETE FROM sessions WHERE token=$1`, [token]);
}

// Populate req.user (or null) from the session cookie. Never blocks.
async function attachUser(req, res, next) {
  try {
    const token = parseCookies(req)[COOKIE];
    req.sessionToken = token || null;
    req.user = null;
    if (token) {
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.role, u.full_name, u.agent_id, u.active
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token=$1 AND s.expires_at > now() AND u.active = TRUE`,
        [token]
      );
      if (rows.length) req.user = rows[0];
    }
    next();
  } catch (e) {
    next(e);
  }
}

// ---- guards ----
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not permitted for your role.' });
    next();
  };
}
// Agent may act only on their own agency; officers/admins may act on any.
function canActOnAgent(user, agentId) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'officer') return true;
  return user.role === 'agent' && Number(user.agent_id) === Number(agentId);
}

module.exports = {
  hashPassword, verifyPassword,
  parseCookies, setSessionCookie, clearSessionCookie,
  createSession, destroySession,
  attachUser, requireAuth, requireRole, canActOnAgent,
  COOKIE,
};
