'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./lib/db');
const auth = require('./lib/auth');
const openai = require('./lib/openai');
const pipeline = require('./lib/pipeline');
const { matchFor, hasPerf } = require('./lib/performance');
const { splitList } = require('./lib/profile');
const { suggestNegativeWords, suggestAdGroups } = require('./lib/classifier');
const { crawlCompetitor, findGaps, MAX_COMPETITORS } = require('./lib/competitors');
const { MAX_PAGES: MAX_SITE_PAGES } = require('./lib/crawler');
const { extractKeywords, MAX_KEYWORDS } = require('./lib/sheet');
const { toCsv } = require('./lib/csv');

const PORT = Number(process.env.PORT) || 3000;
// Optional mount point, for example BASE_PATH=/keyword-selector. Works whether or not the proxy strips it.
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '').replace(/^(?!\/)(?=.)/, '/');
const stripBase = p => (BASE && (p === BASE || p.startsWith(BASE + '/')) ? p.slice(BASE.length) || '/' : p);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CATEGORIES = ['priority', 'relevant', 'review', 'negative'];
const RANK = { viewer: 1, editor: 2, owner: 3 };
const MAX_PROJECT_KEYWORDS = 20000;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).href; } catch { throw new HttpError(400, 'That website address does not look valid.'); }
}

function applyFields(p, b) {
  if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 100) || p.name;
  if (b.url !== undefined) p.url = normalizeUrl(b.url);
  if (b.description !== undefined) p.description = String(b.description).slice(0, 4000);
  if (b.offerings !== undefined) p.offerings = String(b.offerings).slice(0, 4000);
  if (b.serviceArea !== undefined) p.serviceArea = String(b.serviceArea).slice(0, 500);
  if (b.seeds !== undefined) p.seeds = splitList(b.seeds).slice(0, 50);
  if (b.exclude !== undefined) p.exclude = splitList(b.exclude).slice(0, 100);
  if (b.strictness !== undefined) p.strictness = b.strictness === 'strict' ? 'strict' : 'balanced';
  if (b.blockCompetitors !== undefined) p.blockCompetitors = Boolean(b.blockCompetitors);
  if (b.campaign !== undefined) p.campaign = String(b.campaign).slice(0, 100);
}

const countsOf = rows => {
  const c = { priority: 0, relevant: 0, review: 0, negative: 0, unsorted: 0, total: rows.length };
  for (const k of rows) c[k.category || 'unsorted']++;
  return c;
};

function summary(p, role, ownerName, memberCount) {
  const c = countsOf(p.keywords);
  return { id: p.id, name: p.name, url: p.url, updatedAt: p.updatedAt, analyzed: Boolean(p.profile), total: c.total, counts: c, uploads: (p.batches || []).length, role, ownerName, shared: memberCount > 1 };
}

// The full profile weight tables are large and only useful server side.
function publicProject(p, role) {
  const { profile, competitors = [], knowledge, ...rest } = p;
  const view = { ...rest, role, counts: countsOf(p.keywords), perfSummary: p.perfSummary || null };
  view.batches = p.batches.map(b => ({ ...b, page: b.page ? { url: b.page.url, status: b.page.status, title: b.page.title, error: b.page.error } : undefined, counts: countsOf(p.keywords.filter(k => k.batchId === b.id)), stale: Boolean(profile && b.ai && b.ai.status === 'done' && b.ai.profileAt !== profile.builtAt) }));
  view.competitors = competitors.map(c => ({ id: c.id, url: c.url, name: c.name, host: c.host, pages: c.pages, errors: c.errors, crawledAt: c.crawledAt }));
  view.brands = p.competitorBrands || [];
  view.blockCompetitors = p.blockCompetitors !== false;
  if (profile) {
    view.profile = {
      builtAt: profile.builtAt, summary: profile.summary || '', topTerms: profile.topTerms, topPhrases: profile.topPhrases,
      aiOfferings: profile.aiOfferings || [], notOffered: profile.notOffered || [], areasServed: profile.areasServed || [], pages: profile.pages || [], errors: profile.errors || [], aiNote: profile.aiNote || '',
      services: (p.knowledge && p.knowledge.catalogue ? p.knowledge.catalogue.services : []),
    };
    view.negativeWords = suggestNegativeWords(p.keywords, profile);
    view.adGroups = suggestAdGroups(p.keywords, profile);
    view.gaps = findGaps(competitors, profile);
  }
  return view;
}

// Every route reads the project through here. Older projects are upgraded once and saved straight away,
// so the ids the page holds stay valid.
function load(pid) {
  const p = store.get(pid);
  if (p && pipeline.upgrade(p)) { pipeline.rescore(p); store.put(p); }
  return p;
}

function rebuildBrands(p) {
  const old = new Map((p.competitorBrands || []).map(b => [b.phrase, b]));
  const out = new Map();
  for (const c of p.competitors || []) {
    for (const phrase of c.brands || []) {
      if (!out.has(phrase)) out.set(phrase, { phrase, competitor: c.name, enabled: old.has(phrase) ? old.get(phrase).enabled !== false : true });
    }
  }
  p.competitorBrands = [...out.values()];
}

function csvFor(p, type, campaign, batchId) {
  const rows = batchId ? p.keywords.filter(k => k.batchId === batchId) : p.keywords;
  const groups = p.profile ? suggestAdGroups(rows, p.profile) : [];
  const groupOf = new Map();
  groups.forEach(g => g.ids.forEach(i => groupOf.set(i, g.name)));
  const batchName = new Map(p.batches.map(b => [b.id, b.name]));
  const batchPage = new Map(p.batches.map(b => [b.id, b.pageUrl || '']));
  const by = c => rows.filter(k => k.category === c);
  const withPerf = rows.some(hasPerf);
  const withVol = rows.some(k => k.volume != null);
  const detail = ks => toCsv(
    ['Keyword', 'Category', 'Confidence', 'Intent', 'Matched service', 'Suggested match type', 'Suggested ad group', 'Reason', 'File', 'Landing page', ...(withVol ? ['Avg monthly searches'] : []), ...(withPerf ? ['Impressions', 'Clicks', 'Cost', 'Conversions'] : [])],
    ks.map(k => [k.keyword, k.category || '', k.confidence != null ? k.confidence + '%' : '', k.intent || '', k.service || '', k.matchType || '', groupOf.get(k.id) || '', [k.reason, k.note].filter(Boolean).join('. '), batchName.get(k.batchId) || '', batchPage.get(k.batchId) || '',
      ...(withVol ? [k.volume ?? ''] : []), ...(withPerf ? [k.impressions ?? '', k.clicks ?? '', k.cost ?? '', k.conversions ?? ''] : [])])
  );
  const camp = campaign || p.campaign || p.name;
  switch (type) {
    case 'all': return detail(rows);
    case 'priority': return detail(by('priority'));
    case 'relevant': return detail(by('relevant'));
    case 'review': return detail(by('review'));
    case 'negative': return detail(by('negative'));
    case 'ads-targeting':
      return toCsv(['Campaign', 'Ad Group', 'Keyword', 'Criterion Type', 'Status'],
        [...by('priority'), ...by('relevant')].map(k => [camp, groupOf.get(k.id) || 'Other', k.keyword, k.matchType || 'Phrase', k.category === 'priority' ? 'Enabled' : 'Paused']));
    case 'ads-negatives':
      return toCsv(['Campaign', 'Keyword', 'Criterion Type'], by('negative').map(k => [camp, k.keyword, k.matchType || 'Negative Phrase']));
    case 'negative-words':
      return toCsv(['Campaign', 'Keyword', 'Criterion Type'], suggestNegativeWords(rows, p.profile || { uni: {} }).map(w => [camp, w.word, 'Negative Broad']));
    default: throw new HttpError(400, 'Unknown export type.');
  }
}

/* ---------------- request handling ---------------- */

async function authRoutes(req, res, parts, json) {
  const ip = req.socket.remoteAddress || '';
  const sub = parts[1];
  if (sub === 'me' && req.method === 'GET') return json({ user: auth.userFromReq(req) });
  if (sub === 'register' && req.method === 'POST') {
    const r = auth.register(await readBody(req));
    res.setHeader('set-cookie', auth.cookie(r.token, auth.SESSION_MS / 1000));
    return json({ user: r.user, claimed: r.claimed }, 201);
  }
  if (sub === 'login' && req.method === 'POST') {
    const r = auth.login(await readBody(req), ip);
    res.setHeader('set-cookie', auth.cookie(r.token, auth.SESSION_MS / 1000));
    return json({ user: r.user });
  }
  if (sub === 'logout' && req.method === 'POST') {
    auth.endSession(req);
    res.setHeader('set-cookie', auth.cookie('', 0));
    return json({ ok: true });
  }
  throw new HttpError(404, 'Not found');
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;
  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  // A custom header cannot be added by a form on another site, which closes off cross-site posts.
  if (method !== 'GET' && method !== 'HEAD' && req.headers['x-csrf'] !== '1') throw new HttpError(403, 'Missing request header. Reload the page and try again.');

  if (parts[0] === 'config') {
    return json({ aiEnabled: openai.enabled(), maxKeywords: MAX_KEYWORDS, maxCompetitors: MAX_COMPETITORS, maxPages: MAX_SITE_PAGES, signupOpen: process.env.ALLOW_SIGNUP !== '0' || store.userCount() === 0 });
  }
  if (parts[0] === 'auth') return authRoutes(req, res, parts, json);

  const user = auth.userFromReq(req);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  if (parts[0] !== 'projects') throw new HttpError(404, 'Not found');

  if (parts.length === 1) {
    if (method === 'GET') return json(store.listFor(user.id).map(r => summary(r.project, r.role, r.ownerName, r.memberCount)));
    if (method === 'POST') {
      const b = await readBody(req);
      if (!String(b.name || '').trim()) throw new HttpError(400, 'Give the project a name.');
      const p = {
        id: store.id(), name: '', url: '', description: '', offerings: '', serviceArea: '', seeds: [], exclude: [], strictness: 'balanced', campaign: '',
        blockCompetitors: true, competitors: [], competitorBrands: [], batches: [],
        createdAt: new Date().toISOString(), profile: null, keywords: [],
      };
      applyFields(p, b);
      store.create(p, user.id);
      return json(publicProject(p, 'owner'), 201);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const pid = parts[1];
  const role = store.roleOf(pid, user.id);
  // Someone with no access gets the same answer as for a project that does not exist.
  if (!role) throw new HttpError(404, 'Project not found');
  const need = min => { if (RANK[role] < RANK[min]) throw new HttpError(403, min === 'owner' ? 'Only the project owner can do that.' : 'You have view-only access to this project.'); };
  const sub = parts[2];
  const send = (p, extra = {}, status = 200) => json({ ...extra, project: publicProject(p, role) }, status);

  if (!sub) {
    if (method === 'GET') return json(publicProject(load(pid), role));
    if (method === 'PUT') {
      need('editor');
      const p = load(pid);
      const b = await readBody(req);
      const before = JSON.stringify([p.exclude, p.strictness, p.blockCompetitors]);
      applyFields(p, b);
      if (JSON.stringify([p.exclude, p.strictness, p.blockCompetitors]) !== before) pipeline.rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
    if (method === 'DELETE') { need('owner'); store.remove(pid); return json({ ok: true }); }
  }

  // Cheap enough to poll every couple of seconds while AI is working.
  if (sub === 'status' && method === 'GET') {
    const p = load(pid);
    const busyAI = b => b.ai && (b.ai.status === 'running' || b.ai.status === 'queued');
    return json({
      analysis: p.analysis || null,
      batches: p.batches.map(b => ({ id: b.id, ai: b.ai, page: b.page ? { url: b.page.url, status: b.page.status, title: b.page.title, error: b.page.error } : undefined, counts: countsOf(p.keywords.filter(k => k.batchId === b.id)) })),
      busy: p.batches.some(busyAI) || Boolean(p.analysis && p.analysis.status === 'running'),
    });
  }

  // Reading the website takes a while (up to 50 pages), so it runs in the background and the page polls the status.
  if (sub === 'analyze' && method === 'POST') {
    need('editor');
    const b = await readBody(req);
    const p = load(pid);
    if (pipeline.isAnalyzing(pid)) throw new HttpError(409, 'The website is already being read. Wait for it to finish.');
    applyFields(p, b);
    if (!p.url && !p.description && !p.offerings && !p.seeds.length) throw new HttpError(400, 'Add a website address or describe what you sell first.');
    store.put(p); // keep what was typed even if reading the site fails
    pipeline.startAnalysis(pid);
    return json(publicProject(store.get(pid), role));
  }

  /* ----- uploads: every file or paste becomes its own upload ----- */
  if (sub === 'uploads') {
    const bid = parts[3];
    if (method === 'POST' && !bid) {
      need('editor');
      const b = await readBody(req);
      let parsed = extractKeywords(b.text);
      if (parsed.needsMapping && openai.enabled()) {
        try { parsed = extractKeywords(b.text, { mapping: await openai.mapColumns(parsed.sample) }); } catch { /* keep the first-column reading */ }
      }
      const { rows, note } = parsed;
      if (!rows.length) throw new HttpError(400, 'No keywords found in that file.');
      const pageUrl = String(b.pageUrl || '').trim() ? normalizeUrl(b.pageUrl) : '';
      const p = load(pid);
      const byKw = new Map(p.keywords.map(k => [k.keyword.toLowerCase(), k]));
      const fresh = [];
      let dupes = 0, updated = 0, overLimit = 0;
      for (const r of rows) {
        const have = byKw.get(r.keyword.toLowerCase());
        if (have) {
          // A later report for a keyword already held brings its results along.
          if (hasPerf(r) && !hasPerf(have)) { for (const f of ['impressions', 'clicks', 'cost', 'conversions', 'convValue', 'status']) if (r[f] != null) have[f] = r[f]; updated++; }
          else dupes++;
          continue;
        }
        if (fresh.length >= MAX_KEYWORDS || p.keywords.length + fresh.length >= MAX_PROJECT_KEYWORDS) { overLimit++; continue; }
        fresh.push(r);
      }
      if (!fresh.length && !updated) throw new HttpError(409, `Nothing new here. All ${dupes} keywords are already in this project.`);
      let batch = null;
      if (fresh.length) {
        const perf = fresh.some(hasPerf);
        const kind = perf ? 'Search terms report' : fresh.some(r => r.volume != null || r.bid != null || r.competition != null) ? 'Keyword tool export' : 'Keyword list';
        const stamp = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
        const name = String(b.name || '').trim() || String(b.filename || '').replace(/\.[a-z0-9]+$/i, '').trim() || `${kind} ${stamp}`;
        batch = pipeline.newBatch({ name: name.slice(0, 80), filename: String(b.filename || '').slice(0, 120), kind });
        if (pageUrl) batch.pageUrl = pageUrl;
        p.batches.push(batch);
        for (const r of fresh) p.keywords.push({ id: store.id(), batchId: batch.id, ...r });
      }
      pipeline.rescore(p);
      store.put(p);
      if (batch) pipeline.startAI(pid, batch.id);
      return send(load(pid), { batchId: batch && batch.id, added: fresh.length, duplicates: dupes, updated, overLimit, note });
    }
    if (bid && method === 'PATCH') {
      need('editor');
      const b = await readBody(req);
      const p = load(pid);
      const batch = p.batches.find(x => x.id === bid);
      if (!batch) throw new HttpError(404, 'Upload not found');
      if (b.name !== undefined) {
        const name = String(b.name || '').trim().slice(0, 80);
        if (!name) throw new HttpError(400, 'Give the upload a name.');
        batch.name = name;
      }
      let restart = false;
      if (b.pageUrl !== undefined) {
        const url = String(b.pageUrl || '').trim() ? normalizeUrl(b.pageUrl) : '';
        if ((batch.pageUrl || '') !== url) { batch.pageUrl = url || undefined; batch.page = undefined; restart = Boolean(openai.enabled() && p.profile); }
      }
      store.put(p);
      if (restart) pipeline.startAI(pid, bid);
      return json(publicProject(store.get(pid), role));
    }
    if (bid && method === 'DELETE') {
      need('editor');
      const p = load(pid);
      if (!p.batches.some(x => x.id === bid)) throw new HttpError(404, 'Upload not found');
      p.batches = p.batches.filter(x => x.id !== bid);
      p.keywords = p.keywords.filter(k => k.batchId !== bid);
      pipeline.rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
    if (bid && parts[4] === 'recheck' && method === 'POST') {
      need('editor');
      const p = load(pid);
      const batch = p.batches.find(x => x.id === bid);
      if (!batch) throw new HttpError(404, 'Upload not found');
      if (!openai.enabled()) throw new HttpError(409, 'Smart analysis is not switched on for this server. Add OPENAI_API_KEY and restart.');
      if (!p.profile) throw new HttpError(409, 'Read the business website first so the analysis knows what you sell.');
      if (pipeline.isRunning(pid, bid)) throw new HttpError(409, 'That upload is already being analysed.');
      pipeline.startAI(pid, bid);
      return json(publicProject(store.get(pid), role));
    }
  }

  if (sub === 'keyword' && parts[3]) {
    need('editor');
    const p = load(pid);
    const k = p.keywords.find(x => x.id === parts[3]);
    if (!k) throw new HttpError(404, 'Keyword not found');
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Unknown category');
      // Remember what the tool first said, so later AI runs can learn from the correction.
      if (!k.corrected && k.category !== b.category) k.corrected = { from: k.category || 'unsorted' };
      k.category = b.category;
      k.overridden = true;
      k.source = 'you';
      k.confidence = undefined;
      k.reason = 'Set by you';
      k.matchType = matchFor(k.keyword, b.category);
      pipeline.rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
    if (method === 'DELETE') {
      p.keywords = p.keywords.filter(x => x.id !== k.id);
      pipeline.rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  /* ----- competitors ----- */
  if (sub === 'competitors') {
    if (method === 'POST') {
      need('editor');
      const b = await readBody(req);
      const urls = splitList(b.urls).slice(0, MAX_COMPETITORS);
      if (!urls.length) throw new HttpError(400, 'Enter at least one competitor website.');
      const own = (() => { try { return new URL(load(pid).url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      const results = await Promise.allSettled(urls.map(crawlCompetitor));
      const found = [], failed = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && own && r.value.host.replace(/^www\./, '') === own) failed.push({ url: urls[i], error: 'That is your own website.' });
        else if (r.status === 'fulfilled') found.push(r.value);
        else failed.push({ url: urls[i], error: r.reason.message });
      });
      if (!found.length) throw new HttpError(422, 'Could not read any of those sites: ' + failed.map(f => f.url + ' (' + f.error + ')').join('; '));
      const p = load(pid);
      p.competitors = found;
      rebuildBrands(p);
      pipeline.rescore(p);
      store.put(p);
      return send(p, { failed });
    }
    if (method === 'DELETE' && parts[3]) {
      need('editor');
      const p = load(pid);
      p.competitors = (p.competitors || []).filter(c => c.id !== parts[3]);
      rebuildBrands(p);
      pipeline.rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  if (sub === 'brand' && method === 'PATCH') {
    need('editor');
    const b = await readBody(req);
    const p = load(pid);
    const br = (p.competitorBrands || []).find(x => x.phrase === b.phrase);
    if (!br) throw new HttpError(404, 'Brand not found');
    br.enabled = Boolean(b.enabled);
    pipeline.rescore(p);
    store.put(p);
    return json(publicProject(p, role));
  }

  /* ----- sharing ----- */
  if (sub === 'members') {
    const uid = parts[3];
    if (method === 'GET' && !uid) return json(store.members(pid));
    need('owner');
    const b = method === 'DELETE' ? {} : await readBody(req);
    if (method === 'POST' && !uid) {
      if (!['editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'Choose editor or viewer.');
      const target = auth.findByEmail(b.email);
      if (!target) throw new HttpError(404, 'There is no account with that email yet. Ask them to sign up first, then add them.');
      if (store.roleOf(pid, target.id) === 'owner') throw new HttpError(400, 'That person already owns this project.');
      store.setMember(pid, target.id, b.role);
      return json(store.members(pid));
    }
    if (uid && method === 'PATCH') {
      if (!['editor', 'viewer'].includes(b.role)) throw new HttpError(400, 'Choose editor or viewer.');
      if (store.roleOf(pid, uid) === 'owner') throw new HttpError(400, 'The owner role cannot be changed.');
      store.setMember(pid, uid, b.role);
      return json(store.members(pid));
    }
    if (uid && method === 'DELETE') {
      if (store.roleOf(pid, uid) === 'owner') throw new HttpError(400, 'The owner cannot be removed.');
      store.removeMember(pid, uid);
      return json(store.members(pid));
    }
  }
  if (sub === 'leave' && method === 'POST') {
    if (role === 'owner') throw new HttpError(400, 'Owners cannot leave. Delete the project instead.');
    store.removeMember(pid, user.id);
    return json({ ok: true });
  }

  if (sub === 'export' && method === 'GET') {
    const p = load(pid);
    const type = url.searchParams.get('type') || 'all';
    const bid = url.searchParams.get('batch') || '';
    const batch = bid ? p.batches.find(b => b.id === bid) : null;
    if (bid && !batch) throw new HttpError(404, 'Upload not found');
    const csv = csvFor(p, type, url.searchParams.get('campaign'), bid);
    const slug = (batch ? batch.name : p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${slug}-${type}.csv"`, 'cache-control': 'no-store' });
    return res.end(csv);
  }

  throw new HttpError(404, 'Not found');
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  if (file.endsWith('index.html')) {
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    return res.end(fs.readFileSync(file, 'utf8').replaceAll('%BASE%', BASE));
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  url.pathname = stripBase(url.pathname);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : e.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Keyword Selector running on http://localhost:${PORT}` + (openai.enabled() ? ' (OpenAI review on, model ' + openai.model() + ')' : ' (rules only, no OPENAI_API_KEY set)')));
}

module.exports = server;
