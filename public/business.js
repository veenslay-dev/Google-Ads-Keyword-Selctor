/* ---------- business view ---------- */
function renderBusiness() {
  if (state.project) $('#phead').innerHTML = pageHead('Business', 'What the tool knows about this business. It uses this to judge every keyword.');
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
        if (!state.project) { state.project = await api('/projects', { method: 'POST', body: body() }); state.page = 'project'; state.view = 'business'; }
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
    guard(async () => { await api('/projects/' + p.id, { method: 'DELETE' }); await refreshList(); goProjects(); });
  };
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

/* ---------- competitors page ---------- */
function renderCompetitors() {
  const p = state.project;
  $('#phead').innerHTML = pageHead('Competitors', 'Their brand names can be blocked as negatives, and their headings show topics your site may be missing.');
  $('#pane').innerHTML = `<div id="banner"></div>${competitorsHtml(p)}`;
  drawBanner();
  wireCompetitors();
}

function competitorsHtml(p) {
  const comps = p.competitors.map(c => `<li>
      <span><b>${esc(c.name)}</b> <span class="pm">${esc(c.host)}</span><br><span class="pm">${c.pages.length} page${c.pages.length === 1 ? '' : 's'} read${c.errors.length ? ', ' + c.errors.length + ' failed' : ''}</span></span>
      <button class="x ed" data-rm="${c.id}" aria-label="Remove ${esc(c.name)}">${I('x')}</button></li>`).join('');
  const brands = p.brands.map(b => `<button class="chip brand ${b.enabled ? '' : 'off'} ed" data-b="${esc(b.phrase)}" aria-pressed="${b.enabled}" title="${esc('From ' + b.competitor + '. Click to ' + (b.enabled ? 'stop blocking' : 'block again'))}">${esc(b.phrase)}</button>`).join('');
  const gaps = (p.gaps || []).map((g, i) => `<li><label><input type="checkbox" class="ed" data-i="${i}"> <b>${esc(g.phrase)}</b></label> <span class="pm">${g.competitors.map(esc).join(', ')}</span></li>`).join('');
  return `<div class="competitors" id="competitors">
    <div class="kw-wrap">
      <div>
        <div class="field"><label for="c-urls">Competitor websites</label>
          <textarea id="c-urls" class="ed" style="min-height:92px" placeholder="competitor-one.com&#10;competitor-two.com" spellcheck="false">${esc(p.competitors.map(c => c.url).join('\n'))}</textarea>
          <span class="hint">Up to ${state.config.maxCompetitors}, one per line. About 5 pages are read from each.</span></div>
        <div class="actions" style="padding-top:10px"><button class="btn primary ed" id="c-go">${p.competitors.length ? 'Read them again' : 'Read competitor sites'}</button></div>
      </div>
      <div>${p.competitors.length ? `<ul class="members">${comps}</ul>` : ''}</div>
    </div>
    ${p.competitors.length ? `<div class="twocol">
      <div><h3>Brand names</h3>
        <label class="check"><input type="checkbox" id="c-block" class="ed" ${p.blockCompetitors ? 'checked' : ''}> Send searches containing these names to Negative</label>
        <div class="chips" style="margin-top:10px">${brands || '<span class="sub">No usable brand names found.</span>'}</div>
        <p class="hint">Only names with a word that is not in your own vocabulary count. Click a name to switch it off. Leave this off if you plan to bid on competitor names on purpose.</p></div>
      <div><h3>Topics they cover that you do not</h3>
        ${gaps ? `<ul class="gaps">${gaps}</ul>
          <div class="field"><label for="c-camp">Add the ticked topics to</label><select id="c-camp" class="ed">${p.campaigns.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="new">A new campaign called "Competitor topics"</option></select></div>
          <p><button class="btn small primary ed" id="c-add">${I('plus')} Add selected as a new upload</button></p>` : '<span class="sub">Nothing stands out. Try a competitor with a larger site.</span>'}</div>
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
        state.project = r.project; await refreshList(); renderCompetitors(); lockIfViewer();
        if (r.failed.length) toast('Could not use: ' + r.failed.map(f => f.url + ' (' + f.error + ')').join('; '), true);
        else toast('Read ' + r.project.competitors.length + ' competitor site(s).');
      } finally { const b = $('#c-go'); if (b) { b.disabled = false; b.textContent = 'Read competitor sites'; } }
    });
  };
  pane.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => guard(async () => { state.project = await api(`/projects/${p.id}/competitors/${b.dataset.rm}`, { method: 'DELETE' }); await refreshList(); renderCompetitors(); lockIfViewer(); })));
  pane.querySelectorAll('[data-b]').forEach(b => (b.onclick = () => guard(async () => {
    state.project = await api(`/projects/${p.id}/brand`, { method: 'PATCH', body: { phrase: b.dataset.b, enabled: b.getAttribute('aria-pressed') !== 'true' } });
    await refreshList(); renderCompetitors(); lockIfViewer();
  })));
  const blk = $('#c-block');
  if (blk) blk.onchange = () => guard(async () => { state.project = await api('/projects/' + p.id, { method: 'PUT', body: { blockCompetitors: blk.checked } }); await refreshList(); renderCompetitors(); lockIfViewer(); });
  const add = $('#c-add');
  if (add) add.onclick = () => {
    const picked = [...pane.querySelectorAll('.gaps input:checked')].map(i => p.gaps[Number(i.dataset.i)].phrase);
    if (!picked.length) return toast('Tick the topics you want first.', true);
    guard(async () => {
      let campaignId = $('#c-camp').value;
      if (campaignId === 'new') {
        const made = await api(`/projects/${p.id}/campaigns`, { method: 'POST', body: { name: 'Competitor topics' } }).catch(async e => {
          if (/already exists/.test(e.message)) return { project: await api('/projects/' + p.id), campaignId: (p.campaigns.find(c => c.name.toLowerCase() === 'competitor topics') || {}).id };
          throw e;
        });
        state.project = made.project; campaignId = made.campaignId;
      }
      const r = await api(`/projects/${p.id}/uploads`, { method: 'POST', body: { text: picked.join('\n'), name: 'Competitor topics', campaignId } });
      state.project = r.project;
      await finishUpload(r.batchId, [uploadMessage('Competitor topics', r)], { campaignId });
    });
  };
}

/* ---------- team page ---------- */
async function renderTeam() {
  const p = state.project;
  $('#phead').innerHTML = pageHead('Team and sharing', 'Who can see and change this project.');
  $('#pane').innerHTML = '<div class="card" id="team"><p class="muted">Loading...</p></div>';
  const owner = p.role === 'owner';
  const draw = members => {
    $('#team').innerHTML = `
      <p class="sub" style="margin-top:0">${owner ? 'Editors can change everything except sharing and deletion. Viewers can look and download.' : 'You have ' + esc(p.role) + ' access.'}</p>
      <ul class="members">${members.map(m => `<li>
        <span><b>${esc(m.name)}</b><br><span class="pm">${esc(m.email)}</span></span>
        ${owner && m.role !== 'owner'
          ? `<select data-uid="${m.userId}" class="rolesel" aria-label="Role for ${esc(m.name)}"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button type="button" class="x" data-rm="${m.userId}" aria-label="Remove ${esc(m.name)}">${I('x')}</button>`
          : `<span class="role">${esc(m.role)}</span>`}
      </li>`).join('')}</ul>
      ${owner ? `<div class="addm"><input type="text" id="m-email" placeholder="Their account email" aria-label="Email to share with"><select id="m-role" aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button type="button" class="btn primary" id="m-add">${I('plus')} Add</button></div>
      <p class="hint" style="margin-top:8px">They need an account first. Ask them to sign up, then add their email here.</p>` : ''}
      <p class="autherr" id="merr" role="alert"></p>
      ${!owner ? '<button type="button" class="btn danger small" id="leave">Leave project</button>' : ''}`;
    const fail = e => { $('#merr').textContent = e.message; };
    const call = (path, method, body) => api(`/projects/${p.id}/members${path}`, { method, body }).then(draw, fail);
    document.querySelectorAll('#team .rolesel').forEach(s => (s.onchange = () => call('/' + s.dataset.uid, 'PATCH', { role: s.value })));
    document.querySelectorAll('#team [data-rm]').forEach(b => (b.onclick = () => call('/' + b.dataset.rm, 'DELETE')));
    const add = $('#m-add');
    if (add) add.onclick = () => call('', 'POST', { email: $('#m-email').value, role: $('#m-role').value });
    const leave = $('#leave');
    if (leave) leave.onclick = async () => {
      if (!confirm('Leave "' + p.name + '"? You will lose access until someone adds you again.')) return;
      await api(`/projects/${p.id}/leave`, { method: 'POST' }).catch(fail);
      await refreshList(); goProjects();
    };
  };
  try { draw(await api(`/projects/${p.id}/members`)); } catch (e) { if (!e.auth) $('#team').innerHTML = `<p class="autherr">${esc(e.message)}</p>`; }
}
