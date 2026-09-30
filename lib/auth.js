'use strict';

const crypto = require('node:crypto');
const store = require('./db');
const { db } = store;

const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [v, salt, hash] = String(stored).split('$');
  if (v !== 's1') return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// Failed logins per address and email. Memory only, which is fine for one process.
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  if (list.length >= 10) throw new AuthError(429, 'Too many attempts. Wait a few minutes and try again.');
  return list;
}
const fail = (key, list) => attempts.set(key, [...list, Date.now()]);

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_MS);
  return token;
}

const publicUser = u => ({ id: u.id, email: u.email, name: u.name });

function register({ email, name, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, 'Enter a valid email address.');
  if (!name) throw new AuthError(400, 'Enter your name.');
  if (String(password || '').length < 8) throw new AuthError(400, 'Use a password of at least 8 characters.');
  if (process.env.ALLOW_SIGNUP === '0' && store.userCount() > 0) throw new AuthError(403, 'Sign-ups are closed. Ask an existing user to share a project with you after they create your account.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError(409, 'An account with that email already exists.');
  const user = { id: store.id(), email, name, created_at: new Date().toISOString() };
  const first = store.userCount() === 0;
  db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (?,?,?,?,?)').run(user.id, email, name, hashPassword(password), user.created_at);
  const claimed = first ? store.claimLegacy(user.id) : 0;
  return { user: publicUser(user), token: newSession(user.id), claimed };
}

function login({ email, password }, ip) {
  email = String(email || '').trim().toLowerCase();
  const key = ip + '|' + email;
  const list = throttle(key);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Hash even when the user is unknown so timing does not reveal which emails exist.
  const ok = row ? checkPassword(String(password || ''), row.pass_hash) : (crypto.scryptSync('x', 'salt', 64), false);
  if (!ok) { fail(key, list); throw new AuthError(401, 'Email or password is not right.'); }
  attempts.delete(key);
  return { user: publicUser(row), token: newSession(row.id) };
}

function cookieToken(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function userFromReq(req) {
  const t = cookieToken(req);
  if (!t) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), Date.now());
  return row ? publicUser(row) : null;
}

function endSession(req) {
  const t = cookieToken(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
}

const cookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;

const findByEmail = email => {
  const r = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  return r ? publicUser(r) : null;
};

module.exports = { AuthError, register, login, userFromReq, endSession, cookie, findByEmail, SESSION_MS };
