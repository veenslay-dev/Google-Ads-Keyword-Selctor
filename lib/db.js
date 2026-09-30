'use strict';

// SQLite through Node's built-in driver. Users, sessions and sharing are proper
// relational tables. A project is stored as one JSON document, because it is always
// read and written whole and holds at most about 1000 keywords plus report rows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DIR, 'app.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    pass_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
`);

const id = () => crypto.randomBytes(6).toString('hex');

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const parse = row => (row ? JSON.parse(row.data) : null);

const store = {
  id,
  db,
  tx,

  get: pid => parse(db.prepare('SELECT data FROM projects WHERE id = ?').get(pid)),

  roleOf: (pid, uid) => (db.prepare('SELECT role FROM members WHERE project_id = ? AND user_id = ?').get(pid, uid) || {}).role || null,

  listFor(uid) {
    const rows = db.prepare(`
      SELECT p.data, m.role,
        (SELECT u.name FROM members o JOIN users u ON u.id = o.user_id WHERE o.project_id = p.id AND o.role = 'owner') AS owner_name,
        (SELECT COUNT(*) FROM members c WHERE c.project_id = p.id) AS member_count
      FROM projects p JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.updated_at DESC`).all(uid);
    return rows.map(r => ({ project: JSON.parse(r.data), role: r.role, ownerName: r.owner_name, memberCount: r.member_count }));
  },

  create(project, ownerId) {
    project.updatedAt = new Date().toISOString();
    tx(() => {
      db.prepare('INSERT INTO projects (id, data, updated_at) VALUES (?,?,?)').run(project.id, JSON.stringify(project), project.updatedAt);
      db.prepare('INSERT INTO members (project_id, user_id, role) VALUES (?,?,?)').run(project.id, ownerId, 'owner');
    });
    return project;
  },

  put(project) {
    project.updatedAt = new Date().toISOString();
    db.prepare('UPDATE projects SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(project), project.updatedAt, project.id);
    return project;
  },

  remove: pid => db.prepare('DELETE FROM projects WHERE id = ?').run(pid),

  members: pid => db.prepare(`
    SELECT u.id AS userId, u.email, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`).all(pid),

  setMember: (pid, uid, role) => db.prepare(
    'INSERT INTO members (project_id, user_id, role) VALUES (?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role'
  ).run(pid, uid, role),

  removeMember: (pid, uid) => db.prepare('DELETE FROM members WHERE project_id = ? AND user_id = ?').run(pid, uid),

  userCount: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,

  // Projects saved by the first single-user version (data/projects.json) go to the first account created.
  claimLegacy(uid) {
    const file = path.join(DIR, 'projects.json');
    if (!fs.existsSync(file)) return 0;
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(file, 'utf8')).projects || {}; } catch { return 0; }
    let n = 0;
    for (const p of Object.values(legacy)) {
      if (store.get(p.id)) continue;
      store.create(p, uid);
      n++;
    }
    fs.renameSync(file, file + '.migrated');
    return n;
  },
};

module.exports = store;
