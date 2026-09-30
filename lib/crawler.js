'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_PAGES = 50;
const MAX_BYTES = 1.5 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const UA = 'KeywordSieveBot/0.2 (project brief crawler)';
const hostKey = h => String(h).replace(/^www\./i, '').toLowerCase();

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

// Fetches with the private-address check applied to every redirect hop. typeRe limits the content type.
async function fetchBody(url, typeRe, accept) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: accept || '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current);
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!typeRe.test(type)) throw new Error('Not an HTML page (' + (type || 'unknown type') + ')');
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

const fetchHtml = url => fetchBody(url, /html|xml/i, 'text/html,application/xhtml+xml');

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
      if (hostKey(u.hostname) !== hostKey(base.hostname) || !/^https?:$/.test(u.protocol)) continue;
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
    siteName: meta('og:site_name'),
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

// Pages that describe what a business sells come first when there are more links than the limit allows.
const PRIORITY_PATH = /(service|product|solution|offer|what-we|shop|categor|collection|pricing|plans|about|industr|treatment|program|course|work|portfolio|nri|tax|consult)/i;
const ASSET = /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|css|js|xml|ico|woff2?|docx?|xlsx?)$/i;
const SKIP_PATH = /\/(wp-admin|wp-json|wp-login|wp-content|feed|cart|checkout|my-account|login|signin|sign-in|register|cdn-cgi|tag|author|privacy|privacy-policy|terms|terms-and-conditions|cookie-policy|disclaimer)(\/|$)/i;

// A page address without the parts that only track or re-order: hash, query, trailing slash.
function pageKey(href) {
  const u = new URL(href);
  u.hash = '';
  u.search = '';
  const s = u.href;
  return u.pathname !== '/' && s.endsWith('/') ? s.slice(0, -1) : s;
}

// Reads robots.txt so pages a site asks crawlers to stay out of are left alone.
async function loadRobots(origin) {
  const r = await fetchBody(origin + '/robots.txt', /./);
  const rules = [], sitemaps = [];
  let agents = [], inRules = false;
  const applies = () => agents.some(a => a === '*' || a.startsWith('keywordsieve'));
  for (const raw of r.html.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; } // a new group starts
      agents.push(val.toLowerCase());
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (applies() && val) {
        const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
        rules.push({ allow: key === 'allow', len: val.length, re });
      }
    }
  }
  return {
    sitemaps,
    allowed(pathname) {
      let best = null;
      for (const rule of rules) if (rule.re.test(pathname) && (!best || rule.len > best.len || (rule.len === best.len && rule.allow))) best = rule;
      return !best || best.allow;
    },
  };
}

async function loadSitemapUrls(origin, robots) {
  const out = [];
  const queue = [...new Set([...(robots ? robots.sitemaps : []), origin + '/sitemap.xml'])].slice(0, 3);
  let fetched = 0;
  while (queue.length && fetched < 6 && out.length < 500) {
    const loc = queue.shift();
    fetched++;
    let xml;
    try { xml = (await fetchBody(loc, /./)).html; } catch { continue; }
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs.slice(0, 4));
    else out.push(...locs);
  }
  return out.slice(0, 500);
}

/**
 * Reads up to maxPages pages of one site, breadth first, service-like pages first. Pages come from the links
 * on each page and from the sitemap. Stays on the same host, honours robots.txt, fetches a few pages at a time,
 * and stops early at the deadline. onProgress(pagesRead) is called after each round.
 */
async function crawlSite(startUrl, opts = {}) {
  const maxPages = opts.maxPages || MAX_PAGES;
  const onProgress = opts.onProgress || (() => {});
  const concurrency = opts.concurrency || 5;
  const deadline = Date.now() + (opts.deadlineMs || 80000);

  const first = await fetchHtml(startUrl);
  const start = new URL(first.url);
  const robots = await loadRobots(start.origin).catch(() => null);
  const pages = [extractPage(first.html, first.url)];
  const errors = [];
  const seen = new Set([pageKey(first.url)]);
  const frontier = [];

  const add = href => {
    try {
      const u = new URL(href, start);
      if (!/^https?:$/.test(u.protocol) || hostKey(u.hostname) !== hostKey(start.hostname)) return;
      if (ASSET.test(u.pathname) || SKIP_PATH.test(u.pathname)) return;
      if (robots && !robots.allowed(u.pathname)) return;
      const key = pageKey(u.href);
      if (seen.has(key)) return;
      seen.add(key);
      frontier.push(key);
    } catch { /* ignore bad links */ }
  };
  pages[0].links.forEach(add);
  (await loadSitemapUrls(start.origin, robots).catch(() => [])).forEach(add);
  onProgress(pages.length);

  const rank = u => (PRIORITY_PATH.test(new URL(u).pathname) ? 0 : 1);
  while (pages.length < maxPages && frontier.length && Date.now() < deadline) {
    frontier.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
    const batch = frontier.splice(0, Math.min(concurrency, maxPages - pages.length));
    const results = await Promise.allSettled(batch.map(fetchHtml));
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') { errors.push({ url: batch[i], error: r.reason.message }); return; }
      const key = pageKey(r.value.url);
      if (key !== batch[i]) { if (seen.has(key)) return; seen.add(key); } // a redirect landed on a page already held
      const pg = extractPage(r.value.html, r.value.url);
      pages.push(pg);
      pg.links.forEach(add);
    });
    onProgress(pages.length);
  }
  return { pages, errors };
}

// One page, for a landing page given with an upload.
async function fetchPage(url) {
  const r = await fetchHtml(url);
  return extractPage(r.html, r.url);
}

module.exports = { crawlSite, fetchPage, extractPage, isPrivateIp, MAX_PAGES };
