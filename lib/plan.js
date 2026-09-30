'use strict';

// What each person is allowed to do. Limits come from three places, strongest first:
// the admin's setting for that person, the admin's defaults, then "no limit". Admins are never limited.
const store = require('./db');
const pricing = require('./pricing');

const NUM_KEYS = ['projects', 'campaignsPerProject', 'keywordsPerProject', 'keywordsTotal', 'aiBudget'];

function parseLimits(row) {
  try { return row && row.limits ? JSON.parse(row.limits) : {}; } catch { return {}; }
}

// A stored number means a limit, -1 means "no limit", nothing means "use the next level down".
function pick(custom, fallback) {
  if (custom !== undefined && custom !== null) return { value: custom < 0 ? null : custom, source: 'custom' };
  if (fallback !== undefined && fallback !== null) return { value: fallback < 0 ? null : fallback, source: 'default' };
  return { value: null, source: 'default' };
}

// { key: { value: number | null (no limit), source: 'custom' | 'default' | 'admin' } }
function resolve(row) {
  const out = {};
  const custom = parseLimits(row);
  const defaults = store.getSetting('defaultLimits', {});
  const admin = Boolean(row && row.is_admin);
  for (const k of NUM_KEYS) out[k] = admin ? { value: null, source: 'admin' } : pick(custom[k], defaults[k]);
  out.aiEnabled = admin ? { value: true, source: 'admin' }
    : typeof custom.aiEnabled === 'boolean' ? { value: custom.aiEnabled, source: 'custom' } : { value: defaults.aiEnabled !== false, source: 'default' };
  return out;
}

const plain = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]));
const limitsFor = uid => plain(resolve(store.userById(uid)));
const s = n => (n === 1 ? '' : 's');

function projectsMessage(uid) {
  const lim = limitsFor(uid).projects;
  return lim !== null && store.ownedCount(uid) >= lim ? `You have reached your limit of ${lim} project${s(lim)}. Ask the administrator to raise it.` : null;
}

// Campaigns, keywords and analysis belong to the project's owner, so the owner's limits apply whoever is editing.
function campaignsMessage(ownerId, project) {
  const lim = limitsFor(ownerId).campaignsPerProject;
  return lim !== null && project.campaigns.length >= lim ? `This project has reached its limit of ${lim} campaign${s(lim)}. Ask the administrator to raise it.` : null;
}

// How many more keywords this project may take, and which limit is the tight one.
function keywordRoom(ownerId, project) {
  const lim = limitsFor(ownerId);
  const perProject = lim.keywordsPerProject === null ? Infinity : lim.keywordsPerProject - project.keywords.length;
  const total = lim.keywordsTotal === null ? Infinity : lim.keywordsTotal - store.ownedKeywords(ownerId);
  const room = Math.max(0, Math.min(perProject, total));
  const message = room === Infinity ? '' : perProject <= total
    ? `The limit for one project is ${lim.keywordsPerProject.toLocaleString()} keywords.`
    : `The limit across all projects is ${lim.keywordsTotal.toLocaleString()} keywords.`;
  return { room, message };
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
const pricesSet = () => store.getSetting('pricing', {});
const spentSince = (uid, since) => pricing.sumCost(store.usageGroups(since, uid), pricesSet()).cost;

// Whether smart analysis may run for this person right now. Checked before each batch of keywords, so a budget cuts in quickly.
function aiAllowed(ownerId) {
  if (!store.getSetting('aiEnabled', true)) return { ok: false, reason: 'Smart analysis is switched off by the administrator.' };
  const row = store.userById(ownerId);
  if (!row) return { ok: true };
  const r = resolve(row);
  if (!r.aiEnabled.value) return { ok: false, reason: 'Smart analysis is switched off for this account.' };
  if (r.aiBudget.value !== null) {
    const used = spentSince(ownerId, monthStart());
    if (used >= r.aiBudget.value) return { ok: false, reason: `The monthly analysis budget for this account is used up (${pricing.money(used)} of ${pricing.money(r.aiBudget.value)}). It resets on the 1st.` };
  }
  return { ok: true };
}

// What the page shows a person about their own allowance.
function summaryFor(uid) {
  const row = store.userById(uid);
  return { limits: plain(resolve(row)), usage: { projects: store.ownedCount(uid), keywords: store.ownedKeywords(uid), aiSpentMonth: Number(spentSince(uid, monthStart()).toFixed(4)) } };
}

module.exports = { NUM_KEYS, parseLimits, resolve, plain, limitsFor, projectsMessage, campaignsMessage, keywordRoom, aiAllowed, summaryFor, monthStart, pricesSet, spentSince };
