'use strict';

const store = require('./db');
const openai = require('./openai');
const { classifyOne, buildOpts, activeBrands } = require('./classifier');
const { applyPerformance, matchFor, hasPerf } = require('./performance');
const { crawlSite, fetchPage, MAX_PAGES } = require('./crawler');
const { buildProfile } = require('./profile');
const { contentTokens } = require('./nlp');

const CHUNK = 100;   // keywords per model call
const WORKERS = 3;   // calls in flight at once within one upload
const RANK = { priority: 3, relevant: 2, review: 1, negative: 0 };

// Uploads are analysed one at a time, so a burst of files cannot flood the API. The rest wait in line.
const live = new Set();       // "project:upload" while queued or running
const queue = [];
let active = 0;
const isRunning = (pid, bid) => live.has(pid + ':' + bid);
const analyzing = new Set();  // projects whose website is being read
const isAnalyzing = pid => analyzing.has(pid);

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
    if (b.ai && (b.ai.status === 'running' || b.ai.status === 'queued') && !isRunning(p.id, b.id)) {
      b.ai = { ...b.ai, status: 'interrupted', note: 'Stopped when the server restarted. Analyse again to finish.' };
      changed = true;
    }
  }
  if (p.analysis && p.analysis.status === 'running' && !isAnalyzing(p.id)) {
    p.analysis = { ...p.analysis, status: 'interrupted', error: 'Stopped when the server restarted. Read the website again.' };
    changed = true;
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

function buildContext(p, batch) {
  const pr = p.profile;
  const cat = p.knowledge && p.knowledge.catalogue;
  const uniq = a => [...new Set(a.filter(Boolean))];
  return {
    summary: pr.summary, description: p.description, url: p.url,
    offerings: uniq([p.offerings.replace(/\s*\n\s*/g, '; '), ...(pr.aiOfferings || [])]).join('; ').slice(0, 900),
    serviceArea: uniq([p.serviceArea, ...(pr.areasServed || []), ...(pr.locations || [])]).join(', ').slice(0, 300),
    seeds: (p.seeds || []).join('; '),
    excludes: uniq([...(p.exclude || []), ...(pr.notOffered || [])]).join('; ').slice(0, 600),
    brands: uniq(activeBrands(p, pr).map(b => b.term)).join('; ').slice(0, 400),
    strict: p.strictness === 'strict',
    services: cat ? cat.services : [],
    page: batch && batch.page && batch.page.status === 'ok' ? batch.page : null,
    examples: p.keywords.filter(k => k.overridden && k.corrected).slice(-40).map(k => ({ keyword: k.keyword, to: k.category, from: k.corrected.from })),
    perf: p.perfSummary,
  };
}

// The stored pages closest to a set of keywords, so the model sees the actual wording of the site.
function makeRetriever(pages) {
  const docs = pages.map(pg => ({ pg, toks: new Set(contentTokens([pg.title, ...pg.h1, ...pg.h2, pg.text].join(' '))) }));
  const df = new Map();
  for (const d of docs) for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1);
  return keywords => {
    const want = new Set(keywords.flatMap(k => contentTokens(k)));
    const scored = docs.map(d => {
      let sc = 0;
      for (const t of want) if (d.toks.has(t)) sc += Math.log(1 + docs.length / df.get(t));
      return { d, sc };
    }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 3);
    return scored.map(x => ({ url: x.d.pg.url, title: x.d.pg.title, excerpt: x.d.pg.text.slice(0, 900) }));
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

/** Put an upload in line for analysis. The caller answers the request straight away. */
function startAI(pid, bid) {
  const p = store.get(pid);
  const b = p.batches.find(x => x.id === bid);
  if (!p.profile || !openai.enabled()) { b.ai = { status: p.profile ? 'off' : 'waiting' }; store.put(p); return; }
  const key = pid + ':' + bid;
  b.ai = {
    status: active === 0 && queue.length === 0 ? 'running' : 'queued', done: 0, total: eligible(p, bid).length, stage: 'keywords',
    startedAt: new Date().toISOString(), model: openai.model(), profileAt: p.profile.builtAt,
  };
  store.put(p);
  live.add(key); // registered before the job starts, so a job about to begin is never taken for one that died
  queue.push({ pid, bid });
  pump();
}

function pump() {
  while (active < 1 && queue.length) {
    const { pid, bid } = queue.shift();
    active++;
    setAI(pid, bid, { status: 'running' });
    setImmediate(() => {
      runBatchAI(pid, bid)
        .catch(e => { console.error(e); setAI(pid, bid, { status: 'error', note: 'Unexpected error: ' + e.message }); })
        .finally(() => { live.delete(pid + ':' + bid); active--; pump(); });
    });
  }
}

async function runBatchAI(pid, bid) {
  let failed = 0, fatal = null, pageNote = '';
  const p0 = store.get(pid);
  const batch0 = p0 && p0.batches.find(x => x.id === bid);
  if (!batch0) return;

  // The landing page for this upload is read fresh each time, then stored with the upload.
  if (batch0.pageUrl) {
    setAI(pid, bid, { stage: 'page' });
    let page;
    try {
      const pg = await fetchPage(batch0.pageUrl);
      page = { url: batch0.pageUrl, status: 'ok', title: pg.title, h1: pg.h1.slice(0, 3), h2: pg.h2.slice(0, 12), text: pg.text.slice(0, 6000), fetchedAt: new Date().toISOString() };
    } catch (e) {
      page = { url: batch0.pageUrl, status: 'error', error: e.message };
      pageNote = `Could not read the landing page (${e.message}), so these keywords were analysed without it.`;
    }
    const fresh = store.get(pid);
    const fb = fresh && fresh.batches.find(x => x.id === bid);
    if (!fb) return;
    fb.page = page;
    fb.ai = { ...fb.ai, stage: 'keywords' };
    store.put(fresh);
  }

  const p1 = store.get(pid);
  const batch = p1.batches.find(x => x.id === bid);
  const ctx = buildContext(p1, batch);
  const opts = buildOpts(p1.profile, p1);
  const targets = eligible(p1, bid);
  const rules = new Map(targets.map(k => [k.id, classifyOne(k, p1.profile, opts).category]));
  const retrieve = makeRetriever((p1.knowledge && p1.knowledge.pages) || []);
  const chunks = [];
  for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK));

  const processChunk = async chunk => {
    const rows = chunk.map((k, i) => ({ i, id: k.id, keyword: k.keyword, perf: hasPerf(k) || k.volume != null ? perfText(k) : '' }));
    const first = await openai.judgeRows(ctx, rows, retrieve(chunk.map(k => k.keyword)));
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
      Object.assign(k, { category: v.label, source: 'ai', confidence: v.confidence, intent: v.intent, service: v.service || undefined, reason: v.reason, matchType: matchFor(k.keyword, v.label), score: aiScore(v), locked: false });
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
      catch (e) { if (e.fatal) fatal = e; else { failed += chunk.length; console.error('Analysis chunk failed:', e.message); } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, worker));

  const fresh = store.get(pid);
  if (!fresh) return;
  applyPerformance(fresh);
  const b = fresh.batches.find(x => x.id === bid);
  if (b) {
    const notes = [fatal ? fatal.message : failed ? `${failed} keyword${failed === 1 ? '' : 's'} could not be analysed and kept the basic sorting.` : '', pageNote].filter(Boolean);
    b.ai = { ...b.ai, status: fatal ? 'error' : 'done', stage: undefined, finishedAt: new Date().toISOString(), note: notes.join(' ') };
  }
  store.put(fresh);
}

/* ---------- reading the business website ---------- */
const hasOwnText = p => Boolean(p.description || p.offerings || (p.seeds && p.seeds.length));

function startAnalysis(pid) {
  const p = store.get(pid);
  p.analysis = { status: 'running', stage: p.url ? 'Reading the website' : 'Building the profile', done: 0, total: p.url ? MAX_PAGES : 0, startedAt: new Date().toISOString() };
  store.put(p);
  analyzing.add(pid);
  setImmediate(() => runAnalysis(pid).finally(() => analyzing.delete(pid)));
}

async function runAnalysis(pid) {
  const setA = patch => {
    const p = store.get(pid);
    if (!p) return null;
    p.analysis = { ...p.analysis, ...patch };
    store.put(p);
    return p;
  };
  try {
    const p0 = store.get(pid);
    let pages = [], errors = [];
    if (p0.url) {
      try { ({ pages, errors } = await crawlSite(p0.url, { maxPages: MAX_PAGES, onProgress: n => setA({ done: n }) })); }
      catch (e) {
        if (!hasOwnText(p0)) throw new Error('Could not read the website (' + e.message + '). Describe the business in the form and try again.');
        errors = [{ url: p0.url, error: e.message }];
      }
    }
    let catalogue = null, note = '';
    if (openai.enabled() && (pages.length || p0.description)) {
      setA({ stage: 'Understanding your services' });
      try { catalogue = await openai.buildCatalogue(p0, pages); }
      catch (e) { note = 'The service summary was skipped: ' + e.message; }
    }
    setA({ stage: 'Building the profile' });
    const p = store.get(pid); // fresh copy: teammates may have edited while the pages were being read
    const services = catalogue ? catalogue.services : [];
    const profile = buildProfile({ project: p, pages, extraTerms: services.map(s => s.name) });
    if (!profile.topTerms.length) throw new Error('Not enough readable text to build a profile. Add a description or a few starting keywords.');
    profile.summary = catalogue ? catalogue.summary : '';
    profile.aiOfferings = services.map(s => s.name);
    profile.notOffered = catalogue ? catalogue.notOffered : [];
    profile.areasServed = catalogue ? catalogue.areasServed : [];
    profile.aiNote = note;
    profile.pages = pages.map(pg => ({ url: pg.url, title: pg.title, words: pg.text.split(' ').length }));
    profile.errors = errors.slice(0, 30);
    p.profile = profile;
    // What the crawler read is kept, so every later analysis can look at the site's own words.
    p.knowledge = {
      builtAt: profile.builtAt,
      pages: pages.map(pg => ({ url: pg.url, title: pg.title, h1: pg.h1.slice(0, 3), h2: pg.h2.slice(0, 10), text: pg.text.slice(0, 2500) })),
      catalogue,
    };
    rescore(p);
    p.analysis = { ...p.analysis, status: 'done', stage: '', done: pages.length, pagesRead: pages.length, services: services.length, finishedAt: new Date().toISOString() };
    store.put(p);
    for (const b of p.batches) if (b.ai && b.ai.status === 'waiting') startAI(pid, b.id);
  } catch (e) {
    setA({ status: 'error', stage: '', error: e.message, finishedAt: new Date().toISOString() });
  }
}

module.exports = { newBatch, upgrade, rescore, startAI, startAnalysis, isRunning, isAnalyzing, CHUNK };
