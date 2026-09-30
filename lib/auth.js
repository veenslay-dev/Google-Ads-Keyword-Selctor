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

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, isAdmin: Boolean(u.is_admin), status: u.status || 'active' });

// New people may sign up unless the admin closed it (ALLOW_SIGNUP=0 is the starting value). The very first account is always allowed.
const signupOpen = () => store.getSetting('signupOpen', process.env.ALLOW_SIGNUP !== '0');
const adminEmails = () => String(process.env.ADMIN_EMAILS || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);

function cleanNew({ email, name, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, 'Enter a valid email address.');
  if (!name) throw new AuthError(400, 'Enter a name.');
  if (String(password || '').length < 8) throw new AuthError(400, 'Use a password of at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError(409, 'An account with that email already exists.');
  return { email, name };
}

function insertUser({ email, name, password, admin = false, limits = null }) {
  const row = { id: store.id(), email, name, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at, is_admin, limits) VALUES (?,?,?,?,?,?,?)')
    .run(row.id, email, name, hashPassword(password), row.created_at, admin ? 1 : 0, limits ? JSON.stringify(limits) : null);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
}

function register(input) {
  if (!signupOpen() && store.userCount() > 0) throw new AuthError(403, 'Sign-ups are closed. Ask the administrator to create an account for you.');
  const { email, name } = cleanNew(input);
  const first = store.userCount() === 0;
  const row = insertUser({ email, name, password: input.password, admin: first || adminEmails().includes(email) });
  const claimed = first ? store.claimLegacy(row.id) : 0;
  return { user: publicUser(row), token: newSession(row.id), claimed };
}

// Used by the admin panel: no session is started, and the password is whatever the admin chose.
function createUser(input) {
  const { email, name } = cleanNew(input);
  return publicUser(insertUser({ email, name, password: input.password, admin: Boolean(input.admin), limits: input.limits || null }));
}

function setPassword(userId, password) {
  if (String(password || '').length < 8) throw new AuthError(400, 'Use a password of at least 8 characters.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // everywhere they were signed in, they are signed out
}

function changePassword(userId, current, next) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row || !checkPassword(String(current || ''), row.pass_hash)) throw new AuthError(400, 'The current password is not right.');
  if (String(next || '').length < 8) throw new AuthError(400, 'Use a new password of at least 8 characters.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), userId);
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
  // Said only to someone who knew the password, so it does not reveal which emails have accounts.
  if (row.status === 'suspended') throw new AuthError(403, 'This account is suspended. Contact the administrator.');
  db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), row.id);
  return { user: publicUser(row), token: newSession(row.id) };
}

function cookieToken(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

const lastTouch = new Map();
function userFromReq(req) {
  const t = cookieToken(req);
  if (!t) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), Date.now());
  if (!row || row.status === 'suspended') return null; // a suspended person is signed out on their next request
  // "Last seen" is written at most once a minute per person.
  if (Date.now() - (lastTouch.get(row.id) || 0) > 60000) {
    lastTouch.set(row.id, Date.now());
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  }
  return publicUser(row);
}

function endSession(req) {
  const t = cookieToken(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
}

// Scoped to the mount path, so the cookie is not sent to the rest of the site.
const COOKIE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '') || '/';
const cookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAge}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;

const findByEmail = email => {
  const r = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  return r ? publicUser(r) : null;
};

module.exports = { AuthError, register, login, createUser, setPassword, changePassword, signupOpen, userFromReq, endSession, cookie, findByEmail, publicUser, SESSION_MS };
