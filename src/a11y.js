// Accessibility helpers (WCAG 2.2 AA): accessible names for icon-only controls, keyboard operation for
// clickable non-button elements, and live-region semantics. Runs once and keeps up with re-rendered UI.
const nameOf = (el) => {
  if (el.dataset?.tip) { try { return JSON.parse(el.dataset.tip).t; } catch { /* ignore */ } }
  return el.getAttribute('title') || '';
};

function fix(root) {
  for (const b of root.querySelectorAll('button, [role=button]')) {
    if (b.getAttribute('aria-label') || b.textContent.trim()) continue;
    const n = nameOf(b);
    if (n) b.setAttribute('aria-label', n);
  }
  // clickable div/span handlers (ribbon group labels, tree rows...) must be reachable and operable by keyboard
  for (const el of root.querySelectorAll('[data-menu]:not(button), .tr[role=button]')) {
    if (el.dataset.kb) continue;
    el.dataset.kb = '1';
    el.setAttribute('role', 'button'); el.tabIndex = 0;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  }
  for (const i of root.querySelectorAll('input:not([aria-label]):not([id])')) {
    if (!i.closest('label') && i.placeholder) i.setAttribute('aria-label', i.placeholder);
  }
}

export function initA11y() {
  const mi = document.querySelector('#manip-label input'); if (mi) mi.setAttribute('aria-label', 'Distance');
  const t = document.querySelector('#toast');
  if (t) { t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); }
  document.documentElement.lang ||= 'en';
  fix(document);
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fix(document); }); } })
    .observe(document.body, { childList: true, subtree: true });
}
