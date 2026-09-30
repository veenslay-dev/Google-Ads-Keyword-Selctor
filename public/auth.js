'use strict';
/* Sign in, sign out and sharing. Uses the helpers from app.js when called. */

function showAuth(mode = 'login') {
  state.user = null;
  state.project = null;
  clearTimeout(pollTimer);
  $('#main').hidden = true;
  $('#userbox').hidden = true;
  $('.topnav').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  const reg = mode === 'register';
  box.innerHTML = `
    <form class="authform" id="authform">
      <span class="pill" style="align-self:flex-start">${I('search')} Keyword Selector</span>
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
  $('#main').hidden = false;
  $('#userbox').hidden = false;
  $('.topnav').hidden = false;
  $('#adminlink').hidden = !user.isAdmin;
  $('#username').textContent = user.name;
  state.project = null;
  await refreshList();
  await route(); // opens whatever the address bar names, so a bookmark or reload lands in the right place
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
}
