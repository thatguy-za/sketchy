// Light / dark theme: stored choice, otherwise the system preference. Colours live in CSS custom properties
// (see the generated block at the end of style.css); this only flips <html data-theme>.
const KEY = 'sketchy.theme';
const listeners = [];
export function getTheme() {
  try { const t = localStorage.getItem(KEY); if (t === 'dark' || t === 'light') return t; } catch { /* ignore */ }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function setTheme(t, persist = true) {
  document.documentElement.dataset.theme = t;
  if (persist) { try { localStorage.setItem(KEY, t); } catch { /* ignore */ } }
  listeners.forEach((fn) => fn(t));
}
export const onTheme = (fn) => listeners.push(fn);
export const initTheme = () => setTheme(getTheme(), false);
