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
    const reply = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] })); };
    const lines = [...user.matchAll(/^(\d+)\. (.*?)(?: \[[^\]]*\])?$/gm)].map(m => ({ i: Number(m[1]), kw: m[2] }));
    if (/RE-CHECK/.test(sys)) {
      calls.push({ kind: 'verify', user, n: lines.length });
      return reply({ results: lines.map(l => /unsure/.test(l.kw)
        ? { i: l.i, label: 'priority', confidence: 40, intent: 'commercial', reason: 'still unclear' }
        : { i: l.i, label: 'relevant', confidence: 65, intent: 'commercial', reason: 'settled on second look' }) });
    }
    if (/study small business websites/.test(sys)) {
      calls.push({ kind: 'business', user });
      return reply({ summary: 'Test summary of the business.', offerings: ['nri tax filing'], not_offered: ['visa help'], areas_served: ['India'] });
    }
    if (/first rows of an exported spreadsheet/.test(sys)) {
      calls.push({ kind: 'columns', user });
      return reply({ header_row_index: -1, keyword_column: 0, volume_column: 1, competition_column: -1, bid_column: 2, impressions_column: -1, clicks_column: -1, cost_column: -1, conversions_column: -1 });
    }
    calls.push({ kind: 'judge', user, n: lines.length });
    queriesSeen.push(...lines.map(l => l.kw));
    reply({ results: lines.map(l => {
      const kw = l.kw;
      if (/unsure/.test(kw)) return { i: l.i, label: 'relevant', confidence: 50, intent: 'commercial', reason: 'hard to say' };
      if (/jobs|salary/.test(kw)) return { i: l.i, label: 'negative', confidence: 96, intent: 'informational', reason: 'job seeker' };
      if (/tax|nri/.test(kw)) return { i: l.i, label: 'priority', confidence: 92, intent: 'commercial', reason: 'wants tax help' };
      return { i: l.i, label: 'relevant', confidence: 80, intent: 'commercial', reason: 'related' };
    }) });
  });
});

let server, base, cookie = '', pid;
test.before(async () => {
  await new Promise(r => mock.listen(0, r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  server = require('../server');
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); mock.close(); });

async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'x-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function settle() {
  for (let i = 0; i < 100; i++) {
    const s = (await call('GET', `/projects/${pid}/status`)).data;
    if (!s.busy) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('AI job did not finish');
}

test('business summary comes from the model and the page reports AI as on', async () => {
  assert.equal((await call('GET', '/config')).data.aiEnabled, true);
  await call('POST', '/auth/register', { email: 'o@x.test', name: 'O', password: 'longenough1' });
  pid = (await call('POST', '/projects', { name: 'NRI tax', description: 'NRI tax consultancy in Mumbai', offerings: 'NRI tax filing', seeds: 'nri tax consultant', exclude: 'dyson', serviceArea: 'India' })).data.id;
  const r = await call('POST', `/projects/${pid}/analyze`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.profile.summary, 'Test summary of the business.');
  assert.deepEqual(r.data.profile.notOffered, ['visa help']);
});

test('a large upload is checked in chunks, shaky answers get a second opinion, progress is visible', async () => {
  const kws = ['which is the best nri tax consultant in mumbai', 'nri tax filing jobs', 'dyson tax vacuum', 'unsure tax thing', 'zebra crossing safety', 'maybe unsure nri query'];
  for (let i = 0; i < 120; i++) kws.push('nri tax filing ' + i);
  const r = await call('POST', `/projects/${pid}/uploads`, { text: kws.join('\n'), filename: 'big.txt' });
  assert.equal(r.status, 200);
  const first = r.data.project.batches[0];
  assert.equal(first.ai.status, 'running');
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

  const judgeCalls = calls.filter(c => c.kind === 'judge');
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
  const p = (await call('GET', `/projects/${pid}`)).data;
  assert.ok(p.batches.some(b => b.ai.status === 'done' && b.stale));

  const store = require('../lib/db');
  const raw = store.get(pid);
  raw.batches[0].ai = { status: 'running', done: 3, total: 10 };
  store.put(raw);
  const after = (await call('GET', `/projects/${pid}`)).data;
  assert.equal(after.batches[0].ai.status, 'interrupted');
});
