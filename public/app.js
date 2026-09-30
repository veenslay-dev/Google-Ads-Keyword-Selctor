'use strict';

// Set by the server when the app is mounted under a path such as /keyword-selector.
const BASE = (document.querySelector('meta[name=base]') || {}).content || '';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n == null || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const CATS = [['priority', 'Priority'], ['relevant', 'Relevant'], ['review', 'Review'], ['negative', 'Negative']];
const CAT_RANK = { priority: 0, relevant: 1, review: 2, negative: 3, undefined: 4 };

const state = {
  config: { aiEnabled: false, maxKeywords: 1000, maxCompetitors: 3, maxPages: 50 },
  user: null, projects: [], project: null,
  view: 'keywords', scope: 'all', filter: 'all', search: '', sort: { key: 'category', dir: 'asc' },
  up: { open: false, mode: 'files', files: [], name: '', url: '', text: '' },
  goAfterRead: false,
};
const busyAI = b => b.ai && (b.ai.status === 'running' || b.ai.status === 'queued');
const reading = p => Boolean(p && p.analysis && p.analysis.status === 'running');
const resetUpload = p => { state.up = { open: !p || p.batches.length === 0, mode: 'files', files: [], name: '', url: '', text: '' }; };

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
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 6000 : 3500);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { if (!e.auth) toast(e.message, true); }
}

const viewer = () => state.project && state.project.role === 'viewer';
const scopeRows = () => (state.scope === 'all' ? state.project.keywords : state.project.keywords.filter(k => k.batchId === state.scope));
const campaignName = () => state.project.campaign || state.project.name;

/* ---------- sidebar ---------- */
function renderSide() {
  const ul = $('#projectList');
  if (!state.projects.length) { ul.innerHTML = '<li class="empty">No projects yet.</li>'; return; }
  ul.innerHTML = state.projects.map(p => {
    const bits = [p.total ? `${p.total} keywords` : p.analyzed ? 'no keywords yet' : 'not set up'];
    if (p.role !== 'owner') bits.push(p.role + ', ' + p.ownerName); else if (p.shared) bits.push('shared');
    return `<li class="${state.project && state.project.id === p.id ? 'on' : ''}"><button data-id="${p.id}"><span class="pn">${esc(p.name)}</span><span class="pm">${esc(bits.join(' · '))}</span></button></li>`;
  }).join('');
}

async function refreshList() {
  state.projects = await api('/projects');
  renderSide();
}

async function openProject(id) {
  state.project = await api('/projects/' + id);
  state.scope = 'all'; state.filter = 'all'; state.search = '';
  resetUpload(state.project);
  state.view = state.project.profile || reading(state.project) ? 'keywords' : 'business';
  renderSide();
  render();
}

/* ---------- shell ---------- */
function render() {
  const main = $('#main');
  const p = state.project;
  if (!p && state.view !== 'new') {
    main.innerHTML = `<div class="welcome">
      <h1>Sort your keywords by what you actually sell.</h1>
      <p class="sub">Tell the tool about your business, then drop in keyword files from Google Ads, Semrush, Ahrefs or anywhere else. Each file becomes its own upload with its own download, so you can add new keywords every day.</p>
      <button class="btn primary" id="startNew">Create your first project</button></div>`;
    $('#startNew').onclick = startNew;
    return;
  }
  const link = p && p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : '';
  main.innerHTML = `
    <div class="head">
      <div><h1>${p ? esc(p.name) : 'New project'}</h1><p class="sub">${link || (p ? 'No website added yet' : 'Start with a few details about the business.')}</p></div>
      ${p ? `<div class="head-actions"><span class="role">${esc(p.role)}</span><button class="btn small" id="share">Share</button></div>` : ''}
    </div>
    <nav class="tabs2" aria-label="Project sections">
      <button data-view="keywords" class="${state.view === 'keywords' ? 'on' : ''}" ${p ? '' : 'disabled'}>Keywords${p && p.keywords.length ? `<b>${p.keywords.length}</b>` : ''}</button>
      <button data-view="business" class="${state.view !== 'keywords' ? 'on' : ''}">Business</button>
    </nav>
    <section id="pane" class="${viewer() ? 'ro' : ''}"></section>`;
  main.querySelectorAll('.tabs2 button').forEach(b => (b.onclick = () => { state.view = b.dataset.view; render(); }));
  const sh = $('#share');
  if (sh) sh.onclick = openShare;
  if (state.view === 'keywords') renderKeywords(); else renderBusiness();
  lockIfViewer();
  pollIfBusy();
}

// Viewers see everything but change nothing. The server enforces this too.
function lockIfViewer() {
  if (!viewer()) return;
  document.querySelectorAll('#pane textarea, #pane .sel, #pane .ed, #pane #brief input, #pane #brief button').forEach(el => (el.disabled = true));
}

function startNew() {
  state.project = null; state.view = 'new';
  renderSide(); render();
}

/* ---------- keywords view ---------- */
function renderKeywords() {
  $('#pane').innerHTML = `<div id="banner"></div><section id="newup"></section><div id="files"></div><div id="results"></div>`;
  drawBanner();
  drawNewUpload();
  drawFiles();
  drawResults();
}

// Shows the state of the website read, in either view.
function drawBanner() {
  const el = $('#banner');
  const p = state.project;
  if (!el || !p) return;
  const a = p.analysis || {};
  if (a.status === 'running') {
    const pct = a.total ? Math.min(100, Math.round((a.done / a.total) * 100)) : 0;
    const text = a.stage === 'Reading the website' ? `Reading your website: ${a.done || 0} pages so far (up to ${a.total})` : a.stage || 'Working';
    el.innerHTML = `<div class="notice busy"><span class="spin"></span><span>${esc(text)}. ${state.view === 'keywords' ? 'Anything you upload now is analysed as soon as this finishes.' : ''}</span>${a.stage === 'Reading the website' ? `<span class="prog wide"><i style="width:${pct}%"></i></span>` : ''}</div>`;
  } else if (a.status === 'error' || a.status === 'interrupted') {
    el.innerHTML = `<div class="notice bad">${esc(a.error || 'The website could not be read.')} ${state.view === 'keywords' ? '<button class="btn link" id="toBusiness">Open the business details</button>' : ''}</div>`;
  } else if (!p.profile) {
    el.innerHTML = `<div class="notice">Tell the tool about the business first so it knows what to look for. Uploads are sorted as soon as that is done. <button class="btn link" id="toBusiness">Set up the business</button></div>`;
  } else el.innerHTML = '';
  const tb = $('#toBusiness');
  if (tb) tb.onclick = () => { state.view = 'business'; render(); };
}

const prettyUrl = u => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname.replace(/\/$/, '')); } catch { return u; } };
const sizeOf = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// The form for adding keywords. One place for a name, the page the keywords are for, and the keywords themselves.
function drawNewUpload() {
  const p = state.project;
  const el = $('#newup');
  const u = state.up;
  if (!u.open) {
    el.innerHTML = `<div class="newup-closed"><button class="btn primary ed" id="openUp">New upload</button><span class="hint">Add today's keywords. Every upload is kept on its own, so earlier ones stay untouched.</span></div>`;
    $('#openUp').onclick = () => { state.up.open = true; drawNewUpload(); lockIfViewer(); const n = $('#u-name'); if (n) n.focus(); };
    lockIfViewer();
    return;
  }
  const many = u.mode === 'files' && u.files.length > 1;
  el.innerHTML = `
    <div class="newup">
      <div class="newup-head"><h2>New upload</h2>${p.batches.length ? '<button class="btn link" id="closeUp">Cancel</button>' : ''}</div>
      <div class="row2">
        <div class="field"><label for="u-name">Name</label>
          <input type="text" id="u-name" class="ed" value="${esc(u.name)}" placeholder="${many ? 'Each file keeps its own name' : 'NRI property tax, 30 Sep'}" ${many ? 'disabled' : ''}>
          <span class="hint">${many ? 'Several files were chosen, so each is named after its file.' : 'Leave empty to use the file name.'}</span></div>
        <div class="field"><label for="u-url">Landing page <span class="opt">optional</span></label>
          <input type="text" id="u-url" class="ed" value="${esc(u.url)}" placeholder="https://yoursite.com/nri-property-tax">
          <span class="hint">The page these keywords are for. It is read, so each keyword is matched against that exact service.</span></div>
      </div>
      <div class="seg" role="tablist" aria-label="How to add keywords">
        <button role="tab" data-mode="files" class="${u.mode === 'files' ? 'on' : ''}" aria-selected="${u.mode === 'files'}">Upload files</button>
        <button role="tab" data-mode="paste" class="${u.mode === 'paste' ? 'on' : ''}" aria-selected="${u.mode === 'paste'}">Paste keywords</button>
      </div>
      ${u.mode === 'files' ? `
        <div class="drop" id="drop">
          <p>Drop files here, or <button class="btn link ed" id="pick">choose files</button></p>
          <p class="hint">CSV, TSV, TXT or XLSX. Google Ads search terms reports, Keyword Planner, Semrush, Ahrefs or a plain list.</p>
          <input type="file" id="file" multiple accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
        </div>
        ${u.files.length ? `<ul class="staged">${u.files.map((f, i) => `<li><span>${esc(f.name)}</span><span class="hint">${sizeOf(f.size)}</span><button class="x ed" data-rmfile="${i}" aria-label="Remove ${esc(f.name)}">&times;</button></li>`).join('')}</ul>` : ''}`
      : `<div class="field"><label for="u-text" class="sr">Keywords</label><textarea id="u-text" class="ed" spellcheck="false" rows="7" placeholder="One per line, or paste straight from a spreadsheet column.">${esc(u.text)}</textarea></div>`}
      <div class="actions"><button class="btn primary ed" id="u-go">${state.config.aiEnabled ? 'Add and analyse' : 'Add keywords'}</button><span class="hint" id="u-info"></span></div>
    </div>`;

  const save = () => { const n = $('#u-name'), l = $('#u-url'), t = $('#u-text'); if (n && !n.disabled) u.name = n.value; if (l) u.url = l.value; if (t) u.text = t.value; };
  ['#u-name', '#u-url', '#u-text'].forEach(sel => { const i = $(sel); if (i) i.oninput = save; });
  const cl = $('#closeUp'); if (cl) cl.onclick = () => { save(); state.up.open = false; drawNewUpload(); };
  el.querySelectorAll('.seg button').forEach(b => (b.onclick = () => { save(); u.mode = b.dataset.mode; drawNewUpload(); lockIfViewer(); }));
  if (u.mode === 'files') {
    const file = $('#file'), drop = $('#drop');
    const add = list => { save(); u.files.push(...list); drawNewUpload(); lockIfViewer(); };
    $('#pick').onclick = e => { e.preventDefault(); file.click(); };
    file.onchange = () => { if (file.files.length) add([...file.files]); file.value = ''; };
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); if (!viewer()) drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
    drop.addEventListener('drop', e => { if (!viewer() && e.dataTransfer.files.length) add([...e.dataTransfer.files]); });
    el.querySelectorAll('[data-rmfile]').forEach(b => (b.onclick = () => { save(); u.files.splice(Number(b.dataset.rmfile), 1); drawNewUpload(); lockIfViewer(); }));
  }
  $('#u-go').onclick = () => { save(); submitUpload(); };
  lockIfViewer();
}

async function submitUpload() {
  const p = state.project, u = state.up;
  if (u.mode === 'files' && !u.files.length) return toast('Choose at least one file first.', true);
  if (u.mode === 'paste' && !u.text.trim()) return toast('Paste some keywords first.', true);
  const btn = $('#u-go');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Adding...';
  const msgs = [];
  let last = null, failures = 0;
  const jobs = u.mode === 'files' ? u.files.map(f => ({ label: f.name, get: () => readSheetFile(f), name: u.files.length === 1 ? u.name : '', filename: f.name })) : [{ label: u.name || 'Pasted keywords', get: async () => u.text, name: u.name, filename: '' }];
  for (const j of jobs) {
    try {
      const r = await api(`/projects/${p.id}/uploads`, { method: 'POST', body: { text: await j.get(), name: j.name, filename: j.filename, pageUrl: u.url } });
      state.project = r.project; last = r.batchId || last; msgs.push(uploadMessage(j.label, r));
    } catch (e) {
      if (e.auth) return;
      failures++; toast(`${j.label}: ${e.message}`, true);
    }
  }
  if (!msgs.length) { drawNewUpload(); return; }
  resetUpload(state.project); state.up.open = false;
  await finishUpload(last, msgs);
  if (failures) toast(`${failures} file${failures === 1 ? '' : 's'} could not be added. ${msgs.join(' ')}`, true);
}

function uploadMessage(label, r) {
  const bits = [];
  if (r.added) bits.push(`${r.added} new keyword${r.added === 1 ? '' : 's'}`);
  if (r.updated) bits.push(`results added to ${r.updated} you already had`);
  if (r.duplicates) bits.push(`${r.duplicates} already in the project, skipped`);
  if (r.overLimit) bits.push(`${r.overLimit} left out because one upload holds ${state.config.maxKeywords}. Upload them as another file`);
  return `${label}: ${bits.join(', ') || 'nothing to add'}.`;
}

async function finishUpload(batchId, msgs) {
  await refreshList();
  state.project = await api('/projects/' + state.project.id);
  if (batchId) { state.scope = batchId; state.filter = 'all'; state.search = ''; }
  state.view = 'keywords';
  render();
  toast(msgs.join(' '));
}

/* ---------- files ---------- */
const miniBar = c => {
  const t = c.total || 1;
  return `<span class="mbar" aria-hidden="true">${CATS.map(([k]) => `<i class="${k}" style="width:${(c[k] / t) * 100}%"></i>`).join('')}</span>`;
};

function aiStatus(b) {
  const a = b.ai || {};
  const note = a.note ? `<span class="ainote" title="${esc(a.note)}">${esc(a.note)}</span>` : '';
  if (a.status === 'running' || a.status === 'queued') {
    if (a.status === 'queued') return '<span class="ai">Waiting in line</span>';
    if (a.stage === 'page') return '<span class="ai running">Reading the landing page</span>';
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    return `<span class="ai running">Analysing ${a.done || 0} of ${a.total || 0}</span><span class="prog"><i style="width:${pct}%"></i></span>`;
  }
  if (a.status === 'done') return (b.stale ? '<span class="ai stale" title="The business details changed after this was analysed.">Out of date</span>' : '<span class="ai ok">Analysed</span>') + note;
  if (a.status === 'error') return '<span class="ai bad">Analysis failed</span>' + note;
  if (a.status === 'interrupted') return '<span class="ai bad">Analysis stopped</span>' + note;
  if (a.status === 'waiting' && state.config.aiEnabled) return `<span class="ai">${reading(state.project) ? 'Waiting for the website' : 'Waiting for business details'}</span>`;
  return '<span class="ai muted">Basic sorting</span>';
}

function dlHref(type, batch, campaign) {
  const p = state.project;
  return `${BASE}/api/projects/${p.id}/export?type=${type}${batch && batch !== 'all' ? '&batch=' + batch : ''}&campaign=${encodeURIComponent(campaign)}`;
}

function pageLine(b) {
  if (!b.pageUrl) return '';
  const bad = b.page && b.page.status === 'error';
  return ` · <span class="${bad ? 'negative' : ''}" title="${esc(b.pageUrl)}">${bad ? 'page not readable: ' : 'for '}${esc(prettyUrl(b.pageUrl))}</span>`;
}

function drawFiles() {
  const p = state.project;
  const el = $('#files');
  if (!p.batches.length) { el.innerHTML = ''; return; }
  const all = p.counts;
  const stale = p.batches.filter(b => b.stale);
  const rows = [...p.batches].reverse().map(b => {
    const c = b.counts;
    const when = new Date(b.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<li class="file ${state.scope === b.id ? 'on' : ''}" data-id="${b.id}">
      <button class="file-main" data-select="${b.id}" aria-pressed="${state.scope === b.id}"><span class="fname">${esc(b.name)}</span><span class="fmeta">${esc(b.kind)} · ${c.total} keyword${c.total === 1 ? '' : 's'} · ${esc(when)}${pageLine(b)}</span></button>
      <span class="fcounts">${miniBar(c)}<span class="fnums"><b class="priority">${c.priority}</b> <b class="relevant">${c.relevant}</b> <b class="review">${c.review}</b> <b class="negative">${c.negative}</b></span></span>
      <span class="fstat">${aiStatus(b)}</span>
      <details class="menu"><summary aria-label="Actions for ${esc(b.name)}">⋯</summary>
        <div class="menu-pop">
          <a href="${dlHref('ads-targeting', b.id, campaignName())}">Download keywords to target</a>
          <a href="${dlHref('ads-negatives', b.id, campaignName())}">Download negative keywords</a>
          <a href="${dlHref('all', b.id, campaignName())}">Download everything (CSV)</a>
          <hr>
          ${state.config.aiEnabled ? `<button class="ed" data-recheck="${b.id}">Analyse again</button>` : ''}
          <button class="ed" data-rename="${b.id}">Rename</button>
          <button class="ed" data-page="${b.id}">${b.pageUrl ? 'Change landing page' : 'Set landing page'}</button>
          <button class="ed danger" data-delete="${b.id}">Delete this upload</button>
        </div></details>
    </li>`;
  }).join('');
  el.innerHTML = `<div class="sect-head"><h2>Uploads</h2><span class="muted">${p.batches.length} file${p.batches.length === 1 ? '' : 's'}, ${all.total} keywords</span>
      ${stale.length && state.config.aiEnabled ? `<button class="btn small ed right" id="restale">Analyse ${stale.length} out-of-date upload${stale.length === 1 ? '' : 's'} again</button>` : ''}</div>
    <ul class="files">
      <li class="file all ${state.scope === 'all' ? 'on' : ''}"><button class="file-main" data-select="all" aria-pressed="${state.scope === 'all'}"><span class="fname">All uploads together</span><span class="fmeta">${all.total} keywords</span></button>
        <span class="fcounts">${miniBar(all)}<span class="fnums"><b class="priority">${all.priority}</b> <b class="relevant">${all.relevant}</b> <b class="review">${all.review}</b> <b class="negative">${all.negative}</b></span></span><span class="fstat"></span><span></span></li>
      ${rows}</ul>
    <p class="legend"><b class="priority">Priority</b> <b class="relevant">Relevant</b> <b class="review">Review</b> <b class="negative">Negative</b></p>`;

  el.querySelectorAll('[data-select]').forEach(b => (b.onclick = () => { state.scope = b.dataset.select; state.filter = 'all'; drawFiles(); drawResults(); }));
  el.querySelectorAll('[data-rename]').forEach(b => (b.onclick = () => {
    const batch = p.batches.find(x => x.id === b.dataset.rename);
    const name = prompt('Name for this upload', batch.name);
    if (name && name.trim()) guard(async () => { state.project = await api(`/projects/${p.id}/uploads/${batch.id}`, { method: 'PATCH', body: { name } }); drawFiles(); drawResults(); });
  }));
  el.querySelectorAll('[data-page]').forEach(b => (b.onclick = () => {
    const batch = p.batches.find(x => x.id === b.dataset.page);
    const url = prompt('The page these keywords are for (leave empty to remove it)', batch.pageUrl || '');
    if (url !== null) guard(async () => { state.project = await api(`/projects/${p.id}/uploads/${batch.id}`, { method: 'PATCH', body: { pageUrl: url } }); drawFiles(); pollIfBusy(); });
  }));
  el.querySelectorAll('[data-delete]').forEach(b => (b.onclick = () => {
    const batch = p.batches.find(x => x.id === b.dataset.delete);
    if (!confirm(`Delete "${batch.name}" and its ${batch.counts.total} keywords? This cannot be undone.`)) return;
    guard(async () => {
      state.project = await api(`/projects/${p.id}/uploads/${batch.id}`, { method: 'DELETE' });
      if (state.scope === batch.id) state.scope = 'all';
      await refreshList(); drawFiles(); drawResults();
    });
  }));
  el.querySelectorAll('[data-recheck]').forEach(b => (b.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/uploads/${b.dataset.recheck}/recheck`, { method: 'POST' });
    drawFiles(); pollIfBusy(); toast('Analysing this upload again.');
  })));
  const rs = $('#restale');
  if (rs) rs.onclick = () => guard(async () => {
    for (const b of stale) state.project = await api(`/projects/${p.id}/uploads/${b.id}/recheck`, { method: 'POST' });
    drawFiles(); pollIfBusy(); toast(`Analysing ${stale.length} upload${stale.length === 1 ? '' : 's'} again, one after another.`);
  });
  lockIfViewer();
}

// Close any open file menu or download panel when clicking elsewhere.
document.addEventListener('click', e => {
  document.querySelectorAll('details.menu[open], details.dl[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
});

/* ---------- results ---------- */
function sortedRows(rows) {
  const { key, dir } = state.sort;
  const m = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === 'category') return (CAT_RANK[a.category] - CAT_RANK[b.category] || (b.score || 0) - (a.score || 0)) * m;
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * m;
  });
}

function drawResults() {
  const p = state.project;
  const el = $('#results');
  if (!p.keywords.length) {
    el.innerHTML = p.batches.length ? '' : '<div class="empty-state"><b>No keywords yet.</b><br>Add a file or paste a list above and the results appear here.</div>';
    return;
  }
  const base = scopeRows();
  const batch = state.scope === 'all' ? null : p.batches.find(b => b.id === state.scope);
  const c = { all: base.length, priority: 0, relevant: 0, review: 0, negative: 0 };
  base.forEach(k => { if (c[k.category] !== undefined) c[k.category]++; });
  const q = state.search.trim().toLowerCase();
  const rows = sortedRows(base.filter(k => (state.filter === 'all' || k.category === state.filter) && (!q || k.keyword.toLowerCase().includes(q))));
  const has = f => base.some(k => k[f] != null);
  const metrics = [['volume', 'Searches'], ['clicks', 'Clicks'], ['cost', 'Cost'], ['conversions', 'Conv.']].filter(([f]) => has(f));
  const showFile = state.scope === 'all' && p.batches.length > 1;
  const showService = has('service');
  const cols = [['keyword', 'Keyword'], ['category', 'Category'], ['confidence', 'Confidence'], ['intent', 'Intent'], ...(showService ? [['service', 'Service']] : []), ...metrics.map(([f, l]) => [f, l, 1]), ['reason', 'Why']];
  const bn = new Map(p.batches.map(b => [b.id, b.name]));
  const ps = p.perfSummary;
  const campaign = campaignName();

  el.innerHTML = `
    <div class="sect-head"><h2>${batch ? esc(batch.name) : 'All uploads'}</h2>
      <details class="dl"><summary class="btn">Download</summary>
        <div class="dlpanel">
          <label for="camp">Campaign name for Google Ads Editor</label>
          <input type="text" id="camp" value="${esc(campaign)}" class="ed">
          <p class="label">Google Ads Editor</p>
          <a data-dl="ads-targeting">Keywords to target</a>
          <a data-dl="ads-negatives">Negative keywords</a>
          <p class="label">Spreadsheets</p>
          <a data-dl="priority">Priority only</a><a data-dl="relevant">Relevant only</a><a data-dl="review">Review only</a><a data-dl="negative">Negative only</a><a data-dl="all">Everything</a>
        </div></details></div>
    ${ps ? `<p class="perf">From your campaign results: <b>${fmt(ps.totalClicks)}</b> clicks, <b>${fmt(ps.totalCost)}</b> spent, <b>${ps.convRate}%</b> convert${ps.wasteCount ? `. <b class="negative">${fmt(ps.wasteCost)}</b> went on ${ps.wasteCount} keyword${ps.wasteCount === 1 ? '' : 's'} now marked negative` : ''}${ps.winners ? `, and ${ps.winners} converting keyword${ps.winners === 1 ? '' : 's'} are marked priority` : ''}.</p>` : ''}
    <div class="bar" role="img" aria-label="Split by category">${CATS.map(([k]) => `<i class="${k}" style="width:${(c[k] / (c.all || 1)) * 100}%"></i>`).join('')}</div>
    <div class="tools">
      <div class="tabs">${[['all', 'All'], ...CATS].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${k === 'all' ? '' : `<span class="dot" style="background:var(--${k})"></span>`}${l}<b>${c[k]}</b></button>`).join('')}</div>
      <span class="grow"></span>
      <input type="text" class="search" id="search" placeholder="Search keywords" value="${esc(state.search)}" aria-label="Search keywords">
    </div>
    <div class="tablewrap"><table>
      <thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}" ${state.sort.key === k ? `data-dir="${state.sort.dir}"` : ''}>${l}</th>`).join('')}<th></th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <details class="extras"><summary>Suggested account-level negative words</summary>
      <p class="sub">Words that keep turning up in your negatives and never in your site. Good candidates for a shared negative list.</p>
      <div class="chips">${(p.negativeWords || []).map(w => `<span class="chip neg">${esc(w.word)}<small>${w.count}</small></span>`).join('') || '<span class="sub">Nothing repeats yet.</span>'}</div>
      ${(p.negativeWords || []).length ? '<p><a class="btn small" data-dl="negative-words">Download as a negative list</a></p>' : ''}
    </details>
    <details class="extras"><summary>Ad group ideas</summary>
      <p class="sub">Priority and relevant keywords grouped by their strongest shared term. A starting point, not a final structure.</p>
      ${(p.adGroups || []).map(g => `<details class="ag"><summary>${esc(g.name)}<span>${g.ids.length}</span></summary><div>${g.ids.map(id => esc((p.keywords.find(k => k.id === id) || {}).keyword)).join(', ')}</div></details>`).join('') || '<span class="sub">No priority or relevant keywords yet.</span>'}
    </details>`;

  const setLinks = () => el.querySelectorAll('[data-dl]').forEach(a => (a.href = dlHref(a.dataset.dl, state.scope, $('#camp') ? $('#camp').value : campaign)));
  setLinks();
  $('#camp').oninput = setLinks;
  $('#camp').onchange = e => guard(() => api('/projects/' + p.id, { method: 'PUT', body: { campaign: e.target.value } }));

  const body = $('#rows');
  const colCount = cols.length + 1;
  const tag = k => (showFile ? `<span class="ftag">${esc(bn.get(k.batchId) || '')}</span>` : '');
  body.innerHTML = rows.length ? rows.slice(0, 1500).map(k => `<tr data-id="${k.id}">
      <td class="kw">${esc(k.keyword)}${tag(k)}</td>
      <td>${k.category ? `<select class="sel ${k.category}" aria-label="Category for ${esc(k.keyword)}">${CATS.map(([v, l]) => `<option value="${v}" ${k.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : '<span class="mt">unsorted</span>'}</td>
      <td class="conf-td">${confCell(k)}</td>
      <td class="intent">${esc(k.intent || '')}</td>
      ${showService ? `<td class="svc">${esc(k.service || '')}</td>` : ''}
      ${metrics.map(([f]) => `<td class="num">${fmt(k[f])}</td>`).join('')}
      <td class="why" title="${esc([k.reason, k.note].filter(Boolean).join('. '))}">${esc(k.reason || '')}${k.note ? `<span class="note">${esc(k.note)}</span>` : ''}</td>
      <td><button class="x ed" title="Remove keyword" aria-label="Remove ${esc(k.keyword)}">&times;</button></td></tr>`).join('') +
    (rows.length > 1500 ? `<tr><td colspan="${colCount}" class="empty-state">Showing the first 1500 of ${rows.length}. Use the filters to narrow it down.</td></tr>` : '')
    : `<tr><td colspan="${colCount}" class="empty-state">Nothing matches this filter.</td></tr>`;

  el.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => { state.filter = b.dataset.f; drawResults(); }));
  el.querySelectorAll('th[data-k]').forEach(th => (th.onclick = () => {
    const k = th.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'asc' ? 'desc' : 'asc' };
    drawResults();
  }));
  $('#search').oninput = e => {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    drawResults();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  };
  body.querySelectorAll('select').forEach(sel => (sel.onchange = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/keyword/${sel.closest('tr').dataset.id}`, { method: 'PATCH', body: { category: sel.value } });
    await refreshList(); drawFiles(); drawResults();
  })));
  body.querySelectorAll('.x').forEach(btn => (btn.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/keyword/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
    await refreshList(); drawFiles(); drawResults();
  })));
  lockIfViewer();
}

function confCell(k) {
  if (k.source === 'ai' && k.confidence != null) {
    const cls = k.confidence >= 85 ? 'hi' : k.confidence >= 65 ? 'mid' : 'lo';
    return `<span class="conf ${cls}" title="${k.confidence}% sure"><i style="width:${k.confidence}%"></i></span><span class="confn">${k.confidence}%</span>`;
  }
  const label = { you: 'you decided', performance: 'campaign data', rules: 'basic' }[k.source] || '';
  return `<span class="mt">${label}</span>`;
}

/* ---------- progress while the analysis works ---------- */
let pollTimer = null;
function pollIfBusy() {
  clearTimeout(pollTimer);
  const p = state.project;
  if (!p || !(reading(p) || p.batches.some(busyAI))) return;
  pollTimer = setTimeout(async () => {
    try {
      const s = await api(`/projects/${p.id}/status`);
      if (!state.project || state.project.id !== p.id) return;
      const finished = [];
      const was = state.project.analysis && state.project.analysis.status;
      state.project.analysis = s.analysis || state.project.analysis;
      for (const sb of s.batches) {
        const b = state.project.batches.find(x => x.id === sb.id);
        if (!b) continue;
        if (busyAI(b) && !busyAI(sb)) finished.push({ name: b.name, ai: sb.ai });
        b.ai = sb.ai; b.counts = sb.counts; b.page = sb.page || b.page;
      }
      const readDone = was === 'running' && s.analysis && s.analysis.status !== 'running';
      if (readDone || finished.length) {
        state.project = await api('/projects/' + p.id);
        await refreshList();
        if (readDone) {
          const a = state.project.analysis;
          if (a.status === 'done') {
            toast(`Finished reading your website: ${a.pagesRead} page${a.pagesRead === 1 ? '' : 's'}${a.services ? `, ${a.services} services found` : ''}.`);
            if (state.goAfterRead) { state.view = 'keywords'; state.goAfterRead = false; resetUpload(state.project); render(); }
          } else { state.goAfterRead = false; toast(a.error || 'The website could not be read.', true); }
        }
        if (state.view === 'keywords') { drawBanner(); drawFiles(); drawResults(); } else if (readDone) renderBusiness();
        for (const d of finished) toast(d.ai.status === 'error' ? `Analysis of "${d.name}" failed: ${d.ai.note}` : `Finished analysing "${d.name}".`, d.ai.status === 'error');
      } else {
        drawBanner();
        if (state.view === 'keywords') drawFiles();
      }
    } catch (e) { /* try again on the next tick */ }
    pollIfBusy();
  }, 1500);
}

/* ---------- reading files ---------- */
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

async function readSheetFile(f) {
  if (f.size > 8 * 1024 * 1024) throw new Error('That file is over 8 MB. Filter the report to fewer days or one campaign.');
  const buf = await f.arrayBuffer();
  if (/\.xlsx?$/i.test(f.name)) {
    const X = await loadXlsx();
    const wb = X.read(buf, { type: 'array' });
    return X.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
  }
  return decodeBuffer(buf);
}

/* ---------- business view ---------- */
function renderBusiness() {
  const p = state.project || { name: '', url: '', description: '', offerings: '', serviceArea: '', seeds: [], exclude: [], strictness: 'balanced', competitors: [], brands: [] };
  const analyzed = Boolean(p.profile);
  const busy = reading(state.project);
  $('#pane').innerHTML = `
    <div id="banner"></div>
    <form class="form" id="brief" autocomplete="off">
      <div class="field"><label for="f-name">Project name</label><input type="text" id="f-name" value="${esc(p.name)}" required placeholder="Dinesh Aarjav, NRI tax"></div>
      <div class="field"><label for="f-url">Website</label><input type="text" id="f-url" value="${esc(p.url)}" placeholder="example.com"><span class="hint">Up to ${state.config.maxPages} pages are read, starting from this one. The text is stored and used to understand your services.</span></div>
      <div class="field full"><label for="f-desc">About the business</label><textarea id="f-desc" placeholder="Who you are, who buys from you, what makes you different.">${esc(p.description)}</textarea></div>
      <div class="field"><label for="f-off">Products or services</label><textarea id="f-off" placeholder="One per line or separated by commas.">${esc(p.offerings)}</textarea></div>
      <div class="field"><label for="f-area">Where you work</label><textarea id="f-area" placeholder="Cities, countries, or online only. Searches for places you do not serve are treated as waste.">${esc(p.serviceArea || '')}</textarea></div>
      <div class="field"><label for="f-seed">Keywords you already want</label><textarea id="f-seed" placeholder="nri tax consultant&#10;nri itr filing">${esc((p.seeds || []).join('\n'))}</textarea><span class="hint">These count the most.</span></div>
      <div class="field"><label for="f-ex">Never show for</label><textarea id="f-ex" placeholder="Competitor names, services you do not offer">${esc((p.exclude || []).join('\n'))}</textarea><span class="hint">A keyword containing any of these goes straight to Negative.</span></div>
      <div class="field full"><label>Research-style searches ("how to", "what is", courses)</label>
        <div class="radios">
          <label><input type="radio" name="strict" value="balanced" ${p.strictness !== 'strict' ? 'checked' : ''}> Judge them on their merits</label>
          <label><input type="radio" name="strict" value="strict" ${p.strictness === 'strict' ? 'checked' : ''}> Treat them as negatives</label>
        </div></div>
      <div class="actions">
        <button class="btn primary" type="submit" id="save" ${busy ? 'disabled' : ''}>${busy ? 'Reading the website...' : analyzed ? 'Save and re-read the website' : 'Save and read the website'}</button>
        ${analyzed ? '<button class="btn" type="button" id="saveOnly">Save without re-reading</button>' : ''}
        ${p.id && p.role === 'owner' ? '<span class="grow"></span><button class="btn danger" type="button" id="del">Delete project</button>' : ''}
      </div>
    </form>
    ${analyzed ? learnedHtml(p.profile) : ''}
    ${p.id ? competitorsHtml(p) : ''}
    ${state.config.aiEnabled ? '' : '<p class="hint footnote">Smart analysis is not switched on for this server, so keywords are sorted by basic rules only.</p>'}`;
  drawBanner();

  const body = () => ({
    name: $('#f-name').value, url: $('#f-url').value, description: $('#f-desc').value, offerings: $('#f-off').value, serviceArea: $('#f-area').value,
    seeds: $('#f-seed').value, exclude: $('#f-ex').value, strictness: $('input[name=strict]:checked').value,
  });
  $('#brief').onsubmit = e => {
    e.preventDefault();
    const btn = $('#save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Starting...';
    guard(async () => {
      try {
        if (!state.project) { state.project = await api('/projects', { method: 'POST', body: body() }); state.view = 'business'; renderSide(); }
        state.project = await api('/projects/' + state.project.id + '/analyze', { method: 'POST', body: body() });
        state.goAfterRead = true;
        await refreshList();
        render(); // shows the progress banner and starts polling
      } catch (err) {
        await refreshList();
        const b = $('#save');
        if (b) { b.disabled = false; b.textContent = analyzed ? 'Save and re-read the website' : 'Save and read the website'; }
        throw err;
      }
    });
  };
  const so = $('#saveOnly');
  if (so) so.onclick = () => guard(async () => {
    state.project = await api('/projects/' + state.project.id, { method: 'PUT', body: body() });
    await refreshList(); renderBusiness(); lockIfViewer(); toast('Saved. Exclusions and strictness were applied to your keywords.');
  });
  const del = $('#del');
  if (del) del.onclick = () => {
    if (!confirm(`Delete "${p.name}" with all its uploads and keywords? This cannot be undone.`)) return;
    guard(async () => { await api('/projects/' + p.id, { method: 'DELETE' }); state.project = null; state.view = 'keywords'; await refreshList(); render(); });
  };
  if (p.id) wireCompetitors();
}

function learnedHtml(pr) {
  const pages = pr.pages.map(pg => `<li>${esc(pg.url)} <span>(${pg.words} words)</span></li>`).join('');
  const errs = pr.errors.map(er => `<li class="bad">${esc(er.url)}: ${esc(er.error)}</li>`).join('');
  const services = (pr.services || []).map(sv => `<li><b>${esc(sv.name)}</b>${sv.pageUrl ? ` <a href="${esc(sv.pageUrl)}" target="_blank" rel="noopener">${esc(prettyUrl(sv.pageUrl))}</a>` : ''}<br><span class="hint">${esc(sv.what)}${sv.forWhom ? ' For: ' + esc(sv.forWhom) + '.' : ''}</span></li>`).join('');
  return `<div class="learned">
    <h2>What the tool learned</h2>
    ${pr.summary ? `<p>${esc(pr.summary)}</p>` : ''}
    ${services ? `<p class="label">Services found on the website (${pr.services.length})</p><ul class="services">${services}</ul>` : ''}
    <p class="label">Strongest terms</p>
    <div class="chips">${pr.topTerms.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    ${pr.notOffered.length ? `<p class="label">Looks like you do not sell</p><div class="chips">${pr.notOffered.map(t => `<span class="chip neg">${esc(t)}</span>`).join('')}</div>` : ''}
    <details class="extras"><summary>Pages read (${pr.pages.length})</summary><ul class="pages">${pages || '<li>None, using only what you typed.</li>'}${errs}</ul></details>
    ${pr.aiNote ? `<p class="hint">${esc(pr.aiNote)}</p>` : ''}
    <p class="hint">Wrong or missing services? Write a clearer description or add the keywords you want, then read the website again.</p>
  </div>`;
}

/* ---------- competitors ---------- */
function competitorsHtml(p) {
  const comps = p.competitors.map(c => `<li>
      <span><b>${esc(c.name)}</b> <span class="pm">${esc(c.host)}</span><br><span class="pm">${c.pages.length} page${c.pages.length === 1 ? '' : 's'} read${c.errors.length ? ', ' + c.errors.length + ' failed' : ''}</span></span>
      <button class="x ed" data-rm="${c.id}" aria-label="Remove ${esc(c.name)}">&times;</button></li>`).join('');
  const brands = p.brands.map(b => `<button class="chip brand ${b.enabled ? '' : 'off'} ed" data-b="${esc(b.phrase)}" aria-pressed="${b.enabled}" title="${esc('From ' + b.competitor + '. Click to ' + (b.enabled ? 'stop blocking' : 'block again'))}">${esc(b.phrase)}</button>`).join('');
  const gaps = (p.gaps || []).map((g, i) => `<li><label><input type="checkbox" class="ed" data-i="${i}"> <b>${esc(g.phrase)}</b></label> <span class="pm">${g.competitors.map(esc).join(', ')}</span></li>`).join('');
  return `<div class="competitors" id="competitors">
    <h2>Competitors</h2>
    <p class="sub">Optional. Their brand names can be blocked as negatives, and their headings show topics your site may be missing.</p>
    <div class="kw-wrap">
      <div>
        <div class="field"><label for="c-urls">Competitor websites</label>
          <textarea id="c-urls" class="ed" style="min-height:92px" placeholder="competitor-one.com&#10;competitor-two.com" spellcheck="false">${esc(p.competitors.map(c => c.url).join('\n'))}</textarea>
          <span class="hint">Up to ${state.config.maxCompetitors}, one per line. About 5 pages are read from each.</span></div>
        <div class="actions" style="padding-top:10px"><button class="btn ed" id="c-go">${p.competitors.length ? 'Read them again' : 'Read competitor sites'}</button></div>
      </div>
      <div>${p.competitors.length ? `<ul class="members">${comps}</ul>` : ''}</div>
    </div>
    ${p.competitors.length ? `<div class="twocol">
      <div><h3>Brand names</h3>
        <label class="check"><input type="checkbox" id="c-block" class="ed" ${p.blockCompetitors ? 'checked' : ''}> Send searches containing these names to Negative</label>
        <div class="chips" style="margin-top:10px">${brands || '<span class="sub">No usable brand names found.</span>'}</div>
        <p class="hint">Only names with a word that is not in your own vocabulary count. Click a name to switch it off. Leave this off if you plan to bid on competitor names on purpose.</p></div>
      <div><h3>Topics they cover that you do not</h3>
        ${gaps ? `<ul class="gaps">${gaps}</ul><p><button class="btn small primary ed" id="c-add">Add selected as a new upload</button></p>` : '<span class="sub">Nothing stands out. Try a competitor with a larger site.</span>'}</div>
    </div>` : ''}
  </div>`;
}

function wireCompetitors() {
  const p = state.project;
  const pane = $('#pane');
  $('#c-go').onclick = () => {
    const btn = $('#c-go');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Reading sites...';
    guard(async () => {
      try {
        const r = await api(`/projects/${p.id}/competitors`, { method: 'POST', body: { urls: $('#c-urls').value } });
        state.project = r.project; await refreshList(); renderBusiness(); lockIfViewer();
        $('#competitors').scrollIntoView({ behavior: 'smooth' });
        if (r.failed.length) toast('Could not use: ' + r.failed.map(f => f.url + ' (' + f.error + ')').join('; '), true);
        else toast('Read ' + r.project.competitors.length + ' competitor site(s).');
      } finally { const b = $('#c-go'); if (b) { b.disabled = false; b.textContent = 'Read competitor sites'; } }
    });
  };
  pane.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => guard(async () => { state.project = await api(`/projects/${p.id}/competitors/${b.dataset.rm}`, { method: 'DELETE' }); await refreshList(); renderBusiness(); lockIfViewer(); })));
  pane.querySelectorAll('[data-b]').forEach(b => (b.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/brand`, { method: 'PATCH', body: { phrase: b.dataset.b, enabled: b.getAttribute('aria-pressed') !== 'true' } });
    await refreshList(); renderBusiness(); lockIfViewer();
  })));
  const blk = $('#c-block');
  if (blk) blk.onchange = () => guard(async () => { state.project = await api('/projects/' + p.id, { method: 'PUT', body: { blockCompetitors: blk.checked } }); await refreshList(); renderBusiness(); lockIfViewer(); });
  const add = $('#c-add');
  if (add) add.onclick = () => {
    const picked = [...pane.querySelectorAll('.gaps input:checked')].map(i => p.gaps[Number(i.dataset.i)].phrase);
    if (!picked.length) return toast('Tick the topics you want first.', true);
    guard(async () => {
      const r = await api(`/projects/${p.id}/uploads`, { method: 'POST', body: { text: picked.join('\n'), name: 'Competitor topics' } });
      state.project = r.project;
      await finishUpload(r.batchId, [uploadMessage('Competitor topics', r)]);
    });
  };
}
