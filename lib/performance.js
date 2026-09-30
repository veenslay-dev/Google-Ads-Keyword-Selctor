'use strict';

// Real campaign numbers (clicks, cost, conversions) are stronger evidence than any guess about wording.
// Rows that carry them are judged here, and the same rows stay in the normal keyword list.
const { classifyOne, buildOpts } = require('./classifier');

const round = n => Math.round(n * 100) / 100;
const hasPerf = r => r.clicks != null || r.cost != null || r.conversions != null;

const matchFor = (kw, cat) => cat === 'negative' ? (kw.includes(' ') ? 'Negative Phrase' : 'Negative Broad')
  : cat === 'priority' ? (kw.split(' ').length >= 3 ? 'Exact' : 'Phrase') : cat === 'relevant' ? 'Phrase' : '';

/**
 * Evidence from the account overrides wording-based verdicts in three cases:
 *   converted            -> priority
 *   already excluded     -> negative
 *   spent, never converted, and either off-topic or past the click bar -> negative
 * The click bar is about three times the clicks a conversion usually takes at this account's own rate.
 * Everything else keeps its verdict and only gets a note about how much data exists.
 */
function applyPerformance(p) {
  const rows = p.keywords.filter(hasPerf);
  for (const r of p.keywords) { r.perfLocked = false; r.note = undefined; }
  if (!rows.length) { p.perfSummary = null; return null; }

  const sum = f => rows.reduce((a, r) => a + (r[f] || 0), 0);
  const clicks = sum('clicks'), cost = sum('cost'), conv = sum('conversions');
  const convRate = clicks ? conv / clicks : 0;
  const avgCpa = conv ? cost / conv : null;
  const needed = convRate > 0 ? Math.min(200, Math.max(10, Math.ceil(3 / convRate))) : 30;
  const opts = p.profile ? buildOpts(p.profile, p) : null;

  for (const r of rows) {
    if (r.overridden) continue;
    const c = r.cost || 0, k = r.clicks || 0, v = r.conversions || 0;
    const lock = (category, reason) => {
      r.category = category; r.reason = reason; r.source = 'performance'; r.perfLocked = true;
      r.matchType = matchFor(r.keyword, category); r.confidence = undefined;
      if (category === 'negative' && r.matchType === 'Negative Phrase' && !reason.startsWith('Already')) r.matchType = 'Negative Exact';
    };
    if (r.status === 'Excluded') lock('negative', 'Already excluded in your account');
    else if (v > 0) lock('priority', r.status === 'Added' ? 'Converts and is already a keyword' : `Converted: ${round(v)} conversion${v === 1 ? '' : 's'}` + (c ? `, ${round(c / v)} each` : ''));
    else if (c > 0 || k > 0) {
      const offTopic = r.category === 'negative' || (opts && !r.source && classifyOne(r, p.profile, opts).category === 'negative');
      if (offTopic) {
        r.note = `${k} click${k === 1 ? '' : 's'} and ${round(c)} spent`;
      } else if (k >= needed || (avgCpa && c >= 2 * avgCpa)) {
        lock('negative', `${k} clicks and ${round(c)} spent with no conversions`);
      } else {
        r.note = `${k} of about ${needed} clicks needed to judge the spend`;
      }
    }
  }

  const waste = rows.filter(r => r.category === 'negative' && (r.cost || 0) > 0 && !(r.conversions > 0));
  p.perfSummary = {
    rows: rows.length, totalCost: round(cost), totalClicks: clicks, totalConv: round(conv),
    convRate: round(convRate * 100), avgCpa: avgCpa === null ? null : round(avgCpa), neededClicks: needed,
    wasteCost: round(waste.reduce((a, r) => a + r.cost, 0)), wasteCount: waste.length,
    winners: rows.filter(r => r.conversions > 0).length,
  };
  return p.perfSummary;
}

module.exports = { applyPerformance, hasPerf, matchFor };
