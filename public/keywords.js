/* ---------- keyword pages ---------- */
function resetUpload() {
  // open: null means "open while the campaign has no uploads yet"
  state.up = { open: null, mode: 'files', files: [], name: '', url: '', text: '' };
}

// Every campaign together. Keywords are added inside campaigns, so this page only shows results.
function renderAllKeywords() {
  const p = state.project;
  $('#phead').innerHTML = pageHead('All keywords', 'Every campaign together.', statCard(p));
  $('#pane').innerHTML = `<div id="banner"></div>
    <div class="promo"><span class="promo-ico">${I('megaphone')}</span>
      <p>${p.campaigns.length ? 'Keywords are added inside campaigns. Open one from the sidebar to add today\'s keywords.' : 'Keywords are added inside campaigns. Create your first campaign to start.'}</p>
      <button class="btn primary ed" id="newCamp">${I('plus')} New campaign</button></div>
    <div id="results"></div>`;
  $('#newCamp').onclick = () => campaignDialog();
  drawBanner();
  drawResults();
}

// One campaign: its landing page, its uploads, its results.
function renderCampaign() {
  const p = state.project, c = currentCampaign();
  const rows = rowsOfCampaign(c);
  const menu = `<details class="menu"><summary aria-label="Campaign actions">${I('dots')}</summary><div class="menu-pop">
      <button class="ed" id="campEdit">${I('pencil')} Edit name and landing page</button>
      ${state.config.aiEnabled ? `<button class="ed" id="campRecheck">${I('trend')} Analyse all uploads again</button>` : ''}
      <hr><a href="${dlHref('ads-targeting', { campaign: c.id })}">${I('download')} Download keywords to target</a>
      <a href="${dlHref('ads-negatives', { campaign: c.id })}">${I('download')} Download negative keywords</a>
      <hr><button class="ed danger" id="campDelete">${I('trash')} Delete campaign</button></div></details>`;
  $('#phead').innerHTML = `<div class="phead"><div class="pid"><span class="pico">${I('megaphone')}</span><div class="ptitle"><h1>${esc(c.name)}</h1>
      <p class="purl">${c.pageUrl ? `<a href="${esc(c.pageUrl)}" target="_blank" rel="noopener">${esc(c.pageUrl)} ${I('external')}</a>` : '<span class="muted">No landing page set. Uploads can have their own.</span>'}</p></div></div>
    <div class="pright"><div class="pbadges"><span class="role">${esc(p.role)}</span>${menu}</div>${statCard(p, 'Keywords in this campaign', rows, batchesOf(c))}</div></div>`;
  $('#pane').innerHTML = `<div id="banner"></div><section id="newup"></section><div id="files"></div><div id="results"></div>`;
  drawBanner();
  drawNewUpload();
  drawFiles();
  drawResults();
  $('#campEdit').onclick = () => { const m = $('.menu[open]'); if (m) m.open = false; campaignDialog(c); };
  const rc = $('#campRecheck');
  if (rc) rc.onclick = () => guard(async () => { state.project = await api(`/projects/${p.id}/campaigns/${c.id}/recheck`, { method: 'POST' }); render(); toast('Analysing every upload in this campaign, one after another.'); });
  $('#campDelete').onclick = () => {
    if (!confirm(`Delete the campaign "${c.name}" with its ${batchesOf(c).length} upload(s) and ${rows.length} keyword(s)? This cannot be undone.`)) return;
    guard(async () => { state.project = await api(`/projects/${p.id}/campaigns/${c.id}`, { method: 'DELETE' }); await refreshList(); goView('keywords'); });
  };
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
  if (tb) tb.onclick = () => go('/projects/' + projectSlug(p) + '/business');
}

const sizeOf = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// The form for adding keywords. One place for a name, the page the keywords are for, and the keywords themselves.
function drawNewUpload() {
  const p = state.project;
  const c = currentCampaign();
  const el = $('#newup');
  const u = state.up;
  const open = u.open === null ? batchesOf(c).length === 0 : u.open;
  if (!open) {
    el.innerHTML = `<div class="promo"><span class="promo-ico">${I('bulb')}</span><p>Add today's keywords. Every upload is kept on its own, so earlier ones stay untouched.</p><button class="btn primary ed" id="openUp">${I('plus')} New upload</button></div>`;
    $('#openUp').onclick = () => { state.up.open = true; drawNewUpload(); lockIfViewer(); const n = $('#u-name'); if (n) n.focus(); };
    lockIfViewer();
    return;
  }
  const many = u.mode === 'files' && u.files.length > 1;
  el.innerHTML = `
    <div class="newup">
      <div class="newup-head"><h2>New upload <span class="muted" style="font-weight:500">in ${esc(c.name)}</span></h2>${batchesOf(c).length ? `<button class="x" id="closeUp" aria-label="Cancel">${I('x')}</button>` : ''}</div>
      <div class="row2">
        <div class="field"><label for="u-name">Name</label>
          <input type="text" id="u-name" class="ed" value="${esc(u.name)}" placeholder="${many ? 'Each file keeps its own name' : 'NRI property tax, 30 Sep'}" ${many ? 'disabled' : ''}>
          <span class="hint">${many ? 'Several files were chosen, so each is named after its file.' : 'Leave empty to use the file name.'}</span></div>
        <div class="field"><label for="u-url">Landing page <span class="opt">optional</span></label>
          <input type="text" id="u-url" class="ed" value="${esc(u.url)}" placeholder="https://yoursite.com/nri-property-tax">
          <span class="hint">The page these keywords are for. It is read, so each keyword is matched against that exact service.${c.pageUrl ? ` Leave empty to use the campaign's page, ${esc(prettyUrl(c.pageUrl))}.` : ''}</span></div>
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
      const r = await api(`/projects/${p.id}/uploads`, { method: 'POST', body: { text: await j.get(), name: j.name, filename: j.filename, pageUrl: u.url, campaignId: state.campaignId } });
      state.project = r.project; last = r.batchId || last; msgs.push(uploadMessage(j.label, r));
    } catch (e) {
      if (e.auth) return;
      failures++; toast(`${j.label}: ${e.message}`, true);
    }
  }
  if (!msgs.length) { drawNewUpload(); return; }
  resetUpload(); state.up.open = false;
  await finishUpload(last, msgs, { campaignId: state.campaignId });
  if (failures) toast(`${failures} file${failures === 1 ? '' : 's'} could not be added. ${msgs.join(' ')}`, true);
}

function uploadMessage(label, r) {
  const bits = [];
  if (r.added) bits.push(`${r.added} new keyword${r.added === 1 ? '' : 's'}`);
  if (r.updated) bits.push(`results added to ${r.updated} you already had`);
  if (r.duplicates) bits.push(`${r.duplicates} already in the project, skipped`);
  if (r.planLimited) bits.push(`${r.planLimited} left out. ${r.planMessage} Ask the administrator to raise it`);
  if (r.overLimit) bits.push(`${r.overLimit} left out because one upload holds ${state.config.maxKeywords}. Upload them as another file`);
  return `${label}: ${bits.join(', ') || 'nothing to add'}.`;
}

async function finishUpload(batchId, msgs, opts = {}) {
  await refreshList();
  state.project = await api('/projects/' + state.project.id);
  if (opts.campaignId) { state.view = 'campaign'; state.campaignId = opts.campaignId; }
  if (batchId) { state.scope = batchId; state.filter = 'all'; state.search = ''; }
  render();
  toast(msgs.join(' '));
}

/* ---------- files ---------- */
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

// A download link for what is on screen: one upload, one campaign, or everything in the project.
function dlHref(type, scope = {}) {
  const p = state.project;
  const q = scope.batch ? `&batch=${scope.batch}` : scope.campaign ? `&campaignId=${scope.campaign}` : '';
  return `${BASE}/api/projects/${p.id}/export?type=${type}${q}`;
}

function pageLine(b) {
  const url = b.pageUrl || b.inheritedPageUrl;
  if (!url) return '';
  const bad = b.page && b.page.status === 'error';
  return ` · <span class="${bad ? 'negative' : ''}" title="${esc(url)}">${bad ? 'page not readable: ' : b.pageUrl ? 'for ' : 'campaign page: '}${esc(prettyUrl(url))}</span>`;
}

function drawFiles() {
  const p = state.project, camp = currentCampaign();
  const el = $('#files');
  if (!el || !camp) return;
  const batches = batchesOf(camp);
  if (!batches.length) { el.innerHTML = ''; return; }
  const all = countsOf(rowsOfCampaign(camp));
  const stale = batches.filter(b => b.stale);
  const fmtDate = d => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const others = p.campaigns.filter(c => c.id !== camp.id);
  const rows = [...batches].reverse().map(b => {
    const c = b.counts;
    const kind = b.kind === 'Keyword list' ? '' : esc(b.kind) + ' · ';
    return `<li class="urow ${state.scope === b.id ? 'on' : ''}" data-id="${b.id}">
      <button class="umain" data-select="${b.id}" aria-pressed="${state.scope === b.id}"><span class="uico">${I('file')}</span>
        <span class="utext"><span class="uname">${esc(b.name)}</span><span class="umeta">${kind}${c.total} keyword${c.total === 1 ? '' : 's'} · Uploaded on ${esc(fmtDate(b.createdAt))}${pageLine(b)}</span></span></button>
      <span class="ucounts">${miniBar(c)}${nums(c)}</span>
      <span class="ustat">${statusPill(b)}</span>
      <details class="menu"><summary aria-label="Actions for ${esc(b.name)}">${I('dots')}</summary>
        <div class="menu-pop">
          <a href="${dlHref('ads-targeting', { batch: b.id })}">${I('download')} Download keywords to target</a>
          <a href="${dlHref('ads-negatives', { batch: b.id })}">${I('download')} Download negative keywords</a>
          <a href="${dlHref('all', { batch: b.id })}">${I('download')} Download everything (CSV)</a>
          <hr>
          ${state.config.aiEnabled ? `<button class="ed" data-recheck="${b.id}">${I('trend')} Analyse again</button>` : ''}
          <button class="ed" data-rename="${b.id}">${I('pencil')} Rename</button>
          <button class="ed" data-page="${b.id}">${I('globe')} ${b.pageUrl ? 'Change landing page' : 'Set landing page'}</button>
          ${others.map(o => `<button class="ed" data-move="${b.id}" data-to="${o.id}">${I('megaphone')} Move to ${esc(o.name)}</button>`).join('')}
          <button class="ed danger" data-delete="${b.id}">${I('trash')} Delete this upload</button>
        </div></details>
    </li>`;
  }).join('');
  el.innerHTML = `<div class="sect-head"><h2>Uploads</h2><span class="muted">${batches.length} file${batches.length === 1 ? '' : 's'}, ${all.total} keywords</span>
      ${stale.length && state.config.aiEnabled ? `<button class="btn outline small ed right" id="restale">Analyse ${stale.length} out-of-date upload${stale.length === 1 ? '' : 's'} again</button>` : ''}</div>
    <ul class="ucard">
      <li class="urow ${state.scope === 'all' ? 'on' : ''}"><button class="umain" data-select="all" aria-pressed="${state.scope === 'all'}"><span class="uico all">${I('megaphone')}</span>
        <span class="utext"><span class="uname">Whole campaign</span><span class="umeta">${all.total} keywords in ${batches.length} upload${batches.length === 1 ? '' : 's'}</span></span></button>
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
    const url = prompt('The page these keywords are for (leave empty to use the campaign page)', batch.pageUrl || '');
    if (url !== null) guard(async () => { state.project = await api(`/projects/${p.id}/uploads/${batch.id}`, { method: 'PATCH', body: { pageUrl: url } }); drawFiles(); pollIfBusy(); });
  }));
  el.querySelectorAll('[data-move]').forEach(b => (b.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/uploads/${b.dataset.move}`, { method: 'PATCH', body: { campaignId: b.dataset.to } });
    if (state.scope === b.dataset.move) state.scope = 'all';
    toast('Moved. It now shows as out of date, because it is judged against the other campaign\'s page.');
    await refreshList(); render();
  })));
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
  const camp = currentCampaign();
  const batch = state.scope === 'all' ? null : p.batches.find(b => b.id === state.scope);
  const scope = batch ? { batch: batch.id } : camp ? { campaign: camp.id } : {};
  const c = { all: base.length, priority: 0, relevant: 0, review: 0, negative: 0 };
  base.forEach(k => { if (c[k.category] !== undefined) c[k.category]++; });
  const q = state.search.trim().toLowerCase();
  const rows = sortedRows(base.filter(k => (state.filter === 'all' || k.category === state.filter) && (!q || k.keyword.toLowerCase().includes(q))));
  const has = f => base.some(k => k[f] != null);
  const metrics = [['volume', 'Searches'], ['clicks', 'Clicks'], ['cost', 'Cost'], ['conversions', 'Conv.']].filter(([f]) => has(f));
  const cols = [['keyword', 'Keyword'], ['category', 'Category'], ['confidence', 'Confidence'], ['intent', 'Intent'], ...metrics.map(([f, l]) => [f, l, 1]), ['reason', 'Why']];
  const bn = new Map(p.batches.map(b => [b.id, b]));
  const ps = p.perfSummary;
  const colCount = cols.length + 1;

  el.innerHTML = `
    <div class="sect-head"><h2>${batch ? esc(batch.name) : camp ? 'Whole campaign' : 'All keywords'}</h2>
      <details class="dl"><summary class="btn">${I('download')} Download</summary>
        <div class="dlpanel">
          <p class="label" style="margin-top:0">Google Ads Editor</p>
          <p class="hint" style="margin:0 0 4px">Campaign names in these files come from your campaigns.</p>
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

  el.querySelectorAll('[data-dl]').forEach(a => (a.href = dlHref(a.dataset.dl, scope)));

  const detail = k => {
    const b = bn.get(k.batchId);
    const items = [
      ['Matched service', k.service], ['Suggested match type', k.matchType], ['Decided by', DECIDED[k.source]],
      ['Confidence', k.source === 'ai' && k.confidence != null ? k.confidence + '%' : ''], ['Intent', k.intent], ['Upload', b && b.name],
      ['Campaign', b && (campaignOf(b.campaignId) || {}).name], ['Landing page', b && (b.pageUrl || b.inheritedPageUrl) ? prettyUrl(b.pageUrl || b.inheritedPageUrl) : ''], ['Searches a month', fmt(k.volume)], ['Suggested bid', fmt(k.bid)], ['Competition', k.competition],
      ['Impressions', fmt(k.impressions)], ['Clicks', fmt(k.clicks)], ['Cost', fmt(k.cost)], ['Conversions', fmt(k.conversions)],
    ].filter(([, v]) => v !== '' && v != null);
    return `<dl class="dgrid">${items.map(([t, v]) => `<div><dt>${t}</dt><dd>${esc(v)}</dd></div>`).join('')}
      <div class="wide"><dt>Why</dt><dd>${esc([k.reason, k.note].filter(Boolean).join('. ') || 'No reason recorded')}</dd></div></dl>`;
  };

  const body = $('#rows');
  body.innerHTML = rows.length ? rows.slice(0, 1500).map(k => {
    const open = state.expanded.has(k.id);
    const bt = bn.get(k.batchId);
    const sub = [state.view === 'keywords' && bt ? (campaignOf(bt.campaignId) || {}).name : '', state.scope === 'all' && bt ? bt.name : '', k.service].filter(Boolean).join(' · ');
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

// Redraws what depends on counts and statuses, leaving forms and open panels alone.
function redrawLive() {
  if (state.page !== 'project') return;
  drawSidebar();
  drawBanner();
  if (state.view === 'campaign') { drawFiles(); drawResults(); } else if (state.view === 'keywords') drawResults();
}

function pollIfBusy() {
  clearTimeout(pollTimer);
  const p = state.project;
  if (!p || state.page !== 'project' || !(reading(p) || p.batches.some(busyAI))) return;
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
            if (state.goAfterRead) { state.goAfterRead = false; goView('keywords'); }
            else if (state.view === 'business') renderBusiness();
          } else { state.goAfterRead = false; toast(a.error || 'The website could not be read.', true); }
        }
        redrawLive();
        for (const d of finished) toast(d.ai.status === 'error' ? `Analysis of "${d.name}" failed: ${d.ai.note}` : `Finished analysing "${d.name}".`, d.ai.status === 'error');
      } else redrawLive();
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

