'use strict';

process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = require('node:os').tmpdir() + '/ks-camp-' + process.pid;

const test = require('node:test');
const assert = require('node:assert');
const server = require('../server');
const store = require('../lib/db');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, type: res.headers.get('content-type') };
  };
  return (method, path, body) => call(method, '/api' + path, body);
}
const signup = async (c, name) => c('POST', '/auth/register', { email: name.toLowerCase() + '@x.test', name, password: 'longenough1' });

let ann, bob, pid;

test('project addresses are slugs of the name, unique per owner, never "new"', async () => {
  ann = client(); bob = client();
  await signup(ann, 'Ann'); await signup(bob, 'Bob');
  const a1 = (await ann('POST', '/projects', { name: 'Dinesh Aarjav, NRI Tax!' })).data;
  const a2 = (await ann('POST', '/projects', { name: 'Dinesh Aarjav, NRI Tax!' })).data;
  const a3 = (await ann('POST', '/projects', { name: 'New' })).data;
  assert.equal(a1.slug, 'dinesh-aarjav-nri-tax');
  assert.equal(a2.slug, 'dinesh-aarjav-nri-tax-2');
  assert.equal(a3.slug, 'new-project', '"new" is the address of the create form');
  pid = a1.id;

  const b1 = (await bob('POST', '/projects', { name: 'Dinesh Aarjav, NRI Tax!' })).data;
  assert.equal(b1.slug, 'dinesh-aarjav-nri-tax', 'another person can use the same name');

  // Ann shares hers with Bob. Bob now sees two with the same slug, and the newer one is told apart.
  await ann('POST', `/projects/${a1.id}/members`, { email: 'bob@x.test', role: 'viewer' });
  const list = (await bob('GET', '/projects')).data;
  const slugs = list.map(p => p.slug);
  assert.equal(new Set(slugs).size, 2, JSON.stringify(slugs));
  assert.ok(slugs.includes('dinesh-aarjav-nri-tax'));

  const mine = (await ann('GET', '/projects')).data;
  assert.deepEqual(mine.map(p => p.slug).sort(), ['dinesh-aarjav-nri-tax', 'dinesh-aarjav-nri-tax-2', 'new-project']);
});

test('projects saved before slugs existed get one, and uploads before campaigns go into "General"', async () => {
  const uid = store.db.prepare('SELECT id FROM users WHERE email = ?').get('ann@x.test').id;
  store.create({
    id: 'legacy02', name: 'Old Shop', url: '', description: '', offerings: '', seeds: [], exclude: [], strictness: 'balanced', createdAt: '2026-01-01T00:00:00.000Z', profile: null,
    keywords: [{ id: 'k1', keyword: 'boiler repair', batchId: 'b1' }, { id: 'k2', keyword: 'boiler service', batchId: 'b2' }],
    batches: [{ id: 'b1', name: 'One', kind: 'Keyword list', createdAt: '2026-01-01T00:00:00.000Z', ai: { status: 'off' } }, { id: 'b2', name: 'Two', kind: 'Keyword list', createdAt: '2026-01-02T00:00:00.000Z', ai: { status: 'off' } }],
  }, uid);
  assert.ok((await ann('GET', '/projects')).data.find(p => p.id === 'legacy02').slug === 'old-shop');
  const p = (await ann('GET', '/projects/legacy02')).data;
  assert.equal(p.slug, 'old-shop');
  assert.equal(p.campaigns.length, 1);
  assert.equal(p.campaigns[0].name, 'General');
  assert.equal(p.campaigns[0].slug, 'general');
  assert.ok(p.batches.every(b => b.campaignId === p.campaigns[0].id));
  assert.equal(p.campaigns[0].uploads, 2);
  assert.equal(p.campaigns[0].counts.total, 2);
});

test('the app is served for page addresses, so a bookmark or reload works', async () => {
  for (const path of ['/projects', '/projects/dinesh-aarjav-nri-tax', '/projects/dinesh-aarjav-nri-tax/campaigns/brand', '/projects/new', '/whatever']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>Keyword Selector<\/title>/);
  }
  assert.equal((await fetch(base + '/missing.js')).status, 404, 'a missing file is still a 404');
  const api404 = await fetch(base + '/api/nothing', { headers: { 'x-csrf': '1' } });
  assert.match(api404.headers.get('content-type'), /json/);
});

test('campaigns: create, name rules, where uploads go, move, rename, delete', async () => {
  // No campaign yet: the first upload makes "General"
  const first = await ann('POST', `/projects/${pid}/uploads`, { text: 'plumber leeds\nboiler repair', name: 'First' });
  assert.equal(first.data.project.campaigns.length, 1);
  assert.equal(first.data.project.campaigns[0].name, 'General');

  const c2 = await ann('POST', `/projects/${pid}/campaigns`, { name: 'Brand terms', pageUrl: 'https://example.com/brand' });
  assert.equal(c2.status, 201);
  const brand = c2.data.project.campaigns.find(c => c.id === c2.data.campaignId);
  assert.equal(brand.slug, 'brand-terms');
  assert.equal(brand.pageUrl, 'https://example.com/brand');
  assert.equal((await ann('POST', `/projects/${pid}/campaigns`, { name: 'brand TERMS' })).status, 409, 'names are unique, ignoring case');
  assert.equal((await ann('POST', `/projects/${pid}/campaigns`, { name: '  ' })).status, 400);
  assert.equal((await ann('POST', `/projects/${pid}/campaigns`, { name: 'X', pageUrl: 'nope nope' })).status, 400);

  // Two campaigns now: an upload must say which
  assert.equal((await ann('POST', `/projects/${pid}/uploads`, { text: 'brand one' })).status, 400);
  assert.equal((await ann('POST', `/projects/${pid}/uploads`, { text: 'brand one', campaignId: 'nope' })).status, 404);
  const up = await ann('POST', `/projects/${pid}/uploads`, { text: 'brand one\nbrand two', name: 'Brand list', campaignId: brand.id });
  assert.equal(up.status, 200);
  const view = up.data.project;
  const batch = view.batches.find(b => b.id === up.data.batchId);
  assert.equal(batch.campaignId, brand.id);
  assert.equal(batch.inheritedPageUrl, 'https://example.com/brand', 'an upload with no page of its own shows its campaign\'s');
  assert.equal(view.campaigns.find(c => c.id === brand.id).counts.total, 2);
  assert.equal(view.campaigns.find(c => c.id !== brand.id).counts.total, 2);

  // Exports can be scoped to a campaign, and each row carries its own campaign name
  const csv = (await ann('GET', `/projects/${pid}/export?type=all&campaignId=${brand.id}`)).data;
  assert.match(csv, /brand one/);
  assert.doesNotMatch(csv, /plumber leeds/);
  assert.match(csv, /Brand terms/);
  const everything = (await ann('GET', `/projects/${pid}/export?type=all`)).data;
  assert.match(everything, /plumber leeds/);
  assert.match(everything, /General/);
  const ads = (await ann('GET', `/projects/${pid}/export?type=ads-negatives`)).data;
  assert.match(ads.split('\n')[0], /Campaign,Keyword,Criterion Type/);
  assert.equal((await ann('GET', `/projects/${pid}/export?type=all&campaignId=nope`)).status, 404);

  // Move the upload into General
  const general = view.campaigns.find(c => c.id !== brand.id);
  const moved = await ann('PATCH', `/projects/${pid}/uploads/${up.data.batchId}`, { campaignId: general.id });
  assert.equal(moved.data.batches.find(b => b.id === up.data.batchId).campaignId, general.id);
  assert.equal((await ann('PATCH', `/projects/${pid}/uploads/${up.data.batchId}`, { campaignId: 'nope' })).status, 404);
  assert.equal(moved.data.campaigns.find(c => c.id === brand.id).counts.total, 0);

  // Renaming changes the name, not the address
  const renamed = await ann('PATCH', `/projects/${pid}/campaigns/${brand.id}`, { name: 'Brand and competitors' });
  const rc = renamed.data.campaigns.find(c => c.id === brand.id);
  assert.equal(rc.name, 'Brand and competitors');
  assert.equal(rc.slug, 'brand-terms');
  assert.equal((await ann('PATCH', `/projects/${pid}/campaigns/${brand.id}`, { name: 'General' })).status, 409);

  // Deleting a campaign removes its uploads and keywords, and nothing else
  const before = (await ann('GET', `/projects/${pid}`)).data.keywords.length;
  const gone = await ann('DELETE', `/projects/${pid}/campaigns/${general.id}`);
  assert.equal(gone.data.campaigns.length, 1);
  assert.ok(gone.data.keywords.length < before);
  assert.ok(gone.data.batches.every(b => b.campaignId === brand.id));
  assert.equal((await ann('DELETE', `/projects/${pid}/campaigns/${general.id}`)).status, 404);
});

test('changing a campaign landing page marks its uploads out of date, viewers cannot touch campaigns', async () => {
  const camp = (await ann('GET', `/projects/${pid}`)).data.campaigns[0];
  const up = await ann('POST', `/projects/${pid}/uploads`, { text: 'fresh keyword one\nfresh keyword two', campaignId: camp.id });
  // Pretend that upload was analysed earlier
  const raw = store.get(pid);
  const b = raw.batches.find(x => x.id === up.data.batchId);
  b.ai = { status: 'done', profileAt: 'x' }; raw.profile = { builtAt: 'x' };
  store.put(raw);
  assert.equal((await ann('GET', `/projects/${pid}`)).data.batches.find(x => x.id === b.id).stale, false);
  const after = await ann('PATCH', `/projects/${pid}/campaigns/${camp.id}`, { pageUrl: 'https://example.com/new-page' });
  assert.equal(after.data.batches.find(x => x.id === b.id).stale, true);
  const tidy = store.get(pid); tidy.profile = null; store.put(tidy); // the stand-in profile was only for this check

  await ann('POST', `/projects/${pid}/members`, { email: 'bob@x.test', role: 'viewer' });
  assert.equal((await bob('POST', `/projects/${pid}/campaigns`, { name: 'Sneaky' })).status, 403);
  assert.equal((await bob('PATCH', `/projects/${pid}/campaigns/${camp.id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await bob('DELETE', `/projects/${pid}/campaigns/${camp.id}`)).status, 403);
});

test('project options: edit, change the address (owner only), duplicate, delete', async () => {
  const carol = client();
  await signup(carol, 'Carol');
  await ann('POST', `/projects/${pid}/members`, { email: 'carol@x.test', role: 'editor' });
  assert.equal((await ann('GET', '/config')).data.apiVersion, 4);

  const before = (await ann('GET', `/projects/${pid}`)).data;
  assert.equal(before.slug, 'dinesh-aarjav-nri-tax');

  // Renaming keeps the address by default, so links people already hold keep working
  const plain = await ann('PUT', `/projects/${pid}`, { name: 'Fresh Name', url: 'https://example.com' });
  assert.equal(plain.data.name, 'Fresh Name');
  assert.equal(plain.data.url, 'https://example.com/');
  assert.equal(plain.data.slug, 'dinesh-aarjav-nri-tax');

  // An editor can edit but not change the address
  assert.equal((await carol('PUT', `/projects/${pid}`, { name: 'Carol name' })).status, 200);
  assert.equal((await carol('PUT', `/projects/${pid}`, { name: 'Carol again', renameSlug: true })).status, 403);
  assert.equal((await bob('PUT', `/projects/${pid}`, { name: 'Bob' })).status, 403, 'a viewer cannot edit');

  // The owner can, and the new address is unique among their projects
  await ann('PUT', `/projects/${pid}`, { name: 'Fresh Name' });
  const moved = await ann('PUT', `/projects/${pid}`, { renameSlug: true });
  assert.equal(moved.data.slug, 'fresh-name');
  assert.ok((await ann('GET', '/projects')).data.some(p => p.slug === 'fresh-name'));
  const other = (await ann('POST', '/projects', { name: 'Fresh Name' })).data;
  assert.equal(other.slug, 'fresh-name-2');

  // Duplicate: business details and campaigns come along, keywords do not, the copy belongs to whoever asked
  assert.equal((await ann('PUT', `/projects/${pid}`, { description: 'Plumber in Leeds', seeds: 'boiler repair', exclude: 'dyson', serviceArea: 'Leeds' })).status, 200);
  const src = (await ann('GET', `/projects/${pid}`)).data;
  assert.ok(src.keywords.length > 0 && src.campaigns.length > 0);
  assert.equal((await bob('POST', `/projects/${pid}/duplicate`)).status, 403, 'a viewer cannot copy a project');
  const dup = await carol('POST', `/projects/${pid}/duplicate`);
  assert.equal(dup.status, 201);
  const copy = dup.data.project;
  assert.equal(copy.name, 'Fresh Name (copy)');
  assert.equal(copy.slug, 'fresh-name-copy');
  assert.equal(copy.role, 'owner');
  assert.equal(copy.keywords.length, 0);
  assert.equal(copy.batches.length, 0);
  assert.equal(copy.campaigns.length, src.campaigns.length);
  assert.notEqual(copy.campaigns[0].id, src.campaigns[0].id);
  assert.equal(copy.campaigns[0].name, src.campaigns[0].name);
  assert.equal(copy.description, 'Plumber in Leeds');
  assert.deepEqual(copy.exclude, ['dyson']);
  assert.equal(copy.serviceArea, 'Leeds');
  assert.equal((await ann('GET', `/projects/${dup.data.id}`)).status, 404, 'the owner of the original does not get the copy');
  assert.equal((await carol('GET', '/projects')).data.length, 2, 'Carol sees the original and her copy');

  // Delete is for owners only
  assert.equal((await carol('DELETE', `/projects/${pid}`)).status, 403);
  assert.equal((await carol('DELETE', `/projects/${dup.data.id}`)).status, 200);
  assert.equal((await ann('DELETE', `/projects/${other.id}`)).status, 200);
  assert.ok(!(await ann('GET', '/projects')).data.some(p => p.id === other.id));
});
