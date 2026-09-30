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

// Columns and tables added after the first release. Safe to run on every start.
function ensureColumn(table, col, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('users', 'last_login_at', 'TEXT');
ensureColumn('users', 'last_seen_at', 'TEXT');
ensureColumn('users', 'limits', 'TEXT');          // JSON of per-user overrides, null means "use the defaults"
ensureColumn('users', 'note', 'TEXT');
ensureColumn('users', 'kw_uploaded', 'INTEGER NOT NULL DEFAULT 0'); // keywords ever added, including ones later deleted
// Copies of numbers that live inside the project document, so the admin pages can add them up without opening every project.
ensureColumn('projects', 'owner_id', 'TEXT');
ensureColumn('projects', 'name', 'TEXT');
ensureColumn('projects', 'kw_count', 'INTEGER');
ensureColumn('projects', 'camp_count', 'INTEGER');
ensureColumn('projects', 'batch_count', 'INTEGER');
db.exec(`
  CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, project_id TEXT,
    kind TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS usage_user_at ON usage(user_id, at);
  CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT, actor_name TEXT,
    action TEXT NOT NULL, target_id TEXT, target_name TEXT, detail TEXT
  );
`);

const id = () => crypto.randomBytes(6).toString('hex');
const counts = p => [p.name || '', (p.keywords || []).length, (p.campaigns || []).length, (p.batches || []).length];

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

  ownerOf: pid => (db.prepare("SELECT user_id FROM members WHERE project_id = ? AND role = 'owner'").get(pid) || {}).user_id || null,

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
      db.prepare('INSERT INTO projects (id, data, updated_at, owner_id, name, kw_count, camp_count, batch_count) VALUES (?,?,?,?,?,?,?,?)')
        .run(project.id, JSON.stringify(project), project.updatedAt, ownerId, ...counts(project));
      db.prepare('INSERT INTO members (project_id, user_id, role) VALUES (?,?,?)').run(project.id, ownerId, 'owner');
    });
    return project;
  },

  put(project) {
    project.updatedAt = new Date().toISOString();
    db.prepare('UPDATE projects SET data = ?, updated_at = ?, name = ?, kw_count = ?, camp_count = ?, batch_count = ? WHERE id = ?')
      .run(JSON.stringify(project), project.updatedAt, ...counts(project), project.id);
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

  // ---- people
  userById: uid => db.prepare('SELECT * FROM users WHERE id = ?').get(uid) || null,
  userByEmail: email => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase()) || null,
  ownedCount: uid => db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').get(uid).n,
  ownedKeywords: uid => db.prepare('SELECT COALESCE(SUM(kw_count), 0) AS n FROM projects WHERE owner_id = ?').get(uid).n,
  addUploaded: (uid, n) => n > 0 && uid && db.prepare('UPDATE users SET kw_uploaded = kw_uploaded + ? WHERE id = ?').run(n, uid),

  // One row per person with what they own, for the admin pages.
  usersWithTotals: () => db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at, u.is_admin, u.status, u.last_login_at, u.last_seen_at, u.limits, u.note, u.kw_uploaded,
      COALESCE(p.projects, 0) AS projects, COALESCE(p.campaigns, 0) AS campaigns, COALESCE(p.uploads, 0) AS uploads,
      COALESCE(p.keywords, 0) AS keywords, p.last_update,
      (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id AND m.role != 'owner') AS shared_with_them
    FROM users u LEFT JOIN (
      SELECT owner_id, COUNT(*) AS projects, SUM(camp_count) AS campaigns, SUM(batch_count) AS uploads, SUM(kw_count) AS keywords, MAX(updated_at) AS last_update
      FROM projects GROUP BY owner_id) p ON p.owner_id = u.id
    ORDER BY u.created_at DESC`).all(),

  projectsOf: uid => db.prepare(`
    SELECT p.id, p.name, p.kw_count AS keywords, p.camp_count AS campaigns, p.batch_count AS uploads, p.updated_at,
      (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id) AS people
    FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC`).all(uid),

  signupsByDay: since => db.prepare('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day').all(since),
  countWhere: (sql, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${sql}`).get(...args).n,
  contentTotals: () => db.prepare('SELECT COUNT(*) AS projects, COALESCE(SUM(camp_count), 0) AS campaigns, COALESCE(SUM(batch_count), 0) AS uploads, COALESCE(SUM(kw_count), 0) AS keywords FROM projects').get(),

  // Deleting a person deletes the projects they own, and with them everyone else's access to those projects.
  deleteUser(uid) {
    tx(() => {
      db.prepare('DELETE FROM projects WHERE owner_id = ?').run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    });
  },

  // ---- settings, stored as JSON so a value can be a number, a flag or a table
  getSetting(key, fallback) {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  },
  setSetting: (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)),

  // ---- AI usage and the admin audit trail
  addUsage: u => db.prepare('INSERT INTO usage (at, user_id, project_id, kind, model, prompt_tokens, completion_tokens, cached_tokens, ok) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), u.userId || null, u.projectId || null, u.kind, u.model, u.promptTokens || 0, u.completionTokens || 0, u.cachedTokens || 0, u.ok ? 1 : 0),

  // Sums by day, person, step and model. Cost is worked out from these, so a corrected price fixes the history too.
  usageGroups: (since = '', userId = null) => db.prepare(`
    SELECT substr(at, 1, 10) AS day, user_id, kind, model, COUNT(*) AS calls, SUM(1 - ok) AS errors,
      SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_tokens) AS cached
    FROM usage WHERE at >= ? AND (? IS NULL OR user_id = ?) GROUP BY day, user_id, kind, model`).all(since, userId, userId),

  audit: (actor, action, target, detail) => db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, target_id, target_name, detail) VALUES (?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), actor && actor.id, actor && actor.name, action, target && target.id, target && (target.name || target.email), detail ? String(detail).slice(0, 400) : null),
  auditLog: (limit = 100) => db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit),

  dbBytes() {
    try { return DB_PATH === ':memory:' ? 0 : fs.statSync(DB_PATH).size; } catch { return 0; }
  },

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

// Older rows have no owner or counts yet. Fill them in once.
for (const r of db.prepare('SELECT id, data FROM projects WHERE kw_count IS NULL OR owner_id IS NULL OR name IS NULL').all()) {
  const p = JSON.parse(r.data);
  const owner = store.ownerOf(r.id);
  db.prepare('UPDATE projects SET owner_id = ?, name = ?, kw_count = ?, camp_count = ?, batch_count = ? WHERE id = ?').run(owner, ...counts(p), r.id);
}
db.exec('UPDATE users SET kw_uploaded = (SELECT COALESCE(SUM(kw_count), 0) FROM projects WHERE owner_id = users.id) WHERE kw_uploaded = 0');

/**
 * Admins are the people listed in ADMIN_EMAILS plus, when nobody is an admin yet, the earliest account.
 * That way an existing install gets an admin the moment it is updated.
 */
store.ensureAdmins = function ensureAdmins() {
  for (const e of String(process.env.ADMIN_EMAILS || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean)) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(e);
  }
  if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
    const first = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (first) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(first.id);
  }
};
store.ensureAdmins();

module.exports = store;
