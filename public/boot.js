'use strict';

paintIcons();
document.querySelectorAll('.theme button').forEach(b => (b.onclick = () => setTheme(b.dataset.theme)));
setTheme(document.documentElement.dataset.theme);
$('#signout').onclick = () => { $('#userbox').open = false; signOut(); };
$('#home').onclick = e => {
  e.preventDefault();
  if (state.user) guard(async () => { await refreshList(); goProjects(); });
};

guard(async () => {
  state.config = await api('/config');
  const me = await api('/auth/me');
  if (me.user) await startApp(me.user); else showAuth();
});
