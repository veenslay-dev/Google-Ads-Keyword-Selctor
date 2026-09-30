'use strict';

// Optional. Set ANTHROPIC_API_KEY to turn this on. Everything else works without it.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

async function ask(system, user, maxTokens = 2000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('Anthropic API ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

function parseJson(text) {
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new Error('No JSON in model reply');
  return JSON.parse(m[0]);
}

async function describeBusiness(project, pages) {
  const digest = pages.slice(0, 6).map(p =>
    `URL: ${p.url}\nTitle: ${p.title}\nMeta: ${p.description}\nH1: ${p.h1.join(' | ')}\nH2: ${p.h2.slice(0, 10).join(' | ')}\nText: ${p.text.slice(0, 900)}`
  ).join('\n\n');
  const out = await ask(
    'You analyse small business websites for Google Ads keyword planning. Reply with JSON only.',
    `The owner describes the business as:\n${project.description || '(nothing)'}\n\nServices or products they listed:\n${project.offerings || '(nothing)'}\n\nCrawled pages:\n${digest}\n\n` +
    'Return {"summary": "2-3 plain sentences on what they sell and to whom", "offerings": ["specific products or services, max 15"], "not_offered": ["things a searcher might want that this business clearly does not sell, max 10"]}',
    1200
  );
  const j = parseJson(out);
  return {
    summary: String(j.summary || ''),
    offerings: Array.isArray(j.offerings) ? j.offerings.map(String).slice(0, 15) : [],
    notOffered: Array.isArray(j.not_offered) ? j.not_offered.map(String).slice(0, 10) : [],
  };
}

// Only the borderline rows are sent, to keep cost and latency low.
async function judgeKeywords(project, profile, rows) {
  const verdicts = new Map();
  const context = `Business: ${profile.summary || project.description}\nOfferings: ${(profile.aiOfferings || []).join(', ') || project.offerings}\nNot offered: ${(profile.notOffered || []).join(', ') || 'unknown'}\nUser excludes: ${(project.exclude || []).join(', ') || 'none'}`;
  for (let i = 0; i < rows.length; i += 80) {
    const batch = rows.slice(i, i + 80);
    const list = batch.map((r, j) => `${j}. ${r.keyword}`).join('\n');
    try {
      const out = await ask(
        'You sort search keywords for a Google Ads account. Labels: priority (would buy, target it), relevant (related, test it), review (unclear), negative (wrong audience or wrong product, block it). Reply with JSON only.',
        `${context}\n\nKeywords:\n${list}\n\nReturn a JSON array like [{"i":0,"label":"priority","reason":"short reason"}] covering every keyword.`,
        4000
      );
      for (const v of parseJson(out)) {
        const row = batch[v.i];
        if (row && ['priority', 'relevant', 'review', 'negative'].includes(v.label)) verdicts.set(row.id, { label: v.label, reason: String(v.reason || '').slice(0, 120) });
      }
    } catch (e) {
      verdicts.error = e.message;
    }
  }
  return verdicts;
}

module.exports = { enabled, describeBusiness, judgeKeywords, MODEL };
