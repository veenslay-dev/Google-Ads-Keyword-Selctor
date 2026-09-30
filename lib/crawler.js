'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_PAGES = 8;
const MAX_BYTES = 1.5 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const UA = 'KeywordSieveBot/0.1 (project brief crawler)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs are supported.');
  if (process.env.ALLOW_PRIVATE_HOSTS === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That address points to a private network, so it was not fetched.');
}

async function fetchHtml(url) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(type)) throw new Error('Not an HTML page (' + (type || 'unknown type') + ')');
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BYTES) { await reader.cancel(); break; }
    }
    return { url: current.href, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...' };
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    return ENT[e.toLowerCase()] ?? ' ';
  });
}
const strip = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function extractPage(html, pageUrl) {
  const base = new URL(pageUrl);
  const meta = name => {
    const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*>', 'i');
    const tag = (html.match(re) || [''])[0];
    const c = tag.match(/content=["']([^"']*)["']/i);
    return c ? decode(c[1]).trim() : '';
  };
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const heads = tag => [...html.matchAll(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'gi'))].map(m => strip(m[1])).filter(Boolean);
  const alts = [...html.matchAll(/<img[^>]+alt=["']([^"']{3,120})["']/gi)].map(m => decode(m[1]).trim());

  const links = new Set();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
      if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js|xml|ico)$/i.test(u.pathname)) continue;
      u.hash = '';
      links.add(u.href);
    } catch { /* ignore bad hrefs */ }
  }

  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = strip(body).slice(0, 20000);

  return {
    url: pageUrl,
    title,
    description: meta('description') || meta('og:description'),
    metaKeywords: meta('keywords'),
    h1: heads('h1'),
    h2: heads('h2').slice(0, 30),
    h3: heads('h3').slice(0, 30),
    alts: alts.slice(0, 20),
    text,
    links: [...links],
  };
}

const PRIORITY_PATH = /(service|product|solution|offer|what-we|shop|categor|collection|pricing|plans|about|industr|treatment|program|course|work|portfolio)/i;

async function crawlSite(startUrl) {
  const first = await fetchHtml(startUrl);
  const pages = [extractPage(first.html, first.url)];
  const errors = [];
  const seen = new Set([first.url.replace(/\/$/, '')]);

  const queue = pages[0].links
    .filter(l => !seen.has(l.replace(/\/$/, '')))
    .sort((a, b) => (PRIORITY_PATH.test(b) ? 1 : 0) - (PRIORITY_PATH.test(a) ? 1 : 0) || a.length - b.length);
  const picks = [];
  for (const l of queue) {
    const k = l.replace(/\/$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    picks.push(l);
    if (picks.length >= MAX_PAGES - 1) break;
  }

  const results = await Promise.allSettled(picks.map(async u => {
    const r = await fetchHtml(u);
    return extractPage(r.html, r.url);
  }));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') pages.push(r.value);
    else errors.push({ url: picks[i], error: r.reason.message });
  });
  return { pages, errors };
}

module.exports = { crawlSite, extractPage, isPrivateIp, MAX_PAGES };
