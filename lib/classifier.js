'use strict';

const { normalize, words, stem, contentTokens, bigrams, STOP } = require('./nlp');

// Hard negatives: almost never a buyer. Each group has a label shown to the user.
const HARD_NEGATIVES = [
  { reason: 'Job seekers', re: /\b(jobs?|careers?|salary|salaries|hiring|internships?|resume|cv|vacanc(y|ies)|apprenticeships?|recruitment|work from home)\b/ },
  { reason: 'Freebie seekers', re: /\b(free|freebies?|gratis|no cost)\b/, unlessDeclared: ['free'], except: /\bfree (quote|estimate|consultation|consult|trial|shipping|delivery|demo|inspection|assessment|audit|appointment|evaluation|call|survey|installation)s?\b/ },
  { reason: 'Piracy or cracked software', re: /\b(torrent|cracked?|keygen|nulled|pirated|warez|serial key|mod apk)\b/ },
  { reason: 'Support or login queries', re: /\b(log ?in|sign ?in|customer (service|care|support)|contact number|phone number|toll free|helpline|complaints?|refund policy|unsubscribe|tracking number)\b/ },
  { reason: 'Legal trouble or scams', re: /\b(lawsuits?|scam|scams|fraud|class action|reviews? complaints?)\b/ },
  { reason: 'Reference or media sites', re: /\b(wiki|wikipedia|reddit|quora|youtube|pinterest|imdb|pdf|ppt|slideshare)\b/ },
];

// Informational: people researching, not shopping. Negative in strict mode, review otherwise.
const INFORMATIONAL_START = /^(how|what|whats|why|when|who|which|can|does|do|is|are|should|will|where)\b/;
const INFORMATIONAL_ANY = /\b(tutorials?|guides?|tips|ideas|examples?|definitions?|meanings?|explained|difference between|diy|do it yourself|lessons?|courses?|classes|training|certifications?|degree|university|college|school|syllabus|homework|essay|checklist|statistics|facts|history of)\b/;

const TRANSACTIONAL = /\b(buy|order|book|hire|quote|quotes|near me|nearby|price|prices|pricing|cost|costs|cheap|cheapest|affordable|for sale|rental|rent|purchase|shop|deals?|discounts?|coupons?|appointment|schedule|emergency|same day|24 hour|24 7|installation|repair|estimate|booking)\b/;
const COMMERCIAL = /\b(best|top|compare|comparison|vs|versus|reviews?|alternatives?|company|companies|agency|agencies|providers?|services?|consultants?|suppliers?|experts?|specialists?|professionals?|firms?|contractors?|solutions?|software|tools?)\b/;

function detectIntent(kw) {
  if (INFORMATIONAL_START.test(kw) || INFORMATIONAL_ANY.test(kw)) return 'informational';
  if (TRANSACTIONAL.test(kw)) return 'transactional';
  if (COMMERCIAL.test(kw)) return 'commercial';
  return 'unclear';
}

function relevance(kw, profile) {
  const toks = [...new Set(contentTokens(kw))];
  if (!toks.length) return { rel: 0, matched: 0, total: 0 };
  const uni = profile.uni;
  const places = new Set(profile.locations || []);
  let sum = 0, matched = 0, placeMatches = 0;
  for (const t of toks) {
    const w = uni[t];
    if (w !== undefined) { sum += w; matched++; if (places.has(t)) placeMatches++; }
  }
  const coverage = matched / toks.length;
  const avgW = sum / toks.length;
  let rel = 0.5 * coverage + 0.5 * avgW;

  // Phrases the site actually uses in headings and copy.
  const kwBi = bigrams(contentTokens(kw));
  if (kwBi.some(b => profile.bi[b] !== undefined)) rel += 0.15;

  // Overlap with the seed keywords the user typed in.
  const set = new Set(toks);
  for (const seed of profile.seedStems || []) {
    if (seed.every(s => set.has(s)) || (toks.length >= 1 && toks.every(t => seed.includes(t)) && toks.length >= Math.min(2, seed.length))) {
      rel += 0.25;
      break;
    }
  }
  // A place name on its own says nothing about what is being searched for.
  const locationOnly = matched > 0 && placeMatches === matched;
  if (locationOnly) rel = Math.min(rel, 0.2);
  return { rel: Math.min(1, rel), matched, total: toks.length, locationOnly };
}

function hardNegative(kw, declaredSet, excludeList) {
  const n = normalize(kw);
  for (const ex of excludeList) {
    const e = normalize(ex);
    if (e && new RegExp('(^| )' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(n)) return 'Excluded by you';
  }
  for (const g of HARD_NEGATIVES) {
    if (!g.re.test(n)) continue;
    if (g.except && g.except.test(n)) continue;
    if (g.unlessDeclared && g.unlessDeclared.some(w => declaredSet.has(stem(w)))) continue;
    // If the user's own brief uses the trigger word (a job board selling "jobs"), let it through.
    const trig = n.match(g.re)[0].split(' ').map(stem);
    if (trig.every(t => declaredSet.has(t))) continue;
    return g.reason;
  }
  return null;
}

function classifyOne(row, profile, opts) {
  const kw = row.keyword;
  const declared = opts.declared;
  const intent = detectIntent(normalize(kw));
  const { rel, matched, locationOnly } = relevance(kw, profile);
  const wc = words(kw).length;

  let category, reason;
  const hard = hardNegative(kw, declared, opts.exclude);

  if (hard) {
    category = 'negative';
    reason = hard;
  } else if (rel < 0.12) {
    category = 'negative';
    reason = matched === 0 ? 'Nothing here matches your site or offer' : 'Barely related to your offer';
  } else if (locationOnly) {
    category = 'review';
    reason = 'Only the location matches, not what you sell';
  } else if (intent === 'informational') {
    if (opts.strictness === 'strict') { category = 'negative'; reason = 'Research intent, unlikely to buy'; }
    else { category = 'review'; reason = 'Research intent, better for content than ads'; }
  } else if ((rel >= 0.45 && (intent === 'transactional' || intent === 'commercial')) || rel >= 0.7) {
    category = 'priority';
    reason = intent === 'unclear' ? 'Strong match to your offer' : 'Strong match with ' + intent + ' intent';
  } else if (rel >= 0.3) {
    category = 'relevant';
    reason = 'Related to your offer, weaker buying signal';
  } else {
    category = 'review';
    reason = 'Loosely related, check before using';
  }

  let score = rel * 70;
  if (intent === 'transactional') score += 20;
  else if (intent === 'commercial') score += 12;
  else if (intent === 'unclear') score += 5;
  if (row.volume) score += Math.min(10, Math.log10(row.volume + 1) * 2);
  if (category === 'negative') score = Math.min(score, 15);
  score = Math.round(Math.max(0, Math.min(100, score)));

  let matchType;
  if (category === 'negative') matchType = wc === 1 ? 'Negative Broad' : 'Negative Phrase';
  else if (category === 'priority') matchType = wc >= 3 ? 'Exact' : 'Phrase';
  else if (category === 'relevant') matchType = 'Phrase';
  else matchType = '';

  return { category, reason, intent, score, matchType, relevance: Math.round(rel * 100) / 100 };
}

function classifyAll(keywords, profile, project) {
  const opts = {
    declared: new Set(profile.declaredUser || []),
    exclude: (project.exclude || []),
    strictness: project.strictness || 'balanced',
  };
  for (const row of keywords) {
    if (row.overridden) continue;
    Object.assign(row, classifyOne(row, profile, opts), { aiChecked: false });
  }
  return keywords;
}

/** Words that repeat across negatives and are absent from the profile: candidates for account-level negatives. */
function suggestNegativeWords(keywords, profile) {
  const counts = new Map();
  const raw = new Map();
  for (const k of keywords) {
    if (k.category !== 'negative') continue;
    for (const w of new Set(words(k.keyword))) {
      if (STOP.has(w) || w.length < 3) continue;
      const s = stem(w);
      if (profile.uni[s] !== undefined || (profile.declared || []).includes(s)) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
      if (!raw.has(s) || w.length < raw.get(s).length) raw.set(s, w);
    }
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([s, c]) => ({ word: raw.get(s), count: c }));
}

/** Group good keywords by their strongest profile term, as a starting point for ad groups. */
function suggestAdGroups(keywords, profile) {
  const groups = new Map();
  for (const k of keywords) {
    if (k.category !== 'priority' && k.category !== 'relevant') continue;
    const toks = contentTokens(k.keyword);
    let best = null, bw = -1;
    for (const t of toks) {
      const w = profile.uni[t] ?? 0;
      if (w > bw) { bw = w; best = t; }
    }
    if (!best) continue;
    if (!groups.has(best)) groups.set(best, []);
    groups.get(best).push(k.id);
  }
  const named = [...groups.entries()].map(([stemmed, ids]) => ({
    name: (profile.surface && profile.surface[stemmed]) || stemmed,
    ids,
  }));
  const multi = named.filter(g => g.ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length).slice(0, 15);
  const rest = named.filter(g => g.ids.length < 2).flatMap(g => g.ids);
  if (rest.length) multi.push({ name: 'Other', ids: rest });
  return multi.map(g => ({ name: g.name.replace(/^./, c => c.toUpperCase()), ids: g.ids }));
}

module.exports = { classifyAll, classifyOne, detectIntent, relevance, suggestNegativeWords, suggestAdGroups };
