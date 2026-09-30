'use strict';

// The OpenAI calls are answered by a local stand-in. This checks the plumbing around the model
// (chunks, second opinions, locks, progress, errors). It says nothing about how accurate the real model is.
process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = 'test-key';
process.env.DATA_DIR = require('node:os').tmpdir() + '/ks-ai-' + process.pid;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const calls = [];
let queriesSeen = [];
const order = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    if (req.headers.authorization === 'Bearer bad') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    }
    const b = JSON.parse(body);
    const sys = b.messages[0].content, user = b.messages[1].content;
    const reply = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } })); };
    const lines = [...user.matchAll(/^(\d+)\. (.*?)(?: \[[^\]]*\])?$/gm)].map(m => ({ i: Number(m[1]), kw: m[2] }));
    if (/RE-CHECK/.test(sys)) {
      calls.push({ kind: 'verify', user, n: lines.length });
      return reply({ results: lines.map(l => /unsure/.test(l.kw)
        ? { i: l.i, label: 'priority', confidence: 40, intent: 'commercial', service: '', reason: 'still unclear' }
        : { i: l.i, label: 'relevant', confidence: 65, intent: 'commercial', service: '', reason: 'settled on second look' }) });
    }
    if (/study a business website/.test(sys)) {
      calls.push({ kind: 'catalogue', user });
      return reply({
        summary: 'Test summary of the business.',
        services: [{ name: 'NRI tax filing', page_url: 'https://site.test/services/nri-filing', what: 'Files income tax returns for NRIs', for_whom: 'NRIs abroad' }, { name: 'Property sale tax', page_url: 'https://site.test/services/property-tax', what: 'Tax planning on property sales', for_whom: 'NRIs selling property' }],
        not_offered: ['visa help'], areas_served: ['India'],
      });
    }
    if (/first rows of an exported spreadsheet/.test(sys)) {
      calls.push({ kind: 'columns', user });
      return reply({ header_row_index: -1, keyword_column: 0, volume_column: 1, competition_column: -1, bid_column: 2, impressions_column: -1, clicks_column: -1, cost_column: -1, conversions_column: -1 });
    }
    calls.push({ kind: 'judge', user, n: lines.length });
    queriesSeen.push(...lines.map(l => l.kw));
    if (lines.some(l => /slowkw/.test(l.kw))) { order.push('slow-start'); return setTimeout(() => { order.push('slow-end'); answer(); }, 500); }
    order.push('fast');
    answer();
    function answer() { reply({ results: lines.map(l => {
      const kw = l.kw;
      const svc = /property/.test(kw) ? 'Property sale tax' : /tax|nri/.test(kw) ? 'NRI tax filing' : '';
      if (/unsure/.test(kw)) return { i: l.i, label: 'relevant', confidence: 50, intent: 'commercial', service: '', reason: 'hard to say' };
      if (/jobs|salary/.test(kw)) return { i: l.i, label: 'negative', confidence: 96, intent: 'informational', service: '', reason: 'job seeker' };
      if (/tax|nri/.test(kw)) return { i: l.i, label: 'priority', confidence: 92, intent: 'commercial', service: svc, reason: 'wants tax help' };
      return { i: l.i, label: 'relevant', confidence: 80, intent: 'commercial', service: '', reason: 'related' };
    }) }); }
  });
});

const PAGE = (title, body, links = '') => `<html><head><title>${title}</title></head><body><h1>${title}</h1><h2>${body}</h2><p>${body} for non resident Indians.</p>${links}</body></html>`;
const siteServer = http.createServer((req, res) => {
  const out = html => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); };
  if (req.url === '/') return out(PAGE('NRI Tax Experts', 'Tax help for NRIs', '<a href="/services/nri-filing">f</a><a href="/services/property-tax">p</a>'));
  if (req.url === '/services/nri-filing') return out(PAGE('NRI tax filing service', 'We file income tax returns and claim refunds'));
  if (req.url === '/services/property-tax') return out(PAGE('Property sale tax for NRIs', 'Capital gains planning when an NRI sells property in India'));
  res.writeHead(404); res.end();
});

let server, base, cookie = '', pid, siteBase;
test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  await new Promise(r => siteServer.listen(0, r));
  siteBase = `http://127.0.0.1:${siteServer.address().port}`;
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  server = require('../server');
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); mock.close(); siteServer.close(); });

async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'x-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function settle() {
  await new Promise(r => setTimeout(r, 30));
  for (let i = 0; i < 100; i++) {
    const s = (await call('GET', `/projects/${pid}/status`)).data;
    if (!s.busy) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('AI job did not finish');
}

test('reading the site builds a stored service catalogue that the page can show', async () => {
  assert.equal((await call('GET', '/config')).data.aiEnabled, true);
  assert.equal((await call('GET', '/config')).data.maxPages, 50);
  await call('POST', '/auth/register', { email: 'o@x.test', name: 'O', password: 'longenough1' });
  pid = (await call('POST', '/projects', { name: 'NRI tax', url: siteBase, description: 'NRI tax consultancy in Mumbai', offerings: 'NRI tax filing', seeds: 'nri tax consultant', exclude: 'dyson', serviceArea: 'India' })).data.id;
  const r = await call('POST', `/projects/${pid}/analyze`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.analysis.status, 'running');
  await settle();
  const p = (await call('GET', `/projects/${pid}`)).data;
  assert.equal(p.analysis.status, 'done');
  assert.equal(p.analysis.pagesRead, 3);
  assert.equal(p.analysis.services, 2);
  assert.equal(p.profile.summary, 'Test summary of the business.');
  assert.deepEqual(p.profile.notOffered, ['visa help']);
  assert.deepEqual(p.profile.services.map(s => s.name), ['NRI tax filing', 'Property sale tax']);
  assert.ok(!('knowledge' in p), 'the stored page text is not sent to the browser');
  const cat = calls.find(c => c.kind === 'catalogue');
  assert.match(cat.user, /Pages read \(3\)/);
  assert.match(cat.user, /Property sale tax for NRIs/, 'the crawled page text reaches the model');
});

test('a large upload is checked in chunks, shaky answers get a second opinion, progress is visible', async () => {
  const kws = ['which is the best nri tax consultant in mumbai', 'nri tax filing jobs', 'dyson tax vacuum', 'unsure tax thing', 'zebra crossing safety', 'maybe unsure nri query'];
  for (let i = 0; i < 120; i++) kws.push('nri tax filing ' + i);
  const r = await call('POST', `/projects/${pid}/uploads`, { text: kws.join('\n'), filename: 'big.txt' });
  assert.equal(r.status, 200);
  const first = r.data.project.batches[0];
  assert.equal(first.ai.status, 'running');
  assert.equal(first.ai.stage, 'keywords');
  assert.equal(first.ai.total > 100, true);

  await settle();
  const p = (await call('GET', `/projects/${pid}`)).data;
  const b = p.batches[0];
  assert.equal(b.ai.status, 'done');
  assert.equal(b.ai.done, b.ai.total);
  const kw = Object.fromEntries(p.keywords.map(k => [k.keyword, k]));

  const best = kw['which is the best nri tax consultant in mumbai'];
  assert.equal(best.category, 'priority');
  assert.equal(best.source, 'ai');
  assert.equal(best.confidence, 92);
  assert.equal(kw['nri tax filing jobs'].category, 'negative');
  assert.equal(kw['zebra crossing safety'].category, 'relevant');

  assert.equal(kw['dyson tax vacuum'].category, 'negative', 'your exclusions beat the model');
  assert.equal(kw['dyson tax vacuum'].source, 'rules');
  assert.ok(!queriesSeen.includes('dyson tax vacuum'), 'locked keywords are not even sent');

  assert.equal(kw['unsure tax thing'].category, 'review', 'still unsure after the second look, so it goes to review');
  assert.match(kw['unsure tax thing'].reason, /^Unsure:/);
  assert.equal(kw['maybe unsure nri query'].category, 'review');

  assert.equal(best.service, 'NRI tax filing', 'each keyword is matched to a service from the site');
  const judgeCalls = calls.filter(c => c.kind === 'judge');
  assert.match(judgeCalls[0].user, /SERVICES ON THE WEBSITE[\s\S]*- NRI tax filing \(https:\/\/site.test\/services\/nri-filing\)/, 'the stored catalogue is part of every check');
  assert.match(judgeCalls[0].user, /WEBSITE PAGES CLOSEST TO THESE QUERIES[\s\S]*NRI tax filing service/, 'the closest stored pages are included');
  assert.ok(judgeCalls.length >= 2, 'more than 100 keywords means more than one call');
  assert.ok(judgeCalls.every(c => c.n <= 100));
  assert.ok(calls.some(c => c.kind === 'verify'), 'low confidence answers were re-checked');
});

test('results from the account and corrections from the owner shape later checks', async () => {
  const before = queriesSeen.length;
  const report = 'Search term,Clicks,Cost,Conv.\nnri tax return help,10,50,2\ncat food,3,4,0\n';
  const r = await call('POST', `/projects/${pid}/uploads`, { text: report + 'plain relevant thing\n', filename: 'terms.csv' });
  assert.equal(r.data.project.batches.find(b => b.id === r.data.batchId).kind, 'Search terms report');
  await settle();
  const p = (await call('GET', `/projects/${pid}`)).data;
  const conv = p.keywords.find(k => k.keyword === 'nri tax return help');
  assert.equal(conv.category, 'priority');
  assert.equal(conv.source, 'performance', 'a converting term is settled by the data');
  assert.ok(!queriesSeen.slice(before).includes('nri tax return help'));
  assert.ok(queriesSeen.slice(before).includes('cat food'), 'spend without results is still judged for fit');

  // The owner moves a keyword. The next check is told about it.
  const z = p.keywords.find(k => k.keyword === 'zebra crossing safety');
  await call('PATCH', `/projects/${pid}/keyword/${z.id}`, { category: 'negative' });
  await call('POST', `/projects/${pid}/uploads`, { text: 'another nri question', filename: 'next.txt' });
  await settle();
  const judge = calls.filter(c => c.kind === 'judge').pop();
  assert.match(judge.user, /OWNER CORRECTIONS/);
  assert.match(judge.user, /"zebra crossing safety" belongs in negative \(tool had said relevant\)/);
});

test('an unknown sheet layout is mapped by the model', async () => {
  const r = await call('POST', `/projects/${pid}/uploads`, { text: 'nri card renewal,320,4.1\nnri pan help,210,3.2\nnri tax deadline,90,2.5\n', filename: 'mystery.csv' });
  assert.equal(r.status, 200);
  await settle();
  const k = (await call('GET', `/projects/${pid}`)).data.keywords.find(x => x.keyword === 'nri card renewal');
  assert.equal(k.volume, 320);
  assert.equal(k.bid, 4.1);
  assert.ok(calls.some(c => c.kind === 'columns'));
});

test('a wrong key is reported plainly and the rules result is kept; re-check works once fixed', async () => {
  process.env.OPENAI_API_KEY = 'bad';
  const r = await call('POST', `/projects/${pid}/uploads`, { text: 'nri tax one\nnri tax two', filename: 'fails.txt' });
  await settle();
  const p = (await call('GET', `/projects/${pid}`)).data;
  const b = p.batches.find(x => x.id === r.data.batchId);
  assert.equal(b.ai.status, 'error');
  assert.match(b.ai.note, /rejected the API key/);
  const k = p.keywords.find(x => x.keyword === 'nri tax one');
  assert.ok(k.category, 'still sorted by the rules');
  assert.equal(k.source, 'rules');

  process.env.OPENAI_API_KEY = 'test-key';
  assert.equal((await call('POST', `/projects/${pid}/uploads/${b.id}/recheck`)).status, 200);
  await settle();
  const fixed = (await call('GET', `/projects/${pid}`)).data;
  assert.equal(fixed.batches.find(x => x.id === b.id).ai.status, 'done');
  assert.equal(fixed.keywords.find(x => x.keyword === 'nri tax one').source, 'ai');
});

test('editing the business marks earlier AI checks as out of date; a cut-short job is flagged', async () => {
  await call('POST', `/projects/${pid}/analyze`, { description: 'NRI tax consultancy in Mumbai and Pune' });
  await settle();
  const p = (await call('GET', `/projects/${pid}`)).data;
  assert.ok(p.batches.some(b => b.ai.status === 'done' && b.stale));

  const store = require('../lib/db');
  const raw = store.get(pid);
  raw.batches[0].ai = { status: 'running', done: 3, total: 10 };
  store.put(raw);
  const after = (await call('GET', `/projects/${pid}`)).data;
  assert.equal(after.batches[0].ai.status, 'interrupted');
});

test('the landing page for an upload is read and used, and a bad page does not stop the analysis', async () => {
  const r = await call('POST', `/projects/${pid}/uploads`, { text: 'nri capital gains on property\nnri property sale tax', name: 'Property page', pageUrl: siteBase + '/services/property-tax' });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.batches.find(b => b.id === r.data.batchId).pageUrl, siteBase + '/services/property-tax');
  await settle();
  const judge = calls.filter(c => c.kind === 'judge').pop();
  assert.match(judge.user, /LANDING PAGE FOR THIS UPLOAD\nURL: http:\/\/127\.0\.0\.1:\d+\/services\/property-tax\nTitle: Property sale tax for NRIs/);
  assert.match(judge.user, /Capital gains planning when an NRI sells property/);
  const p = (await call('GET', `/projects/${pid}`)).data;
  const b = p.batches.find(x => x.id === r.data.batchId);
  assert.equal(b.page.status, 'ok');
  assert.equal(b.page.title, 'Property sale tax for NRIs');
  assert.ok(!('text' in b.page), 'the page text is kept on the server');
  assert.equal(p.keywords.find(k => k.keyword === 'nri property sale tax').service, 'Property sale tax');

  const bad = await call('POST', `/projects/${pid}/uploads`, { text: 'nri return filing help', name: 'Broken page', pageUrl: siteBase + '/missing' });
  await settle();
  const p2 = (await call('GET', `/projects/${pid}`)).data;
  const b2 = p2.batches.find(x => x.id === bad.data.batchId);
  assert.equal(b2.ai.status, 'done');
  assert.match(b2.ai.note, /Could not read the landing page/);
  assert.equal(b2.page.status, 'error');
  assert.equal(p2.keywords.find(k => k.keyword === 'nri return filing help').source, 'ai');

  assert.equal((await call('POST', `/projects/${pid}/uploads`, { text: 'x y', pageUrl: 'not a url at all' })).status, 400);

  // Changing the landing page later analyses the upload again against the new page
  const moved = await call('PATCH', `/projects/${pid}/uploads/${bad.data.batchId}`, { pageUrl: siteBase + '/services/nri-filing' });
  assert.equal(moved.status, 200);
  await settle();
  const p3 = (await call('GET', `/projects/${pid}`)).data;
  assert.equal(p3.batches.find(x => x.id === bad.data.batchId).page.title, 'NRI tax filing service');
});

test('uploads wait in line, one at a time, and keep their order', async () => {
  order.length = 0;
  const a = await call('POST', `/projects/${pid}/uploads`, { text: 'slowkw nri one', name: 'Slow one' });
  const b = await call('POST', `/projects/${pid}/uploads`, { text: 'fastkw nri two', name: 'Fast one' });
  assert.equal(a.data.project.batches.find(x => x.id === a.data.batchId).ai.status, 'running');
  assert.equal(b.data.project.batches.find(x => x.id === b.data.batchId).ai.status, 'queued');
  await settle();
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast'], 'the second upload did not start until the first finished');
  const p = (await call('GET', `/projects/${pid}`)).data;
  assert.ok(p.batches.filter(x => ['Slow one', 'Fast one'].includes(x.name)).every(x => x.ai.status === 'done'));
});

test('a site that cannot be read is reported, and a cut-short read is flagged', async () => {
  const other = (await call('POST', '/projects', { name: 'Broken', url: siteBase + '/nothing-here' })).data.id;
  await call('POST', `/projects/${other}/analyze`, {});
  for (let i = 0; i < 50; i++) { const st = (await call('GET', `/projects/${other}/status`)).data; if (st.analysis.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  const p = (await call('GET', `/projects/${other}`)).data;
  assert.equal(p.analysis.status, 'error');
  assert.match(p.analysis.error, /Could not read the website/);
  assert.ok(!p.profile);

  const store = require('../lib/db');
  const raw = store.get(other);
  raw.analysis = { status: 'running', done: 4, total: 50 };
  store.put(raw);
  assert.equal((await call('GET', `/projects/${other}`)).data.analysis.status, 'interrupted');
});

test('every model call is recorded under the project owner with its token counts', async () => {
  const store = require('../lib/db');
  const owner = store.userByEmail('o@x.test');
  const rows = store.usageGroups('', owner.id);
  const kinds = new Set(rows.map(r => r.kind));
  assert.ok(kinds.has('catalogue') && kinds.has('judge'), [...kinds].join());
  const calls = rows.reduce((n, r) => n + r.calls - r.errors, 0); // failed calls carry no tokens
  assert.equal(rows.reduce((n, r) => n + r.prompt, 0), calls * 1000);
  assert.equal(rows.reduce((n, r) => n + r.cached, 0), calls * 100);
});
