'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./lib/db');
const auth = require('./lib/auth');
const ai = require('./lib/ai');
const { crawlSite } = require('./lib/crawler');
const { buildProfile, splitList } = require('./lib/profile');
const { classifyAll, classifyOne, buildOpts, suggestNegativeWords, suggestAdGroups } = require('./lib/classifier');
const { analyzeTerms, ACTIONS } = require('./lib/searchterms');
const { crawlCompetitor, findGaps, MAX_COMPETITORS } = require('./lib/competitors');
const { extractKeywords, MAX_KEYWORDS } = require('./lib/sheet');
const { toCsv } = require('./lib/csv');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CATEGORIES = ['priority', 'relevant', 'review', 'negative'];
const RANK = { viewer: 1, editor: 2, owner: 3 };
const MAX_TERMS = 5000;
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
  if (b.seeds !== undefined) p.seeds = splitList(b.seeds).slice(0, 50);
  if (b.exclude !== undefined) p.exclude = splitList(b.exclude).slice(0, 100);
  if (b.strictness !== undefined) p.strictness = b.strictness === 'strict' ? 'strict' : 'balanced';
  if (b.blockCompetitors !== undefined) p.blockCompetitors = Boolean(b.blockCompetitors);
  if (b.campaign !== undefined) p.campaign = String(b.campaign).slice(0, 100);
}

const matchFor = (k, cat) => cat === 'negative' ? (k.keyword.includes(' ') ? 'Negative Phrase' : 'Negative Broad')
  : cat === 'priority' ? (k.keyword.split(' ').length >= 3 ? 'Exact' : 'Phrase') : cat === 'relevant' ? 'Phrase' : '';

function summary(p, role, ownerName, memberCount) {
  const counts = { priority: 0, relevant: 0, review: 0, negative: 0, unsorted: 0 };
  for (const k of p.keywords) counts[k.category || 'unsorted']++;
  return { id: p.id, name: p.name, url: p.url, updatedAt: p.updatedAt, analyzed: Boolean(p.profile), total: p.keywords.length, counts, role, ownerName, shared: memberCount > 1 };
}

// The full profile weight tables are large and only useful server side.
function publicProject(p, role) {
  const { profile, competitors = [], ...rest } = p;
  const view = { ...rest, role, counts: summary(p).counts, searchTerms: p.searchTerms || [], stSummary: p.stSummary || null };
  view.competitors = competitors.map(c => ({ id: c.id, url: c.url, name: c.name, host: c.host, pages: c.pages, errors: c.errors, crawledAt: c.crawledAt }));
  view.brands = p.competitorBrands || [];
  view.blockCompetitors = p.blockCompetitors !== false;
  if (profile) {
    view.profile = {
      builtAt: profile.builtAt, summary: profile.summary || '', topTerms: profile.topTerms, topPhrases: profile.topPhrases,
      aiOfferings: profile.aiOfferings || [], notOffered: profile.notOffered || [], pages: profile.pages || [], errors: profile.errors || [], aiNote: profile.aiNote || '',
    };
    view.negativeWords = suggestNegativeWords(p.keywords, profile);
    view.adGroups = suggestAdGroups(p.keywords, profile);
    view.gaps = findGaps(competitors, profile);
  }
  return view;
}

// Local scoring for keywords and search terms. Synchronous, so it can run on a freshly loaded project.
function rescore(p) {
  if (!p.profile) return;
  classifyAll(p.keywords, p.profile, p);
  if (p.searchTerms && p.searchTerms.length) p.stSummary = analyzeTerms(p.searchTerms, p.profile, p);
}

async function aiReview(pid) {
  const p = store.get(pid);
  const border = p.keywords.filter(k => !k.overridden && (k.category === 'review' || (k.relevance >= 0.12 && k.relevance < 0.5))).slice(0, 400);
  const verdicts = await ai.judgeKeywords(p, p.profile, border);
  // The model call is slow, so apply the verdicts to the current copy of the project.
  const fresh = store.get(pid);
  for (const b of border) {
    const v = verdicts.get(b.id);
    const k = fresh.keywords.find(x => x.id === b.id);
    if (!v || !k || k.overridden) continue;
    k.category = v.label;
    k.reason = 'AI: ' + (v.reason || v.label);
    k.aiChecked = true;
    k.matchType = matchFor(k, v.label);
  }
  store.put(fresh);
  return verdicts.error ? 'AI check hit an error on some batches: ' + verdicts.error : 'AI reviewed ' + border.length + ' borderline keywords.';
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

function csvFor(p, type, campaign) {
  const groups = p.profile ? suggestAdGroups(p.keywords, p.profile) : [];
  const groupOf = new Map();
  groups.forEach(g => g.ids.forEach(i => groupOf.set(i, g.name)));
  const by = c => p.keywords.filter(k => k.category === c);
  const terms = a => (p.searchTerms || []).filter(t => t.action === a);
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
    case 'st-negatives':
      return toCsv(['Campaign', 'Keyword', 'Criterion Type'], terms('block').map(t => [camp, t.term, t.matchType || 'Negative Exact']));
    case 'st-winners':
      return toCsv(['Campaign', 'Ad Group', 'Keyword', 'Criterion Type', 'Status'], terms('add').map(t => [camp, 'Search term winners', t.term, t.matchType || 'Phrase', 'Enabled']));
    case 'st-all':
      return toCsv(['Search term', 'Action', 'Suggested match type', 'Why', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'Fit to your offer'],
        (p.searchTerms || []).map(t => [t.term, t.action, t.matchType || '', t.reason || '', t.impressions ?? '', t.clicks ?? '', t.cost ?? '', t.conversions ?? '', t.fit || '']));
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

  if (parts[0] === 'config') return json({ aiEnabled: ai.enabled(), maxKeywords: MAX_KEYWORDS, maxCompetitors: MAX_COMPETITORS, signupOpen: process.env.ALLOW_SIGNUP !== '0' || store.userCount() === 0 });
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
        id: store.id(), name: '', url: '', description: '', offerings: '', seeds: [], exclude: [], strictness: 'balanced', campaign: '',
        blockCompetitors: true, competitors: [], competitorBrands: [], searchTerms: [], stSummary: null,
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
    if (method === 'GET') return json(publicProject(store.get(pid), role));
    if (method === 'PUT') {
      need('editor');
      const p = store.get(pid);
      const b = await readBody(req);
      const before = JSON.stringify([p.exclude, p.strictness, p.blockCompetitors]);
      applyFields(p, b);
      if (JSON.stringify([p.exclude, p.strictness, p.blockCompetitors]) !== before) rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
    if (method === 'DELETE') { need('owner'); store.remove(pid); return json({ ok: true }); }
  }

  if (sub === 'analyze' && method === 'POST') {
    need('editor');
    const b = await readBody(req);
    const p0 = store.get(pid);
    applyFields(p0, b);
    store.put(p0); // keep what was typed even if the crawl fails
    if (!p0.url && !p0.description && !p0.offerings && !p0.seeds.length) throw new HttpError(400, 'Add a website address or describe what you sell first.');
    let pages = [], errors = [];
    if (p0.url) {
      try { ({ pages, errors } = await crawlSite(p0.url)); }
      catch (e) {
        if (!p0.description && !p0.offerings && !p0.seeds.length) throw new HttpError(422, 'Could not read the website (' + e.message + '). Describe the business below and try again.');
        errors = [{ url: p0.url, error: e.message }];
      }
    }
    let extraTerms = [], aiInfo = {}, aiNote = '';
    if (ai.enabled() && (pages.length || p0.description)) {
      try { aiInfo = await ai.describeBusiness(p0, pages); extraTerms = aiInfo.offerings; }
      catch (e) { aiNote = 'AI summary skipped: ' + e.message; }
    }
    const p = store.get(pid); // reload: teammates may have edited while the crawl ran
    const profile = buildProfile({ project: p, pages, extraTerms });
    profile.summary = aiInfo.summary || '';
    profile.aiOfferings = aiInfo.offerings || [];
    profile.notOffered = aiInfo.notOffered || [];
    profile.aiNote = aiNote;
    profile.pages = pages.map(pg => ({ url: pg.url, title: pg.title, words: pg.text.split(' ').length }));
    profile.errors = errors;
    if (!profile.topTerms.length) throw new HttpError(422, 'Not enough readable text to build a profile. Add a description or a few seed keywords.');
    p.profile = profile;
    rescore(p);
    store.put(p);
    return json(publicProject(p, role));
  }

  if (sub === 'keywords') {
    if (method === 'POST') {
      need('editor');
      const b = await readBody(req);
      const { rows, skipped, note } = extractKeywords(b.text);
      if (!rows.length) throw new HttpError(400, 'No keywords found in that input.');
      const p = store.get(pid);
      const have = new Set(p.keywords.map(k => k.keyword.toLowerCase()));
      let added = 0, dupes = 0, overLimit = 0;
      for (const r of rows) {
        if (have.has(r.keyword.toLowerCase())) { dupes++; continue; }
        if (p.keywords.length >= MAX_KEYWORDS) { overLimit++; continue; }
        p.keywords.push({ id: store.id(), ...r });
        have.add(r.keyword.toLowerCase());
        added++;
      }
      rescore(p);
      store.put(p);
      return send(p, { added, duplicates: dupes + skipped, overLimit, note });
    }
    if (method === 'DELETE') {
      need('editor');
      const p = store.get(pid);
      p.keywords = [];
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  if (sub === 'classify' && method === 'POST') {
    need('editor');
    const p = store.get(pid);
    if (!p.profile) throw new HttpError(409, 'Analyze the project first so there is something to compare against.');
    const b = await readBody(req);
    if (b.reset) { p.keywords.forEach(k => { delete k.overridden; }); (p.searchTerms || []).forEach(t => { delete t.overridden; }); }
    rescore(p);
    store.put(p);
    const note = b.useAI && ai.enabled() ? await aiReview(pid) : '';
    return send(store.get(pid), { note });
  }

  if (sub === 'keyword' && parts[3]) {
    need('editor');
    const p = store.get(pid);
    const k = p.keywords.find(x => x.id === parts[3]);
    if (!k) throw new HttpError(404, 'Keyword not found');
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Unknown category');
      k.category = b.category;
      k.overridden = true;
      k.reason = 'Set by you';
      k.matchType = matchFor(k, b.category);
      store.put(p);
      return json(publicProject(p, role));
    }
    if (method === 'DELETE') {
      p.keywords = p.keywords.filter(x => x.id !== k.id);
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  /* ----- search terms report ----- */
  if (sub === 'searchterms') {
    if (method === 'POST' && parts[3] === 'add-winners') {
      need('editor');
      const p = store.get(pid);
      if (!p.profile) throw new HttpError(409, 'Analyze the project first.');
      const opts = buildOpts(p.profile, p);
      const have = new Set(p.keywords.map(k => k.keyword.toLowerCase()));
      let added = 0, skipped = 0;
      for (const t of p.searchTerms || []) {
        if (t.action !== 'add') continue;
        if (have.has(t.term.toLowerCase())) { t.status = 'Added'; continue; }
        if (p.keywords.length >= MAX_KEYWORDS) { skipped++; continue; }
        const row = { id: store.id(), keyword: t.term, impressions: t.impressions, clicks: t.clicks, cost: t.cost, conversions: t.conversions };
        Object.assign(row, classifyOne(row, p.profile, opts), { category: 'priority', overridden: true, reason: 'Converted in your campaign', source: 'search terms' });
        row.matchType = matchFor(row, 'priority');
        p.keywords.push(row);
        have.add(t.term.toLowerCase());
        t.status = 'Added';
        added++;
      }
      rescore(p);
      store.put(p);
      return send(p, { added, skipped });
    }
    if (method === 'POST') {
      need('editor');
      const b = await readBody(req);
      const { rows, note } = extractKeywords(b.text, { aggregate: true });
      if (!rows.length) throw new HttpError(400, 'No search terms found in that input.');
      if (!rows.some(r => r.clicks != null || r.cost != null)) throw new HttpError(400, 'No Clicks or Cost columns found. Export the "Search terms" report from Google Ads (Insights and reports, then Search terms), not the Keywords list.');
      const p = store.get(pid);
      p.searchTerms = rows.slice(0, MAX_TERMS).map(r => ({
        id: store.id(), term: r.keyword, impressions: r.impressions, clicks: r.clicks, cost: r.cost, conversions: r.conversions, convValue: r.convValue, status: r.status,
      }));
      p.stMeta = { importedAt: new Date().toISOString(), note, truncated: rows.length > MAX_TERMS };
      p.stSummary = analyzeTerms(p.searchTerms, p.profile, p);
      store.put(p);
      return send(p, { imported: p.searchTerms.length, note });
    }
    if (method === 'DELETE') {
      need('editor');
      const p = store.get(pid);
      p.searchTerms = []; p.stSummary = null; p.stMeta = null;
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  if (sub === 'searchterm' && parts[3] && method === 'PATCH') {
    need('editor');
    const b = await readBody(req);
    if (!ACTIONS.includes(b.action)) throw new HttpError(400, 'Unknown action');
    const p = store.get(pid);
    const t = (p.searchTerms || []).find(x => x.id === parts[3]);
    if (!t) throw new HttpError(404, 'Search term not found');
    t.action = b.action;
    t.overridden = true;
    t.reason = 'Set by you';
    t.matchType = b.action === 'block' ? 'Negative Exact' : b.action === 'add' ? (t.term.split(' ').length >= 3 ? 'Exact' : 'Phrase') : '';
    p.stSummary = analyzeTerms(p.searchTerms, p.profile, p);
    store.put(p);
    return json(publicProject(p, role));
  }

  /* ----- competitors ----- */
  if (sub === 'competitors') {
    if (method === 'POST') {
      need('editor');
      const b = await readBody(req);
      const urls = splitList(b.urls).slice(0, MAX_COMPETITORS);
      if (!urls.length) throw new HttpError(400, 'Enter at least one competitor website.');
      const own = (() => { try { return new URL(store.get(pid).url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      const results = await Promise.allSettled(urls.map(crawlCompetitor));
      const found = [], failed = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && own && r.value.host.replace(/^www\./, '') === own) failed.push({ url: urls[i], error: 'That is your own website.' });
        else if (r.status === 'fulfilled') found.push(r.value);
        else failed.push({ url: urls[i], error: r.reason.message });
      });
      if (!found.length) throw new HttpError(422, 'Could not read any of those sites: ' + failed.map(f => f.url + ' (' + f.error + ')').join('; '));
      const p = store.get(pid);
      p.competitors = found;
      rebuildBrands(p);
      rescore(p);
      store.put(p);
      return send(p, { failed });
    }
    if (method === 'DELETE' && parts[3]) {
      need('editor');
      const p = store.get(pid);
      p.competitors = (p.competitors || []).filter(c => c.id !== parts[3]);
      rebuildBrands(p);
      rescore(p);
      store.put(p);
      return json(publicProject(p, role));
    }
  }

  if (sub === 'brand' && method === 'PATCH') {
    need('editor');
    const b = await readBody(req);
    const p = store.get(pid);
    const br = (p.competitorBrands || []).find(x => x.phrase === b.phrase);
    if (!br) throw new HttpError(404, 'Brand not found');
    br.enabled = Boolean(b.enabled);
    rescore(p);
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
    const p = store.get(pid);
    const type = url.searchParams.get('type') || 'all';
    const csv = csvFor(p, type, url.searchParams.get('campaign'));
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
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
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
  server.listen(PORT, () => console.log(`Keyword Sieve running on http://localhost:${PORT}` + (ai.enabled() ? ' (AI review on)' : ' (offline scoring only)')));
}

module.exports = server;
