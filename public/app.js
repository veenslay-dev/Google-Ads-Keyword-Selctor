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
  goAfterRead: false, expanded: new Set(),
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

/* ---------- projects ---------- */
async function refreshList() {
  state.projects = await api('/projects');
}

function remember(id) { try { localStorage.setItem('lastProject', id || ''); } catch (e) { /* storage blocked */ } }

async function openProject(id) {
  state.project = await api('/projects/' + id);
  state.scope = 'all'; state.filter = 'all'; state.search = ''; state.expanded = new Set();
  resetUpload(state.project);
  state.view = state.project.profile || reading(state.project) ? 'keywords' : 'business';
  remember(id);
  render();
}

function goProjects() {
  clearTimeout(pollTimer);
  state.project = null; state.view = 'keywords';
  remember('');
  render();
}

function startNew() {
  state.project = null; state.view = 'new';
  render();
}

const FEATURES = [
  ['cloud', 'Upload Anywhere', 'Use files from Google Ads, Semrush, Ahrefs or any source.'],
  ['filter', 'Smart Filtering', 'Keep only the keywords that match your business.'],
  ['download', 'Individual Downloads', 'Each file gets its own clean, organised download.'],
  ['calendar', 'Save Time', 'Add new keywords and repeat every day.'],
];

function heroArt() {
  return `<svg viewBox="0 0 520 330" role="img" aria-label="Keyword files from several tools flowing into one upload">
    <defs><linearGradient id="hg" x1="0" x2="1"><stop offset="0" stop-color="#ff5468"/><stop offset="1" stop-color="#d8112a"/></linearGradient></defs>
    <path d="M40 210 C 80 120, 160 70, 250 60" fill="none" stroke="#d8112a" stroke-opacity=".25" stroke-width="3" stroke-dasharray="3 7" stroke-linecap="round"/>
    <path d="M410 70 C 450 40, 480 30, 505 22" fill="none" stroke="#d8112a" stroke-opacity=".3" stroke-width="3" stroke-linecap="round"/>
    <rect x="70" y="86" width="350" height="62" rx="31" fill="#fff" stroke="#d8112a" stroke-width="4"/>
    <circle cx="112" cy="117" r="13" fill="none" stroke="#d8112a" stroke-width="4"/><path d="m122 127 11 11" stroke="#d8112a" stroke-width="4" stroke-linecap="round"/>
    <rect x="152" y="110" width="180" height="14" rx="7" fill="#f3d9dc"/>
    <g font-family="Inter, sans-serif" font-weight="700" font-size="15">
      <rect x="110" y="34" width="86" height="40" rx="20" fill="#fff"/><text x="153" y="59" text-anchor="middle" fill="#1e2030">SEO</text>
      <rect x="270" y="26" width="128" height="44" rx="22" fill="url(#hg)"/><text x="334" y="53" text-anchor="middle" fill="#fff">Keywords</text>
      <rect x="110" y="168" width="156" height="46" rx="23" fill="#fff"/><circle cx="138" cy="191" r="9" fill="#2b6be0"/><text x="200" y="197" text-anchor="middle" fill="#1e2030">Google Ads</text>
      <rect x="160" y="228" width="130" height="46" rx="23" fill="#fff"/><circle cx="188" cy="251" r="9" fill="#e38810"/><text x="242" y="257" text-anchor="middle" fill="#1e2030">Semrush</text>
      <rect x="210" y="288" width="116" height="40" rx="20" fill="#fff"/><circle cx="236" cy="308" r="8" fill="#2b6be0"/><text x="284" y="313" text-anchor="middle" fill="#1e2030">Ahrefs</text>
    </g>
    <g transform="translate(345 150) rotate(6)"><rect width="130" height="150" rx="22" fill="url(#hg)"/><path d="M88 0h6l36 36v6H98a10 10 0 0 1-10-10z" fill="#fff" fill-opacity=".3"/>
      <path d="M65 112V58M44 78l21-21 21 21" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></g>
  </svg>`;
}

function renderProjects() {
  const main = $('#main');
  if (!state.projects.length) {
    main.innerHTML = `
      <section class="hero">
        <div>
          <span class="pill">${I('search')} Keyword Selector</span>
          <h1>Sort your keywords by what <em>you actually sell.</em></h1>
          <p>Tell the tool about your business, then drop in keyword files from Google Ads, Semrush, Ahrefs or anywhere else. Each file becomes its own upload with its own download, so you can add new keywords every day.</p>
          <button class="btn primary big" id="startNew">${I('plus')} Create your first project ${I('arrow')}</button>
        </div>
        <div class="hero-art">${heroArt()}</div>
      </section>
      <section class="features">${FEATURES.map(([ic, t, d]) => `<div class="feat"><span class="fico">${I(ic)}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}</section>`;
    $('#startNew').onclick = startNew;
    return;
  }
  main.innerHTML = `
    <div class="lhead"><div><h1>Projects</h1><p class="sub">${state.projects.length} project${state.projects.length === 1 ? '' : 's'}. Pick one to add keywords or see results.</p></div>
      <button class="btn primary" id="startNew">${I('plus')} New project</button></div>
    <div class="pgrid">${state.projects.map(p => {
      const c = p.counts;
      const who = p.role === 'owner' ? (p.shared ? 'Shared' : '') : `${p.role} · ${p.ownerName}`;
      return `<button class="pcard" data-open="${p.id}">
        <span class="pcard-top"><span class="pico">${I('bolt')}</span><span><h3>${esc(p.name)}</h3><span class="purl">${esc(p.url ? prettyUrl(p.url) : 'No website added')}</span></span></span>
        <span class="ucounts">${miniBar(c)}<span class="unums"><b class="priority">${c.priority}</b><b class="relevant">${c.relevant}</b><b class="review">${c.review}</b><b class="negative">${c.negative}</b></span></span>
        <span class="pcard-stats"><span><b>${p.total}</b> keywords</span><span><b>${p.uploads}</b> upload${p.uploads === 1 ? '' : 's'}</span>${who ? `<span class="role">${esc(who)}</span>` : ''}</span>
      </button>`;
    }).join('')}</div>`;
  $('#startNew').onclick = startNew;
  main.querySelectorAll('[data-open]').forEach(b => (b.onclick = () => guard(() => openProject(b.dataset.open))));
}

// Keywords over time: running total after each upload.
function sparkline(p) {
  const pts = [...p.batches].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).reduce((acc, b) => (acc.push((acc.at(-1) || 0) + b.counts.total), acc), []);
  if (!pts.length) pts.push(0, 0); else if (pts.length === 1) pts.unshift(0);
  const W = 150, H = 56, pad = 4, max = Math.max(...pts, 1);
  const x = i => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = v => H - pad - (v / max) * (H - pad * 2 - 2);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Keywords over time">
    <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${x(0)},${H - pad} ${line} ${x(pts.length - 1)},${H - pad}" fill="url(#sg)"/>
    <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function statCard(p) {
  const weekAgo = Date.now() - 7 * 864e5;
  const week = p.batches.filter(b => new Date(b.createdAt).getTime() >= weekAgo).reduce((n, b) => n + b.counts.total, 0);
  return `<div class="stat"><div><div class="stat-label">Total keywords</div><div class="stat-num">${p.counts.total.toLocaleString()}</div>
    ${week ? `<span class="trend" title="Keywords added in the last 7 days">${I('trend')} +${week.toLocaleString()} this week</span>` : ''}</div>${sparkline(p)}</div>`;
}

/* ---------- project shell ---------- */
function render() {
  const p = state.project;
  if (!p && state.view !== 'new') { renderProjects(); return; }
  if (p) remember(p.id); // a reload comes back to this project
  const main = $('#main');
  const link = p && p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)} ${I('external')}</a>` : `<span class="muted">${p ? 'No website added yet' : 'Start with a few details about the business'}</span>`;
  main.innerHTML = `
    <a href="#" class="back" id="back">${I('left')} Back to Projects</a>
    <section class="phead">
      <div class="pid"><span class="pico">${I('bolt')}</span><div class="ptitle"><h1>${p ? esc(p.name) : 'New project'}</h1><p class="purl">${link}</p></div></div>
      ${p ? `<div class="pright"><div class="pbadges"><span class="role">${esc(p.role)}</span><button class="btn outline small" id="share">${I('share')} Share</button></div>${statCard(p)}</div>` : ''}
    </section>
    <nav class="tabs2" aria-label="Project sections">
      <button data-view="keywords" class="${state.view === 'keywords' ? 'on' : ''}" ${p ? '' : 'disabled'}>Keywords${p && p.keywords.length ? `<b>${p.keywords.length}</b>` : ''}</button>
      <button data-view="business" class="${state.view !== 'keywords' ? 'on' : ''}">Business</button>
    </nav>
    <section id="pane" class="${viewer() ? 'ro' : ''}"></section>`;
  $('#back').onclick = async e => { e.preventDefault(); await refreshList(); goProjects(); };
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
  document.querySelectorAll('#pane textarea, #pane select, #pane .ed, #pane #brief input, #pane #brief button').forEach(el => (el.disabled = true));
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
    el.innerHTML = `<div class="promo"><span class="promo-ico">${I('bulb')}</span><p>Add today's keywords. Every upload is kept on its own, so earlier ones stay untouched.</p><button class="btn primary ed" id="openUp">${I('plus')} New upload</button></div>`;
    $('#openUp').onclick = () => { state.up.open = true; drawNewUpload(); lockIfViewer(); const n = $('#u-name'); if (n) n.focus(); };
    lockIfViewer();
    return;
  }
  const many = u.mode === 'files' && u.files.length > 1;
  el.innerHTML = `
    <div class="newup">
      <div class="newup-head"><h2>New upload</h2>${p.batches.length ? `<button class="x" id="closeUp" aria-label="Cancel">${I('x')}</button>` : ''}</div>
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
          <p><span class="fico" style="margin:0 auto 10px">${I('cloud')}</span></p>
          <p><b>Drop files here</b>, or <button class="btn link ed" id="pick">choose files</button></p>
          <p class="hint">CSV, TSV, TXT or XLSX. Google Ads search terms reports, Keyword Planner, Semrush, Ahrefs or a plain list.</p>
          <input type="file" id="file" multiple accept=".csv,.tsv,.txt,.xlsx,.xls" hidden>
        </div>
        ${u.files.length ? `<ul class="staged">${u.files.map((f, i) => `<li><span>${esc(f.name)}</span><span class="hint">${sizeOf(f.size)}</span><button class="x ed" data-rmfile="${i}" aria-label="Remove ${esc(f.name)}">${I('x')}</button></li>`).join('')}</ul>` : ''}`
      : `<div class="field"><label for="u-text" class="sr">Keywords</label><textarea id="u-text" class="ed" spellcheck="false" rows="7" placeholder="One per line, or paste straight from a spreadsheet column.">${esc(u.text)}</textarea></div>`}
      <div class="actions"><button class="btn primary ed" id="u-go">${I('plus')} ${state.config.aiEnabled ? 'Add and analyse' : 'Add keywords'}</button><span class="hint" id="u-info"></span></div>
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
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Adding...';
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
const nums = c => `<span class="unums"><b class="priority">${c.priority}</b><b class="relevant">${c.relevant}</b><b class="review">${c.review}</b><b class="negative">${c.negative}</b></span>`;

function statusPill(b) {
  const a = b.ai || {};
  const note = a.note ? `<span class="ainote" title="${esc(a.note)}">${esc(a.note)}</span>` : '';
  if (a.status === 'running' || a.status === 'queued') {
    if (a.status === 'queued') return '<span class="spill">Waiting in line</span>';
    if (a.stage === 'page') return '<span class="spill run"><span class="spin"></span> Reading the landing page</span>';
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    return `<span class="spill run"><span class="spin"></span> Analysing ${a.done || 0} of ${a.total || 0}</span><span class="prog"><i style="width:${pct}%"></i></span>`;
  }
  if (a.status === 'done') return (b.stale ? `<span class="spill stale" title="The business details changed after this was analysed.">Out of date</span>` : `<span class="spill ok">${I('check')} Analysed</span>`) + note;
  if (a.status === 'error') return '<span class="spill bad">Analysis failed</span>' + note;
  if (a.status === 'interrupted') return '<span class="spill bad">Analysis stopped</span>' + note;
  if (a.status === 'waiting' && state.config.aiEnabled) return `<span class="spill">${reading(state.project) ? 'Waiting for the website' : 'Waiting for business details'}</span>`;
  return '<span class="spill">Basic sorting</span>';
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
  const fmtDate = d => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = [...p.batches].reverse().map(b => {
    const c = b.counts;
    const kind = b.kind === 'Keyword list' ? '' : esc(b.kind) + ' · ';
    return `<li class="urow ${state.scope === b.id ? 'on' : ''}" data-id="${b.id}">
      <button class="umain" data-select="${b.id}" aria-pressed="${state.scope === b.id}"><span class="uico">${I('file')}</span>
        <span class="utext"><span class="uname">${esc(b.name)}</span><span class="umeta">${kind}${c.total} keyword${c.total === 1 ? '' : 's'} · Uploaded on ${esc(fmtDate(b.createdAt))}${pageLine(b)}</span></span></button>
      <span class="ucounts">${miniBar(c)}${nums(c)}</span>
      <span class="ustat">${statusPill(b)}</span>
      <details class="menu"><summary aria-label="Actions for ${esc(b.name)}">${I('dots')}</summary>
        <div class="menu-pop">
          <a href="${dlHref('ads-targeting', b.id, campaignName())}">${I('download')} Download keywords to target</a>
          <a href="${dlHref('ads-negatives', b.id, campaignName())}">${I('download')} Download negative keywords</a>
          <a href="${dlHref('all', b.id, campaignName())}">${I('download')} Download everything (CSV)</a>
          <hr>
          ${state.config.aiEnabled ? `<button class="ed" data-recheck="${b.id}">${I('trend')} Analyse again</button>` : ''}
          <button class="ed" data-rename="${b.id}">${I('file')} Rename</button>
          <button class="ed" data-page="${b.id}">${I('globe')} ${b.pageUrl ? 'Change landing page' : 'Set landing page'}</button>
          <button class="ed danger" data-delete="${b.id}">${I('x')} Delete this upload</button>
        </div></details>
    </li>`;
  }).join('');
  el.innerHTML = `<div class="sect-head"><h2>Uploads</h2><span class="muted">${p.batches.length} file${p.batches.length === 1 ? '' : 's'}, ${all.total} keywords</span>
      ${stale.length && state.config.aiEnabled ? `<button class="btn outline small ed right" id="restale">Analyse ${stale.length} out-of-date upload${stale.length === 1 ? '' : 's'} again</button>` : ''}</div>
    <ul class="ucard">
      <li class="urow ${state.scope === 'all' ? 'on' : ''}"><button class="umain" data-select="all" aria-pressed="${state.scope === 'all'}"><span class="uico all">${I('file')}</span>
        <span class="utext"><span class="uname">All uploads together</span><span class="umeta">${all.total} keywords</span></span></button>
        <span class="ucounts">${miniBar(all)}${nums(all)}</span><span class="ustat"></span><span></span></li>
      ${rows}</ul>
    <div class="legend"><span class="priority"><i></i>Priority</span><span class="relevant"><i></i>Relevant</span><span class="review"><i></i>Review</span><span class="negative"><i></i>Negative</span></div>`;

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
      await refreshList(); render();
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
  document.querySelectorAll('details.menu[open], details.dl[open], details.usermenu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
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

const CAT_ICON = { priority: 'up', relevant: 'circlecheck', review: 'eye', negative: 'ban' };
const DECIDED = { ai: 'Analysis', rules: 'Basic rules', performance: 'Campaign results', you: 'You' };

function drawResults() {
  const p = state.project;
  const el = $('#results');
  if (!p.keywords.length) {
    el.innerHTML = p.batches.length ? '' : `<div class="card empty-state"><b>No keywords yet.</b><br>Add a file or paste a list above and the results appear here.</div>`;
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
  const cols = [['keyword', 'Keyword'], ['category', 'Category'], ['confidence', 'Confidence'], ['intent', 'Intent'], ...metrics.map(([f, l]) => [f, l, 1]), ['reason', 'Why']];
  const bn = new Map(p.batches.map(b => [b.id, b]));
  const ps = p.perfSummary;
  const campaign = campaignName();
  const colCount = cols.length + 1;

  el.innerHTML = `
    <div class="sect-head"><h2>${batch ? esc(batch.name) : 'All uploads'}</h2>
      <details class="dl"><summary class="btn">${I('download')} Download</summary>
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
    <div class="tools">
      <div class="fpills">${[['all', 'All'], ...CATS].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${k === 'all' ? '' : `<span class="dot ${k}"></span>`}${l} <b>${c[k]}</b></button>`).join('')}</div>
      <div class="searchbox">${I('search')}<input type="text" id="search" placeholder="Search keywords..." value="${esc(state.search)}" aria-label="Search keywords"></div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}" ${state.sort.key === k ? `data-dir="${state.sort.dir}"` : ''}>${l}</th>`).join('')}<th class="nosort"></th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <details class="extras"><summary>${I('right')} Suggested account-level negative words</summary>
      <p class="sub">Words that keep turning up in your negatives and never on your site. Good candidates for a shared negative list.</p>
      <div class="chips">${(p.negativeWords || []).map(w => `<span class="chip neg">${esc(w.word)}<small>${w.count}</small></span>`).join('') || '<span class="sub">Nothing repeats yet.</span>'}</div>
      ${(p.negativeWords || []).length ? `<p><a class="btn small" data-dl="negative-words">${I('download')} Download as a negative list</a></p>` : ''}
    </details>
    <details class="extras"><summary>${I('right')} Ad group ideas</summary>
      <p class="sub">Priority and relevant keywords grouped by their strongest shared term. A starting point, not a final structure.</p>
      ${(p.adGroups || []).map(g => `<details class="ag"><summary>${esc(g.name)}<span>${g.ids.length}</span></summary><div>${g.ids.map(id => esc((p.keywords.find(k => k.id === id) || {}).keyword)).join(', ')}</div></details>`).join('') || '<span class="sub">No priority or relevant keywords yet.</span>'}
    </details>`;

  const setLinks = () => el.querySelectorAll('[data-dl]').forEach(a => (a.href = dlHref(a.dataset.dl, state.scope, $('#camp') ? $('#camp').value : campaign)));
  setLinks();
  $('#camp').oninput = setLinks;
  $('#camp').onchange = e => guard(() => api('/projects/' + p.id, { method: 'PUT', body: { campaign: e.target.value } }));

  const detail = k => {
    const b = bn.get(k.batchId);
    const items = [
      ['Matched service', k.service], ['Suggested match type', k.matchType], ['Decided by', DECIDED[k.source]],
      ['Confidence', k.source === 'ai' && k.confidence != null ? k.confidence + '%' : ''], ['Intent', k.intent], ['Upload', b && b.name],
      ['Landing page', b && b.pageUrl ? prettyUrl(b.pageUrl) : ''], ['Searches a month', fmt(k.volume)], ['Suggested bid', fmt(k.bid)], ['Competition', k.competition],
      ['Impressions', fmt(k.impressions)], ['Clicks', fmt(k.clicks)], ['Cost', fmt(k.cost)], ['Conversions', fmt(k.conversions)],
    ].filter(([, v]) => v !== '' && v != null);
    return `<dl class="dgrid">${items.map(([t, v]) => `<div><dt>${t}</dt><dd>${esc(v)}</dd></div>`).join('')}
      <div class="wide"><dt>Why</dt><dd>${esc([k.reason, k.note].filter(Boolean).join('. ') || 'No reason recorded')}</dd></div></dl>`;
  };

  const body = $('#rows');
  body.innerHTML = rows.length ? rows.slice(0, 1500).map(k => {
    const open = state.expanded.has(k.id);
    const sub = [state.scope === 'all' && bn.get(k.batchId) ? bn.get(k.batchId).name : '', k.service].filter(Boolean).join(' · ');
    return `<tr class="kwrow" data-id="${k.id}">
      <td class="kw"><div class="kwcell"><button class="twisty ${open ? 'open' : ''}" data-tw="${k.id}" aria-expanded="${open}" aria-label="Details for ${esc(k.keyword)}">${I('right')}</button>
        <div><span class="kwtext">${esc(k.keyword)}</span>${sub ? `<span class="kwsub">${esc(sub)}</span>` : ''}</div></div></td>
      <td>${k.category ? `<label class="catpill ${k.category}">${I(CAT_ICON[k.category])}<select aria-label="Category for ${esc(k.keyword)}">${CATS.map(([v, l]) => `<option value="${v}" ${k.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : '<span class="mt">unsorted</span>'}</td>
      <td class="conf-td">${confCell(k)}</td>
      <td class="intent">${esc(k.intent || '')}</td>
      ${metrics.map(([f]) => `<td class="num">${fmt(k[f])}</td>`).join('')}
      <td class="why">${esc(k.reason || '')}${k.note ? `<span class="note">${esc(k.note)}</span>` : ''}</td>
      <td><button class="x ed" title="Remove keyword" aria-label="Remove ${esc(k.keyword)}">${I('x')}</button></td></tr>
      ${open ? `<tr class="detail"><td colspan="${colCount}">${detail(k)}</td></tr>` : ''}`;
  }).join('') + (rows.length > 1500 ? `<tr><td colspan="${colCount}" class="empty-state">Showing the first 1500 of ${rows.length}. Use the filters to narrow it down.</td></tr>` : '')
    : `<tr><td colspan="${colCount}" class="empty-state">Nothing matches this filter.</td></tr>`;

  el.querySelectorAll('.fpills button').forEach(b => (b.onclick = () => { state.filter = b.dataset.f; drawResults(); }));
  el.querySelectorAll('th[data-k]').forEach(th => (th.onclick = () => {
    const k = th.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'asc' ? 'desc' : 'asc' };
    drawResults();
  }));
  $('#search').oninput = e => {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    drawResults();
    const sb = $('#search'); sb.focus(); sb.setSelectionRange(pos, pos);
  };
  body.querySelectorAll('[data-tw]').forEach(b => (b.onclick = () => {
    const id = b.dataset.tw;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    drawResults();
  }));
  body.querySelectorAll('select').forEach(sel => (sel.onchange = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/keyword/${sel.closest('tr').dataset.id}`, { method: 'PATCH', body: { category: sel.value } });
    await refreshList(); drawFiles(); drawResults();
  })));
  body.querySelectorAll('.x').forEach(btn => (btn.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/keyword/${btn.closest('tr').dataset.id}`, { method: 'DELETE' });
    await refreshList(); render();
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
    <div class="formcard"><form class="form" id="brief" autocomplete="off">
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
    </form></div>
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
    btn.innerHTML = '<span class="spin"></span> Starting...';
    guard(async () => {
      try {
        if (!state.project) { state.project = await api('/projects', { method: 'POST', body: body() }); state.view = 'business'; }
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
      <button class="x ed" data-rm="${c.id}" aria-label="Remove ${esc(c.name)}">${I('x')}</button></li>`).join('');
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
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Reading sites...';
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
