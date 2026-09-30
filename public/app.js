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
  user: null, projects: [], slugs: {}, project: null,
  page: 'home',            // home, projects, new, project
  view: 'keywords',        // inside a project: keywords (all), campaign, business, competitors, team
  campaignId: null,
  scope: 'all', filter: 'all', search: '', sort: { key: 'category', dir: 'asc' },
  up: { open: false, mode: 'files', files: [], name: '', url: '', text: '' },
  goAfterRead: false, expanded: new Set(), fromRoute: false,
};
// The page asks the server which version it is. A server that was not restarted after an update reports an older one.
const EXPECTED_API = 3;
const busyAI = b => b.ai && (b.ai.status === 'running' || b.ai.status === 'queued');
const reading = p => Boolean(p && p.analysis && p.analysis.status === 'running');

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

/* ---------- small helpers ---------- */
const viewer = () => state.project && state.project.role === 'viewer';
const campaignOf = id => state.project && state.project.campaigns.find(c => c.id === id);
const currentCampaign = () => (state.view === 'campaign' ? campaignOf(state.campaignId) : null);
const batchesOf = c => state.project.batches.filter(b => b.campaignId === c.id);
const rowsOfCampaign = c => { const ids = new Set(batchesOf(c).map(b => b.id)); return state.project.keywords.filter(k => ids.has(k.batchId)); };
const countsOf = rows => {
  const c = { priority: 0, relevant: 0, review: 0, negative: 0, unsorted: 0, total: rows.length };
  for (const k of rows) c[k.category || 'unsorted']++;
  return c;
};
function scopeRows() {
  const p = state.project, c = currentCampaign();
  if (state.scope !== 'all') return p.keywords.filter(k => k.batchId === state.scope);
  return c ? rowsOfCampaign(c) : p.keywords;
}
const prettyUrl = u => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname.replace(/\/$/, '')); } catch { return u; } };
const href = path => BASE + path;

// Viewers see everything but change nothing. The server enforces this too.
function lockIfViewer() {
  if (!viewer()) return;
  document.querySelectorAll('#pane textarea, #pane select, #pane .ed, #pane #brief input, #pane #brief button, #sidebar .ed, #modal .ed').forEach(el => (el.disabled = true));
}

/* ---------- addresses ---------- */
// / home, /projects list, /projects/new, /projects/<slug>, /projects/<slug>/campaigns/<campaign>,
// /projects/<slug>/business, /competitors, /team
function projectSlug(p) { return state.slugs[p.id] || p.slug; }

function pathFor() {
  if (state.page === 'home') return '/';
  if (state.page === 'projects') return '/projects';
  if (state.page === 'new' || !state.project) return '/projects/new';
  const root = '/projects/' + projectSlug(state.project);
  const c = currentCampaign();
  if (state.view === 'campaign' && c) return `${root}/campaigns/${c.slug}`;
  if (state.view === 'business' || state.view === 'competitors' || state.view === 'team') return `${root}/${state.view}`;
  return root;
}

function titleFor() {
  const tail = ' · Keyword Selector';
  if (state.page === 'projects') return 'Projects' + tail;
  if (state.page === 'new') return 'New project' + tail;
  if (state.page === 'project' && state.project) {
    const c = currentCampaign();
    const part = c ? c.name : { business: 'Business', competitors: 'Competitors', team: 'Team' }[state.view] || 'All keywords';
    return `${part} · ${state.project.name}` + tail;
  }
  return 'Keyword Selector';
}

function syncUrl() {
  const want = BASE + pathFor();
  if (location.pathname !== want) history[state.fromRoute ? 'replaceState' : 'pushState'](null, '', want);
  state.fromRoute = false;
  document.title = titleFor();
}

function parsePath() {
  let p = location.pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  const seg = p.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  if (seg[0] !== 'projects') return { page: 'home' };
  if (seg.length === 1) return { page: 'projects' };
  if (seg[1] === 'new') return { page: 'new' };
  return { page: 'project', slug: seg[1], section: seg[2] || '', sub: seg[3] || '' };
}

async function loadProject(id) {
  state.project = await api('/projects/' + id);
  state.expanded = new Set();
  resetUpload();
}

// Reads the address bar and shows whatever it names. Runs on load, on back and forward, and on link clicks.
async function route() {
  clearTimeout(pollTimer);
  const r = parsePath();
  state.fromRoute = true;
  if (r.page !== 'project') {
    state.page = r.page; state.project = null; state.view = 'keywords';
    if (r.page === 'new') state.view = 'business';
    render();
    return;
  }
  await guard(async () => {
    const entry = state.projects.find(p => projectSlug(p) === r.slug);
    if (!entry) { toast('That project was not found.', true); state.page = 'projects'; state.project = null; render(); return; }
    if (!state.project || state.project.id !== entry.id) await loadProject(entry.id);
    state.page = 'project';
    state.scope = 'all'; state.filter = 'all'; state.search = '';
    if (r.section === 'campaigns') {
      const c = state.project.campaigns.find(x => x.slug === r.sub);
      if (c) { state.view = 'campaign'; state.campaignId = c.id; resetUpload(); } else state.view = 'keywords';
    } else state.view = ['business', 'competitors', 'team'].includes(r.section) ? r.section : 'keywords';
    render();
  });
}

function go(path) {
  if (location.pathname === BASE + path) return;
  history.pushState(null, '', BASE + path);
  route();
}

async function refreshList() {
  state.projects = await api('/projects');
  state.slugs = Object.fromEntries(state.projects.map(p => [p.id, p.slug]));
}

function goHome() { state.page = 'home'; state.project = null; render(); }
function goProjects() { clearTimeout(pollTimer); state.page = 'projects'; state.project = null; render(); }
function startNew() { state.page = 'new'; state.project = null; state.view = 'business'; render(); }
function goView(view, campaignId = null) {
  state.view = view; state.campaignId = campaignId; state.scope = 'all'; state.filter = 'all'; state.search = '';
  if (view === 'campaign') resetUpload();
  render();
}

/* ---------- home ---------- */
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

// The first page. People with no project see "Create your first project", everyone else "Create new project".
function renderHome() {
  const n = state.projects.length;
  $('#main').innerHTML = `
    <section class="hero">
      <div>
        <span class="pill">${I('search')} Keyword Selector</span>
        <h1>Sort your keywords by what <em>you actually sell.</em></h1>
        <p>Tell the tool about your business, then drop in keyword files from Google Ads, Semrush, Ahrefs or anywhere else. Each file becomes its own upload with its own download, so you can add new keywords every day.</p>
        <div class="hero-actions">
          <button class="btn primary big" id="startNew">${I('plus')} ${n ? 'Create new project' : 'Create your first project'} ${I('arrow')}</button>
          ${n ? `<a class="btn big" href="${href('/projects')}" data-link>${I('folder')} View projects <span class="count">${n}</span></a>` : ''}
        </div>
      </div>
      <div class="hero-art">${heroArt()}</div>
    </section>
    <section class="features">${FEATURES.map(([ic, t, d]) => `<div class="feat"><span class="fico">${I(ic)}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}</section>`;
  $('#startNew').onclick = () => go('/projects/new');
}

/* ---------- projects page ---------- */
function renderProjects() {
  const main = $('#main');
  if (!state.projects.length) {
    main.innerHTML = `<div class="lhead"><div><h1>Projects</h1><p class="sub">You have no projects yet.</p></div></div>
      <div class="card empty-state"><p>A project holds one business, its website, and all the keyword campaigns you run for it.</p>
      <button class="btn primary" id="startNew">${I('plus')} Create your first project</button></div>`;
    $('#startNew').onclick = () => go('/projects/new');
    return;
  }
  main.innerHTML = `
    <div class="lhead"><div><h1>Projects</h1><p class="sub">${state.projects.length} project${state.projects.length === 1 ? '' : 's'}. Pick one to open its campaigns and keywords.</p></div>
      <button class="btn primary" id="startNew">${I('plus')} New project</button></div>
    <div class="pgrid">${state.projects.map(p => {
      const c = p.counts;
      const who = p.role === 'owner' ? (p.shared ? 'Shared' : '') : `${p.role} \u00b7 ${p.ownerName}`;
      return `<div class="pcard">
        <a class="pcard-link" href="${href('/projects/' + p.slug)}" data-link>
          <span class="pcard-top"><span class="pico">${I('bolt')}</span><span class="pcard-name"><h3>${esc(p.name)}</h3><span class="purl">${esc(p.url ? prettyUrl(p.url) : 'No website added')}</span></span></span>
          <span class="ucounts">${miniBar(c)}${nums(c)}</span>
          <span class="pcard-stats"><span><b>${p.total}</b> keywords</span><span><b>${p.campaigns ?? 0}</b> campaign${p.campaigns === 1 ? '' : 's'}</span>${who ? `<span class="role">${esc(who)}</span>` : ''}</span>
        </a>${projectMenu(p)}</div>`;
    }).join('')}</div>`;
  $('#startNew').onclick = () => go('/projects/new');
}

/* ---------- a project: sidebar + page ---------- */
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

function statCard(p, label = 'Total keywords', rows = p.keywords, batches = p.batches) {
  const weekAgo = Date.now() - 7 * 864e5;
  const week = batches.filter(b => new Date(b.createdAt).getTime() >= weekAgo).reduce((n, b) => n + b.counts.total, 0);
  return `<div class="stat"><div><div class="stat-label">${label}</div><div class="stat-num">${rows.length.toLocaleString()}</div>
    ${week ? `<span class="trend" title="Keywords added in the last 7 days">${I('trend')} +${week.toLocaleString()} this week</span>` : ''}</div>${sparkline({ batches })}</div>`;
}

function pageHead(title, sub, extra = '') {
  const p = state.project;
  return `<div class="phead"><div class="ptitle"><h1>${esc(title)}</h1><p class="sub">${sub}</p></div>
    <div class="pright"><div class="pbadges"><span class="role">${esc(p.role)}</span><a class="btn outline small" href="${href('/projects/' + projectSlug(p) + '/team')}" data-link>${I('share')} Share</a></div>${extra}</div></div>`;
}

function drawSidebar() {
  const el = $('#sidebar');
  const p = state.project;
  if (!el || !p) return;
  const root = '/projects/' + projectSlug(p);
  const item = (icon, label, path, on, count) => `<a class="sitem ${on ? 'on' : ''}" href="${href(path)}" data-link ${on ? 'aria-current="page"' : ''}>${I(icon)}<span>${esc(label)}</span>${count != null ? `<b>${count}</b>` : ''}</a>`;
  el.innerHTML = `
    <a href="${href('/projects')}" class="back" data-link>${I('left')} All projects</a>
    <div class="sid"><span class="pico sm">${I('bolt')}</span><div class="sidtext"><b>${esc(p.name)}</b>${p.url ? `<a class="purl" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(prettyUrl(p.url))} ${I('external')}</a>` : '<span class="purl muted">No website yet</span>'}</div>${projectMenu(entryOf(p))}</div>
    <nav class="snav" aria-label="Project">
      <p class="shead">Keywords</p>
      ${item('list', 'All keywords', root, state.view === 'keywords', p.counts.total)}
      <p class="shead">Campaigns <button class="x ed" id="addCamp" title="New campaign" aria-label="New campaign">${I('plus')}</button></p>
      ${p.campaigns.map(c => item('megaphone', c.name, `${root}/campaigns/${c.slug}`, state.view === 'campaign' && state.campaignId === c.id, c.counts.total)).join('') || '<p class="hint sidehint">A campaign holds the keyword uploads for one Google Ads campaign.</p>'}
      ${p.campaigns.length ? '' : `<button class="btn small outline wide ed" id="addCamp2">${I('plus')} New campaign</button>`}
      <p class="shead">Project</p>
      ${item('building', 'Business', `${root}/business`, state.view === 'business')}
      ${item('trend', 'Competitors', `${root}/competitors`, state.view === 'competitors')}
      ${item('users', 'Team and sharing', `${root}/team`, state.view === 'team')}
    </nav>`;
  $('#addCamp').onclick = () => campaignDialog();
  const first = $('#addCamp2');
  if (first) first.onclick = () => campaignDialog();
  lockIfViewer();
}

function renderProject() {
  const p = state.project;
  const isNew = state.page === 'new' || !p;
  $('#main').innerHTML = isNew
    ? `<div class="layout nosid"><div class="content"><a href="${href('/projects')}" class="back" data-link>${I('left')} Back to Projects</a>
        <div class="phead"><div class="ptitle"><h1>New project</h1><p class="sub">Start with a few details about the business.</p></div></div><section id="pane"></section></div></div>`
    : `<div class="layout"><aside class="side" id="sidebar"></aside><div class="content"><div id="phead"></div><section id="pane" class="${viewer() ? 'ro' : ''}"></section></div></div>`;
  if (!isNew) drawSidebar();
  const v = isNew ? 'business' : state.view;
  if (v === 'campaign' && currentCampaign()) renderCampaign();
  else if (v === 'business') renderBusiness();
  else if (v === 'competitors') renderCompetitors();
  else if (v === 'team') renderTeam();
  else renderAllKeywords();
  lockIfViewer();
  pollIfBusy();
}

/* ---------- project actions: edit, duplicate, download, leave, delete ---------- */
// What the menu needs to know about a project, from the list entry or from an open project.
function entryOf(p) {
  const listed = state.projects.find(x => x.id === p.id) || {};
  return { id: p.id, name: p.name, url: p.url, slug: projectSlug(p), role: p.role, total: p.counts.total, campaigns: p.campaigns.length, shared: Boolean(listed.shared) };
}

function projectMenu(e) {
  const editor = e.role !== 'viewer', owner = e.role === 'owner';
  return `<details class="menu pmenu"><summary aria-label="Actions for ${esc(e.name)}">${I('dots')}</summary><div class="menu-pop">
      <a href="${href('/projects/' + e.slug)}" data-link>${I('folder')} Open project</a>
      ${editor ? `<button data-act="edit" data-id="${e.id}">${I('pencil')} Edit name and website</button>` : ''}
      <a href="${href('/projects/' + e.slug + '/business')}" data-link>${I('building')} Business details</a>
      <a href="${href('/projects/' + e.slug + '/team')}" data-link>${I('users')} Team and sharing</a>
      <a href="${BASE}/api/projects/${e.id}/export?type=all">${I('download')} Download every keyword (CSV)</a>
      ${editor ? `<button data-act="duplicate" data-id="${e.id}">${I('file')} Make a copy without keywords</button>` : ''}
      <hr>
      ${owner ? `<button class="danger" data-act="delete" data-id="${e.id}">${I('trash')} Delete project</button>` : `<button class="danger" data-act="leave" data-id="${e.id}">${I('logout')} Leave project</button>`}
    </div></details>`;
}

function findEntry(id) {
  const open = state.project && state.project.id === id ? entryOf(state.project) : null;
  return open || state.projects.find(x => x.id === id);
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const e = findEntry(b.dataset.id);
  const menu = b.closest('details.menu');
  if (menu) menu.open = false;
  if (!e) return;
  if (b.dataset.act === 'edit') editProjectDialog(e);
  else if (b.dataset.act === 'delete') deleteProjectDialog(e);
  else if (b.dataset.act === 'duplicate') guard(async () => {
    const r = await api(`/projects/${e.id}/duplicate`, { method: 'POST' });
    await refreshList();
    toast(`Made "${r.project.name}". It has the business details and campaigns, and no keywords.`);
    go('/projects/' + (state.slugs[r.id] || r.project.slug));
  });
  else if (b.dataset.act === 'leave') {
    if (!confirm(`Leave "${e.name}"? You will lose access until someone adds you again.`)) return;
    guard(async () => { await api(`/projects/${e.id}/leave`, { method: 'POST' }); await refreshList(); goProjects(); toast(`You left "${e.name}".`); });
  }
});

// A menu inside the sidebar would be clipped by the sidebar's own scrolling, so it opens at fixed coordinates.
document.addEventListener('toggle', ev => {
  const d = ev.target;
  if (!d.matches || !d.matches('details.menu') || !d.open || !d.closest('.side')) return;
  const pop = d.querySelector('.menu-pop'), r = d.querySelector('summary').getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.right = 'auto';
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
}, true);
window.addEventListener('scroll', () => document.querySelectorAll('.side details.menu[open]').forEach(d => { d.open = false; }), { passive: true });

function editProjectDialog(e) {
  const dlg = $('#modal');
  const owner = e.role === 'owner';
  dlg.innerHTML = `
    <form class="dlg" method="dialog">
      <h2>Edit project</h2>
      <div class="field"><label for="ep-name">Project name</label><input type="text" id="ep-name" value="${esc(e.name)}"></div>
      <div class="field" style="margin-top:14px"><label for="ep-url">Website</label><input type="text" id="ep-url" value="${esc(e.url || '')}" placeholder="example.com">
        <span class="hint">Changing the website does not read it again. Use Business, then "Save and re-read the website", when you want that.</span></div>
      ${owner ? `<label class="check" style="margin-top:16px;font-weight:500"><input type="checkbox" id="ep-slug"> Also change the web address to match the name</label>
        <p class="hint" style="margin:4px 0 0 26px">Now <b>${esc(BASE + '/projects/' + e.slug)}</b>. Links people already have to the old address will stop working.</p>` : ''}
      <p class="autherr" id="ep-err" role="alert"></p>
      <div class="actions"><button class="btn primary" id="ep-save" value="save">Save changes</button><button class="btn" value="cancel">Cancel</button></div>
    </form>`;
  dlg.showModal();
  $('#ep-name').focus();
  $('#ep-save').onclick = async ev => {
    ev.preventDefault();
    const name = $('#ep-name').value.trim();
    if (!name) { $('#ep-err').textContent = 'Give the project a name.'; return; }
    try {
      const body = { name, url: $('#ep-url').value };
      if ($('#ep-slug') && $('#ep-slug').checked) body.renameSlug = true;
      const r = await api('/projects/' + e.id, { method: 'PUT', body });
      await refreshList();
      dlg.close();
      if (state.project && state.project.id === e.id) { state.project = r; state.fromRoute = true; }
      render();
      toast('Saved.');
    } catch (err) { $('#ep-err').textContent = err.message; }
  };
}

function deleteProjectDialog(e) {
  const dlg = $('#modal');
  dlg.innerHTML = `
    <form class="dlg" method="dialog">
      <h2>Delete "${esc(e.name)}"?</h2>
      <p>This permanently deletes the project, its ${e.campaigns} campaign${e.campaigns === 1 ? '' : 's'} and ${e.total.toLocaleString()} keyword${e.total === 1 ? '' : 's'}${e.shared ? ', and removes access for everyone it is shared with' : ''}. It cannot be undone.</p>
      <p class="hint">Want a copy first? Close this and choose "Download every keyword (CSV)" from the project's menu.</p>
      <div class="field" style="margin-top:14px"><label for="dp-confirm">Type the project name to confirm</label><input type="text" id="dp-confirm" autocomplete="off" placeholder="${esc(e.name)}"></div>
      <p class="autherr" id="dp-err" role="alert"></p>
      <div class="actions"><button class="btn danger-fill" id="dp-go" value="go" disabled>${I('trash')} Delete project</button><button class="btn" value="cancel">Cancel</button></div>
    </form>`;
  dlg.showModal();
  const input = $('#dp-confirm'), go = $('#dp-go');
  input.focus();
  input.oninput = () => { go.disabled = input.value.trim().toLowerCase() !== e.name.trim().toLowerCase(); };
  go.onclick = async ev => {
    ev.preventDefault();
    try {
      await api('/projects/' + e.id, { method: 'DELETE' });
      await refreshList();
      dlg.close();
      goProjects();
      toast(`Deleted "${e.name}".`);
    } catch (err) { $('#dp-err').textContent = err.message; }
  };
}

/* ---------- campaign dialog ---------- */
function campaignDialog(existing) {
  const dlg = $('#modal');
  dlg.innerHTML = `
    <form class="dlg" method="dialog">
      <h2>${existing ? 'Edit campaign' : 'New campaign'}</h2>
      <p class="sub">A campaign holds the keyword uploads for one Google Ads campaign. Its name is used in the Google Ads Editor files.</p>
      <div class="field"><label for="cd-name">Campaign name</label><input type="text" id="cd-name" class="ed" value="${esc(existing ? existing.name : '')}" placeholder="NRI property tax, India search"></div>
      <div class="field" style="margin-top:14px"><label for="cd-url">Landing page <span class="opt">optional</span></label><input type="text" id="cd-url" class="ed" value="${esc(existing && existing.pageUrl || '')}" placeholder="https://yoursite.com/nri-property-tax">
        <span class="hint">The page this campaign sends people to. Uploads in the campaign are matched against it unless an upload has its own page.</span></div>
      <p class="autherr" id="cd-err" role="alert"></p>
      <div class="actions"><button class="btn primary" value="save" id="cd-save">${existing ? 'Save changes' : 'Create campaign'}</button><button class="btn" value="cancel">Cancel</button></div>
    </form>`;
  dlg.showModal();
  $('#cd-name').focus();
  $('#cd-save').onclick = async e => {
    e.preventDefault();
    const body = { name: $('#cd-name').value, pageUrl: $('#cd-url').value };
    try {
      const p = state.project;
      if (existing) state.project = await api(`/projects/${p.id}/campaigns/${existing.id}`, { method: 'PATCH', body });
      else {
        const r = await api(`/projects/${p.id}/campaigns`, { method: 'POST', body });
        state.project = r.project; state.campaignId = r.campaignId; state.view = 'campaign';
      }
      await refreshList();
      dlg.close();
      state.scope = 'all'; resetUpload();
      render();
    } catch (err) { $('#cd-err').textContent = err.message; }
  };
}

function miniBar(c) {
  const t = c.total || 1;
  return `<span class="mbar" aria-hidden="true">${CATS.map(([k]) => `<i class="${k}" style="width:${(c[k] / t) * 100}%"></i>`).join('')}</span>`;
}
const nums = c => `<span class="unums"><b class="priority">${c.priority}</b><b class="relevant">${c.relevant}</b><b class="review">${c.review}</b><b class="negative">${c.negative}</b></span>`;

// The one place every screen is drawn from.
function render() {
  if (state.page === 'project' && !state.project) state.page = 'projects';
  syncUrl();
  document.querySelectorAll('.topnav a').forEach(a => a.classList.toggle('on', a.dataset.nav === state.page || (a.dataset.nav === 'projects' && ['project', 'new'].includes(state.page))));
  if (state.page === 'home') renderHome();
  else if (state.page === 'projects') renderProjects();
  else renderProject();
  // Back to the top only when the address changed, not after small edits on the same page.
  const here = BASE + pathFor();
  if (here !== lastPath) { window.scrollTo(0, 0); lastPath = here; }
}
let lastPath = '';
