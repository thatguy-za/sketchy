// Account UI (sign in / register) and the "My Designs" browser. Talks to the /api in server.js.
import { confirmBox, alertBox } from './files.js';
import { icon } from './icons.js';
import { uicon } from './ficons.js';

export const acct = { server: false, user: null, admin: false, registration: true, setup: false, created: 0 };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const deviceLabel = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ' on ' + os : ''}`;
};
export async function call(method, path, body, headers = {}) {
  try {
    const r = await fetch('/api' + path, { method, headers: { 'x-sketchy': '1', 'x-device-label': deviceLabel(), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data, rev: +r.headers.get('x-rev') || 0, seq: +r.headers.get('x-seq') || 0 };
  } catch { return { ok: false, status: 0, data: { error: 'Cannot reach the server.' } }; }
}

let onAccountChange = null;
export function setAccountChangeHandler(fn) { onAccountChange = fn; }
export async function refreshAccount() {
  const r = await call('GET', '/me');
  acct.server = r.ok && typeof r.data === 'object' && 'user' in r.data;
  acct.user = acct.server ? r.data.user : null;
  acct.admin = !!(acct.server && r.data.admin);
  acct.registration = acct.server ? r.data.registration !== false : false;
  acct.setup = !!(acct.server && r.data.setup);
  acct.created = acct.server ? r.data.created || 0 : 0;
  renderAccountButton();
  onAccountChange?.();
}

function renderAccountButton() {
  const b = $('#btn-acct');
  if (!b) return;
  b.innerHTML = acct.user ? esc(acct.user.slice(0, 1).toUpperCase()) : uicon('user', 15, 1.8);
  b.title = acct.user ? `Signed in as ${acct.user}` : acct.server ? 'Sign in or create an account to save designs to your profile' : 'Accounts need the Sketchy server (docker compose up)';
  b.onclick = (e) => {
    if (!acct.server) return alertBox({ title: 'Sketchy server not reachable', message: 'Accounts and saved designs need the Sketchy server. Start it with `docker compose up`, or `npm run dev` when developing.' });
    acct.user ? accountMenu(e.currentTarget) : showAuth();
  };
}

let onAccountMenu = null;
export function setAccountMenuHandler(fn) { onAccountMenu = fn; }
function accountMenu(anchor) { onAccountMenu?.(anchor); }

export async function signOut() { await call('POST', '/logout', {}); await refreshAccount(); }

export function modal(html, onClose) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}<button type="button" class="modal-x" aria-label="Close">${uicon('close', 15, 2)}</button></div>`;
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelector('.modal-x').onclick = close;
  const onKey = (e) => { if (e.key === 'Escape') { close(); removeEventListener('keydown', onKey, true); } };
  addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  return { el: back.firstChild, close };
}

const knownVisitor = () => /(?:^|;\s*)sketchy_known=1/.test(document.cookie);
const LOGO = '<svg viewBox="0 0 64 64" width="34" height="34"><rect x="4" y="4" width="56" height="56" rx="14" fill="#169b62"/><path d="M40 22C36 17 24 18 24 26C24 34 40 30 40 39C40 47 27 48 22 42" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>';

/**
 * Full-page sign-up / sign-in. Server with no accounts yet -> sign up (you become the admin); a browser that has
 * signed in before -> login; a brand-new visitor -> sign up when registration is open. Resolves true once signed in.
 */
export function showAuth(startRegister) {
  return new Promise((resolve) => {
    if (document.querySelector('.auth-page')) return;
    let register = startRegister ?? (acct.setup || (!knownVisitor() && acct.registration));
    if (register && !acct.registration && !acct.setup) register = false;
    const page = document.createElement('div');
    page.className = 'auth-page';
    document.body.appendChild(page);
    const render = () => {
      page.innerHTML = `<div class="auth-card" role="dialog" aria-label="${register ? 'Create your account' : 'Sign in'}">
        <div class="auth-brand">${LOGO}<b>Sketchy</b></div>
        <h1>${register ? 'Create your account' : 'Welcome back'}</h1>
        <p class="auth-sub">${register ? (acct.setup ? 'You are the first person here, so this account will be the administrator.' : 'Save your designs to your profile and open them on any device.') : 'Sign in to open your designs.'}</p>
        <form autocomplete="on">
          <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32"></label>
          <label>Password<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="${register ? 8 : 1}"></label>
          ${register ? '<div class="hint">Usernames: a–z, 0–9, _ or -. Passwords: at least 8 characters.</div>' : ''}
          <div class="form-err" role="alert"></div>
          <button class="btn primary" type="submit">${register ? 'Create account' : 'Sign in'}</button>
        </form>
        ${acct.registration || acct.setup ? `<div class="switch">${register ? 'Already have an account? <a href="#">Sign in</a>' : 'New here? <a href="#">Create an account</a>'}</div>` : '<div class="switch">Registration is disabled on this server. Ask the administrator for an account.</div>'}
      </div>`;
      const form = page.querySelector('form');
      page.querySelector('.switch a')?.addEventListener('click', (e) => { e.preventDefault(); register = !register; render(); });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type=submit]'); btn.disabled = true;
        const fd = new FormData(form);
        const r = await call('POST', register ? '/register' : '/login', { username: fd.get('username'), password: fd.get('password') });
        btn.disabled = false;
        if (!r.ok) { form.querySelector('.form-err').textContent = r.data?.error || 'Something went wrong.'; return; }
        page.remove();
        await refreshAccount();
        resolve(true);
      };
      form.username.focus();
    };
    render();
  });
}

/** When the server needs accounts and nobody is signed in, show the sign-up / login page and wait for it. */
export async function ensureSignedIn() { if (acct.server && !acct.user) await showAuth(); }

export async function requireLogin() { return acct.user ? true : showAuth(); }

/** "My Designs" browser: open or delete designs stored on the server for the signed-in user. */
export async function showDesigns({ onOpen, current }) {
  if (!(await requireLogin())) return;
  const m = modal('<div class="modal-title">My Designs</div><div class="modal-body"><div class="design-list">Loading…</div></div>');
  const host = m.el.querySelector('.design-list');
  const load = async () => {
    const r = await call('GET', '/projects');
    if (!r.ok) { host.textContent = r.data?.error || 'Could not load designs.'; return; }
    if (!r.data.length) { host.innerHTML = '<div class="hint">No designs yet. Use <b>Save to My Designs</b> to store the current model in your profile.</div>'; return; }
    host.innerHTML = '';
    for (const p of r.data) {
      const row = document.createElement('div');
      row.className = 'design-row' + (p.name === current ? ' current' : '');
      row.innerHTML = `${icon('box', 18)}<div class="dn"><b>${esc(p.name)}</b><small>${new Date(p.modified).toLocaleString()} · ${(p.size / 1024).toFixed(p.size > 1e5 ? 0 : 1)} KB</small></div><button class="btn" data-o>Open</button><button class="icon-btn danger" data-d title="Delete">${icon('remove', 16)}</button>`;
      row.querySelector('[data-o]').onclick = async () => {
        const d = await call('GET', '/projects/' + encodeURIComponent(p.name));
        if (!d.ok) return alertBox({ title: 'Could not open design', message: d.data?.error || 'The design could not be opened.' });
        m.close();
        onOpen(typeof d.data === 'string' ? d.data : JSON.stringify(d.data), p.name);
      };
      row.querySelector('[data-d]').onclick = async () => {
        if (!(await confirmBox({ title: 'Delete design', message: `Delete "${p.name}" permanently?`, ok: 'Delete', danger: true }))) return;
        await call('DELETE', '/projects/' + encodeURIComponent(p.name));
        load();
      };
      host.appendChild(row);
    }
  };
  load();
}

// ---------------------------------------------------------------- change password
/** Popover under the avatar: who you are, shortcuts, theme switch, log out. */
export function openUserMenu(anchor, { onAccount, onSettings, onTheme, isDark, onLogout }) {
  document.querySelector('.umenu')?.remove();
  const el = document.createElement('div');
  el.className = 'umenu'; el.setAttribute('role', 'menu');
  const item = (id, ico, label, extra = '') => `<button role="menuitem" class="um-item" data-id="${id}" type="button"><span class="um-ico">${uicon(ico, 17, 1.6)}</span><span class="um-lbl">${label}</span>${extra}</button>`;
  el.innerHTML = `<div class="um-head"><span class="avatar big" aria-hidden="true">${esc(acct.user.slice(0, 1).toUpperCase())}</span><div class="um-who"><b>${esc(acct.user)}</b><span>${acct.admin ? 'Administrator' : 'Member'}</span></div></div>
    <div class="um-group">${item('account', 'user', 'Account')}${acct.admin ? item('settings', 'cog', 'Server settings') : ''}</div>
    <div class="um-group"><button role="menuitemcheckbox" aria-checked="${isDark()}" class="um-item" data-id="theme" type="button"><span class="um-ico">${uicon(isDark() ? 'moon' : 'sun', 17, 1.6)}</span><span class="um-lbl">Dark mode</span><span class="um-switch${isDark() ? ' on' : ''}" aria-hidden="true"><i></i></span></button></div>
    <div class="um-group">${item('logout', 'logout', 'Log out')}</div>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = r.bottom + 6 + 'px';
  el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + 'px';
  const items = [...el.querySelectorAll('.um-item')];
  const close = () => { el.remove(); removeEventListener('pointerdown', off, true); removeEventListener('keydown', key, true); anchor.focus?.(); };
  const off = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') close();
  };
  addEventListener('pointerdown', off, true); addEventListener('keydown', key, true);
  el.onclick = (e) => {
    const b = e.target.closest('.um-item'); if (!b) return;
    if (b.dataset.id === 'theme') { onTheme(); close(); return; }
    close();
    ({ account: onAccount, settings: onSettings, logout: onLogout })[b.dataset.id]?.();
  };
  items[0].focus({ preventScroll: true });
}

/** Account dialog with three tabs: Profile, Security, AI assistants (MCP). */
export async function showAccount(startTab = 'profile') {
  const origin = location.origin, mcpUrl = origin + '/mcp';
  const since = acct.created ? new Date(acct.created).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '—';
  const tab = (id, ico, label) => `<button type="button" class="ac-tab" role="tab" id="tab-${id}" aria-controls="pane-${id}" data-t="${id}">${uicon(ico, 16, 1.6)}<span>${label}</span></button>`;
  const m = modal(`<div class="ac-head"><span class="avatar big lg" aria-hidden="true">${esc(acct.user.slice(0, 1).toUpperCase())}</span>
      <div class="ac-who"><div class="ac-name">${esc(acct.user)}</div><div class="ac-meta"><span class="ac-role">${acct.admin ? 'Administrator' : 'Member'}</span><span>Member since ${esc(since)}</span><span id="ac-n">…</span></div></div>
</div>
    <div class="ac-tabs" role="tablist" aria-label="Account sections">${tab('profile', 'user', 'Profile')}${tab('security', 'lock', 'Security')}${tab('ai', 'sparkle', 'AI assistants')}</div>
    <div class="ac-panes">
      <section class="ac-pane" role="tabpanel" id="pane-profile" aria-labelledby="tab-profile">
        <h3>Your account</h3>
        <dl class="ac-dl"><dt>Username</dt><dd>${esc(acct.user)}</dd><dt>Role</dt><dd>${acct.admin ? 'Administrator' : 'Member'}</dd><dt>Member since</dt><dd>${esc(since)}</dd><dt>Saved designs</dt><dd id="ac-n2">…</dd></dl>
        <p class="hint">Your designs live on this server and are private to you. Every save keeps the previous version in the design's history.</p>
      </section>
      <section class="ac-pane" role="tabpanel" id="pane-security" aria-labelledby="tab-security" hidden>
        <h3>Change password</h3>
        <form class="ac-form" autocomplete="off">
          <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
          <label>New password<input name="next" type="password" autocomplete="new-password" required minlength="8"></label>
          <label>Repeat new password<input name="again" type="password" autocomplete="new-password" required minlength="8"></label>
          <div class="hint">At least 8 characters. Your other signed-in devices will be signed out.</div>
          <div class="form-err" role="alert"></div><div class="ac-ok" role="status"></div>
          <div><button class="btn primary" type="submit">Update password</button></div>
        </form>
      </section>
      <section class="ac-pane" role="tabpanel" id="pane-ai" aria-labelledby="tab-ai" hidden>
        <h3>AI assistants (MCP)</h3>
        <p class="hint">Let Claude, ChatGPT or any MCP-capable assistant build designs in <b>your</b> account. Each token only works for you, can be revoked at any time, and every change becomes a new version you can roll back.</p>
        <div class="mcp-url"><span>Server URL</span><code>${esc(mcpUrl)}</code><button class="btn sm" id="mc-copyurl" type="button">Copy</button></div>
        <div id="mc-off" class="ac-warn" hidden>MCP access is turned off on this server by the administrator.</div>
        <div id="mc-list" class="mcp-list">Loading…</div>
        <form class="mcp-new" id="mc-form"><input name="name" placeholder="Token name, e.g. Claude Desktop" maxlength="60" aria-label="Token name"><button class="btn primary" type="submit">Create token</button></form>
        <div id="mc-out"></div>
      </section>
    </div>`);
  m.el.classList.add('acct-modal');
  // ---- tabs
  const tabs = [...m.el.querySelectorAll('.ac-tab')], panes = [...m.el.querySelectorAll('.ac-pane')];
  const show = (id, focus = false) => {
    tabs.forEach((t) => { const on = t.dataset.t === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    panes.forEach((p) => (p.hidden = p.id !== 'pane-' + id));
  };
  tabs.forEach((t, i) => {
    t.onclick = () => show(t.dataset.t);
    t.onkeydown = (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.t, true); } };
  });
  show(startTab);
  // ---- counts
  call('GET', '/projects').then((r) => { const n = r.ok ? `${r.data.length} design${r.data.length === 1 ? '' : 's'}` : '—'; m.el.querySelector('#ac-n').textContent = n; m.el.querySelector('#ac-n2').textContent = r.ok ? String(r.data.length) : '—'; });
  // ---- security
  const pf = m.el.querySelector('.ac-form');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    const err = pf.querySelector('.form-err'), ok = pf.querySelector('.ac-ok'); err.textContent = ''; ok.textContent = '';
    if (pf.next.value !== pf.again.value) { err.textContent = "The new passwords don't match."; return; }
    const r = await call('POST', '/password', { current: pf.current.value, next: pf.next.value });
    if (!r.ok) { err.textContent = r.data?.error || 'Could not change the password.'; return; }
    pf.reset(); ok.textContent = 'Password updated.';
  };
  // ---- MCP
  const copy = async (txt, btn) => { try { await navigator.clipboard.writeText(txt); const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = o), 1400); } catch { prompt('Copy this:', txt); } };
  m.el.querySelector('#mc-copyurl').onclick = (e) => copy(mcpUrl, e.currentTarget);
  const list = m.el.querySelector('#mc-list'), out = m.el.querySelector('#mc-out'), form = m.el.querySelector('#mc-form');
  const when = (t) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const loadTokens = async () => {
    const t = await call('GET', '/mcp/tokens');
    if (!t.ok) { list.textContent = t.data?.error || 'Could not load tokens.'; return; }
    m.el.querySelector('#mc-off').hidden = t.data.enabled;
    form.hidden = !t.data.enabled;
    list.innerHTML = t.data.tokens.length ? '' : '<div class="ac-empty">No tokens yet. Create one to connect an assistant.</div>';
    for (const k of t.data.tokens) {
      const row = document.createElement('div');
      row.className = 'mcp-row';
      row.innerHTML = `<span class="mcp-ico">${uicon('key', 16, 1.6)}</span><div class="mcp-info"><b>${esc(k.name)}</b><span>Created ${when(k.created)} · Last used ${when(k.lastUsed)}</span></div><button class="btn sm danger" type="button">Revoke</button>`;
      row.querySelector('button').onclick = async () => {
        if (!(await confirmBox({ title: 'Revoke token', message: `Revoke "${k.name}"? Assistants using it will lose access immediately.`, ok: 'Revoke', danger: true }))) return;
        await call('DELETE', '/mcp/tokens/' + encodeURIComponent(k.id)); out.innerHTML = ''; loadTokens();
      };
      list.appendChild(row);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = await call('POST', '/mcp/tokens', { name: form.name.value });
    if (!res.ok) { out.innerHTML = `<div class="form-err">${esc(res.data?.error || 'Could not create the token.')}</div>`; return; }
    form.name.value = '';
    const tok = res.data.token;
    const snip = {
      'Claude Code': `claude mcp add --transport http sketchy ${mcpUrl} --header "Authorization: Bearer ${tok}"`,
      'Claude Desktop': JSON.stringify({ mcpServers: { sketchy: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${tok}`] } } }, null, 2),
      'ChatGPT / URL only': `${mcpUrl}/${tok}`,
    };
    out.innerHTML = `<div class="mcp-token"><b>Copy your token now. It won't be shown again.</b><div class="mcp-url"><code>${esc(tok)}</code><button class="btn sm" type="button" data-c>Copy</button></div>
      ${Object.entries(snip).map(([k, v], i) => `<div class="mcp-snip"><div class="mcp-snip-h"><span>${esc(k)}</span><button class="btn sm" type="button" data-i="${i}">Copy</button></div><pre>${esc(v)}</pre></div>`).join('')}
      <div class="hint">ChatGPT and other web-based assistants need a publicly reachable <b>https</b> address, so put Sketchy behind a reverse proxy first. Anyone holding the URL-only link can act as you; treat it like a password.</div></div>`;
    out.querySelector('[data-c]').onclick = (ev) => copy(tok, ev.currentTarget);
    out.querySelectorAll('[data-i]').forEach((b) => (b.onclick = (ev) => copy(Object.values(snip)[+b.dataset.i], ev.currentTarget)));
    loadTokens();
  };
  loadTokens();
}

export function showChangePassword() {
  const m = modal(`<div class="modal-title">Change password</div>
    <form class="modal-body" autocomplete="off">
      <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password<input name="next" type="password" autocomplete="new-password" required minlength="8"></label>
      <label>Repeat new password<input name="again" type="password" autocomplete="new-password" required minlength="8"></label>
      <div class="hint">At least 8 characters. Signing in on your other devices will be required again.</div>
      <div class="form-err" role="alert"></div>
      <div class="modal-foot"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">Change password</button></div>
    </form>`);
  const form = m.el.querySelector('form');
  form.querySelector('[data-x]').onclick = m.close;
  form.current.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-err');
    if (form.next.value !== form.again.value) { err.textContent = "The new passwords don't match."; return; }
    const r = await call('POST', '/password', { current: form.current.value, next: form.next.value });
    if (!r.ok) { err.textContent = r.data?.error || 'Could not change the password.'; return; }
    m.close();
    alertBox({ title: 'Password changed', message: 'Your password has been updated.' });
  };
}

// ---------------------------------------------------------------- admin: users
const fmtBytes = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '—');
export async function showAdmin() {
  const m = modal(`<div class="modal-title">Server settings</div><div class="modal-body"><h3 class="mh3">Registration</h3><label class="chk" style="font-weight:400"><input type="checkbox" id="ad-reg"> Allow new people to register</label><label class="chk" style="font-weight:400"><input type="checkbox" id="ad-mcp"> Allow AI assistants (MCP) to connect with user tokens</label><h3 class="mh3">Users</h3><div id="ad-msg" class="hint"></div><div class="ad-table" id="ad-table">Loading…</div></div>`);
  m.el.classList.add('wide');
  const msg = m.el.querySelector('#ad-msg'), host = m.el.querySelector('#ad-table'), reg = m.el.querySelector('#ad-reg');
  const st = await call('GET', '/admin/settings');
  reg.checked = !!st.data?.allowRegistration;
  reg.onchange = async () => { await call('PUT', '/admin/settings', { allowRegistration: reg.checked }); await refreshAccount(); };
  const mcp = m.el.querySelector('#ad-mcp'); mcp.checked = st.data?.allowMcp !== false;
  mcp.onchange = async () => { await call('PUT', '/admin/settings', { allowMcp: mcp.checked }); };
  const load = async () => {
    const r = await call('GET', '/admin/users');
    if (!r.ok) { host.textContent = r.data?.error || 'Could not load users.'; return; }
    host.innerHTML = `<div class="ad-row ad-head"><span>User</span><span>Designs</span><span>Storage</span><span>Last sign-in</span><span></span></div>`;
    for (const u of r.data) {
      const row = document.createElement('div');
      row.className = 'ad-row';
      row.innerHTML = `<span><b>${esc(u.name)}</b>${u.admin ? ' <em class="adm">admin</em>' : ''}${u.name === acct.user ? ' <em>(you)</em>' : ''}</span><span>${u.designs}</span><span>${fmtBytes(u.bytes)}</span><span>${fmtDate(u.lastLogin)}</span>
        <span class="ad-act"><button class="btn sm" data-a="pw">Reset password</button><button class="btn sm" data-a="adm">${u.admin ? 'Remove admin' : 'Make admin'}</button>${u.name === acct.user ? '' : '<button class="btn sm danger" data-a="del">Delete</button>'}</span>`;
      row.querySelector('[data-a=pw]').onclick = async () => {
        if (!(await confirmBox({ title: 'Reset password', message: `Reset the password for ${u.name}? They will be signed out everywhere.`, ok: 'Reset' }))) return;
        const pw = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/password`, {});
        msg.innerHTML = pw.ok ? `Temporary password for <b>${esc(u.name)}</b>: <code>${esc(pw.data.password)}</code> — shown once; ask them to change it after signing in.` : esc(pw.data?.error || 'Failed');
      };
      row.querySelector('[data-a=adm]').onclick = async () => { const a = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/admin`, { admin: !u.admin }); if (!a.ok) msg.textContent = a.data?.error || 'Failed'; await load(); await refreshAccount(); };
      row.querySelector('[data-a=del]')?.addEventListener('click', async () => {
        if (!(await confirmBox({ title: 'Delete user', message: `Delete ${u.name} and all of their saved designs? This cannot be undone.`, ok: 'Delete', danger: true }))) return;
        const d = await call('DELETE', `/admin/users/${encodeURIComponent(u.name)}`);
        msg.textContent = d.ok ? `Deleted ${u.name}.` : d.data?.error || 'Failed';
        await load();
      });
      host.appendChild(row);
    }
  };
  load();
}
