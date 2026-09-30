'use strict';
/* The admin pages: overview, people, settings and activity. Only drawn for admins, and the server checks again on every call. */

const A = { tab: 'overview', data: {}, q: '', filter: 'all', sort: { key: 'createdAt', dir: 'desc' }, table: {}, userId: null };

const money = n => (n == null ? '' : '$' + (n < 10 ? n.toFixed(n > 0 && n < 0.1 ? 4 : 2) : n.toFixed(2)));
const compact = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : Number(n || 0).toLocaleString());

function ago(iso) {
  if (!iso) return 'Never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'Just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  if (s < 86400 * 45) return Math.round(s / 86400) + ' days ago';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const when = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortDay = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const upTime = s => (s >= 86400 ? Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h' : s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min' : Math.max(1, Math.round(s / 60)) + ' min');
const bytes = n => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');
const limitText = v => (v === null || v === undefined ? 'No limit' : Number(v).toLocaleString());

async function adminApi(path, opts) { return api('/admin' + path, opts); }

/* ---------- shell ---------- */
const TABS = [['overview', 'Overview', ''], ['users', 'Users', '/users'], ['settings', 'Settings', '/settings'], ['activity', 'Activity', '/activity']];

async function renderAdmin() {
  if (!state.user || !state.user.isAdmin) { state.page = 'home'; return render(); }
  const tab = A.tab;
  $('#main').innerHTML = `<div class="admin">
    <div class="lhead"><div><h1>Admin</h1><p class="sub">Who is using the tool, what it costs, and what each person is allowed.</p></div></div>
    <nav class="atabs" aria-label="Admin sections">${TABS.map(([k, label, p]) => `<a href="${href('/admin' + p)}" data-link class="${tab === k || (tab === 'user' && k === 'users') ? 'on' : ''}">${label}</a>`).join('')}</nav>
    <div id="apane"><p class="muted">Loading</p></div></div>`;
  await guard(async () => {
    if (tab === 'overview') overviewPage(A.data.overview = await adminApi('/overview'));
    else if (tab === 'users') usersPage(A.data.users = await adminApi('/users'));
    else if (tab === 'user') userPage(A.data.user = await adminApi('/users/' + A.userId));
    else if (tab === 'settings') settingsPage(A.data.settings = await adminApi('/settings'));
    else if (tab === 'activity') activityPage(await adminApi('/activity'));
  });
}

/* ---------- small pieces ---------- */
const tile = (label, value, note, tone) => `<div class="kpi ${tone || ''}"><span class="kpi-label">${label}</span><span class="kpi-num">${value}</span>${note ? `<span class="kpi-note">${note}</span>` : ''}</div>`;

// A column chart in one hue. Each column's slot is wider than the column, so it is easy to hover.
function columns(id, series, { fmt = compact, unit = '' } = {}) {
  const max = Math.max(...series.map(d => d.value), 0);
  const top = max > 0 ? niceMax(max) : 1;
  const asTable = A.table[id];
  const total = series.reduce((n, d) => n + d.value, 0);
  const body = asTable
    ? `<div class="tablewrap short"><table class="mini"><thead><tr><th>Day</th><th class="num">${unit || 'Value'}</th></tr></thead><tbody>${[...series].reverse().map(d => `<tr><td>${shortDay(d.day)}</td><td class="num">${fmt(d.value)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="chart" role="img" aria-label="${esc(unit)} per day, last ${series.length} days, ${fmt(total)} in total">
        <span class="ymax">${fmt(top)}</span>
        <div class="cols" data-chart="${id}">${series.map((d, i) => `<span class="col" data-i="${i}" data-tip="${esc(shortDay(d.day) + ': ' + fmt(d.value) + (unit ? ' ' + unit.toLowerCase() : ''))}"><i style="height:${top ? (d.value / top) * 100 : 0}%"></i></span>`).join('')}</div>
        <div class="xaxis"><span>${shortDay(series[0].day)}</span><span>${shortDay(series[Math.floor(series.length / 2)].day)}</span><span>${shortDay(series.at(-1).day)}</span></div>
        <div class="tip" hidden></div></div>`;
  return `<div class="chartcard card"><div class="chead"><div><h3>${esc(unit)}</h3><p class="hint">Last ${series.length} days, ${fmt(total)} in total</p></div>
    <button class="btn link small" type="button" data-toggle="${id}">${asTable ? 'View as chart' : 'View as table'}</button></div>${body}</div>`;
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function wireCharts(root, redraw) {
  root.querySelectorAll('[data-toggle]').forEach(b => (b.onclick = () => { A.table[b.dataset.toggle] = !A.table[b.dataset.toggle]; redraw(); }));
  root.querySelectorAll('.cols').forEach(cols => {
    const wrap = cols.closest('.chart'), tip = $('.tip', wrap);
    const show = col => {
      if (!col) { tip.hidden = true; return; }
      tip.textContent = col.dataset.tip; tip.hidden = false;
      const x = col.offsetLeft + col.offsetWidth / 2, w = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(wrap.clientWidth - w, x - w / 2)) + 'px';
    };
    cols.onmouseover = e => show(e.target.closest('.col'));
    cols.onmouseleave = () => show(null);
  });
}

function barList(rows, valueOf, labelOf, fmt) {
  const max = Math.max(...rows.map(valueOf), 0);
  if (!rows.length || !max) return '<p class="hint">Nothing yet.</p>';
  return `<ul class="bars">${rows.map(r => `<li><span class="bl">${labelOf(r)}</span><span class="bt"><i style="width:${Math.max(2, (valueOf(r) / max) * 100)}%"></i></span><span class="bv">${fmt(valueOf(r))}</span></li>`).join('')}</ul>`;
}

const statusPillA = u => (u.status === 'suspended' ? '<span class="tag off">Suspended</span>' : u.isAdmin ? '<span class="tag adm">Admin</span>' : '<span class="tag ok">Active</span>');
const userLink = u => `<a href="${href('/admin/users/' + u.id)}" data-link class="ulink"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></a>`;

/* ---------- overview ---------- */
function overviewPage(o) {
  const u = o.users, c = o.content, ai = o.ai, sys = o.system;
  const warn = [];
  if (!sys.keyConfigured) warn.push('No OpenAI key is set on the server, so smart analysis cannot run.');
  if (!sys.aiSwitchOn) warn.push('Smart analysis is switched off for everyone (Settings).');
  if (ai.unknownModels.length) warn.push(`No price is set for ${ai.unknownModels.map(esc).join(', ')}, so its calls count as $0. Add a price in Settings.`);
  $('#apane').innerHTML = `
    ${warn.length ? `<div class="notice" role="status">${warn.map(w => `<p>${w}</p>`).join('')}</div>` : ''}
    <div class="kpis">
      ${tile('People signed up', u.total.toLocaleString(), `+${u.newWeek} this week, +${u.newMonth} in 30 days`)}
      ${tile('Active this week', u.activeWeek.toLocaleString(), `${u.suspended ? u.suspended + ' suspended, ' : ''}${u.admins} admin${u.admins === 1 ? '' : 's'}`)}
      ${tile('Keywords held', c.keywords.toLocaleString(), `${c.projects.toLocaleString()} projects, ${c.campaigns.toLocaleString()} campaigns, ${c.uploads.toLocaleString()} uploads`)}
      ${tile('Analysis cost, this month', money(ai.costMonth), `${money(ai.costAll)} all time, ${money(ai.costToday)} today`, 'cost')}
    </div>
    <div class="two">${columns('signups', o.series.signups, { unit: 'Sign-ups' })}${columns('cost', o.series.cost, { fmt: money, unit: 'Analysis cost' })}</div>
    <div class="two">
      <section class="card"><h3>Where the cost goes</h3>
        ${barList(o.byKind, r => r.cost, r => `${esc(r.label)} <small>${r.calls.toLocaleString()} calls</small>`, money)}
        <p class="label">By model</p>
        ${barList(o.byModel, r => r.cost, r => `${esc(r.model)} <small>${compact(r.prompt + r.completion)} tokens</small>`, money)}
        <p class="hint tokens">${ai.calls.toLocaleString()} calls so far, ${compact(ai.tokens)} tokens${ai.errors ? `, ${ai.errors} failed` : ''}. Costs are estimates from token counts and the prices in Settings. The OpenAI bill is the real number.</p>
      </section>
      <section class="card"><h3>Biggest spenders</h3>
        ${o.topCost.length ? `<ul class="rank">${o.topCost.map(x => `<li>${userLink(x)}<span class="rv">${money(x.ai.costAll)}</span></li>`).join('')}</ul>` : '<p class="hint">No analysis has run yet.</p>'}
        <p class="label">Most keywords held</p>
        ${o.topKeywords.length ? `<ul class="rank">${o.topKeywords.map(x => `<li>${userLink(x)}<span class="rv">${x.keywords.toLocaleString()}</span></li>`).join('')}</ul>` : '<p class="hint">No keywords yet.</p>'}
      </section>
    </div>
    <section class="card sys"><h3>System</h3><dl class="facts">
      <div><dt>Model</dt><dd>${esc(sys.model)}</dd></div>
      <div><dt>OpenAI key</dt><dd>${sys.keyConfigured ? 'Set' : 'Missing'}</dd></div>
      <div><dt>Analysis</dt><dd>${sys.aiSwitchOn ? 'On' : 'Off'}</dd></div>
      <div><dt>Sign-ups</dt><dd>${sys.signupOpen ? 'Open' : 'Closed'}</dd></div>
      <div><dt>Database</dt><dd>${bytes(sys.dbBytes)}</dd></div>
      <div><dt>Node</dt><dd>${esc(sys.node)}</dd></div>
      <div><dt>Running for</dt><dd>${upTime(sys.uptimeSeconds)}</dd></div>
      <div><dt>Mounted at</dt><dd>${esc(sys.basePath || '/')}</dd></div></dl></section>`;
  wireCharts($('#apane'), () => overviewPage(o));
}

/* ---------- people ---------- */
const FILTERS = [['all', 'Everyone'], ['active', 'Active'], ['suspended', 'Suspended'], ['admins', 'Admins'], ['idle', 'Never uploaded'], ['capped', 'Has a custom limit']];
const SORTS = { createdAt: u => u.createdAt, name: u => u.name.toLowerCase(), projects: u => u.projects, keywords: u => u.keywords, uploaded: u => u.keywordsUploaded, cost: u => u.ai.costAll, month: u => u.ai.costMonth, seen: u => u.lastSeenAt || '' };

function usersPage(list) {
  const q = A.q.trim().toLowerCase();
  const pass = u => ({ all: true, active: u.status === 'active', suspended: u.status === 'suspended', admins: u.isAdmin, idle: u.keywordsUploaded === 0, capped: Object.values(u.overrides).some(v => v !== null && v !== undefined) })[A.filter]
    && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  const rows = list.filter(pass).sort((a, b) => {
    const f = SORTS[A.sort.key], x = f(a), y = f(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (A.sort.dir === 'asc' ? 1 : -1);
  });
  const th = (key, label, cls = '') => `<th class="${cls}" aria-sort="${A.sort.key === key ? (A.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${key}">${label}${A.sort.key === key ? (A.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
  const lim = (u, k, used) => `${used.toLocaleString()}<small> / ${limitText(u.limits[k])}</small>`;
  const tot = list.reduce((a, u) => ({ k: a.k + u.keywords, up: a.up + u.keywordsUploaded, c: a.c + u.ai.costAll }), { k: 0, up: 0, c: 0 });
  $('#apane').innerHTML = `
    <div class="toolbar"><input type="search" id="uq" placeholder="Search name or email" value="${esc(A.q)}" aria-label="Search people">
      <select id="uf" aria-label="Filter">${FILTERS.map(([k, l]) => `<option value="${k}" ${A.filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="grow"></span><span class="hint">${rows.length} of ${list.length}</span>
      <button class="btn primary small" id="addUser">${I('plus')} Add user</button></div>
    <div class="card flush"><div class="tablewrap"><table class="utable">
      <thead><tr>${th('name', 'Person')}${th('projects', 'Projects', 'num')}${th('keywords', 'Keywords held', 'num')}${th('uploaded', 'Uploaded ever', 'num')}${th('month', 'Cost this month', 'num')}${th('cost', 'Cost all time', 'num')}${th('seen', 'Last seen')}${th('createdAt', 'Joined')}<th>Status</th></tr></thead>
      <tbody>${rows.map(u => `<tr>
        <td>${userLink(u)}</td><td class="num">${lim(u, 'projects', u.projects)}</td><td class="num">${u.keywords.toLocaleString()}${u.limits.keywordsTotal !== null ? `<small> / ${limitText(u.limits.keywordsTotal)}</small>` : ''}</td>
        <td class="num">${u.keywordsUploaded.toLocaleString()}</td><td class="num">${money(u.ai.costMonth)}${u.limits.aiBudget !== null ? `<small> / ${money(u.limits.aiBudget)}</small>` : ''}</td><td class="num">${money(u.ai.costAll)}</td>
        <td>${ago(u.lastSeenAt)}</td><td>${ago(u.createdAt)}</td><td>${statusPillA(u)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nobody matches.</td></tr>'}</tbody>
      <tfoot><tr><td>${list.length} people</td><td></td><td class="num">${tot.k.toLocaleString()}</td><td class="num">${tot.up.toLocaleString()}</td><td></td><td class="num">${money(tot.c)}</td><td colspan="3"></td></tr></tfoot>
    </table></div></div>
    <p class="hint">Numbers show use, then the limit after the slash. Open a person to change their limits.</p>`;
  $('#uq').oninput = e => { A.q = e.target.value; const at = e.target.selectionStart; usersPage(list); const n = $('#uq'); n.focus(); n.setSelectionRange(at, at); };
  $('#uf').onchange = e => { A.filter = e.target.value; usersPage(list); };
  document.querySelectorAll('[data-sort]').forEach(b => (b.onclick = () => {
    const k = b.dataset.sort;
    A.sort = { key: k, dir: A.sort.key === k && A.sort.dir === 'desc' ? 'asc' : (k === 'name' ? 'asc' : 'desc') };
    usersPage(list);
  }));
  $('#addUser').onclick = addUserDialog;
}

/* ---------- limits form, used for one person and for the defaults ---------- */
const LIMITS = [
  ['projects', 'Projects', 'Projects this person can own.', 'projects'],
  ['campaignsPerProject', 'Campaigns per project', 'Applies to each project they own.', 'campaigns'],
  ['keywordsPerProject', 'Keywords per project', 'Uploads stop when a project is full.', 'keywords'],
  ['keywordsTotal', 'Keywords in total', 'Across every project they own.', 'keywords'],
  ['aiBudget', 'Monthly analysis budget (USD)', 'Smart analysis pauses when this month’s estimated cost reaches it.', 'dollars'],
];

function limitRows(values, fallback, used = {}) {
  return LIMITS.map(([k, label, help, unit]) => {
    const v = values[k];
    const no = v === -1;
    const shown = v === undefined || v === null || no ? '' : v;
    const fb = fallback ? (fallback[k] === null || fallback[k] === undefined ? 'no limit' : unit === 'dollars' ? money(fallback[k]) : Number(fallback[k]).toLocaleString()) : null;
    return `<div class="lrow" data-k="${k}">
      <div class="lname"><label for="l-${k}">${label}</label><span class="hint">${help}${used[k] != null ? ` <b>Using ${used[k]}.</b>` : ''}</span></div>
      <input type="number" min="0" step="${unit === 'dollars' ? '0.5' : '1'}" id="l-${k}" value="${shown}" placeholder="${fb ? 'Default: ' + fb : 'No limit'}" ${no ? 'disabled' : ''} inputmode="decimal">
      <label class="chk"><input type="checkbox" ${no ? 'checked' : ''} data-nolimit> No limit</label></div>`;
  }).join('');
}

function readLimits(root, forDefaults) {
  const out = {};
  root.querySelectorAll('.lrow[data-k]').forEach(row => {
    const input = $('input[type=number]', row), no = $('[data-nolimit]', row).checked;
    out[row.dataset.k] = no ? -1 : input.value.trim() === '' ? (forDefaults ? -1 : null) : Number(input.value);
  });
  return out;
}

function wireLimits(root) {
  root.querySelectorAll('.lrow').forEach(row => {
    const input = $('input[type=number]', row), box = $('[data-nolimit]', row);
    if (!input || !box) return; // the analysis on/off row is a plain select
    box.onchange = () => { input.disabled = box.checked; if (box.checked) input.value = ''; else input.focus(); };
  });
}

/* ---------- one person ---------- */
function userPage(u) {
  const big = Math.max(0, ...u.projectList.map(p => p.keywords)), camps = Math.max(0, ...u.projectList.map(p => p.campaigns));
  const used = { projects: `${u.projects}`, campaignsPerProject: camps ? `${camps} in the busiest project` : null, keywordsPerProject: big ? `${big.toLocaleString()} in the biggest` : null, keywordsTotal: u.keywords.toLocaleString(), aiBudget: money(u.usage.spentMonth) };
  const self = state.user.id === u.id;
  const aiSel = u.overrides.aiEnabled === true ? 'on' : u.overrides.aiEnabled === false ? 'off' : 'default';
  $('#apane').innerHTML = `
    <a href="${href('/admin/users')}" class="back" data-link>${I('left')} All users</a>
    <div class="uhead"><div><h2 class="uname">${esc(u.name)} ${statusPillA(u)}</h2><p class="sub">${esc(u.email)}. Joined ${ago(u.createdAt)}, last seen ${ago(u.lastSeenAt)}, last signed in ${ago(u.lastLoginAt)}.</p></div></div>
    <div class="kpis">
      ${tile('Projects', u.projects, `${u.campaigns} campaigns, ${u.uploads} uploads`)}
      ${tile('Keywords held', u.keywords.toLocaleString(), `${u.keywordsUploaded.toLocaleString()} uploaded ever`)}
      ${tile('Analysis cost, this month', money(u.ai.costMonth), `${money(u.ai.costAll)} all time`, 'cost')}
      ${tile('Analysis calls', u.ai.calls.toLocaleString(), `${compact(u.ai.tokens)} tokens${u.ai.errors ? ', ' + u.ai.errors + ' failed' : ''}`)}
    </div>
    <div class="two wide">
      <section class="card"><h3>Limits</h3>
        <p class="hint">Leave a box empty to use the default. Tick No limit to remove the cap. Campaigns, keywords and analysis on a shared project are counted against the project owner.</p>
        <div id="lform">${limitRows(u.overrides, u.defaults, used)}
          <div class="lrow"><div class="lname"><label for="l-ai">Smart analysis</label><span class="hint">Switch it off to keep this person on rules only.</span></div>
            <select id="l-ai"><option value="default" ${aiSel === 'default' ? 'selected' : ''}>Default</option><option value="on" ${aiSel === 'on' ? 'selected' : ''}>On</option><option value="off" ${aiSel === 'off' ? 'selected' : ''}>Off</option></select><span></span></div></div>
        ${u.isAdmin ? '<p class="hint">Admins are never limited, so these only apply if admin access is removed.</p>' : ''}
        <p class="autherr" id="lerr" role="alert"></p>
        <div class="actions"><button class="btn primary" id="saveLimits">Save limits</button><button class="btn" id="resetLimits" type="button">Reset all to default</button></div>
      </section>
      <section class="card"><h3>Account</h3>
        <div class="field"><label for="u-note">Private note</label><textarea id="u-note" rows="3" maxlength="500" placeholder="Plan, invoice, anything to remember. Only admins see this.">${esc(u.note)}</textarea></div>
        <div class="actions tight"><button class="btn small" id="saveNote">Save note</button></div>
        <hr><div class="acts">
          <button class="btn small" id="setPass">Set a new password</button>
          <button class="btn small" id="toggleAdmin" ${self ? 'disabled title="You cannot change your own access"' : ''}>${u.isAdmin ? 'Remove admin access' : 'Make admin'}</button>
          <button class="btn small" id="toggleStatus" ${self ? 'disabled title="You cannot suspend yourself"' : ''}>${u.status === 'suspended' ? 'Restore access' : 'Suspend'}</button>
          <button class="btn small danger" id="delUser" ${self ? 'disabled title="You cannot delete yourself"' : ''}>${I('trash')} Delete user</button></div>
        <p class="hint">Suspending signs them out at once and blocks sign-in. Their projects stay. Deleting removes their account and every project they own.</p>
      </section>
    </div>
    ${columns('ucost', u.usage.costSeries, { fmt: money, unit: 'Analysis cost' })}
    <div class="two">
      <section class="card"><h3>Projects they own</h3>${u.projectList.length ? `<div class="tablewrap short"><table class="mini"><thead><tr><th>Project</th><th class="num">Campaigns</th><th class="num">Uploads</th><th class="num">Keywords</th><th>Updated</th></tr></thead><tbody>${u.projectList.map(p => `<tr><td>${esc(p.name)}${p.people > 1 ? ` <small>shared with ${p.people - 1}</small>` : ''}</td><td class="num">${p.campaigns}</td><td class="num">${p.uploads}</td><td class="num">${p.keywords.toLocaleString()}</td><td>${ago(p.updated_at)}</td></tr>`).join('')}</tbody></table></div><p class="hint">Project names and counts only. Keywords and business details are not shown here.</p>` : '<p class="hint">No projects yet.</p>'}
        ${u.sharedWithThem ? `<p class="hint">Also a member of ${u.sharedWithThem} shared project${u.sharedWithThem === 1 ? '' : 's'}.</p>` : ''}</section>
      <section class="card"><h3>Analysis by step</h3>${barList(u.usage.byKind, r => r.cost, r => `${esc(r.label)} <small>${r.calls} calls</small>`, money)}</section>
    </div>`;
  const reload = async () => { A.data.user = await adminApi('/users/' + u.id); userPage(A.data.user); };
  const patch = async (body, msg) => guard(async () => { await adminApi('/users/' + u.id, { method: 'PATCH', body }); toast(msg); await reload(); });
  wireLimits($('#lform'));
  wireCharts($('#apane'), () => userPage(u));
  $('#saveLimits').onclick = async () => {
    const limits = readLimits($('#lform'));
    for (const v of Object.values(limits)) if (v !== null && (!Number.isFinite(v) || v < -1)) { $('#lerr').textContent = 'Use whole numbers of zero or more.'; return; }
    limits.aiEnabled = { default: null, on: true, off: false }[$('#l-ai').value];
    await patch({ limits }, 'Limits saved.');
  };
  $('#resetLimits').onclick = () => patch({ limits: null }, 'Back to the defaults.');
  $('#saveNote').onclick = () => patch({ note: $('#u-note').value }, 'Note saved.');
  $('#toggleStatus').onclick = () => patch({ status: u.status === 'suspended' ? 'active' : 'suspended' }, u.status === 'suspended' ? 'Access restored.' : 'Suspended and signed out.');
  $('#toggleAdmin').onclick = () => patch({ isAdmin: !u.isAdmin }, u.isAdmin ? 'Admin access removed.' : 'Now an admin.');
  $('#setPass').onclick = () => passwordDialog(u);
  $('#delUser').onclick = () => deleteDialog(u);
}

/* ---------- dialogs ---------- */
function dlg(html) { const d = $('#modal'); d.innerHTML = `<form class="dlg" method="dialog">${html}</form>`; d.showModal(); return d; }

function passwordDialog(u) {
  const d = dlg(`<h2>New password for ${esc(u.name)}</h2><p class="sub">They are signed out everywhere. Leave it empty to make a random one, then pass it on to them. They can change it from the menu after signing in.</p>
    <div class="field"><label for="pw">Password</label><input type="text" id="pw" autocomplete="off" placeholder="Random"></div><p class="autherr" id="pw-err" role="alert"></p>
    <div class="actions"><button class="btn primary" id="pw-go" value="x">Set password</button><button class="btn" value="cancel">Cancel</button></div>`);
  $('#pw-go').onclick = async e => {
    e.preventDefault();
    try {
      const r = await adminApi(`/users/${u.id}/password`, { method: 'POST', body: { password: $('#pw').value } });
      d.innerHTML = `<form class="dlg" method="dialog"><h2>Password set</h2><p class="sub">Copy it now. It is not shown again.</p><div class="secret"><code id="secret">${esc(r.password)}</code><button class="btn small" type="button" id="copy">Copy</button></div><div class="actions"><button class="btn primary" value="ok">Done</button></div></form>`;
      $('#copy').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast('Copied.'), () => toast('Select it and copy by hand.', true));
    } catch (err) { $('#pw-err').textContent = err.message; }
  };
}

function deleteDialog(u) {
  const d = dlg(`<h2>Delete ${esc(u.name)}?</h2><p class="sub">This removes the account and the ${u.projects} project${u.projects === 1 ? '' : 's'} they own (${u.keywords.toLocaleString()} keywords), including for anyone those projects were shared with. It cannot be undone. Suspending is the gentler option.</p>
    <div class="field"><label for="del-mail">Type <b>${esc(u.email)}</b> to confirm</label><input type="text" id="del-mail" autocomplete="off"></div><p class="autherr" id="del-err" role="alert"></p>
    <div class="actions"><button class="btn danger-fill" id="del-go" value="x">Delete for good</button><button class="btn" value="cancel">Cancel</button></div>`);
  $('#del-go').onclick = async e => {
    e.preventDefault();
    try {
      await adminApi('/users/' + u.id, { method: 'DELETE', body: { confirmEmail: $('#del-mail').value } });
      d.close(); toast('User deleted.'); go('/admin/users');
    } catch (err) { $('#del-err').textContent = err.message; }
  };
}

function addUserDialog() {
  const d = dlg(`<h2>Add user</h2><p class="sub">Makes the account straight away. Limits start at the defaults and can be changed on their page.</p>
    <div class="field"><label for="nu-name">Name</label><input type="text" id="nu-name" autocomplete="off"></div>
    <div class="field" style="margin-top:12px"><label for="nu-mail">Email</label><input type="text" id="nu-mail" autocomplete="off" inputmode="email"></div>
    <div class="field" style="margin-top:12px"><label for="nu-pw">Password <span class="opt">optional</span></label><input type="text" id="nu-pw" autocomplete="off" placeholder="Random"></div>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="nu-admin"> Make them an admin</label>
    <p class="autherr" id="nu-err" role="alert"></p>
    <div class="actions"><button class="btn primary" id="nu-go" value="x">Create account</button><button class="btn" value="cancel">Cancel</button></div>`);
  $('#nu-name').focus();
  $('#nu-go').onclick = async e => {
    e.preventDefault();
    try {
      const r = await adminApi('/users', { method: 'POST', body: { name: $('#nu-name').value, email: $('#nu-mail').value, password: $('#nu-pw').value, isAdmin: $('#nu-admin').checked } });
      if (r.password) {
        d.innerHTML = `<form class="dlg" method="dialog"><h2>Account created</h2><p class="sub">Sign-in for ${esc(r.user.email)}. The password is shown once.</p><div class="secret"><code>${esc(r.password)}</code><button class="btn small" type="button" id="copy">Copy</button></div><div class="actions"><button class="btn primary" value="ok">Done</button></div></form>`;
        $('#copy').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast('Copied.'), () => toast('Select it and copy by hand.', true));
        d.addEventListener('close', () => go('/admin/users/' + r.user.id), { once: true });
      } else { d.close(); go('/admin/users/' + r.user.id); }
    } catch (err) { $('#nu-err').textContent = err.message; }
  };
}

/* ---------- settings ---------- */
function settingsPage(s) {
  const dl = s.defaultLimits;
  $('#apane').innerHTML = `
    <div class="two wide">
      <section class="card"><h3>Sign-ups and analysis</h3>
        <label class="switch"><input type="checkbox" id="s-signup" ${s.signupOpen ? 'checked' : ''}><span><b>Anyone can create an account</b><small>Turn off to invite people yourself with Add user. The very first account is always allowed.</small></span></label>
        <label class="switch"><input type="checkbox" id="s-ai" ${s.aiEnabled ? 'checked' : ''}><span><b>Smart analysis is on</b><small>Turn off to stop every OpenAI call for everyone, for example while checking a bill. Rules-based sorting keeps working.</small></span></label>
        <div class="actions tight"><button class="btn primary small" id="saveSwitches">Save</button></div>
      </section>
      <section class="card"><h3>Default limits</h3>
        <p class="hint">Apply to everyone who has no limit of their own. A person’s own setting always wins. Admins are never limited.</p>
        <div id="dform">${limitRows(dl, null)}
          <div class="lrow"><div class="lname"><label for="d-ai">Smart analysis for new people</label><span class="hint">A person can be switched on or off on their own page.</span></div><select id="d-ai"><option value="on" ${dl.aiEnabled === false ? '' : 'selected'}>On</option><option value="off" ${dl.aiEnabled === false ? 'selected' : ''}>Off</option></select><span></span></div></div>
        <p class="autherr" id="derr" role="alert"></p>
        <div class="actions"><button class="btn primary" id="saveDefaults">Save defaults</button></div>
      </section>
    </div>
    <section class="card"><h3>Token prices</h3>
      <p class="hint">US dollars per one million tokens. These start as estimates and OpenAI changes its prices, so check them against the OpenAI pricing page. Changing a price also changes the cost shown for past use, because cost is worked out from stored token counts.</p>
      <div class="tablewrap"><table class="mini prices"><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Cached input</th><th class="num">Output</th><th>Source</th></tr></thead><tbody>
        ${s.pricing.map(p => `<tr data-model="${esc(p.model)}" class="${p.current ? 'cur' : ''}"><td>${esc(p.model)}${p.current ? ' <span class="tag ok">in use</span>' : ''}</td>
          <td class="num"><input type="number" min="0" step="0.001" data-f="in" value="${p.in ?? ''}" aria-label="${esc(p.model)} input price"></td>
          <td class="num"><input type="number" min="0" step="0.001" data-f="cached" value="${p.cached ?? ''}" aria-label="${esc(p.model)} cached price"></td>
          <td class="num"><input type="number" min="0" step="0.001" data-f="out" value="${p.out ?? ''}" aria-label="${esc(p.model)} output price"></td><td><small>${esc(p.source)}</small></td></tr>`).join('')}
      </tbody></table></div>
      <p class="autherr" id="perr" role="alert"></p>
      <div class="actions"><button class="btn primary" id="savePrices">Save prices</button></div>
    </section>`;
  wireLimits($('#dform'));
  const save = async (body, msg) => guard(async () => { A.data.settings = await adminApi('/settings', { method: 'PUT', body }); toast(msg); settingsPage(A.data.settings); });
  $('#saveSwitches').onclick = () => save({ signupOpen: $('#s-signup').checked, aiEnabled: $('#s-ai').checked }, 'Saved.');
  $('#saveDefaults').onclick = () => {
    const limits = readLimits($('#dform'), true);
    for (const v of Object.values(limits)) if (!Number.isFinite(v) || v < -1) { $('#derr').textContent = 'Use whole numbers of zero or more.'; return; }
    limits.aiEnabled = $('#d-ai').value === 'on' ? null : false;
    save({ defaultLimits: limits }, 'Default limits saved.');
  };
  $('#savePrices').onclick = () => {
    const pricing = {};
    for (const tr of document.querySelectorAll('.prices tbody tr')) {
      const v = f => $(`[data-f=${f}]`, tr).value;
      if ([v('in'), v('out'), v('cached')].every(x => x === '')) continue;
      pricing[tr.dataset.model] = { in: v('in') || 0, out: v('out') || 0, cached: v('cached') === '' ? v('in') || 0 : v('cached') };
    }
    save({ pricing }, 'Prices saved.');
  };
}

/* ---------- activity ---------- */
const ACTIONS = { 'user.update': 'Changed a user', 'user.password': 'Set a password', 'user.create': 'Added a user', 'user.delete': 'Deleted a user', 'settings.update': 'Changed settings' };
function activityPage(rows) {
  $('#apane').innerHTML = `<div class="card flush"><div class="tablewrap"><table class="mini"><thead><tr><th>When</th><th>Who</th><th>What</th><th>About</th><th>Detail</th></tr></thead><tbody>
    ${rows.map(a => `<tr><td class="nowrap">${when(a.at)}</td><td>${esc(a.actor || '')}</td><td>${esc(ACTIONS[a.action] || a.action)}</td><td>${esc(a.target || '')}</td><td>${esc(a.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No admin changes yet.</td></tr>'}
    </tbody></table></div></div><p class="hint">The last 100 changes made from this panel.</p>`;
}

/* ---------- for everyone: change password ---------- */
function changePasswordDialog() {
  const d = dlg(`<h2>Change password</h2>
    <div class="field"><label for="cp-old">Current password</label><input type="password" id="cp-old" autocomplete="current-password"></div>
    <div class="field" style="margin-top:12px"><label for="cp-new">New password</label><input type="password" id="cp-new" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
    <p class="autherr" id="cp-err" role="alert"></p>
    <div class="actions"><button class="btn primary" id="cp-go" value="x">Change password</button><button class="btn" value="cancel">Cancel</button></div>`);
  $('#cp-old').focus();
  $('#cp-go').onclick = async e => {
    e.preventDefault();
    try { await api('/auth/password', { method: 'POST', body: { current: $('#cp-old').value, next: $('#cp-new').value } }); d.close(); toast('Password changed.'); }
    catch (err) { $('#cp-err').textContent = err.message; }
  };
}
