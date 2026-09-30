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
  assert.equal((await owner('POST', `/projects/${pid}/analyze`, {})).status, 200);

  assert.equal((await stranger('GET', `/projects/${pid}`)).status, 404);
  assert.deepEqual((await stranger('GET', '/projects')).data, []);

  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'nobody@agency.test', role: 'editor' })).status, 404);
  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'ed@agency.test', role: 'editor' })).status, 200);
  assert.equal((await owner('POST', `/projects/${pid}/members`, { email: 'vic@agency.test', role: 'viewer' })).status, 200);

  assert.equal((await viewer('GET', `/projects/${pid}`)).data.role, 'viewer');
  assert.equal((await viewer('POST', `/projects/${pid}/keywords`, { text: 'boiler repair' })).status, 403);
  assert.equal((await viewer('PUT', `/projects/${pid}`, { name: 'Hacked' })).status, 403);
  assert.equal((await viewer('GET', `/projects/${pid}/export?type=all`)).status, 200);

  const add = await editor('POST', `/projects/${pid}/keywords`, { text: 'boiler repair leeds\nplumber jobs' });
  assert.equal(add.status, 200);
  assert.equal(add.data.added, 2);
  assert.equal((await editor('DELETE', `/projects/${pid}`)).status, 403);
  assert.equal((await editor('POST', `/projects/${pid}/members`, { email: 'sam@agency.test', role: 'viewer' })).status, 403);

  assert.equal((await stranger('GET', '/projects')).data.length, 0);
  assert.equal((await viewer('GET', '/projects')).data[0].role, 'viewer');

  // Editors and owner see each other's changes because every request reads the current project.
  assert.equal((await owner('GET', `/projects/${pid}`)).data.keywords.length, 2);

  assert.equal((await owner('DELETE', `/projects/${pid}/members/${(await owner('GET', `/projects/${pid}/members`)).data.find(m => m.email === 'vic@agency.test').userId}`)).status, 200);
  assert.equal((await viewer('GET', `/projects/${pid}`)).status, 404);
});

test('search terms report: aggregation, verdicts and winners', async () => {
  const r = await owner('POST', `/projects/${pid}/searchterms`, { text: REPORT });
  assert.equal(r.status, 200);
  const terms = Object.fromEntries(r.data.project.searchTerms.map(t => [t.term, t]));
  assert.equal(Object.keys(terms).length, 6, 'totals row skipped and duplicates merged');
  assert.equal(terms['emergency plumber leeds'].clicks, 130);
  assert.equal(terms['emergency plumber leeds'].cost, 640);
  assert.equal(terms['emergency plumber leeds'].action, 'ignore');
  assert.equal(terms['plumber jobs leeds'].action, 'block');
  assert.equal(terms['plumber jobs leeds'].matchType, 'Negative Phrase');
  assert.equal(terms['boiler installation cost'].action, 'block', '60 clicks and nothing, on an account converting well');
  assert.equal(terms['boiler installation cost'].matchType, 'Negative Exact');
  assert.equal(terms['combi boiler service'].action, 'watch');
  assert.equal(terms['leak repair leeds'].action, 'add');
  assert.equal(terms['already blocked thing'].action, 'ignore');
  const s = r.data.project.stSummary;
  assert.equal(s.blockCount, 2);
  assert.equal(s.wasteCost, 312.5);

  const csv = (await owner('GET', `/projects/${pid}/export?type=st-negatives&campaign=Search`)).data;
  assert.match(csv, /Search,plumber jobs leeds,Negative Phrase/);
  assert.match(csv, /Search,boiler installation cost,Negative Exact/);
  assert.doesNotMatch(csv, /combi/);

  const bad = await owner('POST', `/projects/${pid}/searchterms`, { text: 'Keyword,Avg. monthly searches\nboiler,100\nradiator,90' });
  assert.equal(bad.status, 400);

  const w = await owner('POST', `/projects/${pid}/searchterms/add-winners`, {});
  assert.equal(w.data.added, 1);
  const kw = w.data.project.keywords.find(k => k.keyword === 'leak repair leeds');
  assert.equal(kw.category, 'priority');
  assert.equal(kw.conversions, 1);

  // A manual decision survives re-scoring
  const t = w.data.project.searchTerms.find(x => x.term === 'combi boiler service');
  await owner('PATCH', `/projects/${pid}/searchterm/${t.id}`, { action: 'block' });
  const again = await owner('POST', `/projects/${pid}/classify`, {});
  assert.equal(again.data.project.searchTerms.find(x => x.term === 'combi boiler service').action, 'block');
});

test('competitors: brands become negatives, headings become gaps', async () => {
  const r = await owner('POST', `/projects/${pid}/competitors`, { urls: `http://localhost:${sitePort(siteB)}\nhttp://127.0.0.1:${sitePort(siteA)}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.competitors.length, 1);
  assert.equal(r.data.failed.length, 1, 'own site is refused');
  assert.equal(r.data.project.competitors[0].name, 'Zenith Heating');
  const phrases = r.data.project.brands.map(b => b.phrase);
  assert.ok(phrases.includes('zenith heating'));

  const add = await owner('POST', `/projects/${pid}/keywords`, { text: 'zenith boiler cover\nzenith heating reviews\nboiler cover leeds' });
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

  // Turning a brand off, or the whole setting off, stops the blocking
  const off = await owner('PATCH', `/projects/${pid}/brand`, { phrase: 'zenith heating', enabled: false });
  assert.doesNotMatch(off.data.keywords.find(k => k.keyword === 'zenith heating reviews').reason, /Competitor brand/);
  await owner('PATCH', `/projects/${pid}/brand`, { phrase: 'zenith heating', enabled: true });
  const settings = await owner('PUT', `/projects/${pid}`, { blockCompetitors: false });
  assert.doesNotMatch(settings.data.keywords.find(k => k.keyword === 'zenith boiler cover').reason, /Competitor brand/);
});
