'use strict';
// Loaded in the head so the chosen theme is applied before anything is painted.
(function () {
  let t = 'light';
  try { t = localStorage.getItem('theme') || 'light'; } catch (e) { /* storage blocked */ }
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
})();
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) { /* storage blocked */ }
  document.querySelectorAll('.theme button').forEach(b => b.classList.toggle('on', b.dataset.theme === t));
}
