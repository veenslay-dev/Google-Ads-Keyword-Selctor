'use strict';

// OpenAI chat completions with structured output. Turned on by OPENAI_API_KEY.
// OPENAI_MODEL picks the model, OPENAI_BASE_URL lets tests and proxies stand in for the real API.
const enabled = () => Boolean(process.env.OPENAI_API_KEY);
const model = () => process.env.OPENAI_MODEL || 'gpt-4.1';
const baseUrl = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

class OpenAIError extends Error {
  constructor(message, status, fatal) { super(message); this.status = status; this.fatal = Boolean(fatal); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chat({ system, user, name, schema, maxTokens = 6000 }) {
  let useSchema = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = {
      model: model(),
      messages: [{ role: 'system', content: system }, { role: 'user', content: useSchema ? user : user + '\n\nReply with a single JSON object only.' }],
      max_completion_tokens: maxTokens,
      response_format: useSchema ? { type: 'json_schema', json_schema: { name, strict: true, schema } } : { type: 'json_object' },
    };
    let res;
    try {
      res = await fetch(baseUrl() + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      if (attempt < 3) { await sleep(1200 * (attempt + 1)); continue; }
      throw new OpenAIError('Could not reach OpenAI: ' + e.message, 0, false);
    }
    if (res.ok) {
      const data = await res.json();
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new OpenAIError('OpenAI sent an empty reply.', 200, false);
      if (msg.refusal) throw new OpenAIError('OpenAI declined this request: ' + msg.refusal, 200, false);
      try { return JSON.parse(msg.content); }
      catch { if (attempt < 3) continue; throw new OpenAIError('OpenAI sent a reply that was not valid JSON.', 200, false); }
    }
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* keep empty */ }
    if (res.status === 400 && useSchema && /response_format|json_schema|structured/i.test(detail)) { useSchema = false; continue; }
    if (res.status === 401) throw new OpenAIError('OpenAI rejected the API key. Check OPENAI_API_KEY on the server.', 401, true);
    if (res.status === 403 || res.status === 404) throw new OpenAIError(detail || 'OpenAI refused the request (' + res.status + '). Check the key and OPENAI_MODEL.', res.status, true);
    if (res.status === 429 && /quota|billing/i.test(detail)) throw new OpenAIError('The OpenAI account is out of credit: ' + detail, 429, true);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
    throw new OpenAIError(detail || 'OpenAI error ' + res.status, res.status, false);
  }
  throw new OpenAIError('OpenAI did not answer after several tries.', 0, false);
}

const str = { type: 'string' };
const strList = { type: 'array', items: str };

/* ---------- what the business is ---------- */
async function describeBusiness(project, pages) {
  const digest = pages.slice(0, 6).map(p =>
    `URL: ${p.url}\nTitle: ${p.title}\nMeta: ${p.description}\nH1: ${p.h1.join(' | ')}\nH2: ${p.h2.slice(0, 12).join(' | ')}\nText: ${p.text.slice(0, 1000)}`).join('\n\n');
  const j = await chat({
    system: 'You study small business websites so that a Google Ads specialist can judge search queries for them. Be concrete and only state what the material supports.',
    user: `The owner says:\nAbout: ${project.description || '(nothing)'}\nProducts or services: ${project.offerings || '(nothing)'}\nWhere they serve: ${project.serviceArea || '(not stated)'}\n\nPages read:\n${digest || '(website could not be read)'}`,
    name: 'business_profile',
    schema: {
      type: 'object', additionalProperties: false, required: ['summary', 'offerings', 'not_offered', 'areas_served'],
      properties: { summary: str, offerings: strList, not_offered: strList, areas_served: strList },
    },
    maxTokens: 1500,
  });
  const list = (a, n) => (Array.isArray(a) ? a.map(String).filter(Boolean).slice(0, n) : []);
  return { summary: String(j.summary || ''), offerings: list(j.offerings, 20), notOffered: list(j.not_offered, 15), areasServed: list(j.areas_served, 10) };
}

/* ---------- judging keywords ---------- */
const LABELS = ['priority', 'relevant', 'review', 'negative'];
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['i', 'label', 'confidence', 'intent', 'reason'],
        properties: {
          i: { type: 'integer' },
          label: { type: 'string', enum: LABELS },
          confidence: { type: 'integer' },
          intent: { type: 'string', enum: ['transactional', 'commercial', 'informational', 'navigational'] },
          reason: str,
        },
      },
    },
  },
};

const SPECIALIST = `You are a senior Google Ads search specialist with more than 20 years of experience running paid search for service and product businesses. You decide, query by query, whether this advertiser should pay for clicks on it.

Labels:
- priority: the searcher clearly wants to buy, hire or enquire about something this advertiser sells, in a place they serve. Includes shopping questions such as "which is the best X in Y", "how much does X cost" and "X near me".
- relevant: clearly related to what they sell, but intent is broader or weaker. Worth testing in a separate ad group.
- review: honestly ambiguous. A human should look. Use it when you truly cannot tell, never as a dumping ground.
- negative: clicking would waste money on this advertiser. Wrong product or service, job seekers, people wanting it free or DIY when the business charges, research with no buying path, support or login queries, competitor brand names, places the advertiser does not serve, unrelated topics.

How to judge:
- Decide what the person typing it wants, then whether THIS advertiser can give it to them. Read the advertiser details closely. Same words can be a buyer for one business and waste for another.
- Question-shaped queries are not automatically research. "Which is the best NRI tax consultant in Mumbai?" is a buyer. "What is a tax advisory service?" is not.
- Account data beats guessing. If a query shows clicks and cost but no conversions and it does not fit, it is negative. Conversions mean priority.
- Follow the owner's past corrections below. They show how this owner draws the line.
- confidence is 0 to 100 and must be honest. Use 90 or more only when the answer is obvious. Use under 70 when a reasonable specialist could disagree.
- reason is at most 14 words, specific to the query, with no filler.
Return one result for every numbered query.`;

function contextText(ctx) {
  const lines = [
    'ADVERTISER',
    `Business: ${ctx.summary || ctx.description || '(not described)'}`,
    `Website: ${ctx.url || '(none)'}`,
    `Sells: ${ctx.offerings || '(not listed)'}`,
    `Serves: ${ctx.serviceArea || '(not stated)'}`,
    `Keywords the owner wants: ${ctx.seeds || '(none given)'}`,
    `Does NOT sell or owner excludes: ${ctx.excludes || '(none given)'}`,
    `Competitor brands (never buy their searches): ${ctx.brands || '(none)'}`,
    `Research-style queries (how to, what is, courses): ${ctx.strict ? 'the owner wants these as negative' : 'label review unless there is a buying path'}`,
  ];
  if (ctx.examples && ctx.examples.length) {
    lines.push('', 'OWNER CORRECTIONS FROM EARLIER (learn from these):', ...ctx.examples.map(e => `- "${e.keyword}" belongs in ${e.to}${e.from ? ' (tool had said ' + e.from + ')' : ''}`));
  }
  if (ctx.perf) lines.push('', `ACCOUNT BASELINE: about ${ctx.perf.convRate}% of clicks convert${ctx.perf.avgCpa ? ', ' + ctx.perf.avgCpa + ' per conversion' : ''}.`);
  return lines.join('\n');
}

const queryLine = r => `${r.i}. ${r.keyword}` + (r.perf ? ` [${r.perf}]` : '');

function toMap(j, rows) {
  const valid = new Set(rows.map(r => r.i));
  const out = new Map();
  for (const v of (j && j.results) || []) {
    if (!valid.has(v.i) || !LABELS.includes(v.label)) continue;
    out.set(v.i, {
      label: v.label,
      confidence: Math.max(0, Math.min(100, Math.round(Number(v.confidence) || 0))),
      intent: v.intent,
      reason: String(v.reason || '').replace(/[–—]/g, '-').slice(0, 140),
    });
  }
  return out;
}

async function judgeRows(ctx, rows) {
  const j = await chat({
    system: SPECIALIST,
    user: `${contextText(ctx)}\n\nQUERIES\n${rows.map(queryLine).join('\n')}`,
    name: 'keyword_verdicts', schema: JUDGE_SCHEMA, maxTokens: 8000,
  });
  return toMap(j, rows);
}

// Second opinion on the shaky ones, with both earlier opinions on the table.
async function verifyRows(ctx, rows) {
  const j = await chat({
    system: SPECIALIST + '\n\nThis is a RE-CHECK. You are the account director settling a disagreement. Weigh the first opinion and the rules opinion, then give your own final call. If after careful thought it is still truly ambiguous, answer review with confidence under 60 and say what is unclear.',
    user: `${contextText(ctx)}\n\nQUERIES TO SETTLE\n${rows.map(r => `${queryLine(r)}\n   first opinion: ${r.first}\n   rules opinion: ${r.rules}`).join('\n')}`,
    name: 'keyword_recheck', schema: JUDGE_SCHEMA, maxTokens: 6000,
  });
  return toMap(j, rows);
}

/* ---------- unknown sheet layouts ---------- */
async function mapColumns(sample) {
  const fields = ['keyword', 'volume', 'competition', 'bid', 'impressions', 'clicks', 'cost', 'conversions'];
  const props = { header_row_index: { type: 'integer' } };
  for (const f of fields) props[f + '_column'] = { type: 'integer' };
  const j = await chat({
    system: 'You read the first rows of an exported spreadsheet of search keywords or search terms. Report which column holds each field. Columns and rows count from 0. Use -1 when a field is not present. header_row_index is the row holding the column titles, or -1 if there is none.',
    user: sample.map((r, i) => `${i}: ${JSON.stringify(r)}`).join('\n'),
    name: 'column_map',
    schema: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
    maxTokens: 400,
  });
  const metrics = {};
  for (const f of fields.slice(1)) if (Number.isInteger(j[f + '_column']) && j[f + '_column'] >= 0) metrics[f] = j[f + '_column'];
  return { headerRow: Number.isInteger(j.header_row_index) ? j.header_row_index : -1, keywordCol: j.keyword_column, metrics };
}

module.exports = { enabled, model, describeBusiness, judgeRows, verifyRows, mapColumns, OpenAIError, LABELS };
