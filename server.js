'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./lib/store');
const ai = require('./lib/ai');
const { crawlSite } = require('./lib/crawler');
const { buildProfile, splitList } = require('./lib/profile');
const { classifyAll, suggestNegativeWords, suggestAdGroups } = require('./lib/classifier');
const { extractKeywords, MAX_KEYWORDS } = require('./lib/sheet');
const { toCsv } = require('./lib/csv');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CATEGORIES = ['priority', 'relevant', 'review', 'negative'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 6 * 1024 * 1024) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); }
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
  if (b.seeds !== undefined) p.seeds = splitList(b.seeds).slice(0, 50);
  if (b.exclude !== undefined) p.exclude = splitList(b.exclude).slice(0, 100);
  if (b.strictness !== undefined) p.strictness = b.strictness === 'strict' ? 'strict' : 'balanced';
  if (b.campaign !== undefined) p.campaign = String(b.campaign).slice(0, 100);
}

function summary(p) {
  const counts = { priority: 0, relevant: 0, review: 0, negative: 0, unsorted: 0 };
  for (const k of p.keywords) counts[k.category || 'unsorted']++;
  return { id: p.id, name: p.name, url: p.url, updatedAt: p.updatedAt, analyzed: Boolean(p.profile), total: p.keywords.length, counts };
}

// The full profile weight tables are large and only useful server side.
function publicProject(p) {
  const { profile, ...rest } = p;
  const view = { ...rest, counts: summary(p).counts };
  if (profile) {
    view.profile = {
      builtAt: profile.builtAt, summary: profile.summary || '', topTerms: profile.topTerms, topPhrases: profile.topPhrases,
      aiOfferings: profile.aiOfferings || [], notOffered: profile.notOffered || [], pages: profile.pages || [], errors: profile.errors || [], aiNote: profile.aiNote || '',
    };
    view.negativeWords = suggestNegativeWords(p.keywords, profile);
    view.adGroups = suggestAdGroups(p.keywords, profile);
  }
  return view;
}

async function reclassify(p, useAI) {
  if (!p.profile) return '';
  classifyAll(p.keywords, p.profile, p);
  let note = '';
  if (useAI && ai.enabled()) {
    const border = p.keywords.filter(k => !k.overridden && (k.category === 'review' || (k.relevance >= 0.12 && k.relevance < 0.5))).slice(0, 400);
    const verdicts = await ai.judgeKeywords(p, p.profile, border);
    for (const k of border) {
      const v = verdicts.get(k.id);
      if (!v) continue;
      k.category = v.label;
      k.reason = 'AI: ' + (v.reason || v.label);
      k.aiChecked = true;
      k.matchType = v.label === 'negative' ? (k.keyword.includes(' ') ? 'Negative Phrase' : 'Negative Broad') : v.label === 'priority' ? (k.keyword.split(' ').length >= 3 ? 'Exact' : 'Phrase') : v.label === 'relevant' ? 'Phrase' : '';
    }
    note = verdicts.error ? 'AI check hit an error on some batches: ' + verdicts.error : 'AI reviewed ' + border.length + ' borderline keywords.';
  }
  return note;
}

function csvFor(p, type, campaign) {
  const groups = p.profile ? suggestAdGroups(p.keywords, p.profile) : [];
  const groupOf = new Map();
  groups.forEach(g => g.ids.forEach(i => groupOf.set(i, g.name)));
  const by = c => p.keywords.filter(k => k.category === c);
  const detail = ks => toCsv(
    ['Keyword', 'Category', 'Score', 'Intent', 'Suggested match type', 'Suggested ad group', 'Reason', 'Avg monthly searches', 'Competition', 'Bid'],
    ks.map(k => [k.keyword, k.category || '', k.score ?? '', k.intent || '', k.matchType || '', groupOf.get(k.id) || '', k.reason || '', k.volume ?? '', k.competition ?? '', k.bid ?? ''])
  );
  const camp = campaign || p.campaign || p.name;
  switch (type) {
    case 'all': return detail(p.keywords);
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
      return toCsv(['Campaign', 'Keyword', 'Criterion Type'], suggestNegativeWords(p.keywords, p.profile || { uni: {} }).map(w => [camp, w.word, 'Negative Broad']));
    default: throw new HttpError(400, 'Unknown export type.');
  }
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;
  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  if (parts[0] === 'config') return json({ aiEnabled: ai.enabled(), maxKeywords: MAX_KEYWORDS });

  if (parts[0] !== 'projects') throw new HttpError(404, 'Not found');

  if (parts.length === 1) {
    if (method === 'GET') return json(store.list().map(summary));
    if (method === 'POST') {
      const b = await readBody(req);
      if (!String(b.name || '').trim()) throw new HttpError(400, 'Give the project a name.');
      const p = { id: store.id(), name: '', url: '', description: '', offerings: '', seeds: [], exclude: [], strictness: 'balanced', campaign: '', createdAt: new Date().toISOString(), profile: null, keywords: [] };
      applyFields(p, b);
      store.put(p);
      return json(publicProject(p), 201);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const p = store.get(parts[1]);
  if (!p) throw new HttpError(404, 'Project not found');
  const sub = parts[2];

  if (!sub) {
    if (method === 'GET') return json(publicProject(p));
    if (method === 'PUT') {
      const b = await readBody(req);
      const before = JSON.stringify([p.exclude, p.strictness]);
      applyFields(p, b);
      if (JSON.stringify([p.exclude, p.strictness]) !== before) await reclassify(p, false);
      store.put(p);
      return json(publicProject(p));
    }
    if (method === 'DELETE') { store.remove(p.id); return json({ ok: true }); }
  }

  if (sub === 'analyze' && method === 'POST') {
    const b = await readBody(req);
    applyFields(p, b);
    if (!p.url && !p.description && !p.offerings && !p.seeds.length) throw new HttpError(400, 'Add a website address or describe what you sell first.');
    let pages = [], errors = [];
    if (p.url) {
      try { ({ pages, errors } = await crawlSite(p.url)); }
      catch (e) {
        if (!p.description && !p.offerings && !p.seeds.length) throw new HttpError(422, 'Could not read the website (' + e.message + '). Describe the business below and try again.');
        errors = [{ url: p.url, error: e.message }];
      }
    }
    let extraTerms = [], aiInfo = {}, aiNote = '';
    if (ai.enabled() && (pages.length || p.description)) {
      try {
        aiInfo = await ai.describeBusiness(p, pages);
        extraTerms = aiInfo.offerings;
      } catch (e) { aiNote = 'AI summary skipped: ' + e.message; }
    }
    const profile = buildProfile({ project: p, pages, extraTerms });
    profile.summary = aiInfo.summary || '';
    profile.aiOfferings = aiInfo.offerings || [];
    profile.notOffered = aiInfo.notOffered || [];
    profile.aiNote = aiNote;
    profile.pages = pages.map(pg => ({ url: pg.url, title: pg.title, words: pg.text.split(' ').length }));
    profile.errors = errors;
    if (!profile.topTerms.length) throw new HttpError(422, 'Not enough readable text to build a profile. Add a description or a few seed keywords.');
    p.profile = profile;
    await reclassify(p, false);
    store.put(p);
    return json(publicProject(p));
  }

  if (sub === 'keywords') {
    if (method === 'POST') {
      const b = await readBody(req);
      const { rows, skipped, note } = extractKeywords(b.text);
      if (!rows.length) throw new HttpError(400, 'No keywords found in that input.');
      const have = new Set(p.keywords.map(k => k.keyword.toLowerCase()));
      let added = 0, dupes = 0, overLimit = 0;
      for (const r of rows) {
        if (have.has(r.keyword.toLowerCase())) { dupes++; continue; }
        if (p.keywords.length >= MAX_KEYWORDS) { overLimit++; continue; }
        p.keywords.push({ id: store.id(), ...r });
        have.add(r.keyword.toLowerCase());
        added++;
      }
      await reclassify(p, false);
      store.put(p);
      return json({ added, duplicates: dupes + skipped, overLimit, note, project: publicProject(p) });
    }
    if (method === 'DELETE') {
      p.keywords = [];
      store.put(p);
      return json(publicProject(p));
    }
  }

  if (sub === 'keywords' || sub === 'classify') {
    if (sub === 'classify' && method === 'POST') {
      if (!p.profile) throw new HttpError(409, 'Analyze the project first so there is something to compare against.');
      const b = await readBody(req);
      if (b.reset) p.keywords.forEach(k => { delete k.overridden; });
      const note = await reclassify(p, Boolean(b.useAI));
      store.put(p);
      return json({ note, project: publicProject(p) });
    }
  }

  if (sub === 'keyword' && parts[3]) {
    const k = p.keywords.find(x => x.id === parts[3]);
    if (!k) throw new HttpError(404, 'Keyword not found');
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Unknown category');
      k.category = b.category;
      k.overridden = true;
      k.reason = 'Set by you';
      k.matchType = b.category === 'negative' ? (k.keyword.includes(' ') ? 'Negative Phrase' : 'Negative Broad') : b.category === 'priority' ? (k.keyword.split(' ').length >= 3 ? 'Exact' : 'Phrase') : b.category === 'relevant' ? 'Phrase' : '';
      store.put(p);
      return json(publicProject(p));
    }
    if (method === 'DELETE') {
      p.keywords = p.keywords.filter(x => x.id !== k.id);
      store.put(p);
      return json(publicProject(p));
    }
  }

  if (sub === 'export' && method === 'GET') {
    const type = url.searchParams.get('type') || 'all';
    const csv = csvFor(p, type, url.searchParams.get('campaign'));
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${slug}-${type}.csv"` });
    return res.end(csv);
  }

  throw new HttpError(404, 'Not found');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
  server.listen(PORT, () => console.log(`Keyword Sieve running on http://localhost:${PORT}` + (ai.enabled() ? ' (AI review on)' : ' (offline scoring only)')));
}

module.exports = server;
