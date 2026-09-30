'use strict';

// Everything behind the admin pages. The server checks the caller is an admin before any of this runs.
const crypto = require('node:crypto');
const store = require('./db');
const plan = require('./plan');
const pricing = require('./pricing');
const auth = require('./auth');
const openai = require('./openai');

class AdminError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LABELS = { projects: 'projects', campaignsPerProject: 'campaigns per project', keywordsPerProject: 'keywords per project', keywordsTotal: 'keywords in total', aiBudget: 'monthly analysis budget' };
const day = offset => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const lastDays = n => Array.from({ length: n }, (_, i) => day(n - 1 - i));
const r2 = n => Math.round(n * 10000) / 10000;

// ---- usage, added up from the stored token counts
function tally(rows, prices) {
  const t = { calls: 0, errors: 0, prompt: 0, completion: 0, cost: 0 };
  for (const r of rows) {
    t.calls += r.calls; t.errors += r.errors || 0; t.prompt += r.prompt || 0; t.completion += r.completion || 0;
    t.cost += pricing.costOf(r, prices).cost;
  }
  return { ...t, cost: r2(t.cost) };
}

function groupBy(rows, key, prices) {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([k, rs]) => ({ [key]: k, ...tally(rs, prices) }));
}

const KIND_LABEL = { catalogue: 'Understanding the website', judge: 'Judging keywords', verify: 'Second opinions', columns: 'Reading file layouts' };

function userFigures(rows, prices) {
  const monthPrefix = day(0).slice(0, 7);
  return { all: tally(rows, prices), month: tally(rows.filter(r => r.day.startsWith(monthPrefix)), prices) };
}

function shapeUser(u, usageRows, prices) {
  const fig = userFigures(usageRows.filter(r => r.user_id === u.id), prices);
  const resolved = plan.resolve(u);
  return {
    id: u.id, name: u.name, email: u.email, createdAt: u.created_at, isAdmin: Boolean(u.is_admin), status: u.status, note: u.note || '',
    lastLoginAt: u.last_login_at, lastSeenAt: u.last_seen_at, lastChange: u.last_update,
    projects: u.projects, campaigns: u.campaigns, uploads: u.uploads, keywords: u.keywords, keywordsUploaded: Math.max(u.kw_uploaded, u.keywords), sharedWithThem: u.shared_with_them,
    ai: { calls: fig.all.calls, errors: fig.all.errors, tokens: fig.all.prompt + fig.all.completion, costAll: fig.all.cost, costMonth: fig.month.cost, callsMonth: fig.month.calls },
    overrides: plan.parseLimits(u), limits: plan.plain(resolved), sources: Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.source])),
  };
}

function overview() {
  const prices = plan.pricesSet();
  const since = day(29);
  const all = store.usageGroups('');
  const today = day(0), month = today.slice(0, 7);
  const t = tally(all, prices);
  const unknown = pricing.sumCost(all, prices).unknown;

  const recent = all.filter(r => r.day >= since);
  const costByDay = Object.fromEntries(groupBy(recent, 'day', prices).map(d => [d.day, d]));
  const signups = Object.fromEntries(store.signupsByDay(since).map(r => [r.day, r.n]));
  const users = store.usersWithTotals();
  const shaped = users.map(u => shapeUser(u, all, prices));

  return {
    users: {
      total: users.length, active: users.filter(u => u.status === 'active').length, suspended: users.filter(u => u.status === 'suspended').length, admins: users.filter(u => u.is_admin).length,
      newWeek: store.countWhere('created_at >= ?', new Date(Date.now() - 7 * 864e5).toISOString()),
      newMonth: store.countWhere('created_at >= ?', new Date(Date.now() - 30 * 864e5).toISOString()),
      activeWeek: store.countWhere('last_seen_at >= ?', new Date(Date.now() - 7 * 864e5).toISOString()),
    },
    content: store.contentTotals(),
    ai: {
      calls: t.calls, errors: t.errors, tokens: t.prompt + t.completion, costAll: t.cost,
      costMonth: tally(all.filter(r => r.day.startsWith(month)), prices).cost, costToday: tally(all.filter(r => r.day === today), prices).cost,
      unknownModels: unknown,
    },
    series: {
      signups: lastDays(30).map(d => ({ day: d, value: signups[d] || 0 })),
      cost: lastDays(30).map(d => ({ day: d, value: costByDay[d] ? costByDay[d].cost : 0, calls: costByDay[d] ? costByDay[d].calls : 0 })),
    },
    byKind: groupBy(all, 'kind', prices).map(k => ({ ...k, label: KIND_LABEL[k.kind] || k.kind })).sort((a, b) => b.cost - a.cost),
    byModel: groupBy(all, 'model', prices).sort((a, b) => b.cost - a.cost),
    topCost: [...shaped].sort((a, b) => b.ai.costAll - a.ai.costAll).filter(u => u.ai.costAll > 0).slice(0, 5),
    topKeywords: [...shaped].sort((a, b) => b.keywords - a.keywords).filter(u => u.keywords > 0).slice(0, 5),
    system: systemInfo(),
  };
}

function systemInfo() {
  return {
    model: openai.model(), keyConfigured: openai.enabled(), aiSwitchOn: store.getSetting('aiEnabled', true), signupOpen: auth.signupOpen(),
    dbBytes: store.dbBytes(), node: process.version, uptimeSeconds: Math.round(process.uptime()), basePath: process.env.BASE_PATH || '',
  };
}

function users() {
  const prices = plan.pricesSet();
  const all = store.usageGroups('');
  return store.usersWithTotals().map(u => shapeUser(u, all, prices));
}

function userDetail(id) {
  const u = store.usersWithTotals().find(x => x.id === id);
  if (!u) throw new AdminError(404, 'User not found');
  const prices = plan.pricesSet();
  const all = store.usageGroups('', id);
  const shaped = shapeUser(u, all.map(r => ({ ...r, user_id: id })), prices);
  const since = day(29);
  const costByDay = Object.fromEntries(groupBy(all.filter(r => r.day >= since), 'day', prices).map(d => [d.day, d]));
  return {
    ...shaped,
    usage: {
      costSeries: lastDays(30).map(d => ({ day: d, value: costByDay[d] ? costByDay[d].cost : 0, calls: costByDay[d] ? costByDay[d].calls : 0 })),
      byKind: groupBy(all, 'kind', prices).map(k => ({ ...k, label: KIND_LABEL[k.kind] || k.kind })).sort((a, b) => b.cost - a.cost),
      spentMonth: plan.spentSince(id, plan.monthStart()),
    },
    projectList: store.projectsOf(id),
    defaults: plan.plain(plan.resolve({ limits: null, is_admin: 0 })),
  };
}

// ---- changes
function cleanLimits(input) {
  if (!input || typeof input !== 'object') throw new AdminError(400, 'Limits must be an object.');
  const out = {};
  for (const k of plan.NUM_KEYS) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === null) { out[k] = null; continue; } // null removes the custom value, so the default applies
    const n = Number(v);
    if (!Number.isFinite(n) || n < -1) throw new AdminError(400, `Enter a number for ${LABELS[k]}. Use -1 for no limit.`);
    out[k] = k === 'aiBudget' ? Math.round(n * 100) / 100 : Math.floor(n);
  }
  if ('aiEnabled' in input) {
    if (input.aiEnabled !== null && typeof input.aiEnabled !== 'boolean') throw new AdminError(400, 'Analysis must be on, off or default.');
    out.aiEnabled = input.aiEnabled;
  }
  return out;
}

const show = v => (v === -1 ? 'no limit' : v);
const describe = c => Object.entries(c).map(([k, v]) => `${LABELS[k] || k}: ${v === null ? 'default' : typeof v === 'boolean' ? (v ? 'on' : 'off') : show(v)}`).join(', ');

function applyLimits(row, changes) {
  const next = { ...plan.parseLimits(row) };
  for (const [k, v] of Object.entries(changes)) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}

const adminCount = () => store.countWhere('is_admin = 1 AND status = ?', 'active');

function updateUser(actor, id, body) {
  const row = store.userById(id);
  if (!row) throw new AdminError(404, 'User not found');
  const self = actor.id === id;
  const notes = [];
  const set = (col, val) => store.db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, id);

  if (body.limits !== undefined) {
    const changes = body.limits === null ? null : cleanLimits(body.limits);
    const next = changes ? applyLimits(row, changes) : {};
    set('limits', Object.keys(next).length ? JSON.stringify(next) : null);
    notes.push('limits: ' + (changes ? describe(changes) : 'all reset to default'));
  }
  if (body.status !== undefined) {
    if (!['active', 'suspended'].includes(body.status)) throw new AdminError(400, 'Status must be active or suspended.');
    if (self && body.status === 'suspended') throw new AdminError(400, 'You cannot suspend your own account.');
    if (body.status === 'suspended' && row.is_admin && adminCount() <= 1) throw new AdminError(400, 'That is the last active admin.');
    set('status', body.status);
    if (body.status === 'suspended') store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    notes.push(body.status);
  }
  if (body.isAdmin !== undefined) {
    if (self) throw new AdminError(400, 'You cannot change your own admin access.');
    if (!body.isAdmin && row.is_admin && adminCount() <= 1) throw new AdminError(400, 'That is the last active admin.');
    set('is_admin', body.isAdmin ? 1 : 0);
    notes.push(body.isAdmin ? 'made admin' : 'admin removed');
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80);
    if (!name) throw new AdminError(400, 'Enter a name.');
    set('name', name);
    notes.push('renamed');
  }
  if (body.note !== undefined) { set('note', String(body.note).slice(0, 500) || null); notes.push('note'); }
  if (notes.length) store.audit(actor, 'user.update', row, notes.join('; '));
  return userDetail(id);
}

const tempPassword = () => crypto.randomBytes(9).toString('base64url');

function setPassword(actor, id, password) {
  const row = store.userById(id);
  if (!row) throw new AdminError(404, 'User not found');
  const chosen = password ? String(password) : tempPassword();
  auth.setPassword(id, chosen);
  store.audit(actor, 'user.password', row, 'password set, sessions ended');
  return { password: chosen };
}

function createUser(actor, body) {
  const password = body.password ? String(body.password) : tempPassword();
  const limits = body.limits ? applyLimits({ limits: null }, cleanLimits(body.limits)) : null;
  const user = auth.createUser({ email: body.email, name: body.name, password, admin: Boolean(body.isAdmin), limits: limits && Object.keys(limits).length ? limits : null });
  store.audit(actor, 'user.create', user, body.isAdmin ? 'admin' : null);
  return { user: userDetail(user.id), password: body.password ? null : password };
}

function deleteUser(actor, id, confirmEmail) {
  const row = store.userById(id);
  if (!row) throw new AdminError(404, 'User not found');
  if (actor.id === id) throw new AdminError(400, 'You cannot delete your own account.');
  if (row.is_admin && adminCount() <= 1) throw new AdminError(400, 'That is the last active admin.');
  if (String(confirmEmail || '').trim().toLowerCase() !== row.email) throw new AdminError(400, 'Type their email address to confirm.');
  const owned = store.ownedCount(id);
  store.deleteUser(id);
  store.audit(actor, 'user.delete', row, `${owned} project${owned === 1 ? '' : 's'} deleted with them`);
  return { ok: true, projectsDeleted: owned };
}

// ---- settings
function settings() {
  const overrides = store.getSetting('pricing', {});
  const names = [...new Set([...Object.keys(pricing.DEFAULTS), ...Object.keys(overrides), openai.model()])];
  return {
    signupOpen: auth.signupOpen(), aiEnabled: store.getSetting('aiEnabled', true), defaultLimits: store.getSetting('defaultLimits', {}),
    pricing: names.map(model => { const p = pricing.priceFor(model, overrides); return { model, in: p ? p.in : null, out: p ? p.out : null, cached: p ? p.cached : null, source: p ? p.source : 'not set', current: model === openai.model() }; }),
    system: systemInfo(),
  };
}

function updateSettings(actor, body) {
  const notes = [];
  if (body.signupOpen !== undefined) { store.setSetting('signupOpen', Boolean(body.signupOpen)); notes.push('sign-ups ' + (body.signupOpen ? 'open' : 'closed')); }
  if (body.aiEnabled !== undefined) { store.setSetting('aiEnabled', Boolean(body.aiEnabled)); notes.push('analysis ' + (body.aiEnabled ? 'on' : 'off') + ' for everyone'); }
  if (body.defaultLimits !== undefined) {
    const clean = cleanLimits(body.defaultLimits);
    const next = { ...store.getSetting('defaultLimits', {}) };
    for (const [k, v] of Object.entries(clean)) { if (v === null || v === -1) delete next[k]; else next[k] = v; } // no entry means no limit
    if ('aiEnabled' in clean) { if (clean.aiEnabled === false) next.aiEnabled = false; else delete next.aiEnabled; }
    store.setSetting('defaultLimits', next);
    notes.push('default limits: ' + (Object.entries(next).map(([k, v]) => `${LABELS[k] || 'analysis'} ${v}`).join(', ') || 'none'));
  }
  if (body.pricing !== undefined) {
    const next = { ...store.getSetting('pricing', {}) };
    for (const [model, p] of Object.entries(body.pricing || {})) {
      const vals = [p.in, p.out, p.cached].map(Number);
      if (vals.some(v => !Number.isFinite(v) || v < 0)) throw new AdminError(400, `Prices for ${model} must be numbers, zero or more.`);
      const base = pricing.DEFAULTS[model];
      if (base && base.in === vals[0] && base.out === vals[1] && base.cached === vals[2]) delete next[model];
      else next[model] = { in: vals[0], out: vals[1], cached: vals[2] };
    }
    store.setSetting('pricing', next);
    notes.push('token prices');
  }
  if (notes.length) store.audit(actor, 'settings.update', null, notes.join('; '));
  return settings();
}

const activity = () => store.auditLog(100).map(a => ({ id: a.id, at: a.at, actor: a.actor_name, action: a.action, target: a.target_name, detail: a.detail }));

module.exports = { AdminError, overview, users, userDetail, updateUser, setPassword, createUser, deleteUser, settings, updateSettings, activity, tally };
