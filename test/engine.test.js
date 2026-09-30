'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractKeywords } = require('../lib/sheet');
const { extractPage, isPrivateIp } = require('../lib/crawler');
const { buildProfile } = require('../lib/profile');
const { classifyAll, suggestNegativeWords } = require('../lib/classifier');

const project = {
  description: 'Family run emergency plumber in Leeds. We fix leaking pipes, blocked drains and install boilers.',
  offerings: 'Boiler installation, drain unblocking, leak repair, bathroom plumbing',
  seeds: ['emergency plumber leeds', 'boiler installation'],
  exclude: ['dyson'],
  strictness: 'balanced',
};
const pages = [{
  url: 'https://x.test', title: 'Emergency Plumber Leeds | Boiler Installation', description: 'Fast plumbers in Leeds for burst pipes and boilers.',
  metaKeywords: '', h1: ['Emergency plumber in Leeds'], h2: ['Boiler installation', 'Blocked drains', 'Leak repair'], h3: [], alts: [],
  text: 'Our plumbers fix leaks, unblock drains and fit new boilers across Leeds. Call for a free quote.',
}];
const profile = buildProfile({ project, pages });

const run = list => classifyAll(list.map((k, i) => ({ id: String(i), keyword: k })), profile, project);
const cat = (rows, k) => rows.find(r => r.keyword === k).category;

test('sorts a mixed list sensibly', () => {
  const rows = run([
    'emergency plumber leeds', 'boiler installation cost', 'blocked drain repair', 'plumber jobs leeds',
    'free plumbing course', 'how to fix a leaking tap', 'dyson vacuum', 'cat food', 'free quote plumber', 'best price', 'best pizza in leeds',
  ]);
  assert.equal(cat(rows, 'best pizza in leeds'), 'review');
  assert.equal(cat(rows, 'emergency plumber leeds'), 'priority');
  assert.equal(cat(rows, 'boiler installation cost'), 'priority');
  assert.equal(cat(rows, 'blocked drain repair'), 'priority');
  assert.equal(cat(rows, 'plumber jobs leeds'), 'negative');
  assert.equal(cat(rows, 'free plumbing course'), 'negative');
  assert.equal(cat(rows, 'how to fix a leaking tap'), 'review');
  assert.equal(cat(rows, 'dyson vacuum'), 'negative');
  assert.equal(cat(rows, 'cat food'), 'negative');
  assert.notEqual(cat(rows, 'free quote plumber'), 'negative');
  assert.equal(cat(rows, 'best price'), 'negative');
});

test('strict mode turns research keywords into negatives', () => {
  const rows = classifyAll([{ id: '1', keyword: 'how to unblock a drain' }], profile, { ...project, strictness: 'strict' });
  assert.equal(rows[0].category, 'negative');
});

test('user overrides survive reclassification', () => {
  const rows = [{ id: '1', keyword: 'cat food', category: 'priority', overridden: true }];
  classifyAll(rows, profile, project);
  assert.equal(rows[0].category, 'priority');
});

test('negative word suggestions skip profile words', () => {
  const rows = run(['plumber jobs leeds', 'boiler jobs', 'drain jobs near me', 'cat food', 'dog food']);
  const words = suggestNegativeWords(rows, profile).map(w => w.word);
  assert.ok(words.includes('jobs') || words.includes('food'));
  assert.ok(!words.includes('plumber'));
});

test('parses a Keyword Planner style export with metrics', () => {
  const text = 'Keyword Stats 2025\nJan 2024 - Dec 2024\nKeyword\tCurrency\tAvg. monthly searches\tCompetition\tTop of page bid (high range)\nemergency plumber\tGBP\t1K – 10K\tHigh\t8.20\n[boiler repair]\tGBP\t500\tMedium\t5.10\n"drain cleaning"\tGBP\t90\tLow\t3\n';
  const { rows } = extractKeywords(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { keyword: 'emergency plumber', volume: 1000, competition: 'High', bid: 8.2 });
  assert.equal(rows[1].keyword, 'boiler repair');
});

test('handles plain pasted lists, duplicates and comma lists', () => {
  assert.equal(extractKeywords('a b\nA B\nc d\n').rows.length, 2);
  assert.equal(extractKeywords('plumber, boiler fitter, drain unblocker').rows.length, 3);
  assert.equal(extractKeywords('buy shoes, cheap\nred shoes, sale').rows.length, 2);
});

test('page extraction reads title, headings and same-site links', () => {
  const html = '<html><head><title>Acme &amp; Co</title><meta name="description" content="We sell anvils"></head><body><nav>menu</nav><h1>Anvils</h1><a href="/services">s</a><a href="https://other.com/x">o</a><p>Heavy anvils for sale</p><script>var x=1</script></body></html>';
  const p = extractPage(html, 'https://acme.test/');
  assert.equal(p.title, 'Acme & Co');
  assert.equal(p.description, 'We sell anvils');
  assert.deepEqual(p.h1, ['Anvils']);
  assert.deepEqual(p.links, ['https://acme.test/services']);
  assert.ok(p.text.includes('Heavy anvils') && !p.text.includes('var x'));
});

test('private addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '::1', '::ffff:10.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp('8.8.8.8'));
});
