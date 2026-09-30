'use strict';

const crypto = require('node:crypto');
const { crawlSite } = require('./crawler');
const { normalize, words, contentTokens, stem } = require('./nlp');

const PAGES_PER_COMPETITOR = 5;
const MAX_COMPETITORS = 3;

// "acme-plumbing.co.uk" -> "acme-plumbing"
function hostLabel(host) {
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) return parts[parts.length - 3];
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

function brandCandidates(pages, host) {
  const label = hostLabel(host);
  const cands = new Set([label.replace(/[-_]+/g, ' '), label.replace(/[-_]+/g, '')]);
  const home = pages[0] || {};
  if (home.siteName) cands.add(home.siteName);
  // Titles usually end with the brand: "Emergency Plumber Leeds | Acme Plumbing".
  const seg = (home.title || '').split(/\s*[|–—•·»:]\s*|\s+-\s+/).map(x => x.trim()).filter(Boolean);
  if (seg.length > 1) cands.add(seg[seg.length - 1]);
  return [...cands].map(normalize).filter(c => c.length >= 4 && c.split(' ').length <= 4);
}

async function crawlCompetitor(rawUrl) {
  const u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
  const { pages, errors } = await crawlSite(u.href, { maxPages: PAGES_PER_COMPETITOR, deadlineMs: 30000 });
  const heads = new Set();
  for (const p of pages) {
    for (const h of [...p.h1, ...p.h2, ...p.h3]) {
      const n = normalize(h);
      const wc = n.split(' ').length;
      if (n && wc >= 2 && wc <= 6 && n.length <= 60) heads.add(n);
    }
  }
  const host = new URL(pages[0].url).hostname;
  return {
    id: crypto.randomBytes(4).toString('hex'),
    url: pages[0].url,
    host,
    name: pages[0].siteName || hostLabel(host).replace(/[-_]+/g, ' '),
    pages: pages.map(p => ({ url: p.url, title: p.title })),
    errors,
    headings: [...heads].slice(0, 120),
    brands: brandCandidates(pages, host),
    crawledAt: new Date().toISOString(),
  };
}

/**
 * Heading phrases competitors use that are close to your business (one word you already use)
 * but bring in something your own site does not mention (one word you do not).
 */
function findGaps(competitors, profile) {
  if (!profile) return [];
  // Only words that are not already yours count as brand words. Otherwise a rival called
  // "Zenith Heating" would hide every heading that mentions heating.
  const brandWords = new Set();
  const addBrand = w => { const t = stem(w); if (profile.uni[t] === undefined) brandWords.add(t); };
  for (const c of competitors) for (const b of c.brands || []) for (const w of words(b)) addBrand(w);
  for (const c of competitors) for (const w of words(c.name)) addBrand(w);

  const found = new Map();
  for (const c of competitors) {
    for (const h of c.headings) {
      const toks = contentTokens(h);
      if (!toks.length) continue;
      const known = toks.filter(t => profile.uni[t] !== undefined).length;
      const fresh = toks.filter(t => profile.uni[t] === undefined && !brandWords.has(t)).length;
      const hasBrand = toks.some(t => brandWords.has(t));
      if (known < 1 || fresh < 1 || hasBrand) continue;
      const e = found.get(h) || { phrase: h, competitors: new Set() };
      e.competitors.add(c.name);
      found.set(h, e);
    }
  }
  return [...found.values()]
    .map(e => ({ phrase: e.phrase, competitors: [...e.competitors] }))
    .sort((a, b) => b.competitors.length - a.competitors.length || a.phrase.length - b.phrase.length)
    .slice(0, 40);
}

module.exports = { crawlCompetitor, findGaps, MAX_COMPETITORS, hostLabel, brandCandidates };
