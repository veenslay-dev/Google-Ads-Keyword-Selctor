'use strict';

process.env.DB_PATH = ':memory:';
process.env.ALLOW_PRIVATE_HOSTS = '1';
process.env.DATA_DIR = require('node:os').tmpdir() + '/ks-test-' + process.pid;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const server = require('../server');

const OWN = `<html><head><title>Brightside Plumbing Leeds | Emergency Plumber</title><meta name="description" content="Emergency plumber in Leeds. Boiler installation, blocked drains, central heating repair."></head>
<body><h1>Emergency plumber in Leeds</h1><h2>Boiler installation</h2><h2>Central heating repair</h2><h2>Blocked drain unblocking</h2>
<p>Brightside Plumbing fits boilers and repairs central heating across Leeds.</p></body></html>`;
const COMP = `<html><head><title>Boiler Service Plans | Zenith Heating</title><meta property="og:site_name" content="Zenith Heating"></head>
<body><h1>Boiler service plans</h1><h2>Annual boiler service plan</h2><h2>Gas safety certificates</h2><h2>Boiler installation</h2><h2>Powerflush heating systems</h2><h2>Our team</h2></body></html>`;

const REPORT = `Search terms report
1 January 2026 - 31 March 2026

Search term,Match type,Added/Excluded,Campaign,Impr.,Clicks,Cost,Conv.
emergency plumber leeds,Exact match,Added,C1,900,120,600.00,12
emergency plumber leeds,Exact match,Added,C2,100,10,40,1
plumber jobs leeds,Broad match,None,C1,50,4,12.50,0
boiler installation cost,Phrase match,None,C1,400,60,300,0
combi boiler service,Broad match,None,C1,80,5,20,0
leak repair leeds,Phrase match,None,C1,60,3,15,1
already blocked thing,Broad match,Excluded,C1,10,1,2,0
"Total: Search terms",,,,1600,203,989.5,14
`;

let base, siteA, siteB;
const serve = html => new Promise(r => { const s = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }); s.listen(0, () => r(s)); });

test.before(async () => {
  siteA = await serve(OWN);
  siteB = await serve(COMP);
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); siteA.close(); siteB.close(); });

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'x-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const sitePort = s => s.address().port;
async function analysed(c, id) {
  for (let i = 0; i < 100; i++) {
    const st = (await c('GET', `/projects/${id}/status`)).data;
    if (!st.analysis || st.analysis.status !== 'running') return st.analysis;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('analysis did not finish');
}
let owner, editor, viewer, stranger, pid;

test('sign-up, login and access control', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/projects')).status, 401);
  const noCsrf = await fetch(base + '/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(noCsrf.status, 403);

  owner = client(); editor = client(); viewer = client(); stranger = client();
  for (const [c, n] of [[owner, 'Olive'], [editor, 'Ed'], [viewer, 'Vic'], [stranger, 'Sam']]) {
    const r = await c('POST', '/auth/register', { email: n.toLowerCase() + '@agency.test', name: n, password: 'correct horse' });
    assert.equal(r.status, 201);
  }
  assert.equal((await client()('POST', '/auth/register', { email: 'olive@agency.test', name: 'X', password: 'correct horse' })).status, 409);
  assert.equal((await client()('POST', '/auth/register', { email: 'a@b.test', name: 'X', password: 'short' })).status, 400);
  const bad = client();
  assert.equal((await bad('POST', '/auth/login', { email: 'olive@agency.test', password: 'wrong wrong' })).status, 401);
  assert.equal((await bad('POST', '/auth/login', { email: 'olive@agency.test', password: 'correct horse' })).status, 200);
  assert.equal((await bad('GET', '/auth/me')).data.user.email, 'olive@agency.test');
  await bad('POST', '/auth/logout');
  assert.equal((await bad('GET', '/projects')).status, 401);
});

test('projects are private until shared, and roles are enforced', async () => {
  const created = await owner('POST', '/projects', {
    name: 'Brightside', url: `http://127.0.0.1:${sitePort(siteA)}`, description: 'Plumber in Leeds', seeds: 'emergency plumber leeds\nboiler installation',
  });
  assert.equal(created.status, 201);
  pid = created.data.id;
  const started = await owner('POST', `/projects/${pid}/analyze`, {});
  assert.equal(started.status, 200);
  assert.equal(started.data.analysis.status, 'running', 'the page is answered at once while the site is read in the background');
  assert.equal((await owner('POST', `/projects/${pid}/analyze`, {})).status, 409, 'a second run is refused while one is going');
  const done = await analysed(owner, pid);
  assert.equal(done.status, 'done');
  assert.ok(done.pagesRead >= 1);
  assert.ok((await owner('GET', `/projects/${pid}`)).data.profile.topTerms.length > 0);

  assert.equal((await stranger('GET', `/projects/${pid}`)).status, 404);
  assert.deepEqual((await stranger('GET', '/projects')).data, []);

  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'nobody@agency.test', role: 'editor' })).status, 404);
  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'ed@agency.test', role: 'editor' })).status, 200);
  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'vic@agency.test', role: 'viewer' })).status, 200);

  assert.equal((await viewer('GET', `/projects/${pid}`)).data.role, 'viewer');
  assert.equal((await viewer('POST', `/projects/${pid}/uploads`, { text: 'boiler repair' })).status, 403);
  assert.equal((await viewer('PUT', `/projects/${pid}`, { name: 'Hacked' })).status, 403);
  assert.equal((await viewer('GET', `/projects/${pid}/export?type=all`)).status, 200);

  const add = await editor('POST', `/projects/${pid}/uploads`, { text: 'boiler repair leeds\nplumber jobs', filename: 'day-1.csv' });
  assert.equal(add.status, 200);
  assert.equal(add.data.added, 2);
  assert.equal((await editor('DELETE', `/projects/${pid}`)).status, 403);
  assert.equal((await editor('POST', `/projects/${pid}/members`, { email: 'sam@agency.test', role: 'viewer' })).status, 403);

  assert.equal((await stranger('GET', '/projects')).data.length, 0);
  assert.equal((await viewer('GET', '/projects')).data[0].role, 'viewer');
  assert.equal((await owner('GET', `/projects/${pid}`)).data.keywords.length, 2);

  const members = (await owner('GET', `/projects/${pid}/members`)).data;
  assert.equal((await owner('DELETE', `/projects/${pid}/members/${members.find(m => m.email === 'vic@agency.test').userId}`)).status, 200);
  assert.equal((await viewer('GET', `/projects/${pid}`)).status, 404);
});

test('each upload is its own file, and daily uploads do not repeat keywords', async () => {
  const p1 = (await owner('GET', `/projects/${pid}`)).data;
  assert.equal(p1.batches.length, 1);
  assert.equal(p1.batches[0].name, 'day-1');
  assert.equal(p1.batches[0].kind, 'Keyword list');

  const day2 = await owner('POST', `/projects/${pid}/uploads`, { text: 'boiler repair leeds\ncombi boiler installation\nblocked drain leeds', filename: 'day-2.txt' });
  assert.equal(day2.data.added, 2);
  assert.equal(day2.data.duplicates, 1, 'the keyword already held on day 1 is not added again');
  assert.equal(day2.data.project.batches.length, 2);

  const again = await owner('POST', `/projects/${pid}/uploads`, { text: 'boiler repair leeds\ncombi boiler installation' });
  assert.equal(again.status, 409);

  const only2 = (await owner('GET', `/projects/${pid}/export?type=all&batch=${day2.data.batchId}`)).data;
  assert.match(only2, /combi boiler installation/);
  assert.doesNotMatch(only2, /plumber jobs/);
  const everything = (await owner('GET', `/projects/${pid}/export?type=all`)).data;
  assert.match(everything, /plumber jobs/);
  assert.equal((await owner('GET', `/projects/${pid}/export?type=all&batch=nope`)).status, 404);

  const renamed = await owner('PATCH', `/projects/${pid}/uploads/${day2.data.batchId}`, { name: 'Tuesday additions' });
  assert.equal(renamed.data.batches.find(b => b.id === day2.data.batchId).name, 'Tuesday additions');

  const gone = await owner('DELETE', `/projects/${pid}/uploads/${day2.data.batchId}`);
  assert.equal(gone.data.batches.length, 1);
  assert.ok(!gone.data.keywords.some(k => k.keyword === 'combi boiler installation'));
});

test('a search terms report goes through the same upload, and real results outrank wording', async () => {
  const r = await owner('POST', `/projects/${pid}/uploads`, { text: REPORT, filename: 'search-terms-march.csv' });
  assert.equal(r.status, 200);
  const batch = r.data.project.batches.find(b => b.id === r.data.batchId);
  assert.equal(batch.kind, 'Search terms report');
  const kw = Object.fromEntries(r.data.project.keywords.map(k => [k.keyword, k]));

  assert.equal(kw['emergency plumber leeds'].clicks, 130, 'same term in two campaigns is added up');
  assert.equal(kw['emergency plumber leeds'].cost, 640);
  assert.equal(kw['emergency plumber leeds'].category, 'priority');
  assert.equal(kw['emergency plumber leeds'].reason, 'Converts and is already a keyword');
  assert.equal(kw['plumber jobs leeds'].category, 'negative');
  assert.equal(kw['plumber jobs leeds'].reason, 'Job seekers');
  assert.match(kw['plumber jobs leeds'].note, /4 clicks and 12.5 spent/);
  assert.equal(kw['boiler installation cost'].category, 'negative', '60 clicks and nothing, on an account that converts well');
  assert.equal(kw['boiler installation cost'].matchType, 'Negative Exact');
  assert.notEqual(kw['combi boiler service'].category, 'negative');
  assert.match(kw['combi boiler service'].note, /needed to judge/);
  assert.equal(kw['leak repair leeds'].category, 'priority');
  assert.match(kw['leak repair leeds'].reason, /^Converted/);
  assert.equal(kw['already blocked thing'].category, 'negative');
  assert.ok(!kw['Total: Search terms'], 'totals row skipped');

  const s = r.data.project.perfSummary;
  assert.equal(s.wasteCount, 3);
  assert.equal(s.wasteCost, 314.5);
  assert.equal(s.winners, 2);

  // A report that arrives later brings numbers for a keyword already held
  const later = await owner('POST', `/projects/${pid}/uploads`, { text: 'Search term,Clicks,Cost,Conv.\nboiler repair leeds,4,9,1\n', filename: 'late.csv' });
  assert.equal(later.data.updated, 1);
  assert.equal(later.data.project.keywords.find(k => k.keyword === 'boiler repair leeds').category, 'priority');

  // A decision made by hand survives later uploads
  const id = kw['combi boiler service'].id;
  await owner('PATCH', `/projects/${pid}/keyword/${id}`, { category: 'negative' });
  const after = await owner('POST', `/projects/${pid}/uploads`, { text: 'radiator flush leeds', filename: 'x.txt' });
  assert.equal(after.data.project.keywords.find(k => k.id === id).category, 'negative');
  assert.equal(after.data.project.keywords.find(k => k.id === id).source, 'you');
});

test('competitors: brands become negatives, headings become gaps', async () => {
  const r = await owner('POST', `/projects/${pid}/competitors`, { urls: `http://localhost:${sitePort(siteB)}\nhttp://127.0.0.1:${sitePort(siteA)}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.competitors.length, 1);
  assert.equal(r.data.failed.length, 1, 'own site is refused');
  assert.equal(r.data.project.competitors[0].name, 'Zenith Heating');
  assert.ok(r.data.project.brands.map(b => b.phrase).includes('zenith heating'));

  const add = await owner('POST', `/projects/${pid}/uploads`, { text: 'zenith boiler cover\nzenith heating reviews\nboiler cover leeds', name: 'Competitor test' });
  const byKw = Object.fromEntries(add.data.project.keywords.map(k => [k.keyword, k]));
  assert.equal(byKw['zenith boiler cover'].category, 'negative');
  assert.match(byKw['zenith boiler cover'].reason, /Competitor brand \(Zenith Heating\)/);
  assert.notEqual(byKw['boiler cover leeds'].category, 'negative');

  const gaps = r.data.project.gaps.map(g => g.phrase);
  assert.ok(gaps.includes('annual boiler service plan'), JSON.stringify(gaps));
  assert.ok(gaps.includes('powerflush heating systems'), 'a brand word that is also yours must not hide headings');
  assert.ok(!gaps.includes('gas safety certificates'));
  assert.ok(!gaps.includes('our team'));
  assert.ok(!gaps.includes('boiler installation'));

  const off = await owner('PATCH', `/projects/${pid}/brand`, { phrase: 'zenith heating', enabled: false });
  assert.doesNotMatch(off.data.keywords.find(k => k.keyword === 'zenith heating reviews').reason, /Competitor brand/);
  await owner('PATCH', `/projects/${pid}/brand`, { phrase: 'zenith heating', enabled: true });
  const settings = await owner('PUT', `/projects/${pid}`, { blockCompetitors: false });
  assert.doesNotMatch(settings.data.keywords.find(k => k.keyword === 'zenith boiler cover').reason, /Competitor brand/);
});

test('projects saved by the earlier version are upgraded into uploads', async () => {
  const store = require('../lib/db');
  const old = {
    id: 'legacy01', name: 'Old', url: '', description: 'Plumber in Leeds', offerings: '', seeds: [], exclude: [], strictness: 'balanced', campaign: '', createdAt: '2026-01-01T00:00:00.000Z',
    profile: null, keywords: [{ id: 'a1', keyword: 'boiler repair', category: 'relevant' }, { id: 'a2', keyword: 'plumber jobs', category: 'negative', overridden: true }],
    searchTerms: [{ id: 't1', term: 'drain unblocking', clicks: 5, cost: 10, conversions: 1 }, { id: 't2', term: 'boiler repair', clicks: 2, cost: 3 }],
  };
  const me = (await owner('GET', '/projects')).data; assert.ok(me.length);
  const uid = store.db.prepare('SELECT id FROM users WHERE email = ?').get('olive@agency.test').id;
  store.create(old, uid);
  const r = (await owner('GET', '/projects/legacy01')).data;
  assert.equal(r.batches.length, 2);
  assert.ok(!('searchTerms' in r));
  assert.equal(r.keywords.length, 3, 'the repeated term is merged, not duplicated');
  assert.ok(r.keywords.every(k => r.batches.some(b => b.id === k.batchId)));
  assert.equal(r.keywords.find(k => k.keyword === 'boiler repair').clicks, 2);
  const again = (await owner('GET', '/projects/legacy01')).data;
  assert.deepEqual(again.batches.map(b => b.id), r.batches.map(b => b.id), 'upgrade is saved, ids stay put');
});
