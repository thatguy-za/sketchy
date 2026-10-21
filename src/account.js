// Account UI (sign in / register) and the "My Designs" browser. Talks to the /api in server.js.
import { confirmBox, alertBox } from './files.js';
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
  acct.mcp = acct.server ? r.data.mcp !== false : false; // may assistants connect to this server?
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
  // a window that asks for a number opens with that number selected (unless it already put the focus somewhere itself)
  if (!document.body.classList.contains('touch')) setTimeout(() => { if (!back.contains(document.activeElement)) back.querySelector('input[type=number], input[inputmode=decimal], input[inputmode=numeric]')?.focus(); }, 0);
  return { el: back.firstChild, close };
}

const LOGO = '<svg viewBox="0 0 64 64" width="34" height="34"><rect x="4" y="4" width="56" height="56" rx="14" fill="#169b62"/><path d="M40 22C36 17 24 18 24 26C24 34 40 30 40 39C40 47 27 48 22 42" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>';

/**
 * Full-page sign-up / sign-in. Server with no accounts yet -> sign up (you become the admin); a browser that has
 * signed in before -> login; a brand-new visitor -> sign up when registration is open. Resolves true once signed in.
 */
export function showAuth(startRegister) {
  return new Promise((resolve) => {
    if (document.querySelector('.auth-page')) return;
    let register = startRegister ?? acct.setup; // sign in by default; the first account on a new server is the only time it starts on sign-up
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
        let r = await call('POST', register ? '/register' : '/login', { username: fd.get('username'), password: fd.get('password') });
        btn.disabled = false;
        if (!r.ok) { form.querySelector('.form-err').textContent = r.data?.error || 'Something went wrong.'; return; }
        if (r.data?.totp) { r = await secondStep(page, r.data.ticket, render); if (!r) return; } // two-step sign-in is on for this account
        page.remove();
        await refreshAccount();
        resolve(true);
      };
      form.username.focus();
    };
    render();
  });
}

/** The second sign-in step for accounts with two-step sign-in: a 6-digit code from the authenticator app, or a recovery code. */
function secondStep(page, ticket, back) {
  return new Promise((resolve) => {
    page.innerHTML = `<div class="auth-card" role="dialog" aria-label="Two-step sign-in">
      <div class="auth-brand">${LOGO}<b>Sketchy</b></div>
      <h1>Two-step sign-in</h1>
      <p class="auth-sub">Open your authenticator app and enter the 6-digit code for Sketchy. Lost your phone? Enter one of your recovery codes instead.</p>
      <form autocomplete="off">
        <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required maxlength="12" aria-describedby="tf-hint"></label>
        <div class="form-err" role="alert"></div>
        <button class="btn primary" type="submit">Verify and sign in</button>
      </form>
      <div class="switch"><a href="#">Back to sign in</a></div></div>`;
    const form = page.querySelector('form'), err = form.querySelector('.form-err');
    page.querySelector('.switch a').onclick = (e) => { e.preventDefault(); back(); resolve(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]'); btn.disabled = true;
      const r = await call('POST', '/login/totp', { ticket, code: form.code.value });
      btn.disabled = false;
      if (r.ok) return resolve(r);
      err.textContent = r.data?.error || 'Something went wrong.';
      if (r.data?.expired) { back(); resolve(null); } else { form.code.select(); }
    };
    form.code.focus();
  });
}

/**
 * The page an assistant (Claude, ChatGPT...) sends you to when you add Sketchy as a connector: shows who is asking and lets you allow
 * or refuse. Needs you signed in first (ensureSignedIn has run). Ends by sending the browser back to the assistant.
 */
export async function oauthConsent() {
  const q = new URLSearchParams(location.search);
  const params = { client_id: q.get('client_id') || '', redirect_uri: q.get('redirect_uri') || '', code_challenge: q.get('code_challenge') || '', code_challenge_method: q.get('code_challenge_method') || '', state: q.get('state') || '' };
  const page = document.createElement('div');
  page.className = 'auth-page';
  document.body.appendChild(page);
  const card = (inner) => (page.innerHTML = `<div class="auth-card" role="dialog" aria-label="Connect an assistant"><div class="auth-brand">${LOGO}<b>Sketchy</b></div>${inner}</div>`);
  const info = await call('GET', `/oauth/client?client_id=${encodeURIComponent(params.client_id)}&redirect_uri=${encodeURIComponent(params.redirect_uri)}`);
  if (!info.ok || q.get('response_type') !== 'code') {
    card(`<h1>Can't connect</h1><p class="auth-sub">${esc(info.data?.error || 'This connection request is not valid. Start again from the assistant.')}</p><div class="switch"><a href="/">Open Sketchy</a></div>`);
    return;
  }
  card(`<h1>Connect ${esc(info.data.name)}?</h1>
    <p class="auth-sub"><b>${esc(info.data.name)}</b> wants to view and change your designs in Sketchy, signed in as <b>${esc(acct.user)}</b>. It can create designs, edit them and export them, but it can't see your password or other people's designs.</p>
    <p class="auth-sub">You will be sent back to <b>${esc(info.data.host)}</b>. Only allow this if you just started it from there.</p>
    <div class="form-err" role="alert"></div>
    <div class="oauth-actions"><button class="btn primary" id="oa-allow" type="button">Allow</button><button class="btn" id="oa-deny" type="button">Cancel</button></div>
    <div class="switch">You can disconnect it any time under Account, then AI assistants.</div>`);
  const go = async (deny) => {
    page.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const r = await call('POST', '/oauth/approve', { ...params, deny });
    if (!r.ok) { page.querySelector('.form-err').textContent = r.data?.error || 'Something went wrong.'; page.querySelectorAll('button').forEach((b) => (b.disabled = false)); return; }
    location.assign(r.data.redirect);
  };
  page.querySelector('#oa-allow').onclick = () => go(false);
  page.querySelector('#oa-deny').onclick = () => go(true);
  page.querySelector('#oa-allow').focus();
}

/** When the server needs accounts and nobody is signed in, show the sign-up / login page and wait for it. */
export async function ensureSignedIn() { if (acct.server && !acct.user) await showAuth(); }

export async function requireLogin() { return acct.user ? true : showAuth(); }

// ---------------------------------------------------------------- change password
/** Popover under the avatar: who you are, shortcuts, theme switch, log out. */
export function openUserMenu(anchor, { onAccount, onPrefs, onSettings, onTheme, isDark, onLogout }) {
  document.querySelector('.umenu')?.remove();
  const el = document.createElement('div');
  el.className = 'umenu'; el.setAttribute('role', 'menu');
  const item = (id, ico, label, extra = '') => `<button role="menuitem" class="um-item" data-id="${id}" type="button"><span class="um-ico">${uicon(ico, 17, 1.6)}</span><span class="um-lbl">${label}</span>${extra}</button>`;
  el.innerHTML = `<div class="um-head"><span class="avatar big" aria-hidden="true">${esc(acct.user.slice(0, 1).toUpperCase())}</span><div class="um-who"><b>${esc(acct.user)}</b><span>${acct.admin ? 'Administrator' : 'Member'}</span></div></div>
    <div class="um-group">${item('account', 'user', 'Account')}${item('prefs', 'cog', 'Settings')}${acct.admin ? item('settings', 'globe', 'Server settings') : ''}</div>
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
    ({ account: onAccount, prefs: onPrefs, settings: onSettings, logout: onLogout })[b.dataset.id]?.();
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
        <dl class="ac-dl"><dt>Username</dt><dd>${esc(acct.user)}</dd><dt>Role</dt><dd>${acct.admin ? 'Administrator' : 'Member'}</dd><dt>Member since</dt><dd>${esc(since)}</dd><dt>Saved designs</dt><dd id="ac-n2">…</dd><dt>Storage</dt><dd id="ac-store">…</dd></dl>
        <p class="hint">Your designs live on this server and are private to you. Your changes are saved automatically. Saving a version (Ctrl+S) adds a restorable step to the design's history.</p>
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
        <h3 class="mh3 mt22">Two-step sign-in</h3>
        <div id="tf-box" class="tf-box">Loading…</div>
        <h3 class="mh3 mt22">Signed-in devices</h3>
        <div id="ss-box" class="ss-box">Loading…</div>
      </section>
      <section class="ac-pane" role="tabpanel" id="pane-ai" aria-labelledby="tab-ai" hidden>
        <h3>AI assistants (MCP)</h3>
        <p class="hint">Let Claude, ChatGPT or any MCP-capable assistant build designs in <b>your</b> account. Claude and ChatGPT connect by themselves (steps below, no token needed); other tools use a token. Everything is private to you, can be disconnected at any time, and every change becomes a new version you can roll back.</p>
        <div class="mcp-url"><span>Server URL</span><code>${esc(mcpUrl)}</code><button class="btn sm" id="mc-copyurl" type="button">Copy</button></div>
        <div id="mc-off" class="ac-warn" hidden>MCP access is turned off on this server by the administrator.</div>
        <div id="mc-list" class="mcp-list">Loading…</div>
        <form class="mcp-new" id="mc-form"><input name="name" placeholder="Token name, e.g. Claude Desktop" maxlength="60" aria-label="Token name"><button class="btn primary" type="submit">Create token</button></form>
        <div id="mc-out"></div>
        <h3 class="mh3 mt14">Set up your assistant</h3>
        <div id="mc-guide" class="mcp-guide"></div>
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
  call('GET', '/storage').then((r) => { const el = m.el.querySelector('#ac-store'); if (!el) return; el.textContent = r.ok ? `${fmtBytes(r.data.used)} of ${r.data.quota ? fmtBytes(r.data.quota) : 'unlimited'}` : '—'; });
  // ---- two-step sign-in
  const tf = m.el.querySelector('#tf-box');
  const tfCopy = (text, btn) => navigator.clipboard?.writeText(text).then(() => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1400); });
  const tfRender = async () => {
    const r = await call('GET', '/totp');
    if (!r.ok) { tf.textContent = 'Could not load.'; return; }
    if (r.data.enabled) {
      tf.innerHTML = `<p class="hint"><b>On.</b> You will be asked for a code from your authenticator app each time you sign in. ${r.data.recoveryLeft} recovery code${r.data.recoveryLeft === 1 ? '' : 's'} left.</p>
        <form class="ac-form" id="tf-off" autocomplete="off"><label>Password<input name="password" type="password" autocomplete="current-password" required></label><label>Code (or a recovery code)<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
        <div class="form-err" role="alert"></div><div><button class="btn" type="submit">Turn off</button></div></form>`;
      const f = tf.querySelector('#tf-off');
      f.onsubmit = async (e) => { e.preventDefault(); const d = await call('POST', '/totp/disable', { password: f.password.value, code: f.code.value }); if (!d.ok) { f.querySelector('.form-err').textContent = d.data?.error || 'Could not turn it off.'; return; } tfRender(); };
    } else {
      tf.innerHTML = `<p class="hint">Adds a second check at sign-in: a 6-digit code from an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis). Optional, and recommended if this server is on the internet.</p>
        <form class="ac-form" id="tf-on" autocomplete="off"><label>Your password<input name="password" type="password" autocomplete="current-password" required></label><div class="form-err" role="alert"></div><div><button class="btn primary" type="submit">Set up two-step sign-in</button></div></form>`;
      const f = tf.querySelector('#tf-on');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const s = await call('POST', '/totp/setup', { password: f.password.value });
        if (!s.ok) { f.querySelector('.form-err').textContent = s.data?.error || 'Could not start the setup.'; return; }
        const spaced = s.data.secret.match(/.{1,4}/g).join(' ');
        tf.innerHTML = `<ol class="tf-steps"><li>In your authenticator app choose <b>Add account</b>, then <b>Enter a setup key</b> (on a phone you can also <a href="${esc(s.data.uri)}">tap here</a>).</li>
          <li>Account: <b>Sketchy (${esc(acct.user)})</b>. Key: <code class="tf-key">${esc(spaced)}</code> <button class="btn sm" type="button" id="tf-copykey">Copy</button>. Keep it on <b>time-based</b>.</li>
          <li>Enter the 6-digit code the app shows:</li></ol>
          <form class="ac-form" id="tf-confirm" autocomplete="off"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="8"></label><div class="form-err" role="alert"></div><div><button class="btn primary" type="submit">Turn on</button> <button class="btn" type="button" id="tf-cancel">Cancel</button></div></form>`;
        tf.querySelector('#tf-copykey').onclick = (ev) => tfCopy(s.data.secret, ev.currentTarget);
        tf.querySelector('#tf-cancel').onclick = tfRender;
        const c = tf.querySelector('#tf-confirm');
        c.code.focus();
        c.onsubmit = async (ev) => {
          ev.preventDefault();
          const d = await call('POST', '/totp/enable', { code: c.code.value });
          if (!d.ok) { c.querySelector('.form-err').textContent = d.data?.error || 'That code is not right.'; return; }
          tf.innerHTML = `<p><b>Two-step sign-in is on.</b> Save these recovery codes somewhere safe, such as a password manager. Each works once if you lose your phone. They are not shown again.</p>
            <pre class="tf-codes">${d.data.recoveryCodes.map(esc).join('\n')}</pre><button class="btn sm" type="button" id="tf-copycodes">Copy codes</button> <button class="btn primary" type="button" id="tf-done">I have saved them</button>`;
          tf.querySelector('#tf-copycodes').onclick = (ev2) => tfCopy(d.data.recoveryCodes.join('\n'), ev2.currentTarget);
          tf.querySelector('#tf-done').onclick = tfRender;
        };
      };
    }
  };
  tfRender();
  // ---- signed-in devices
  const ss = m.el.querySelector('#ss-box');
  const ssRender = async () => {
    const r = await call('GET', '/sessions');
    if (!r.ok) { ss.textContent = 'Could not load.'; return; }
    ss.innerHTML = r.data.map((x) => `<div class="ss-row"><div><b>${esc(x.device)}</b>${x.current ? ' <em class="adm">this device</em>' : ''}<span>Signed in ${when(x.created)} · Last active ${when(x.last)}</span></div>${x.current ? '' : `<button class="btn sm" type="button" data-id="${esc(x.id)}">Sign out</button>`}</div>`).join('')
      + (r.data.length > 1 ? '<div><button class="btn sm danger" type="button" id="ss-others">Sign out all other devices</button></div>' : '');
    ss.querySelectorAll('[data-id]').forEach((b) => (b.onclick = async () => { await call('DELETE', '/sessions/' + b.dataset.id); ssRender(); }));
    ss.querySelector('#ss-others')?.addEventListener('click', async () => { await call('POST', '/sessions/others', {}); ssRender(); });
  };
  ssRender();
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
  // ---- step-by-step setup guides, one collapsed section per assistant (Claude and ChatGPT first)
  const guide = m.el.querySelector('#mc-guide');
  const renderGuide = (tok, open = false) => {
    const t = tok || 'YOUR_TOKEN', secure = location.protocol === 'https:';
    const code = (txt) => `<div class="mcp-snip"><div class="mcp-snip-h"><span></span><button class="btn sm" type="button" data-copy>Copy</button></div><pre>${esc(txt)}</pre></div>`;
    const json = (o) => JSON.stringify(o, null, 2);
    const hdr = { Authorization: `Bearer ${t}` };
    const note = tok ? '' : '<p class="hint">Create a token above first and these steps fill in your token. Until then <b>YOUR_TOKEN</b> stands in for it.</p>';
    const needHttps = secure ? '' : `<p class="ac-warn">You are on <b>${esc(location.origin)}</b>, which isn't a public https address. Claude's website, ChatGPT and other web assistants call Sketchy from their own servers, so they can't reach it. Either <a href="https://github.com/thatguy-za/sketchy/blob/main/docs/HTTPS.md" target="_blank" rel="noopener">put Sketchy behind https</a> or use the local option below.</p>`;
    const sections = [
      ['Claude', `<p>Works in Claude on the web and in the Claude desktop app. You don't need a token: Claude signs in to Sketchy itself.</p>${needHttps}
        <ol>
          <li>In Claude open <b>Settings</b>, then <b>Connectors</b>.</li>
          <li>Choose <b>Add custom connector</b>.</li>
          <li>Name it <em>Sketchy</em> and paste this into <b>Remote MCP server URL</b>:${code(mcpUrl)}</li>
          <li>Click <b>Add</b>, then <b>Connect</b>. Sketchy opens: sign in if asked, then click <b>Allow</b>.</li>
          <li>Start a new chat, open the connectors menu (the <b>+</b> button by the message box) and switch <b>Sketchy</b> on.</li>
          <li>Ask for something: <em>“Make a 60×30×8 mm bracket with two 10 mm holes and call it Bracket.”</em> Then open <b>Bracket</b> in your library.</li>
        </ol>
        <details class="mcp-sub"><summary>Sketchy only on this computer (no https address)? Use the desktop app with a token</summary>
          <ol>
            <li>Install <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a>, then create a token above (name it <em>Claude</em>).</li>
            <li>In the Claude desktop app open <b>Settings</b>, then <b>Developer</b>, then <b>Edit Config</b>, and merge this in:${code(json({ mcpServers: { sketchy: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${t}`] } } }))}</li>
            <li>Quit Claude completely and open it again.</li>
          </ol>${note}
        </details>`],
      ['ChatGPT', `<p>Needs a public https address and a ChatGPT plan that offers custom connectors. Menu names change between releases, so look for the closest match. No token needed.</p>${needHttps}
        <ol>
          <li>In ChatGPT open <b>Settings</b>, then <b>Connectors</b> (or <b>Apps</b>), then <b>Advanced settings</b>, and turn on <b>Developer mode</b>.</li>
          <li>Back in Connectors choose <b>Create</b>.</li>
          <li>Name it <em>Sketchy</em>, paste this as the <b>MCP server URL</b>, and set authentication to <b>OAuth</b>:${code(mcpUrl)}</li>
          <li>Tick the box confirming you trust the server, then click <b>Create</b>. Sketchy opens: sign in if asked, then click <b>Allow</b>.</li>
          <li>In a new chat, add <b>Sketchy</b> from the tools menu under the message box, then ask for a part to be built.</li>
        </ol>`],
      ['Gemini CLI', `<ol><li>Create a token above.</li><li>Open <code>~/.gemini/settings.json</code> and add:${code(json({ mcpServers: { sketchy: { httpUrl: mcpUrl, headers: hdr } } }))}</li><li>Start <code>gemini</code> and run <code>/mcp</code> to check that <b>sketchy</b> is connected.</li></ol>${note}`],
      ['Cursor', `<ol><li>Create a token above.</li><li>Open <b>Settings</b>, then <b>MCP</b>, then <b>Add new MCP server</b> (this edits <code>~/.cursor/mcp.json</code>), and add:${code(json({ mcpServers: { sketchy: { url: mcpUrl, headers: hdr } } }))}</li><li>Turn <b>sketchy</b> on in the MCP list, then ask the agent to build a part.</li></ol>${note}`],
      ['VS Code (GitHub Copilot)', `<ol><li>Create a token above.</li><li>Run <b>MCP: Open User Configuration</b> from the command palette and add:${code(json({ servers: { sketchy: { type: 'http', url: mcpUrl, headers: hdr } } }))}</li><li>Open Copilot chat in <b>Agent</b> mode, check <b>sketchy</b> under the tools button, and ask for a part.</li></ol>${note}`],
      ['Any other MCP client', `<p>Sketchy speaks standard MCP over HTTP. Give your client this address and header. The token is accepted only in the header, so a client that can't send one can't connect:</p>${code(mcpUrl)}and the header <code>Authorization: Bearer ${esc(t)}</code>${note}`],
    ];
    guide.innerHTML = sections.map(([name, body], i) => `<details class="mcp-llm"${open && i === 0 ? ' open' : ''}><summary>${esc(name)}</summary><div class="mcp-llm-body">${body}</div></details>`).join('');
    guide.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = (ev) => copy(b.closest('.mcp-snip').querySelector('pre').textContent, ev.currentTarget)));
  };
  renderGuide('');
  const loadTokens = async () => {
    const t = await call('GET', '/mcp/tokens');
    if (!t.ok) { list.textContent = t.data?.error || 'Could not load tokens.'; return; }
    m.el.querySelector('#mc-off').hidden = t.data.enabled;
    form.hidden = !t.data.enabled;
    list.innerHTML = t.data.tokens.length ? '' : '<div class="ac-empty">No connected apps or tokens yet. Claude and ChatGPT connect with the steps below; create a token for other tools.</div>';
    for (const k of t.data.tokens) {
      const row = document.createElement('div');
      row.className = 'mcp-row';
      row.innerHTML = `<span class="mcp-ico">${uicon('key', 16, 1.6)}</span><div class="mcp-info"><b>${esc(k.name)}</b>${k.paused ? ` <em class="adm warnb">paused</em>` : ''}<span>${k.app ? 'Connected app · ' : ''}Created ${when(k.created)} · Last used ${when(k.lastUsed)}${k.paused ? ` · Paused ${when(k.paused.at)} after repeated problems (${esc(k.paused.reason)})` : ''}</span></div>${k.paused ? '<button class="btn sm" type="button" data-resume>Resume</button>' : ''}<button class="btn sm danger" type="button" data-revoke>Revoke</button>`;
      row.querySelector('[data-resume]')?.addEventListener('click', async () => { await call('POST', '/mcp/tokens/' + encodeURIComponent(k.id) + '/resume', {}); loadTokens(); });
      row.querySelector('[data-revoke]').onclick = async () => {
        if (!(await confirmBox({ title: k.app ? 'Disconnect app' : 'Revoke token', message: `${k.app ? 'Disconnect' : 'Revoke'} "${k.name}"? It will lose access immediately.`, ok: k.app ? 'Disconnect' : 'Revoke', danger: true }))) return;
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
    out.innerHTML = `<div class="mcp-token"><b>Copy your token now. It won't be shown again.</b><div class="mcp-url"><code>${esc(tok)}</code><button class="btn sm" type="button" data-c>Copy</button></div>
      <div class="hint">The setup guide below now has this token filled in. Anyone holding it can act as you; treat it like a password.</div></div>`;
    renderGuide(tok, true);
    out.querySelector('[data-c]').onclick = (ev) => copy(tok, ev.currentTarget);
    loadTokens();
  };
  loadTokens();
}

// ---------------------------------------------------------------- admin: server settings
const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2).replace(/\.?0+$/, '') + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB' : Math.round(n / 1024) + ' KB');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '—');
/** Server settings, in three tabs: Registration, Security (sign-in protection) and Users. */
export async function showAdmin(startTab = 'registration') {
  const tab = (id, ico, label) => `<button type="button" class="ac-tab" role="tab" id="atab-${id}" aria-controls="apane-${id}" data-t="${id}">${uicon(ico, 16, 1.6)}<span>${label}</span></button>`;
  const m = modal(`<div class="modal-title">Server settings</div>
    <div class="ac-tabs" role="tablist" aria-label="Server settings sections">${tab('registration', 'globe', 'Registration')}${tab('security', 'lock', 'Security')}${tab('users', 'user', 'Users')}</div>
    <div class="ac-panes">
      <section class="ac-pane" role="tabpanel" id="apane-registration" aria-labelledby="atab-registration" hidden>
        <h3>Who can use this server</h3>
        <label class="chk"><input type="checkbox" id="ad-reg"> Allow new people to register</label>
        <div class="hint">Off by default. When it is off, add people yourself on the Users tab.</div>
        <label class="chk"><input type="checkbox" id="ad-mcp"> Allow AI assistants to connect (MCP)</label>
        <label class="chk"><input type="checkbox" id="ad-addins"> Allow people to install their own add-ins</label>
        <div class="hint">People create their own access tokens under Account, and each token only reaches that person's designs.</div>
        <h3 class="mh3">Storage</h3>
        <div class="ad-lock"><label>Default storage per person<input type="number" id="ad-quota" min="0" max="10000000" step="1" inputmode="numeric"></label><span>MB (0 = no limit)</span></div>
        <div class="hint">Applies to everyone without their own limit, which you can set per person on the Users tab.</div>
        <div id="ad-msg-reg" class="hint" role="status"></div>
      </section>
      <section class="ac-pane" role="tabpanel" id="apane-security" aria-labelledby="atab-security" hidden>
        <h3>Sign-in protection</h3>
        <div class="ad-lock"><label>Lock out after<input type="number" id="ad-max" min="0" max="1000" step="1" inputmode="numeric"></label><span>failed sign-ins within</span><label><span class="sr-only">Minutes counted</span><input type="number" id="ad-win" min="1" max="10080" step="1" inputmode="numeric"></label><span>minutes, for</span><label><span class="sr-only">Lock-out minutes</span><input type="number" id="ad-lockmin" min="1" max="10080" step="1" inputmode="numeric"></label><span>minutes.</span></div>
        <div class="hint">Counted per address and per username. Use 0 failed sign-ins to turn lock-outs off. Behind a reverse proxy the real address is read from its forwarding header.</div>
        <h3 class="mh3">Passwords and sessions</h3>
        <label class="chk"><input type="checkbox" id="ad-breach"> Refuse passwords found in known data breaches</label>
        <div class="hint">When someone picks a password, the first five characters of its SHA-1 hash are sent to the Have I Been Pwned service to see whether it has leaked. The password itself never leaves this server. If the service cannot be reached the password is accepted. Needs internet access from the server.</div>
        <div class="ad-lock"><label>Sign people out after<input type="number" id="ad-idle" min="0" max="525600" step="1" inputmode="numeric"></label><span>minutes without use (0 = never)</span></div>
        <div class="hint">Applies to each signed-in device. Connected AI assistants are not affected.</div>
        <h3 class="mh3">Locked out now</h3>
        <div id="ad-locks" class="ad-locks" role="status"><span class="hint">Nobody is locked out.</span></div>
        <div id="ad-msg-sec" class="hint" role="status"></div>
      </section>
      <section class="ac-pane" role="tabpanel" id="apane-users" aria-labelledby="atab-users" hidden>
        <h3>Add a person</h3>
        <form class="ad-add" id="ad-add" autocomplete="off"><input name="username" placeholder="Username" aria-label="New username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32"><input name="password" type="text" placeholder="Password (blank = generate one)" aria-label="Password for the new user, blank to generate one" autocomplete="off"><label class="chk"><input type="checkbox" name="admin"> Admin</label><button class="btn primary" type="submit">Add</button></form>
        <div id="ad-msg" class="hint" role="status"></div>
        <div class="ad-users" id="ad-table">Loading…</div>
      </section>
    </div>`);
  m.el.classList.add('wide', 'admin-modal');
  const tabs = [...m.el.querySelectorAll('.ac-tab')], panes = [...m.el.querySelectorAll('.ac-pane')];
  const show = (id, focus = false) => {
    tabs.forEach((t) => { const on = t.dataset.t === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    panes.forEach((p) => (p.hidden = p.id !== 'apane-' + id));
  };
  tabs.forEach((t, i) => {
    t.onclick = () => show(t.dataset.t);
    t.onkeydown = (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.t, true); } };
  });
  show(startTab);
  const $m = (s) => m.el.querySelector(s);
  const msg = $m('#ad-msg'), msgReg = $m('#ad-msg-reg'), msgSec = $m('#ad-msg-sec'), host = $m('#ad-table');
  const st = await call('GET', '/admin/settings');
  // ---- registration
  const reg = $m('#ad-reg'), mcp = $m('#ad-mcp'), addins = $m('#ad-addins');
  reg.checked = !!st.data?.allowRegistration;
  reg.onchange = async () => { await call('PUT', '/admin/settings', { allowRegistration: reg.checked }); msgReg.textContent = 'Saved.'; await refreshAccount(); };
  mcp.checked = st.data?.allowMcp !== false;
  addins.checked = st.data?.allowAddins !== false;
  addins.onchange = async () => { await call('PUT', '/admin/settings', { allowAddins: addins.checked }); msgReg.textContent = 'Saved.'; };
  mcp.onchange = async () => { await call('PUT', '/admin/settings', { allowMcp: mcp.checked }); msgReg.textContent = 'Saved.'; };
  // ---- security
  const lim = { max: $m('#ad-max'), win: $m('#ad-win'), lock: $m('#ad-lockmin') };
  lim.max.value = st.data?.maxFailedLogins ?? 5; lim.win.value = st.data?.failWindowMinutes ?? 15; lim.lock.value = st.data?.lockoutMinutes ?? 15;
  const saveLimits = async () => {
    const r = await call('PUT', '/admin/settings', { maxFailedLogins: +lim.max.value, failWindowMinutes: +lim.win.value, lockoutMinutes: +lim.lock.value });
    msgSec.textContent = r.ok ? 'Sign-in protection saved.' : r.data?.error || 'Could not save.';
  };
  Object.values(lim).forEach((el) => (el.onchange = saveLimits));
  const breach = $m('#ad-breach'), idle = $m('#ad-idle');
  breach.checked = !!st.data?.breachCheck; idle.value = st.data?.idleMinutes ?? 0;
  const savePolicy = async () => {
    const r = await call('PUT', '/admin/settings', { breachCheck: breach.checked, idleMinutes: Math.max(0, +idle.value || 0) });
    msgSec.textContent = r.ok ? 'Saved.' : r.data?.error || 'Could not save.';
  };
  breach.onchange = idle.onchange = savePolicy;
  const locks = $m('#ad-locks');
  const loadLocks = async () => {
    const r = await call('GET', '/admin/lockouts');
    locks.innerHTML = '';
    if (!r.ok || !r.data.length) { locks.innerHTML = '<span class="hint">Nobody is locked out.</span>'; return; }
    for (const l of r.data) {
      const row = document.createElement('div');
      row.className = 'ad-lockrow';
      row.innerHTML = `<span>Locked: <b>${esc(l.name)}</b> (${l.kind}), ${l.minutes} min left</span><button class="btn sm" type="button">Unlock</button>`;
      row.querySelector('button').onclick = async () => { await call('DELETE', '/admin/lockouts?key=' + encodeURIComponent(l.key)); loadLocks(); };
      locks.appendChild(row);
    }
  };
  loadLocks();
  // ---- users
  const dq = $m('#ad-quota');
  dq.value = st.data?.defaultQuotaMb ?? 2048;
  dq.onchange = async () => {
    const r = await call('PUT', '/admin/settings', { defaultQuotaMb: dq.value === '' ? NaN : +dq.value });
    msgReg.textContent = r.ok ? 'Default storage saved.' : r.data?.error || 'Could not save.';
    if (r.ok) load();
  };
  const add = $m('#ad-add');
  add.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(add), btn = add.querySelector('[type=submit]'); btn.disabled = true;
    const r = await call('POST', '/admin/users', { username: fd.get('username'), password: fd.get('password') || undefined, admin: fd.get('admin') === 'on' });
    btn.disabled = false;
    if (!r.ok) { msg.textContent = r.data?.error || 'Could not add the user.'; return; }
    msg.innerHTML = r.data.password ? `Added <b>${esc(r.data.user)}</b>. Temporary password: <code>${esc(r.data.password)}</code> — shown once; ask them to change it after signing in.` : `Added <b>${esc(r.data.user)}</b>.`;
    add.reset(); add.username.focus(); await load();
  };
  const load = async () => {
    const r = await call('GET', '/admin/users');
    if (!r.ok) { host.textContent = r.data?.error || 'Could not load users.'; return; }
    host.innerHTML = '';
    for (const u of r.data) {
      const lim = u.effectiveQuotaMb ? fmtBytes(u.effectiveQuotaMb * 1048576) : 'no limit';
      const pct = u.effectiveQuotaMb ? Math.min(100, (u.bytes / (u.effectiveQuotaMb * 1048576)) * 100) : 0;
      const box = document.createElement('div');
      box.className = 'ad-user';
      box.innerHTML = `<div class="ad-uhead"><span><b>${esc(u.name)}</b>${u.admin ? ' <em class="adm">admin</em>' : ''}${u.totp ? ' <em class="adm">2-step</em>' : ''}${u.name === acct.user ? ' <em>(you)</em>' : ''}</span><span class="ad-umeta">${u.designs} design${u.designs === 1 ? '' : 's'} · last sign-in ${fmtDate(u.lastLogin)}</span></div>
        <div class="ad-ustore"><div class="ad-bar" role="img" aria-label="${esc(fmtBytes(u.bytes))} used of ${esc(lim)}"><i class="${pct > 90 ? 'hot' : ''}"></i></div><span>${esc(fmtBytes(u.bytes))} of ${esc(lim)}</span>
          <label>Limit <input type="number" min="0" max="10000000" step="1" inputmode="numeric" data-a="quota" placeholder="${u.effectiveQuotaMb}" value="${u.quotaMb ?? ''}" aria-label="Storage limit for ${esc(u.name)} in megabytes, blank for the default"> MB</label></div>
        <div class="ad-act"><button class="btn sm" data-a="pw">Reset password</button>${u.totp ? '<button class="btn sm" data-a="totp">Turn off 2-step</button>' : ''}<button class="btn sm" data-a="adm">${u.admin ? 'Remove admin' : 'Make admin'}</button>${u.name === acct.user ? '' : '<button class="btn sm danger" data-a="del">Delete</button>'}</div>`;
      box.querySelector('.ad-bar i').style.width = `${pct}%`;
      box.querySelector('[data-a=quota]').onchange = async (e) => {
        const v = e.target.value.trim();
        const q = await call('PUT', `/admin/users/${encodeURIComponent(u.name)}/quota`, { quotaMb: v === '' ? null : Number(v) });
        msg.textContent = q.ok ? (q.data.quotaMb === null ? `${u.name} follows the default (${q.data.effectiveQuotaMb} MB).` : q.data.effectiveQuotaMb ? `${u.name} can store ${q.data.effectiveQuotaMb} MB.` : `${u.name} has no storage limit.`) : q.data?.error || 'Could not save.';
        await load();
      };
      box.querySelector('[data-a=pw]').onclick = async () => {
        if (!(await confirmBox({ title: 'Reset password', message: `Reset the password for ${u.name}? They will be signed out everywhere.`, ok: 'Reset' }))) return;
        const pw = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/password`, {});
        msg.innerHTML = pw.ok ? `Temporary password for <b>${esc(u.name)}</b>: <code>${esc(pw.data.password)}</code> — shown once; ask them to change it after signing in.` : esc(pw.data?.error || 'Failed');
      };
      box.querySelector('[data-a=totp]')?.addEventListener('click', async () => {
        if (!(await confirmBox({ title: 'Turn off two-step sign-in', message: `Turn off two-step sign-in for ${u.name}? They will sign in with just their password until they set it up again. Do this only for someone who lost their phone and recovery codes.`, ok: 'Turn off', danger: true }))) return;
        const d = await call('DELETE', `/admin/users/${encodeURIComponent(u.name)}/totp`);
        msg.textContent = d.ok ? `Two-step sign-in is off for ${u.name}.` : d.data?.error || 'Failed';
        await load();
      });
      box.querySelector('[data-a=adm]').onclick = async () => { const a = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/admin`, { admin: !u.admin }); if (!a.ok) msg.textContent = a.data?.error || 'Failed'; await load(); await refreshAccount(); };
      box.querySelector('[data-a=del]')?.addEventListener('click', async () => {
        if (!(await confirmBox({ title: 'Delete user', message: `Delete ${u.name} and all of their saved designs? This cannot be undone.`, ok: 'Delete', danger: true }))) return;
        const d = await call('DELETE', `/admin/users/${encodeURIComponent(u.name)}`);
        msg.textContent = d.ok ? `Deleted ${u.name}.` : d.data?.error || 'Failed';
        await load();
      });
      host.appendChild(box);
    }
  };
  load();
}
