'use strict';

// Set by the server when the app is mounted under a path such as /keyword-selector.
const BASE = (document.querySelector('meta[name=base]') || {}).content || '';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATS = [['priority', 'Priority'], ['relevant', 'Relevant'], ['review', 'Review'], ['negative', 'Negative']];

const state = { config: { aiEnabled: false, maxKeywords: 1000, maxCompetitors: 3 }, user: null, projects: [], project: null, tab: 'brief', filter: 'all', search: '', sort: { key: 'score', dir: 'desc' }, st: { filter: 'all', search: '', sort: { key: 'cost', dir: 'desc' } } };

async function api(path, opts = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method: opts.method || 'GET',
    headers: { 'x-csrf': '1', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) {
    showAuth();
    throw Object.assign(new Error('Sign in to continue.'), { auth: true });
  }
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 5000 : 2800);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { if (!e.auth) toast(e.message, true); }
}

/* ---------- sidebar ---------- */
function renderSide() {
  const ul = $('#projectList');
  if (!state.projects.length) { ul.innerHTML = '<li class="empty">No projects yet.</li>'; return; }
  ul.innerHTML = state.projects.map(p => {
    const meta = p.total ? `${p.total} kw, ${p.counts.priority} priority` : p.analyzed ? 'analyzed, no keywords' : 'not analyzed';
    const who = p.role === 'owner' ? (p.shared ? ' \u00b7 shared' : '') : ' \u00b7 ' + p.role + ', ' + p.ownerName;
    return `<li class="${state.project && state.project.id === p.id ? 'on' : ''}"><button data-id="${p.id}"><span class="pn">${esc(p.name)}</span><span class="pm">${esc(meta + who)}</span></button></li>`;
  }).join('');
}

async function refreshList() {
  state.projects = await api('/projects');
  renderSide();
}

async function openProject(id, tab) {
  state.project = await api('/projects/' + id);
  state.filter = 'all';
  state.search = '';
  state.tab = tab || (state.project.keywords.length && state.project.profile ? 'results' : state.project.profile ? 'keywords' : 'brief');
  renderSide();
  render();
}

/* ---------- main render ---------- */
function render() {
  const main = $('#main');
  const p = state.project;
  if (!p && state.tab !== 'new') {
    main.innerHTML = `<div class="welcome">
      <h1>Sort a thousand keywords by what you actually sell.</h1>
      <p class="sub">Tell the tool about your business and website, drop in a keyword sheet from Google Ads, Semrush, Ahrefs or anywhere else, and get back four lists: priority, relevant, review and negative.</p>
      <ol>
        <li>Create a project with your website address and a few lines about what you offer.</li>
        <li>The site is crawled and turned into a profile of your products and wording.</li>
        <li>Paste or upload up to ${state.config.maxKeywords} keywords.</li>
        <li>Download CSVs ready for Google Ads Editor, including negatives.</li>
      </ol>
      <p><button class="btn primary" id="startNew">Create your first project</button></p></div>`;
    $('#startNew').onclick = startNew;
    return;
  }
  const title = p ? esc(p.name) : 'New project';
  const link = p && p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : '';
  const analyzed = Boolean(p && p.profile);
  const tab = (id, n, label, on, off) => `<button data-tab="${id}" class="${on ? 'on' : ''}" ${off ? 'disabled' : ''}><span class="n">${n}</span>${label}</button>`;
  main.innerHTML = `
    <div class="head">
      <div><h1>${title}</h1><p class="sub">${link || 'Fill in the brief to get started.'}</p></div>
      ${p ? `<div class="head-actions"><span class="role">${esc(p.role)}</span><button class="btn small" id="share">Share</button></div>` : ''}
    </div>
    <nav class="steps" aria-label="Project steps">
      ${tab('brief', 1, 'Brief', state.tab === 'brief' || state.tab === 'new')}
      ${tab('keywords', 2, 'Keywords' + (p && p.keywords.length ? ' (' + p.keywords.length + ')' : ''), state.tab === 'keywords', !p)}
      ${tab('terms', 3, 'Search terms' + (p && p.searchTerms.length ? ' (' + p.searchTerms.length + ')' : ''), state.tab === 'terms', !analyzed)}
      ${tab('competitors', 4, 'Competitors' + (p && p.competitors.length ? ' (' + p.competitors.length + ')' : ''), state.tab === 'competitors', !analyzed)}
      ${tab('results', 5, 'Results', state.tab === 'results', !(p && p.keywords.length))}
    </nav>
    <section id="pane" class="${p && p.role === 'viewer' ? 'ro' : ''}"></section>`;
  main.querySelectorAll('.steps button').forEach(b => (b.onclick = () => { state.tab = b.dataset.tab; render(); }));
  const sh = $('#share');
  if (sh) sh.onclick = openShare;
  if (state.tab === 'brief' || state.tab === 'new') renderBrief(analyzed);
  else if (state.tab === 'keywords') renderKeywords(analyzed);
  else if (state.tab === 'terms') renderTerms();
  else if (state.tab === 'competitors') renderCompetitors();
  else renderResults();
  lockIfViewer();
}

// Viewers see everything but change nothing. The server enforces this too.
function lockIfViewer() {
  if (!state.project || state.project.role !== 'viewer') return;
  document.querySelectorAll('#pane textarea, #pane .sel, #pane .ed, #pane #brief input, #pane #brief button').forEach(el => (el.disabled = true));
}

function startNew() {
  state.project = null;
  state.tab = 'new';
  renderSide();
  render();
}

/* ---------- brief ---------- */
function renderBrief(analyzed) {
  const p = state.project || { name: '', url: '', description: '', offerings: '', seeds: [], exclude: [], strictness: 'balanced' };
  $('#pane').innerHTML = `
    <form class="form" id="brief" autocomplete="off">
      <div class="field"><label for="f-name">Project name</label><input type="text" id="f-name" value="${esc(p.name)}" required placeholder="Acme Plumbing, Leeds"></div>
      <div class="field"><label for="f-url">Website address</label><input type="text" id="f-url" value="${esc(p.url)}" placeholder="acmeplumbing.co.uk"><span class="hint">Up to 8 pages are read, starting from this one.</span></div>
      <div class="field full"><label for="f-desc">About the business</label><textarea id="f-desc" placeholder="Who you are, where you work, who buys from you.">${esc(p.description)}</textarea></div>
      <div class="field"><label for="f-off">Products or services</label><textarea id="f-off" placeholder="One per line or comma separated.">${esc(p.offerings)}</textarea></div>
      <div class="field"><label for="f-seed">Starting keywords</label><textarea id="f-seed" placeholder="emergency plumber leeds&#10;boiler installation">${esc((p.seeds || []).join('\n'))}</textarea><span class="hint">Terms you already know you want to rank for. These count the most.</span></div>
      <div class="field"><label for="f-ex">Never show for</label><textarea id="f-ex" placeholder="competitor names, products you do not sell">${esc((p.exclude || []).join('\n'))}</textarea><span class="hint">Any keyword containing one of these goes straight to negatives.</span></div>
      <div class="field"><label>Research keywords ("how to", "what is", courses)</label>
        <div class="radios">
          <label><input type="radio" name="strict" value="balanced" ${p.strictness !== 'strict' ? 'checked' : ''}> Put them in Review, they may suit content</label>
          <label><input type="radio" name="strict" value="strict" ${p.strictness === 'strict' ? 'checked' : ''}> Treat them as negatives</label>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" type="submit" id="save">${analyzed ? 'Save and re-analyze' : 'Save and analyze website'}</button>
        ${p.id && p.role === 'owner' ? '<button class="btn danger" type="button" id="del">Delete project</button>' : ''}
      </div>
    </form>
    ${analyzed ? learnedHtml(p.profile) : ''}`;

  $('#brief').onsubmit = e => {
    e.preventDefault();
    const body = {
      name: $('#f-name').value, url: $('#f-url').value, description: $('#f-desc').value, offerings: $('#f-off').value,
      seeds: $('#f-seed').value, exclude: $('#f-ex').value, strictness: $('input[name=strict]:checked').value,
    };
    const btn = $('#save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Reading the website...';
    guard(async () => {
      try {
        if (!state.project) { state.project = await api('/projects', { method: 'POST', body }); renderSide(); }
        state.project = await api('/projects/' + state.project.id + '/analyze', { method: 'POST', body });
        await refreshList();
        state.tab = state.project.keywords.length ? 'results' : 'keywords';
        render();
        toast('Profile built from ' + (state.project.profile.pages.length || 'your') + ' page(s).');
      } catch (err) {
        // The project may exist even if the crawl failed. Keep it so nothing typed is lost.
        await refreshList();
        throw err;
      } finally {
        const b = $('#save');
        if (b) { b.disabled = false; b.textContent = analyzed ? 'Save and re-analyze' : 'Save and analyze website'; }
      }
    });
  };
  const del = $('#del');
  if (del) del.onclick = () => {
    if (!confirm('Delete "' + p.name + '" and all its keywords?')) return;
    guard(async () => {
      await api('/projects/' + p.id, { method: 'DELETE' });
      state.project = null; state.tab = 'brief';
      await refreshList();
      render();
    });
  };
}

function learnedHtml(pr) {
  const pages = pr.pages.map(pg => `<li>${esc(pg.url)} <span>(${pg.words} words)</span></li>`).join('');
  const errs = pr.errors.map(er => `<li class="bad">${esc(er.url)}: ${esc(er.error)}</li>`).join('');
  return `<div class="learned">
    <h2>What the tool learned</h2>
    ${pr.summary ? `<p>${esc(pr.summary)}</p>` : ''}
    <p class="label">Strongest terms</p>
    <div class="chips">${pr.topTerms.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    ${pr.topPhrases.length ? `<p class="label">Phrases from your pages</p><div class="chips">${pr.topPhrases.map(t => `<span class="chip ph">${esc(t)}</span>`).join('')}</div>` : ''}
    ${pr.notOffered.length ? `<p class="label">Looks like you do not sell</p><div class="chips">${pr.notOffered.map(t => `<span class="chip neg">${esc(t)}</span>`).join('')}</div>` : ''}
    <p class="label">Pages read</p>
    <ul class="pages">${pages || '<li>None, using only what you typed.</li>'}${errs}</ul>
    ${pr.aiNote ? `<p class="hint">${esc(pr.aiNote)}</p>` : ''}
    <p class="sub" style="margin-top:12px">Wrong terms at the top? Add a clearer description or starting keywords and re-analyze.</p>
  </div>`;
}

/* ---------- keywords ---------- */
function renderKeywords(analyzed) {
  const p = state.project;
  const max = state.config.maxKeywords;
  $('#pane').innerHTML = `
    <div class="kw-wrap">
      <div>
        <div class="field"><label for="kw-text">Paste keywords</label>
          <textarea id="kw-text" spellcheck="false" placeholder="One per line, or paste straight from a spreadsheet column."></textarea></div>
        <div class="counter"><span id="cnt">0 in box</span><span id="room">${p.keywords.length} saved, room for ${Math.max(0, max - p.keywords.length)} more</span></div>
        <div class="actions" style="grid-column:auto;padding-top:12px">
          <button class="btn primary ed" id="add">Add keywords</button>
          ${p.keywords.length ? '<button class="btn danger ed" id="clear">Remove all</button>' : ''}
        </div>
      </div>
      <div>
        <div class="drop" id="drop">
          <p>Drop a sheet here, or pick a file.<br>CSV, TSV, TXT or XLSX.</p>
          <input type="file" id="file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
          <button class="btn ed" id="pick">Choose file</button>
        </div>
        <div class="aside-note">
          <p class="label">What gets read</p>
          <ul>
            <li>The keyword column is found by its header, so Google Ads, Keyword Planner, Semrush and Ahrefs exports work as they are.</li>
            <li>Volume, competition, bid, clicks and cost columns are kept when present.</li>
            <li>Duplicates and <code>[exact]</code> or <code>"phrase"</code> brackets are cleaned up.</li>
          </ul>
        </div>
        ${analyzed ? '' : '<p class="aside-note"><b>Analyze the website first</b> (step 1). Keywords can be added now but they stay unsorted until then.</p>'}
      </div>
    </div>`;
  const ta = $('#kw-text');
  const count = () => {
    const n = ta.value.split(/\r?\n/).filter(l => l.trim()).length;
    $('#cnt').innerHTML = `<span class="${n > max ? 'over' : ''}">${n} line${n === 1 ? '' : 's'} in box</span>`;
  };
  ta.oninput = count;
  $('#add').onclick = () => submitKeywords(ta.value, () => { ta.value = ''; count(); });
  const clear = $('#clear');
  if (clear) clear.onclick = () => {
    if (!confirm('Remove all ' + p.keywords.length + ' keywords from this project?')) return;
    guard(async () => { state.project = await api('/projects/' + p.id + '/keywords', { method: 'DELETE' }); await refreshList(); render(); });
  };
  const file = $('#file'), drop = $('#drop');
  $('#pick').onclick = () => file.click();
  file.onchange = () => file.files[0] && handleFile(file.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
}

function submitKeywords(text, done) {
  if (!text.trim()) return toast('Nothing to add yet.', true);
  return guard(async () => {
    const r = await api('/projects/' + state.project.id + '/keywords', { method: 'POST', body: { text } });
    state.project = r.project;
    await refreshList();
    let msg = `Added ${r.added} keyword${r.added === 1 ? '' : 's'}.`;
    if (r.duplicates) msg += ` ${r.duplicates} duplicate or unusable skipped.`;
    if (r.overLimit) msg += ` ${r.overLimit} left out, the ${state.config.maxKeywords} keyword limit was reached.`;
    if (done) done();
    if (r.project.profile) { state.tab = 'results'; render(); } else render();
    toast(msg + (r.note ? ' ' + r.note : ''));
  });
}

function decodeBuffer(buf) {
  const u = new Uint8Array(buf);
  if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  return new TextDecoder('utf-8').decode(buf);
}

function loadXlsx() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Could not load the Excel reader. Save the sheet as CSV and upload that instead.'));
    document.head.appendChild(s);
  });
}

function handleFile(f) {
  guard(async () => {
    if (f.size > 5 * 1024 * 1024) throw new Error('That file is over 5 MB. Trim it to the keyword columns first.');
    const buf = await f.arrayBuffer();
    let text;
    if (/\.xlsx?$/i.test(f.name)) {
      const X = await loadXlsx();
      const wb = X.read(buf, { type: 'array' });
      text = X.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
    } else text = decodeBuffer(buf);
    await submitKeywords(text);
  });
}

/* ---------- results ---------- */
function visibleRows() {
  const p = state.project;
  const q = state.search.trim().toLowerCase();
  let rows = p.keywords.filter(k => (state.filter === 'all' || k.category === state.filter) && (!q || k.keyword.toLowerCase().includes(q)));
  const { key, dir } = state.sort;
  const m = dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * m;
  });
  return rows;
}

function renderResults() {
  const p = state.project;
  if (!p.profile) {
    $('#pane').innerHTML = '<div class="empty-state">Analyze the website in step 1 to sort these keywords.</div>';
    return;
  }
  const c = p.counts, total = p.keywords.length || 1;
  const bar = CATS.map(([k]) => `<i class="${k}" style="width:${(c[k] / total) * 100}%"></i>`).join('');
  const tabs = [['all', 'All', p.keywords.length], ...CATS.map(([k, l]) => [k, l, c[k]])].map(([k, l, n]) =>
    `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${k === 'all' ? '' : `<span class="dot" style="background:var(--${k})"></span>`}${l}<b>${n}</b></button>`).join('');
  const q = encodeURIComponent(p.campaign || p.name);

  $('#pane').innerHTML = `
    <div class="bar" role="img" aria-label="Category split">${bar}</div>
    <div class="tools">
      <div class="tabs">${tabs}</div><span class="grow"></span>
      <input type="text" class="search" id="search" placeholder="Filter keywords" value="${esc(state.search)}" aria-label="Filter keywords">
      ${state.config.aiEnabled ? '<button class="btn small ed" id="ai">Ask AI about borderline ones</button>' : ''}
      <button class="btn small ed" id="reset" title="Discard your manual changes and score again">Re-score</button>
    </div>
    <div class="exports">
      <span class="label">Download</span>
      <a class="btn small" href="${BASE}/api/projects/${p.id}/export?type=all">Everything</a>
      <a class="btn small" href="${BASE}/api/projects/${p.id}/export?type=priority">Priority</a>
      <a class="btn small" href="${BASE}/api/projects/${p.id}/export?type=negative">Negative</a>
      <span class="grow"></span>
      <span class="label">Google Ads Editor</span>
      <input type="text" id="camp" value="${esc(p.campaign || p.name)}" aria-label="Campaign name">
      <a class="btn small" id="dl-t" href="${BASE}/api/projects/${p.id}/export?type=ads-targeting&campaign=${q}">Search targeting</a>
      <a class="btn small" id="dl-n" href="${BASE}/api/projects/${p.id}/export?type=ads-negatives&campaign=${q}">Negatives</a>
    </div>
    <div class="tablewrap"><table>
      <thead><tr>${[['keyword', 'Keyword'], ['category', 'Category'], ['score', 'Score', 1], ['intent', 'Intent'], ['volume', 'Searches', 1], ['bid', 'Bid', 1], ['matchType', 'Match type'], ['reason', 'Why']]
        .map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}" ${state.sort.key === k ? `data-dir="${state.sort.dir}"` : ''}>${l}</th>`).join('')}<th></th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <div class="twocol">
      <div><h2>Account-level negative words</h2>
        <p class="sub" style="margin-bottom:10px">Words that keep turning up in your negatives and never in your site. Good candidates for a shared negative list.</p>
        <div class="chips">${(p.negativeWords || []).map(w => `<span class="chip neg">${esc(w.word)}<small>${w.count}</small></span>`).join('') || '<span class="sub">Nothing repeats yet.</span>'}</div>
        ${(p.negativeWords || []).length ? `<p><a class="btn small" style="text-decoration:none;color:inherit" href="${BASE}/api/projects/${p.id}/export?type=negative-words&campaign=${q}">Download as negative list</a></p>` : ''}
      </div>
      <div><h2>Ad group ideas</h2>
        <p class="sub" style="margin-bottom:10px">Priority and relevant keywords grouped by their strongest shared term. A starting point, not a final structure.</p>
        ${(p.adGroups || []).map(g => `<details class="ag"><summary>${esc(g.name)}<span>${g.ids.length}</span></summary><div>${g.ids.map(id => esc((p.keywords.find(k => k.id === id) || {}).keyword)).join(', ')}</div></details>`).join('') || '<span class="sub">No priority or relevant keywords yet.</span>'}
      </div>
    </div>`;

  drawRows();
  document.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => { state.filter = b.dataset.f; renderResults(); }));
  document.querySelectorAll('th[data-k]').forEach(th => (th.onclick = () => {
    const k = th.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    renderResults();
  }));
  $('#search').oninput = e => { state.search = e.target.value; drawRows(); };
  $('#camp').oninput = e => {
    const v = encodeURIComponent(e.target.value);
    $('#dl-t').href = `${BASE}/api/projects/${p.id}/export?type=ads-targeting&campaign=${v}`;
    $('#dl-n').href = `${BASE}/api/projects/${p.id}/export?type=ads-negatives&campaign=${v}`;
  };
  $('#camp').onchange = e => guard(() => api('/projects/' + p.id, { method: 'PUT', body: { campaign: e.target.value } }));
  $('#reset').onclick = () => guard(async () => {
    const r = await api('/projects/' + p.id + '/classify', { method: 'POST', body: { reset: true } });
    state.project = r.project; await refreshList(); renderResults(); toast('Scored again.');
  });
  const ai = $('#ai');
  if (ai) ai.onclick = () => {
    ai.disabled = true; ai.innerHTML = '<span class="spin"></span>Asking...';
    guard(async () => {
      try {
        const r = await api('/projects/' + p.id + '/classify', { method: 'POST', body: { useAI: true } });
        state.project = r.project; await refreshList(); renderResults(); toast(r.note || 'Done.');
      } finally { if ($('#ai')) { $('#ai').disabled = false; $('#ai').textContent = 'Ask AI about borderline ones'; } }
    });
  };
}

function drawRows() {
  const p = state.project;
  const rows = visibleRows();
  const body = $('#rows');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="empty-state">Nothing matches this filter.</td></tr>'; return; }
  body.innerHTML = rows.map(k => `<tr data-id="${k.id}">
    <td class="kw">${esc(k.keyword)}</td>
    <td>${k.category ? `<select class="sel ${k.category}" aria-label="Category for ${esc(k.keyword)}">${CATS.map(([v, l]) => `<option value="${v}" ${k.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : '<span class="mt">unsorted</span>'}</td>
    <td class="num"><span class="sc">${k.score ?? ''}</span></td>
    <td>${esc(k.intent || '')}</td>
    <td class="num">${k.volume != null ? k.volume.toLocaleString() : ''}</td>
    <td class="num">${k.bid != null ? k.bid : ''}</td>
    <td><span class="mt">${esc(k.matchType || '')}</span></td>
    <td class="why">${esc(k.reason || '')}</td>
    <td><button class="x" title="Remove keyword" aria-label="Remove ${esc(k.keyword)}">&times;</button></td></tr>`).join('');
  body.querySelectorAll('select').forEach(sel => (sel.onchange = () => {
    const id = sel.closest('tr').dataset.id;
    guard(async () => {
      state.project = await api(`/projects/${p.id}/keyword/${id}`, { method: 'PATCH', body: { category: sel.value } });
      await refreshList(); renderResults();
    });
  }));
  body.querySelectorAll('.x').forEach(btn => (btn.onclick = () => {
    const id = btn.closest('tr').dataset.id;
    guard(async () => {
      state.project = await api(`/projects/${p.id}/keyword/${id}`, { method: 'DELETE' });
      await refreshList(); state.project.keywords.length ? renderResults() : render();
    });
  }));
}

/* ---------- boot ---------- */
$('#projectList').onclick = e => {
  const b = e.target.closest('button[data-id]');
  if (b) guard(() => openProject(b.dataset.id));
};
$('#newProject').onclick = startNew;
$('#signout').onclick = () => signOut();
$('#home').onclick = e => { e.preventDefault(); state.project = null; state.tab = 'brief'; renderSide(); render(); };

guard(async () => {
  state.config = await api('/config');
  $('#engine').innerHTML = state.config.aiEnabled ? '<b>AI review on</b>' : 'Offline scoring';
  const me = await api('/auth/me');
  if (me.user) await startApp(me.user); else showAuth();
});
