'use strict';

const MAX_KEYWORDS = 1000;

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"' && cell === '') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 10);
  let best = null, bestScore = 0;
  for (const d of ['\t', ',', ';']) {
    const hits = lines.filter(l => l.includes(d)).length;
    if (hits > bestScore) { best = d; bestScore = hits; }
  }
  return bestScore >= Math.max(2, Math.ceil(lines.length / 2)) ? best : null;
}

const KW_HEADER = /^(keywords?|keyword text|search terms?|search quer(y|ies)|quer(y|ies)|top quer(y|ies)|phrases?|terms?|keyword \(by relevance\)|seed keyword)$/i;

const METRICS = {
  volume: /(avg\.?\s*monthly|monthly searches|search volume|^volume$|^sv$|^searches$)/i,
  competition: /^(competition|keyword difficulty|^kd$|difficulty)$/i,
  bid: /(top of page bid.*high|top of page bid|^cpc|avg\.? cpc|suggested bid|^bid$)/i,
  impressions: /^(impr\.?|impressions)$/i,
  clicks: /^clicks$/i,
  cost: /^cost$/i,
  conversions: /^(conv\.?|conversions)$/i,
  convValue: /^(conv\.? value|conversion value|all conv\.? value)$/i,
};
// Text columns kept as they are when a value is not a number.
const TEXT_COLS = { competition: true, status: /^added\/excluded$/i };
const SUMMED = ['impressions', 'clicks', 'cost', 'conversions', 'convValue'];

function parseNum(v) {
  if (v == null) return null;
  let s = String(v).trim().toLowerCase();
  if (!s || s === '-' || s === '--') return null;
  // Keyword Planner ranges like "1K – 10K": keep the lower bound.
  s = s.split(/[–—-]{1}\s*(?=\d)/)[0].trim();
  const m = s.replace(/[,\s$£€₹]/g, '').match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) * 100) / 100;
}

// Strip Google Ads match type decoration: [exact], "phrase", +broad +modifier.
function cleanKeyword(k) {
  let s = String(k || '').trim();
  s = s.replace(/^[\[\"]+|[\]\"]+$/g, '').replace(/(^|\s)\+/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Turn pasted text or an uploaded sheet into keyword rows.
 * Returns { rows: [{keyword, volume?, ...}], skipped, note }
 */
function extractKeywords(text, { aggregate = false } = {}) {
  text = String(text || '').replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  let rows = [];
  let note = '';

  if (delim) {
    const grid = parseDelimited(text, delim);
    let headerIdx = -1, kwCol = -1;
    for (let i = 0; i < Math.min(grid.length, 8) && headerIdx < 0; i++) {
      const j = grid[i].findIndex(c => KW_HEADER.test(c.trim()));
      if (j >= 0) { headerIdx = i; kwCol = j; }
    }
    if (headerIdx >= 0) {
      const header = grid[headerIdx].map(h => h.trim());
      const cols = {};
      for (const [key, re] of Object.entries(METRICS)) {
        const j = header.findIndex((h, idx) => idx !== kwCol && re.test(h));
        if (j >= 0) cols[key] = j;
      }
      if (aggregate) {
        const j = header.findIndex((h, idx) => idx !== kwCol && TEXT_COLS.status.test(h));
        if (j >= 0) cols.status = j;
      }
      for (const r of grid.slice(headerIdx + 1)) {
        const kw = cleanKeyword(r[kwCol]);
        if (!kw || /^total\b\s*:/i.test(kw)) continue;
        const row = { keyword: kw };
        for (const [key, j] of Object.entries(cols)) {
          const num = parseNum(r[j]);
          const val = (key === 'competition' || key === 'status') && num === null ? (r[j] || '').trim() : num;
          if (val !== null && val !== '' && !(key === 'status' && /^(none|--)$/i.test(val))) row[key] = val;
        }
        rows.push(row);
      }
      note = 'Read the "' + header[kwCol] + '" column' + (Object.keys(cols).length ? ' plus ' + Object.keys(cols).join(', ') : '') + '.';
    } else if (delim === '\t') {
      rows = grid.map(r => ({ keyword: cleanKeyword(r[0]) })).filter(r => r.keyword);
      note = 'No header found, used the first column.';
    }
  }

  if (!rows.length) {
    let lines = text.split(/\r?\n/).map(cleanKeyword).filter(Boolean);
    if (lines.length === 1 && lines[0].includes(',')) lines = lines[0].split(',').map(cleanKeyword).filter(Boolean);
    rows = lines.map(k => ({ keyword: k }));
  }

  const seen = new Map();
  const out = [];
  let skipped = 0;
  const maxLen = aggregate ? 120 : 80, maxWords = aggregate ? 14 : 10;
  for (const r of rows) {
    const key = r.keyword.toLowerCase();
    const wc = key.split(' ').length;
    if (key.length > maxLen || wc > maxWords || key.length < 2 || /^(keyword|search term)s?$/.test(key)) { skipped++; continue; }
    if (seen.has(key)) {
      // A search terms report lists the same term once per campaign or match type, so add those up.
      if (aggregate) {
        const first = seen.get(key);
        for (const f of SUMMED) if (r[f] != null) first[f] = Math.round(((first[f] || 0) + r[f]) * 100) / 100;
        if (r.status === 'Excluded') first.status = 'Excluded';
      } else skipped++;
      continue;
    }
    seen.set(key, r);
    out.push(r);
  }
  return { rows: out, skipped, note };
}

module.exports = { MAX_KEYWORDS, parseDelimited, detectDelimiter, extractKeywords, cleanKeyword, parseNum };
