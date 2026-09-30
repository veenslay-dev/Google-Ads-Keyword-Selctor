'use strict';

paintIcons();
document.querySelectorAll('.theme button').forEach(b => (b.onclick = () => setTheme(b.dataset.theme)));
setTheme(document.documentElement.dataset.theme);
$('#signout').onclick = () => { $('#userbox').open = false; signOut(); };

// Links marked data-link change the page without a reload, and keep the address bar in step.
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const to = new URL(a.href).pathname;
  if (to !== location.pathname) history.pushState(null, '', to);
  route();
});
window.addEventListener('popstate', () => { if (state.user) route(); });

guard(async () => {
  state.config = await api('/config');
  const me = await api('/auth/me');
  if (me.user) await startApp(me.user); else showAuth();
});
