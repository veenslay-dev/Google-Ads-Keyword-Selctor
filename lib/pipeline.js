'use strict';

const store = require('./db');
const openai = require('./openai');
const { classifyOne, buildOpts, activeBrands } = require('./classifier');
const { applyPerformance, matchFor, hasPerf } = require('./performance');

const CHUNK = 100;   // keywords per model call
const WORKERS = 3;   // calls in flight at once
const RANK = { priority: 3, relevant: 2, review: 1, negative: 0 };
const running = new Set();
const isRunning = (pid, bid) => running.has(pid + ':' + bid);

/* ---------- uploads ---------- */
function newBatch({ name, filename, kind, createdAt }) {
  return { id: store.id(), name, filename: filename || '', kind, createdAt: createdAt || new Date().toISOString(), ai: { status: 'off' } };
}

/**
 * Older projects kept a flat keyword list and a separate search terms list. Fold both into uploads,
 * and mark AI runs that were cut short by a restart. Returns true when something changed.
 */
function upgrade(p) {
  let changed = false;
  if (!p.batches) { p.batches = []; changed = true; }
  const orphans = p.keywords.filter(k => !k.batchId);
  if (orphans.length) {
    const b = newBatch({ name: 'Earlier upload', kind: 'Keyword list', createdAt: p.createdAt });
    orphans.forEach(k => { k.batchId = b.id; if (k.overridden && !k.source) k.source = 'you'; });
    p.batches.push(b);
    changed = true;
  }
  if (p.searchTerms && p.searchTerms.length) {
    const b = newBatch({ name: 'Earlier search terms report', kind: 'Search terms report', createdAt: (p.stMeta && p.stMeta.importedAt) || p.createdAt });
    const have = new Map(p.keywords.map(k => [k.keyword.toLowerCase(), k]));
    let used = false;
    for (const t of p.searchTerms) {
      const row = { impressions: t.impressions, clicks: t.clicks, cost: t.cost, conversions: t.conversions, convValue: t.convValue, status: t.status };
      const existing = have.get(t.term.toLowerCase());
      if (existing) { if (!hasPerf(existing)) Object.assign(existing, row); continue; }
      const k = { id: t.id, batchId: b.id, keyword: t.term, ...row };
      p.keywords.push(k); have.set(t.term.toLowerCase(), k); used = true;
    }
    if (used) p.batches.push(b);
  }
  if ('searchTerms' in p || 'stSummary' in p || 'stMeta' in p) { delete p.searchTerms; delete p.stSummary; delete p.stMeta; changed = true; }
  for (const b of p.batches) {
    if (b.ai && b.ai.status === 'running' && !isRunning(p.id, b.id)) {
      b.ai = { ...b.ai, status: 'interrupted', note: 'Stopped when the server restarted. Re-check to finish.' };
      changed = true;
    }
  }
  return changed;
}

/* ---------- rules ---------- */
// Re-run the rules on everything you have not decided yourself. AI verdicts stay unless a hard rule
// (your exclusions, competitor brands) now says otherwise.
function rescore(p) {
  if (p.profile) {
    const opts = buildOpts(p.profile, p);
    for (const k of p.keywords) {
      if (k.overridden) continue;
      const local = classifyOne(k, p.profile, opts);
      if (local.locked || k.source !== 'ai') Object.assign(k, local, { source: 'rules', confidence: undefined });
      else k.locked = false;
    }
  }
  applyPerformance(p);
}

/* ---------- AI ---------- */
const aiScore = v => Math.round(({ priority: 70, relevant: 45, review: 25, negative: 5 })[v.label] + v.confidence * 0.3);

function perfText(k) {
  const bits = [];
  if (k.clicks != null) bits.push('clicks ' + k.clicks);
  if (k.cost != null) bits.push('cost ' + k.cost);
  if (k.conversions != null) bits.push('conversions ' + k.conversions);
  if (k.volume != null) bits.push('searches/month ' + k.volume);
  return bits.join(', ');
}

function buildContext(p) {
  const pr = p.profile;
  const uniq = a => [...new Set(a.filter(Boolean))];
  return {
    summary: pr.summary, description: p.description, url: p.url,
    offerings: uniq([p.offerings.replace(/\s*\n\s*/g, '; '), ...(pr.aiOfferings || [])]).join('; ').slice(0, 900),
    serviceArea: uniq([p.serviceArea, ...(pr.areasServed || []), ...(pr.locations || [])]).join(', ').slice(0, 300),
    seeds: (p.seeds || []).join('; '),
    excludes: uniq([...(p.exclude || []), ...(pr.notOffered || [])]).join('; ').slice(0, 600),
    brands: uniq(activeBrands(p, pr).map(b => b.term)).join('; ').slice(0, 400),
    strict: p.strictness === 'strict',
    examples: p.keywords.filter(k => k.overridden && k.corrected).slice(-40).map(k => ({ keyword: k.keyword, to: k.category, from: k.corrected.from })),
    perf: p.perfSummary,
  };
}

const eligible = (p, bid) => p.keywords.filter(k => k.batchId === bid && !k.overridden && !k.locked && !k.perfLocked);

function setAI(pid, bid, patch) {
  const p = store.get(pid);
  const b = p && p.batches.find(x => x.id === bid);
  if (!b) return null;
  b.ai = { ...b.ai, ...patch };
  store.put(p);
  return p;
}

/** Mark the upload as running and start the work in the background. The caller answers the request straight away. */
function startAI(pid, bid) {
  const p = store.get(pid);
  const b = p.batches.find(x => x.id === bid);
  if (!p.profile || !openai.enabled()) { b.ai = { status: p.profile ? 'off' : 'waiting' }; store.put(p); return; }
  b.ai = { status: 'running', done: 0, total: eligible(p, bid).length, startedAt: new Date().toISOString(), model: openai.model(), profileAt: p.profile.builtAt };
  store.put(p);
  // Registered before the job starts, so nothing can mistake a job that is about to begin for one that died.
  running.add(pid + ':' + bid);
  setImmediate(() => runBatchAI(pid, bid).catch(e => { console.error(e); setAI(pid, bid, { status: 'error', note: 'Unexpected error: ' + e.message }); }));
}

async function runBatchAI(pid, bid) {
  const key = pid + ':' + bid;
  let failed = 0, fatal = null;
  try {
    const p0 = store.get(pid);
    const ctx = buildContext(p0);
    const opts = buildOpts(p0.profile, p0);
    const targets = eligible(p0, bid);
    const rules = new Map(targets.map(k => [k.id, classifyOne(k, p0.profile, opts).category]));
    const chunks = [];
    for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK));

    const processChunk = async chunk => {
      const rows = chunk.map((k, i) => ({ i, id: k.id, keyword: k.keyword, perf: hasPerf(k) || k.volume != null ? perfText(k) : '' }));
      const first = await openai.judgeRows(ctx, rows);
      const shaky = [];
      for (const r of rows) {
        const v = first.get(r.i);
        if (!v) continue;
        const rc = rules.get(r.id);
        if (v.confidence < 70 || Math.abs(RANK[v.label] - RANK[rc]) >= 3) {
          shaky.push({ ...r, first: `${v.label} (${v.confidence}%): ${v.reason}`, rules: `${rc} from keyword rules` });
        }
      }
      let second = new Map();
      if (shaky.length) {
        try { second = await openai.verifyRows(ctx, shaky); } catch (e) { if (e.fatal) throw e; }
      }
      const final = new Map();
      for (const r of rows) {
        let v = second.get(r.i) || first.get(r.i);
        if (!v) continue;
        if (v.confidence < 60 && v.label !== 'review') v = { ...v, label: 'review', reason: 'Unsure: ' + v.reason };
        final.set(r.id, v);
      }
      const fresh = store.get(pid);
      const byId = new Map(fresh.keywords.map(k => [k.id, k]));
      for (const [id, v] of final) {
        const k = byId.get(id);
        if (!k || k.overridden || k.locked || k.perfLocked) continue;
        Object.assign(k, { category: v.label, source: 'ai', confidence: v.confidence, intent: v.intent, reason: v.reason, matchType: matchFor(k.keyword, v.label), score: aiScore(v), locked: false });
      }
      failed += rows.length - final.size;
      const b = fresh.batches.find(x => x.id === bid);
      if (b) b.ai.done = Math.min(b.ai.total || targets.length, (b.ai.done || 0) + chunk.length);
      store.put(fresh);
    };

    const worker = async () => {
      while (!fatal) {
        const chunk = chunks.shift();
        if (!chunk) return;
        try { await processChunk(chunk); }
        catch (e) { if (e.fatal) fatal = e; else { failed += chunk.length; console.error('AI chunk failed:', e.message); } }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, worker));

    const fresh = store.get(pid);
    applyPerformance(fresh);
    const b = fresh.batches.find(x => x.id === bid);
    if (b) {
      b.ai = {
        ...b.ai, status: fatal ? 'error' : 'done', finishedAt: new Date().toISOString(),
        note: fatal ? fatal.message : failed ? `${failed} keyword${failed === 1 ? '' : 's'} could not be checked and kept the rules result.` : '',
      };
    }
    store.put(fresh);
  } finally {
    running.delete(key);
  }
}

module.exports = { newBatch, upgrade, rescore, startAI, isRunning, CHUNK };
