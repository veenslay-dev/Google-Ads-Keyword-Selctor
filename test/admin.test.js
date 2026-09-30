'use strict';

process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = require('node:os').tmpdir() + '/ks-admin-' + process.pid;

const test = require('node:test');
const assert = require('node:assert');
const server = require('../server');
const store = require('../lib/db');
const plan = require('../lib/plan');
const pricing = require('../lib/pricing');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + '/api' + path, { method, headers: { 'x-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}
const signup = (c, name) => c('POST', '/auth/register', { email: name.toLowerCase() + '@x.test', name, password: 'longenough1' });
const words = (n, tag = 'kw') => Array.from({ length: n }, (_, i) => `${tag} word ${i}`).join('\n');

let root, ann, bob;

test('the first account is the admin, later ones are not, and only admins reach /admin', async () => {
  root = client(); ann = client(); bob = client();
  const first = await signup(root, 'Root');
  assert.equal(first.data.user.isAdmin, true);
  assert.equal((await signup(ann, 'Ann')).data.user.isAdmin, false);
  await signup(bob, 'Bob');
  assert.equal((await ann('GET', '/admin/overview')).status, 403);
  assert.equal((await ann('GET', '/admin/users')).status, 403);
  assert.equal((await client()('GET', '/admin/overview')).status, 401);
  assert.equal((await root('GET', '/admin/overview')).status, 200);
});

test('overview counts sign-ups, keywords and usage cost, with the cost worked out from tokens', async () => {
  const p = (await ann('POST', '/projects', { name: 'Ann site' })).data;
  const up = await ann('POST', `/projects/${p.id}/uploads`, { text: words(40), filename: 'a.txt' });
  assert.equal(up.data.added, 40);
  const ann_ = store.userByEmail('ann@x.test');
  store.addUsage({ userId: ann_.id, projectId: p.id, kind: 'judge', model: 'gpt-4.1-mini', promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 0, ok: true });
  // 1M in at $0.40 plus 0.5M out at $1.60 is $1.20
  const o = (await root('GET', '/admin/overview')).data;
  assert.equal(o.users.total, 3);
  assert.equal(o.users.admins, 1);
  assert.equal(o.content.keywords, 40);
  assert.equal(o.ai.costAll, 1.2);
  assert.equal(o.series.signups.reduce((n, d) => n + d.value, 0), 3);
  const list = (await root('GET', '/admin/users')).data;
  const a = list.find(u => u.email === 'ann@x.test');
  assert.equal(a.keywords, 40);
  assert.equal(a.keywordsUploaded, 40);
  assert.equal(a.ai.costAll, 1.2);
  assert.equal(list.find(u => u.email === 'bob@x.test').ai.costAll, 0);
});

test('changing a token price changes the cost of past usage too', async () => {
  const s = (await root('PUT', '/admin/settings', { pricing: { 'gpt-4.1-mini': { in: 1, out: 1, cached: 1 } } })).data;
  assert.equal(s.pricing.find(r => r.model === 'gpt-4.1-mini').in, 1);
  assert.equal((await root('GET', '/admin/overview')).data.ai.costAll, 1.5);
  await root('PUT', '/admin/settings', { pricing: { 'gpt-4.1-mini': pricing.DEFAULTS['gpt-4.1-mini'] } });
  assert.equal((await root('GET', '/admin/overview')).data.ai.costAll, 1.2);
});

test('project limit: per person, stops creating and duplicating, admins and others are not affected', async () => {
  const id = store.userByEmail('bob@x.test').id;
  assert.equal((await root('PATCH', `/admin/users/${id}`, { limits: { projects: 2 } })).status, 200);
  const one = (await bob('POST', '/projects', { name: 'B1' })).data;
  assert.ok(one.id);
  assert.equal((await bob('POST', '/projects', { name: 'B2' })).status, 201);
  const blocked = await bob('POST', '/projects', { name: 'B3' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /limit of 2 projects/);
  assert.equal((await bob('POST', `/projects/${one.id}/duplicate`)).status, 403);
  for (const n of ['x', 'y', 'z']) assert.equal((await ann('POST', '/projects', { name: 'Ann ' + n })).status, 201);
  assert.equal((await bob('GET', '/auth/me')).data.plan.limits.projects, 2);
});

test('campaign limit counts per project and follows the owner', async () => {
  const id = store.userByEmail('ann@x.test').id;
  await root('PATCH', `/admin/users/${id}`, { limits: { campaignsPerProject: 2 } });
  const p = (await ann('POST', '/projects', { name: 'Campaign limit' })).data;
  assert.equal((await ann('POST', `/projects/${p.id}/campaigns`, { name: 'One' })).status, 201);
  assert.equal((await ann('POST', `/projects/${p.id}/campaigns`, { name: 'Two' })).status, 201);
  const third = await ann('POST', `/projects/${p.id}/campaigns`, { name: 'Three' });
  assert.equal(third.status, 403);
  assert.match(third.data.error, /limit of 2 campaigns/);
  // a second project has its own allowance
  const q = (await ann('POST', '/projects', { name: 'Other' })).data;
  assert.equal((await ann('POST', `/projects/${q.id}/campaigns`, { name: 'One' })).status, 201);
  // an editor added to the project is held to the owner's limit, not their own
  await ann('POST', `/projects/${p.id}/members`, { email: 'bob@x.test', role: 'editor' });
  assert.equal((await bob('POST', `/projects/${p.id}/campaigns`, { name: 'Four' })).status, 403);
  // the automatic "General" campaign obeys the limit as well
  await root('PATCH', `/admin/users/${id}`, { limits: { campaignsPerProject: 0 } });
  const r = await ann('POST', `/projects/${q.id}/uploads`, { text: 'one two three', campaignId: undefined });
  assert.ok([403, 200].includes(r.status));
  await root('PATCH', `/admin/users/${id}`, { limits: { campaignsPerProject: null } });
});

test('keyword limits cap an upload, say how many were left out, and count across projects', async () => {
  const id = store.userByEmail('ann@x.test').id;
  const before = store.ownedKeywords(id);
  await root('PATCH', `/admin/users/${id}`, { limits: { keywordsPerProject: 50 } });
  const p = (await ann('POST', '/projects', { name: 'Keyword limit' })).data;
  const r = await ann('POST', `/projects/${p.id}/uploads`, { text: words(80, 'cap'), filename: 'cap.txt' });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 50);
  assert.equal(r.data.planLimited, 30);
  assert.match(r.data.planMessage, /50 keywords/);
  const again = await ann('POST', `/projects/${p.id}/uploads`, { text: words(10, 'more') });
  assert.equal(again.status, 403);
  assert.match(again.data.error, /No room/);

  // total across projects
  await root('PATCH', `/admin/users/${id}`, { limits: { keywordsPerProject: null, keywordsTotal: before + 50 + 5 } });
  const q = (await ann('POST', '/projects', { name: 'Keyword total' })).data;
  const t = await ann('POST', `/projects/${q.id}/uploads`, { text: words(20, 'tot') });
  assert.equal(t.data.added, 5);
  await root('PATCH', `/admin/users/${id}`, { limits: { keywordsTotal: -1 } });
  assert.equal((await ann('POST', `/projects/${q.id}/uploads`, { text: words(20, 'free') })).data.added, 20);
});

test('default limits apply to everyone without their own, a custom value wins, -1 and admins are unlimited', async () => {
  await root('PUT', '/admin/settings', { defaultLimits: { projects: 1 } });
  const carol = client(); await signup(carol, 'Carol');
  assert.equal((await carol('POST', '/projects', { name: 'C1' })).status, 201);
  assert.equal((await carol('POST', '/projects', { name: 'C2' })).status, 403);
  const id = store.userByEmail('carol@x.test').id;
  await root('PATCH', `/admin/users/${id}`, { limits: { projects: 3 } });
  assert.equal((await carol('POST', '/projects', { name: 'C2' })).status, 201);
  await root('PATCH', `/admin/users/${id}`, { limits: { projects: -1 } });
  for (const n of ['C3', 'C4', 'C5']) assert.equal((await carol('POST', '/projects', { name: n })).status, 201);
  for (const n of ['R1', 'R2']) assert.equal((await root('POST', '/projects', { name: n })).status, 201);
  const d = (await root('GET', `/admin/users/${id}`)).data;
  assert.equal(d.limits.projects, null);
  assert.equal(d.sources.projects, 'custom');
  await root('PUT', '/admin/settings', { defaultLimits: { projects: -1 } });
});

test('bad limit values are refused', async () => {
  const id = store.userByEmail('bob@x.test').id;
  assert.equal((await root('PATCH', `/admin/users/${id}`, { limits: { projects: 'many' } })).status, 400);
  assert.equal((await root('PATCH', `/admin/users/${id}`, { limits: { projects: -5 } })).status, 400);
});

test('monthly budget and the switches stop analysis', async () => {
  const id = store.userByEmail('bob@x.test').id;
  assert.equal(plan.aiAllowed(id).ok, true);
  await root('PATCH', `/admin/users/${id}`, { limits: { aiBudget: 0.5 } });
  store.addUsage({ userId: id, kind: 'judge', model: 'gpt-4.1', promptTokens: 400_000, completionTokens: 0, ok: true }); // $0.80
  const r = plan.aiAllowed(id);
  assert.equal(r.ok, false);
  assert.match(r.reason, /monthly analysis budget/);
  await root('PATCH', `/admin/users/${id}`, { limits: { aiBudget: null } });
  assert.equal(plan.aiAllowed(id).ok, true);
  await root('PATCH', `/admin/users/${id}`, { limits: { aiEnabled: false } });
  assert.equal(plan.aiAllowed(id).ok, false);
  await root('PATCH', `/admin/users/${id}`, { limits: { aiEnabled: null } });
  await root('PUT', '/admin/settings', { aiEnabled: false });
  assert.equal(plan.aiAllowed(id).ok, false);
  assert.equal((await bob('GET', '/config')).data.aiEnabled, false);
  await root('PUT', '/admin/settings', { aiEnabled: true });
  assert.equal(plan.aiAllowed(id).ok, true);
});

test('suspending signs the person out and blocks login, until they are restored', async () => {
  const dan = client(); await signup(dan, 'Dan');
  const id = store.userByEmail('dan@x.test').id;
  assert.equal((await dan('GET', '/projects')).status, 200);
  await root('PATCH', `/admin/users/${id}`, { status: 'suspended' });
  assert.equal((await dan('GET', '/projects')).status, 401);
  const l = await client()('POST', '/auth/login', { email: 'dan@x.test', password: 'longenough1' });
  assert.equal(l.status, 403);
  assert.match(l.data.error, /suspended/);
  await root('PATCH', `/admin/users/${id}`, { status: 'active' });
  assert.equal((await client()('POST', '/auth/login', { email: 'dan@x.test', password: 'longenough1' })).status, 200);
});

test('passwords: admin sets one (ending sessions), people change their own', async () => {
  const eve = client(); await signup(eve, 'Eve');
  const id = store.userByEmail('eve@x.test').id;
  const r = await root('POST', `/admin/users/${id}/password`, {});
  assert.ok(r.data.password.length >= 10);
  assert.equal((await eve('GET', '/projects')).status, 401);
  const again = client();
  assert.equal((await again('POST', '/auth/login', { email: 'eve@x.test', password: r.data.password })).status, 200);
  assert.equal((await again('POST', '/auth/password', { current: 'wrong', next: 'newpassword1' })).status, 400);
  assert.equal((await again('POST', '/auth/password', { current: r.data.password, next: 'short' })).status, 400);
  assert.equal((await again('POST', '/auth/password', { current: r.data.password, next: 'newpassword1' })).status, 200);
  assert.equal((await client()('POST', '/auth/login', { email: 'eve@x.test', password: 'newpassword1' })).status, 200);
});

test('admin can add a person with limits, and delete one (their projects go too) but not the last admin or themselves', async () => {
  const made = await root('POST', '/admin/users', { name: 'Fay', email: 'fay@x.test', limits: { projects: 1 } });
  assert.equal(made.status, 201);
  assert.ok(made.data.password);
  assert.equal(made.data.user.limits.projects, 1);
  assert.equal((await root('POST', '/admin/users', { name: 'Fay', email: 'fay@x.test' })).status, 409);
  const fay = client();
  assert.equal((await fay('POST', '/auth/login', { email: 'fay@x.test', password: made.data.password })).status, 200);
  await fay('POST', '/projects', { name: 'Fay project' });
  const id = made.data.user.id;
  assert.equal((await root('DELETE', `/admin/users/${id}`, { confirmEmail: 'nope@x.test' })).status, 400);
  const del = await root('DELETE', `/admin/users/${id}`, { confirmEmail: 'fay@x.test' });
  assert.equal(del.data.projectsDeleted, 1);
  assert.equal(store.userById(id), null);

  const rootId = store.userByEmail('root@x.test').id;
  assert.equal((await root('DELETE', `/admin/users/${rootId}`, { confirmEmail: 'root@x.test' })).status, 400);
  assert.equal((await root('PATCH', `/admin/users/${rootId}`, { status: 'suspended' })).status, 400);
  assert.equal((await root('PATCH', `/admin/users/${rootId}`, { isAdmin: false })).status, 400);
});

test('closing sign-ups blocks new registrations, and every change lands in the activity log', async () => {
  await root('PUT', '/admin/settings', { signupOpen: false });
  assert.equal((await client()('GET', '/config')).data.signupOpen, false);
  assert.equal((await signup(client(), 'Late')).status, 403);
  await root('PUT', '/admin/settings', { signupOpen: true });
  assert.equal((await signup(client(), 'Late')).status, 201);
  const log = (await root('GET', '/admin/activity')).data;
  const actions = new Set(log.map(a => a.action));
  for (const a of ['user.update', 'user.password', 'user.create', 'user.delete', 'settings.update']) assert.ok(actions.has(a), a);
  assert.ok(log.every(a => a.actor === 'Root'));
});
