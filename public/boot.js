'use strict';

$('#projectList').onclick = e => {
  const b = e.target.closest('button[data-id]');
  if (b) guard(() => openProject(b.dataset.id));
};
$('#newProject').onclick = startNew;
$('#signout').onclick = () => signOut();
$('#home').onclick = e => { e.preventDefault(); if (state.user) { state.project = null; state.view = 'keywords'; renderSide(); render(); } };

guard(async () => {
  state.config = await api('/config');
  const me = await api('/auth/me');
  if (me.user) await startApp(me.user); else showAuth();
});
