'use strict';

const { contentTokens, bigrams, normalize, stem } = require('./nlp');

const TOP_UNI = 220;
const TOP_BI = 120;

function splitList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

// Places named after "in", "near", "across" and similar. Best effort, capitalised words only.
function findLocations(texts) {
  const out = new Set();
  const re = /\b(?:in|near|across|around|serving|throughout|based in|covering)\s+((?:[A-Z][\p{L}'-]+)(?:\s+(?:[A-Z][\p{L}'-]+))?)/gu;
  for (const t of texts) {
    for (const m of String(t || '').matchAll(re)) {
      for (const w of m[1].split(/\s+/)) for (const tok of contentTokens(w)) out.add(tok);
    }
  }
  return [...out];
}

/**
 * Build the relevance profile from crawled pages plus what the user told us.
 * User-written text counts most, because it says what they actually sell.
 */
function buildProfile({ project, pages, extraTerms = [] }) {
  const uni = new Map();
  const bi = new Map();
  const surface = new Map(); // stem -> most common raw word for display
  const declared = new Set();
  const declaredUser = new Set();

  const add = (text, weight, { declare = false, phrases = true, user = false } = {}) => {
    const toks = contentTokens(text);
    const counts = new Map();
    for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, c] of counts) {
      uni.set(t, (uni.get(t) || 0) + weight * (1 + Math.log(c)));
      if (declare) declared.add(t);
      if (user) declaredUser.add(t);
    }
    if (phrases) {
      // Fragments are split on " . " so phrases never straddle two headings.
      for (const frag of String(text || '').split(/\s\.\s|\n/)) {
        for (const b of bigrams(contentTokens(frag))) bi.set(b, (bi.get(b) || 0) + weight);
      }
    }
    for (const w of normalize(text).split(' ')) {
      const s = stem(w);
      if (!surface.has(s) || w.length < surface.get(s).length) surface.set(s, w);
    }
  };

  const seeds = splitList(project.seeds);
  add(project.description, 3, { declare: true, user: true });
  for (const o of splitList(project.offerings)) add(o, 3, { declare: true, user: true });
  for (const s of seeds) add(s, 4, { declare: true, user: true });
  for (const t of extraTerms) add(t, 3, { declare: true });

  for (const p of pages) {
    add(p.title, 3, { declare: true });
    add(p.description, 2.5, { declare: true });
    add(p.metaKeywords, 2, { declare: true });
    add(p.h1.join(' . '), 3, { declare: true });
    add(p.h2.join(' . '), 1.5);
    add(p.h3.join(' . '), 0.8);
    add(p.alts.join(' . '), 0.5, { phrases: false });
    add(p.text, 0.25, { phrases: false });
  }

  // Bigrams from body text are skipped on purpose, they add noise. Headings and user text carry the phrases.
  const rank = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const topUni = rank(uni).slice(0, TOP_UNI);
  const topBi = rank(bi).filter(([, w]) => w >= 3).slice(0, TOP_BI);
  const maxU = topUni.length ? topUni[0][1] : 1;
  const maxB = topBi.length ? topBi[0][1] : 1;

  const uniObj = {}, biObj = {};
  for (const [t, w] of topUni) uniObj[t] = Math.round(Math.sqrt(w / maxU) * 1000) / 1000;
  for (const [t, w] of topBi) biObj[t] = Math.round(Math.sqrt(w / maxB) * 1000) / 1000;

  // Where the owner says they work counts as a place, and places alone never make a keyword relevant.
  const areaTokens = contentTokens(project.serviceArea || '');
  for (const t of areaTokens) if (uniObj[t] === undefined) uniObj[t] = 0.3;
  const locations = findLocations([
    project.description, project.offerings,
    ...pages.flatMap(p => [p.title, p.description, ...p.h1, ...p.h2]),
  ]);

  const show = t => t.split(' ').map(x => surface.get(x) || x).join(' ');
  return {
    builtAt: new Date().toISOString(),
    uni: uniObj,
    bi: biObj,
    declared: [...declared],
    declaredUser: [...declaredUser],
    locations: [...new Set([...locations, ...areaTokens])],
    seedStems: seeds.map(s => contentTokens(s)).filter(a => a.length),
    topTerms: topUni.slice(0, 30).map(([t]) => show(t)),
    topPhrases: topBi.slice(0, 15).map(([t]) => show(t)),
    surface: Object.fromEntries([...surface.entries()].filter(([s]) => uniObj[s] !== undefined)),
  };
}

module.exports = { buildProfile, splitList };
