'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'projects.json');

let db = null;

function load() {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { projects: {} }; }
  return db;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

const id = () => crypto.randomBytes(6).toString('hex');

module.exports = {
  id,
  list: () => Object.values(load().projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  get: pid => load().projects[pid] || null,
  put(project) { project.updatedAt = new Date().toISOString(); load().projects[project.id] = project; save(); return project; },
  remove(pid) { delete load().projects[pid]; save(); },
};
