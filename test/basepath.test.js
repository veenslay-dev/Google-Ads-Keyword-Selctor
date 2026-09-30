'use strict';

process.env.DB_PATH = ':memory:';
process.env.BASE_PATH = '/keyword-selector';
process.env.DATA_DIR = require('node:os').tmpdir() + '/ks-base-' + process.pid;

const test = require('node:test');
const assert = require('node:assert');
const server = require('../server');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

test('works when mounted under a path, with or without the proxy stripping it', async () => {
  for (const p of ['/keyword-selector/', '/keyword-selector', '/']) {
    const html = await (await fetch(base + p)).text();
    assert.match(html, /<meta name="base" content="\/keyword-selector">/, p);
    assert.match(html, /src="\/keyword-selector\/app\.js"/, p);
  }
  assert.equal((await fetch(base + '/keyword-selector/app.js')).status, 200);
  assert.equal((await fetch(base + '/keyword-selector/style.css')).status, 200);
  for (const p of ['/keyword-selector/api/config', '/api/config']) {
    assert.equal((await (await fetch(base + p)).json()).maxKeywords, 1000, p);
  }
});

test('the session cookie is limited to the mount path', async () => {
  const res = await fetch(base + '/keyword-selector/api/auth/register', {
    method: 'POST', headers: { 'x-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.test', name: 'A', password: 'longenough1' }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie'), /Path=\/keyword-selector;/);
});
