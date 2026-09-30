'use strict';
/* Sign in, sign out and sharing. Uses the helpers from app.js when called. */

function showAuth(mode = 'login') {
  state.user = null;
  state.project = null;
  clearTimeout(pollTimer);
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
      <div class="actions"><button class="btn primary" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
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
  await refreshList();
  if (state.projects.length) await openProject(state.projects[0].id); else { state.view = 'keywords'; render(); }
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
}

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
        <div class="actions" style="margin-top:8px">
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
      state.project = null; state.view = 'keywords';
      await refreshList();
      render();
    };
  };
  draw(await api(`/projects/${p.id}/members`));
  dlg.showModal();
}
