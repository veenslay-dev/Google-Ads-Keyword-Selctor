'use strict';

const { classifyOne, buildOpts } = require('./classifier');

const ACTIONS = ['block', 'watch', 'add', 'ignore'];
const round = n => Math.round(n * 100) / 100;

/**
 * Judge each search term from a live campaign.
 *  block  : spent money and either does not fit the business or has had enough clicks to judge
 *  watch  : spent money, fits the business, too few clicks to call it yet
 *  add    : converted, worth targeting on purpose
 *  ignore : no spend, or already excluded
 * "Enough clicks" comes from the account's own conversion rate, so a 1% account and a 10% account get different bars.
 */
function analyzeTerms(terms, profile, project) {
  const sum = f => terms.reduce((a, t) => a + (t[f] || 0), 0);
  const totalClicks = sum('clicks'), totalCost = sum('cost'), totalConv = sum('conversions');
  const convRate = totalClicks ? totalConv / totalClicks : 0;
  const avgCpa = totalConv ? totalCost / totalConv : null;
  const neededClicks = convRate > 0 ? Math.min(200, Math.max(10, Math.ceil(3 / convRate))) : 30;
  const opts = profile ? buildOpts(profile, project) : null;

  for (const t of terms) {
    if (t.overridden) continue;
    const cost = t.cost || 0, clicks = t.clicks || 0, conv = t.conversions || 0;
    const fit = opts ? classifyOne({ keyword: t.term }, profile, opts) : null;
    t.fit = fit ? fit.category : null;
    t.matchType = '';
    if (t.status === 'Excluded') {
      t.action = 'ignore'; t.reason = 'Already excluded in your account';
    } else if (conv > 0) {
      t.action = t.status === 'Added' ? 'ignore' : 'add';
      t.reason = t.status === 'Added'
        ? 'Converts and is already a keyword'
        : `${round(conv)} conversion${conv === 1 ? '' : 's'}` + (cost ? `, ${round(cost / conv)} per conversion` : '');
      if (t.action === 'add') t.matchType = t.term.split(' ').length >= 3 ? 'Exact' : 'Phrase';
    } else if (cost <= 0 && clicks === 0) {
      t.action = 'ignore'; t.reason = 'No clicks, nothing lost';
    } else if (fit && fit.category === 'negative') {
      t.action = 'block';
      t.reason = fit.reason + `, ${clicks} click${clicks === 1 ? '' : 's'} and ${round(cost)} spent`;
      t.matchType = t.term.split(' ').length === 1 ? 'Negative Broad' : 'Negative Phrase';
    } else if (clicks >= neededClicks || (avgCpa && cost >= 2 * avgCpa)) {
      t.action = 'block';
      t.reason = `${clicks} clicks and ${round(cost)} spent with no conversions`;
      t.matchType = 'Negative Exact';
    } else {
      t.action = 'watch';
      t.reason = `Fits your offer. ${clicks} of about ${neededClicks} clicks needed before judging`;
    }
  }

  const by = a => terms.filter(t => t.action === a);
  return {
    terms: terms.length,
    totalCost: round(totalCost), totalConv: round(totalConv), totalClicks,
    convRate: round(convRate * 100), avgCpa: avgCpa === null ? null : round(avgCpa), neededClicks,
    blockCount: by('block').length, watchCount: by('watch').length, addCount: by('add').length,
    wasteCost: round(by('block').reduce((a, t) => a + (t.cost || 0), 0)),
    watchCost: round(by('watch').reduce((a, t) => a + (t.cost || 0), 0)),
    hasProfile: Boolean(profile),
  };
}

module.exports = { analyzeTerms, ACTIONS };
