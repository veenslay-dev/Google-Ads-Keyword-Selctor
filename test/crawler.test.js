'use strict';

process.env.ALLOW_PRIVATE_HOSTS = '1';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { crawlSite, fetchPage, MAX_PAGES } = require('../lib/crawler');

// A site of 120 pages. The home page links only to a few, the rest are reachable through those
// or through the sitemap. /private/ is closed by robots.txt. /loop redirects to itself.
let site, base, hits;
const page = (title, links = []) => `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>About ${title}.</p>${links.map(l => `<a href="${l}">x</a>`).join('')}</body></html>`;

test.before(async () => {
  hits = [];
  site = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (type, body, code = 200) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (req.url === '/robots.txt') return send('text/plain', 'User-agent: *\nDisallow: /private/\nSitemap: ' + base + '/sitemap.xml\n');
    if (req.url === '/sitemap.xml') return send('application/xml', '<urlset>' + Array.from({ length: 60 }, (_, i) => `<url><loc>${base}/deep/${i}</loc></url>`).join('') + `<url><loc>${base}/private/secret</loc></url></urlset>`);
    if (req.url === '/') return send('text/html', page('Home', ['/services', '/about', '/private/secret', '/loop', '/file.pdf', '/privacy-policy', '/services?utm=1#top']));
    if (req.url === '/services') return send('text/html', page('Services', Array.from({ length: 30 }, (_, i) => `/services/s${i}`)));
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (/^\/(about|services\/s\d+|deep\/\d+|private\/secret)$/.test(req.url)) return send('text/html', page(req.url));
    send('text/plain', 'nope', 404);
  });
  await new Promise(r => site.listen(0, r));
  base = `http://127.0.0.1:${site.address().port}`;
});
test.after(() => site.close());

test('reads up to 50 pages, service pages first, and reports progress', async () => {
  assert.equal(MAX_PAGES, 50);
  const progress = [];
  const { pages, errors } = await crawlSite(base + '/', { onProgress: n => progress.push(n) });
  assert.equal(pages.length, 50);
  const urls = pages.map(p => new URL(p.url).pathname);
  assert.equal(new Set(urls).size, 50, 'no page is read twice');
  assert.ok(urls.includes('/about') && urls.includes('/services'));
  assert.ok(urls.filter(u => u.startsWith('/services/')).length >= 25, 'pages that look like services are taken before the rest');
  assert.ok(progress.length > 3 && progress.at(-1) === 50 && progress.every((n, i) => i === 0 || n >= progress[i - 1]));
  assert.ok(errors.some(e => /redirect/i.test(e.error)), 'a redirect loop is reported and skipped');
});

test('honours robots.txt, skips files and low value pages, and never leaves the site', async () => {
  hits.length = 0;
  const { pages } = await crawlSite(base + '/', { maxPages: 50 });
  const urls = pages.map(p => new URL(p.url).pathname);
  assert.ok(!urls.includes('/private/secret'));
  assert.ok(!hits.includes('/private/secret'), 'the closed page is never even requested');
  assert.ok(!hits.includes('/file.pdf') && !hits.includes('/privacy-policy'));
  assert.equal(hits.filter(h => h === '/services').length, 1, 'a link with a query string or hash is the same page');
});

test('a small limit is respected and a single page can be read on its own', async () => {
  const { pages } = await crawlSite(base + '/', { maxPages: 5 });
  assert.equal(pages.length, 5);
  const one = await fetchPage(base + '/about');
  assert.equal(one.title, '/about');
  await assert.rejects(() => fetchPage(base + '/missing'), /404/);
});
