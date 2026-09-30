'use strict';

// US dollars per one million tokens. These are starting estimates and OpenAI changes its prices, so the
// admin Settings page lets you overwrite any row. The bill from OpenAI is always the real number.
const DEFAULTS = {
  'gpt-4.1': { in: 2, out: 8, cached: 0.5 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cached: 0.1 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4, cached: 0.025 },
  'gpt-4o': { in: 2.5, out: 10, cached: 1.25 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cached: 0.075 },
  'gpt-5': { in: 1.25, out: 10, cached: 0.125 },
  'gpt-5-mini': { in: 0.25, out: 2, cached: 0.025 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cached: 0.005 },
};

// A dated model name such as "gpt-4.1-2025-04-14" uses the price of the longest name it starts with.
function priceFor(model, overrides = {}) {
  const table = { ...DEFAULTS, ...overrides };
  if (table[model]) return { ...table[model], source: overrides[model] ? 'set by you' : 'built in' };
  const hit = Object.keys(table).filter(k => model.startsWith(k + '-') || model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? { ...table[hit], source: overrides[hit] ? 'set by you' : 'built in' } : null;
}

// Cost of a group of calls. Cached prompt tokens are cheaper, and every model not in the table counts as zero and is reported.
function costOf(row, overrides) {
  const price = priceFor(row.model, overrides);
  if (!price) return { cost: 0, known: false };
  const cached = Math.min(row.cached || 0, row.prompt || 0);
  const cost = ((row.prompt - cached) * price.in + cached * (price.cached ?? price.in) + (row.completion || 0) * price.out) / 1e6;
  return { cost, known: true };
}

function sumCost(rows, overrides) {
  let cost = 0;
  const unknown = new Set();
  for (const r of rows) {
    const c = costOf(r, overrides);
    cost += c.cost;
    if (!c.known) unknown.add(r.model);
  }
  return { cost, unknown: [...unknown] };
}

const money = n => '$' + (n < 10 ? n.toFixed(n < 0.1 && n > 0 ? 4 : 2) : n.toFixed(2));

module.exports = { DEFAULTS, priceFor, costOf, sumCost, money };
