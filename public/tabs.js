'use strict';
/* Sign-in, sharing, search terms and competitors. Loaded before app.js and uses its helpers at call time. */

const fmt = n => (n == null || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const isViewer = () => state.project && state.project.role === 'viewer';

/* ---------- sign in ---------- */
function showAuth(mode = 'login') {
  state.user = null;
  state.project = null;
  $('.shell').hidden = true;
  $('#userbox').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  const reg = mode === 'register';
  box.innerHTML = `
    <form class="authform" id="authform">
      <h1>${reg ? 'Create your account' : 'Sign in'}</h1>
      <p class="sub">${reg ? 'Projects you create are private until you share them.' : 'Your projects and the ones shared with you.'}</p>
      ${reg ? '<div class="field"><label for="a-name">Your name</label><input type="text" id="a-name" autocomplete="name" required></div>' : ''}
      <div class="field"><label for="a-email">Email</label><input type="text" id="a-email" autocomplete="email" inputmode="email" required></div>
      <div class="field"><label for="a-pass">Password</label><input type="password" id="a-pass" autocomplete="${reg ? 'new-password' : 'current-password'}" required>${reg ? '<span class="hint">At least 8 characters.</span>' : ''}</div>
      <p class="autherr" id="autherr" role="alert"></p>
      <div class="actions" style="grid-column:auto"><button class="btn primary" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
        ${state.config.signupOpen || reg ? `<button class="btn link" type="button" id="switch">${reg ? 'I already have an account' : 'Create an account'}</button>` : ''}</div>
    </form>`;
  const sw = $('#switch');
  if (sw) sw.onclick = () => showAuth(reg ? 'login' : 'register');
  $('#a-email').focus();
  $('#authform').onsubmit = async e => {
    e.preventDefault();
    const body = { email: $('#a-email').value, password: $('#a-pass').value };
    if (reg) body.name = $('#a-name').value;
    try {
      const r = await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body });
      await startApp(r.user);
      if (r.claimed) toast(r.claimed + ' project' + (r.claimed === 1 ? '' : 's') + ' from the earlier single-user version moved into your account.');
    } catch (err) { $('#autherr').textContent = err.message; }
  };
}

async function startApp(user) {
  state.user = user;
  $('#auth').hidden = true;
  $('.shell').hidden = false;
  $('#userbox').hidden = false;
  $('#username').textContent = user.name;
  state.project = null;
  state.tab = 'brief';
  await refreshList();
  if (state.projects.length) await openProject(state.projects[0].id); else render();
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
}

/* ---------- sharing ---------- */
async function openShare() {
  const p = state.project;
  const dlg = $('#shareDlg');
  const owner = p.role === 'owner';
  const draw = members => {
    dlg.innerHTML = `
      <form method="dialog" class="dlg">
        <h2>Share "${esc(p.name)}"</h2>
        <p class="sub" style="margin-bottom:14px">${owner ? 'Editors can change everything except sharing and deletion. Viewers can look and download.' : 'You have ' + esc(p.role) + ' access.'}</p>
        <ul class="members">${members.map(m => `<li>
          <span><b>${esc(m.name)}</b><br><span class="pm">${esc(m.email)}</span></span>
          ${owner && m.role !== 'owner'
            ? `<select data-uid="${m.userId}" class="rolesel" aria-label="Role for ${esc(m.name)}"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button type="button" class="x" data-rm="${m.userId}" aria-label="Remove ${esc(m.name)}">&times;</button>`
            : `<span class="role">${esc(m.role)}</span>`}
        </li>`).join('')}</ul>
        ${owner ? `<div class="addm"><input type="text" id="m-email" placeholder="Their account email" aria-label="Email to share with"><select id="m-role" aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button type="button" class="btn small primary" id="m-add">Add</button></div>
        <p class="hint" style="margin-top:6px">They need an account first. Ask them to sign up, then add their email here.</p>` : ''}
        <p class="autherr" id="merr" role="alert"></p>
        <div class="actions" style="grid-column:auto;margin-top:8px">
          <button class="btn small" value="close">Close</button>
          ${!owner ? '<button type="button" class="btn small danger" id="leave">Leave project</button>' : ''}
        </div>
      </form>`;
    const fail = e => { $('#merr').textContent = e.message; };
    const call = (path, method, body) => api(`/projects/${p.id}/members${path}`, { method, body }).then(draw, fail);
    dlg.querySelectorAll('.rolesel').forEach(s => (s.onchange = () => call('/' + s.dataset.uid, 'PATCH', { role: s.value })));
    dlg.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => call('/' + b.dataset.rm, 'DELETE')));
    const add = $('#m-add');
    if (add) add.onclick = () => call('', 'POST', { email: $('#m-email').value, role: $('#m-role').value });
    const leave = $('#leave');
    if (leave) leave.onclick = async () => {
      if (!confirm('Leave "' + p.name + '"? You will lose access until someone adds you again.')) return;
      await api(`/projects/${p.id}/leave`, { method: 'POST' }).catch(fail);
      dlg.close();
      state.project = null; state.tab = 'brief';
      await refreshList();
      render();
    };
  };
  draw(await api(`/projects/${p.id}/members`));
  dlg.showModal();
}

/* ---------- search terms ---------- */
function importPanel(id, title, help, hasData) {
  return `<div class="kw-wrap">
    <div>
      <div class="field"><label for="${id}-text">${title}</label>
        <textarea id="${id}-text" spellcheck="false" placeholder="Paste the report here, or use the file picker."></textarea></div>
      <div class="actions" style="grid-column:auto;padding-top:12px">
        <button class="btn primary ed" id="${id}-go">${hasData ? 'Replace with this report' : 'Analyze report'}</button>
      </div>
    </div>
    <div>
      <div class="drop" id="${id}-drop"><p>Drop the report here, or pick a file.<br>CSV, TSV or XLSX.</p>
        <input type="file" id="${id}-file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden><button class="btn ed" id="${id}-pick">Choose file</button></div>
      <div class="aside-note">${help}</div>
    </div>
  </div>`;
}

async function readSheetFile(f) {
  if (f.size > 8 * 1024 * 1024) throw new Error('That file is over 8 MB. Filter the report to the last 90 days or to one campaign.');
  const buf = await f.arrayBuffer();
  if (/\.xlsx?$/i.test(f.name)) {
    const X = await loadXlsx();
    const wb = X.read(buf, { type: 'array' });
    return X.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
  }
  return decodeBuffer(buf);
}

function wireImport(id, submit) {
  const ta = $('#' + id + '-text'), file = $('#' + id + '-file'), drop = $('#' + id + '-drop');
  const run = text => guard(() => submit(text));
  $('#' + id + '-go').onclick = () => (ta.value.trim() ? run(ta.value) : toast('Paste a report or pick a file first.', true));
  $('#' + id + '-pick').onclick = () => file.click();
  const fromFile = f => guard(async () => submit(await readSheetFile(f)));
  file.onchange = () => file.files[0] && fromFile(file.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && fromFile(e.dataTransfer.files[0]));
}

const ACTION_LABEL = { block: 'Block', watch: 'Watch', add: 'Add', ignore: 'Ignore' };

function renderTerms() {
  const p = state.project;
  const pane = $('#pane');
  const help = `<p class="label">Where to get it</p>
    <ul><li>In Google Ads open the campaign, then <b>Insights and reports</b>, then <b>Search terms</b>.</li>
    <li>Set a date range that holds a few hundred clicks or more, then download as CSV.</li>
    <li>The Impr., Clicks, Cost and Conv. columns are used. Match type and Added/Excluded are read when present.</li>
    <li>The same term across campaigns is added up. Importing again replaces the last report.</li></ul>`;

  if (!p.searchTerms.length || state.st.replacing) {
    pane.innerHTML = `<p class="sub" style="max-width:70ch">Search terms are what people actually typed before clicking your ads. The ones that cost money and never converted are your most reliable negatives.</p>` +
      importPanel('st', 'Paste your Search terms report', help, p.searchTerms.length > 0) +
      (p.searchTerms.length ? '<p><button class="btn small" id="st-cancel">Keep the current report</button></p>' : '');
    wireImport('st', async text => {
      const r = await api(`/projects/${p.id}/searchterms`, { method: 'POST', body: { text } });
      state.project = r.project; state.st.replacing = false;
      toast(`Read ${r.imported} search terms.`);
      render();
    });
    const c = $('#st-cancel');
    if (c) c.onclick = () => { state.st.replacing = false; renderTerms(); lockIfViewer(); };
    return;
  }

  const s = p.stSummary || {};
  const counts = { all: p.searchTerms.length, block: 0, watch: 0, add: 0, ignore: 0 };
  p.searchTerms.forEach(t => counts[t.action]++);
  const q = encodeURIComponent(p.campaign || p.name);
  const tabs = ['all', 'block', 'watch', 'add', 'ignore'].map(k => `<button data-f="${k}" class="${state.st.filter === k ? 'on' : ''}">${k === 'all' ? 'All' : ACTION_LABEL[k]}<b>${counts[k]}</b></button>`).join('');

  pane.innerHTML = `
    <div class="figures">
      <div><span class="fig">${fmt(s.totalCost)}</span><span class="fl">spent in this report</span></div>
      <div class="bad"><span class="fig">${fmt(s.wasteCost)}</span><span class="fl">on ${s.blockCount} term${s.blockCount === 1 ? '' : 's'} to block</span></div>
      <div><span class="fig">${fmt(s.watchCost)}</span><span class="fl">on ${s.watchCount} still to judge</span></div>
      <div class="good"><span class="fig">${s.addCount}</span><span class="fl">converting term${s.addCount === 1 ? '' : 's'} not yet targeted</span></div>
    </div>
    <p class="sub" style="max-width:80ch">${s.totalConv ? `Your account converts about ${s.convRate}% of clicks${s.avgCpa ? ` at ${fmt(s.avgCpa)} per conversion` : ''}. A term that fits your offer is only blocked after about ${s.neededClicks} clicks with nothing, or spend past twice your cost per conversion.` : `No conversions appear in this report, so a fitting term is only blocked after ${s.neededClicks} clicks. Check that conversion tracking was on for this date range before trusting these verdicts.`}
      ${s.hasProfile ? '' : ' Analyze the website in step 1 so off-topic terms can be spotted too.'}</p>
    <div class="tools">
      <div class="tabs">${tabs}</div><span class="grow"></span>
      <input type="text" class="search keep" id="st-search" placeholder="Filter terms" value="${esc(state.st.search)}" aria-label="Filter search terms">
    </div>
    <div class="exports">
      <span class="label">Download</span>
      <input type="text" class="keep" id="st-camp" value="${esc(p.campaign || p.name)}" aria-label="Campaign name">
      <a class="btn small" id="st-dl-n" href="/api/projects/${p.id}/export?type=st-negatives&campaign=${q}">Negatives for Google Ads Editor</a>
      <a class="btn small" href="/api/projects/${p.id}/export?type=st-all">Full report with verdicts</a>
      <span class="grow"></span>
      <button class="btn small ed" id="st-win" ${s.addCount ? '' : 'disabled'}>Add ${s.addCount} winner${s.addCount === 1 ? '' : 's'} to keywords</button>
      <button class="btn small ed" id="st-replace">Replace report</button>
      <button class="btn small danger ed" id="st-clear">Remove report</button>
    </div>
    <div class="tablewrap"><table><thead><tr>${[['term', 'Search term'], ['action', 'Action'], ['clicks', 'Clicks', 1], ['cost', 'Cost', 1], ['conversions', 'Conv.', 1], ['fit', 'Fit'], ['matchType', 'Match type'], ['reason', 'Why']]
      .map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}" ${state.st.sort.key === k ? `data-dir="${state.st.sort.dir}"` : ''}>${l}</th>`).join('')}</tr></thead><tbody id="st-rows"></tbody></table></div>`;

  drawTermRows();
  pane.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => { state.st.filter = b.dataset.f; renderTerms(); lockIfViewer(); }));
  pane.querySelectorAll('th[data-k]').forEach(th => (th.onclick = () => {
    const k = th.dataset.k;
    state.st.sort = { key: k, dir: state.st.sort.key === k && state.st.sort.dir === 'desc' ? 'asc' : 'desc' };
    renderTerms(); lockIfViewer();
  }));
  $('#st-search').oninput = e => { state.st.search = e.target.value; drawTermRows(); lockIfViewer(); };
  $('#st-camp').oninput = e => { $('#st-dl-n').href = `/api/projects/${p.id}/export?type=st-negatives&campaign=${encodeURIComponent(e.target.value)}`; };
  $('#st-camp').onchange = e => guard(() => api('/projects/' + p.id, { method: 'PUT', body: { campaign: e.target.value } }));
  $('#st-replace').onclick = () => { state.st.replacing = true; renderTerms(); lockIfViewer(); };
  $('#st-clear').onclick = () => {
    if (!confirm('Remove the imported report and its verdicts?')) return;
    guard(async () => { state.project = await api(`/projects/${p.id}/searchterms`, { method: 'DELETE' }); render(); });
  };
  $('#st-win').onclick = () => guard(async () => {
    const r = await api(`/projects/${p.id}/searchterms/add-winners`, { method: 'POST' });
    state.project = r.project; await refreshList(); render();
    toast(`Added ${r.added} converting term${r.added === 1 ? '' : 's'} to your keywords as priority.` + (r.skipped ? ` ${r.skipped} did not fit under the limit.` : ''));
  });
}

function drawTermRows() {
  const p = state.project, st = state.st;
  const q = st.search.trim().toLowerCase();
  const { key, dir } = st.sort;
  const m = dir === 'asc' ? 1 : -1;
  const rows = p.searchTerms.filter(t => (st.filter === 'all' || t.action === st.filter) && (!q || t.term.toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * m;
    });
  const body = $('#st-rows');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty-state">Nothing matches this filter.</td></tr>'; return; }
  body.innerHTML = rows.slice(0, 1500).map(t => `<tr data-id="${t.id}">
    <td class="kw">${esc(t.term)}</td>
    <td><select class="sel act-${t.action}" aria-label="Action for ${esc(t.term)}">${Object.entries(ACTION_LABEL).map(([v, l]) => `<option value="${v}" ${t.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td class="num">${fmt(t.clicks)}</td><td class="num">${fmt(t.cost)}</td><td class="num">${fmt(t.conversions)}</td>
    <td>${esc(t.fit || '')}</td>
    <td><span class="mt">${esc(t.matchType || '')}</span></td>
    <td class="why">${esc(t.reason || '')}</td></tr>`).join('') +
    (rows.length > 1500 ? `<tr><td colspan="8" class="empty-state">Showing the first 1500 of ${rows.length}. Narrow the filter to see the rest.</td></tr>` : '');
  body.querySelectorAll('select').forEach(sel => (sel.onchange = () => {
    const id = sel.closest('tr').dataset.id;
    guard(async () => { state.project = await api(`/projects/${p.id}/searchterm/${id}`, { method: 'PATCH', body: { action: sel.value } }); renderTerms(); lockIfViewer(); });
  }));
}

/* ---------- competitors ---------- */
function renderCompetitors() {
  const p = state.project;
  const max = state.config.maxCompetitors;
  const comps = p.competitors.map(c => `<li>
      <span><b>${esc(c.name)}</b> <span class="pm">${esc(c.host)}</span><br><span class="pm">${c.pages.length} page${c.pages.length === 1 ? '' : 's'} read${c.errors.length ? ', ' + c.errors.length + ' failed' : ''}</span></span>
      <button class="x ed" data-rm="${c.id}" aria-label="Remove ${esc(c.name)}">&times;</button></li>`).join('');
  const brands = p.brands.map(b => `<button class="chip brand ${b.enabled ? '' : 'off'} ed" data-b="${esc(b.phrase)}" aria-pressed="${b.enabled}" title="${esc('From ' + b.competitor + '. Click to ' + (b.enabled ? 'stop blocking' : 'block again'))}">${esc(b.phrase)}</button>`).join('');
  const gaps = (p.gaps || []).map((g, i) => `<li><label><input type="checkbox" class="ed" data-i="${i}"> <b>${esc(g.phrase)}</b></label> <span class="pm">${g.competitors.map(esc).join(', ')}</span></li>`).join('');

  $('#pane').innerHTML = `
    <div class="kw-wrap">
      <div>
        <div class="field"><label for="c-urls">Competitor websites</label>
          <textarea id="c-urls" style="min-height:96px" placeholder="acmeplumbing.co.uk&#10;zenithheating.com" spellcheck="false">${esc(p.competitors.map(c => c.url).join('\n'))}</textarea>
          <span class="hint">Up to ${max}, one per line. About 5 pages are read from each. Analyzing again replaces the list.</span></div>
        <div class="actions" style="grid-column:auto;padding-top:12px"><button class="btn primary ed" id="c-go">${p.competitors.length ? 'Analyze again' : 'Analyze competitors'}</button></div>
      </div>
      <div>${p.competitors.length ? `<p class="label">Read so far</p><ul class="members">${comps}</ul>` : '<div class="aside-note"><p>Brand names found here can be blocked as negatives, and the headings they use show topics your site may be missing.</p></div>'}</div>
    </div>
    ${p.competitors.length ? `
    <div class="twocol">
      <div>
        <h2>Competitor brand names</h2>
        <p class="sub" style="margin-bottom:10px">Only brands with a word that is not part of your own vocabulary are used, so a generic name cannot block your real keywords. Click a name to switch it off.</p>
        <label class="check"><input type="checkbox" id="c-block" class="ed" ${p.blockCompetitors ? 'checked' : ''}> Send searches containing these names to Negative</label>
        <div class="chips" style="margin-top:10px">${brands || '<span class="sub">No usable brand names found.</span>'}</div>
        <p class="hint">Leave this off if you plan to bid on competitor names on purpose. That is a legitimate tactic, but it needs its own campaign and landing page.</p>
      </div>
      <div>
        <h2>Topics they cover that you do not</h2>
        <p class="sub" style="margin-bottom:10px">Competitor headings that share a word with your business but add something your site never mentions.</p>
        ${gaps ? `<ul class="gaps">${gaps}</ul><p><button class="btn small primary ed" id="c-add">Add selected to keywords</button></p>` : '<span class="sub">Nothing stands out. Try a competitor with a larger site.</span>'}
      </div>
    </div>` : ''}`;

  $('#c-go').onclick = () => {
    const btn = $('#c-go');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Reading sites...';
    guard(async () => {
      try {
        const r = await api(`/projects/${p.id}/competitors`, { method: 'POST', body: { urls: $('#c-urls').value } });
        state.project = r.project; render();
        if (r.failed.length) toast('Could not use: ' + r.failed.map(f => f.url + ' (' + f.error + ')').join('; '), true);
        else toast('Read ' + r.project.competitors.length + ' competitor site(s).');
      } finally { const b = $('#c-go'); if (b) { b.disabled = false; b.textContent = 'Analyze competitors'; } }
    });
  };
  $('#pane').querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => guard(async () => { state.project = await api(`/projects/${p.id}/competitors/${b.dataset.rm}`, { method: 'DELETE' }); render(); })));
  $('#pane').querySelectorAll('[data-b]').forEach(b => (b.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/brand`, { method: 'PATCH', body: { phrase: b.dataset.b, enabled: b.getAttribute('aria-pressed') !== 'true' } });
    await refreshList(); render();
  })));
  const blk = $('#c-block');
  if (blk) blk.onchange = () => guard(async () => { state.project = await api('/projects/' + p.id, { method: 'PUT', body: { blockCompetitors: blk.checked } }); await refreshList(); render(); });
  const add = $('#c-add');
  if (add) add.onclick = () => {
    const picked = [...$('#pane').querySelectorAll('.gaps input:checked')].map(i => p.gaps[Number(i.dataset.i)].phrase);
    if (!picked.length) return toast('Tick the topics you want first.', true);
    guard(async () => {
      const r = await api(`/projects/${p.id}/keywords`, { method: 'POST', body: { text: picked.join('\n') } });
      state.project = r.project; await refreshList(); render();
      toast(`Added ${r.added} keyword${r.added === 1 ? '' : 's'}. See them under Results.`);
    });
  };
}
