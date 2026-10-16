// Account UI (sign in / register) and the "My Designs" browser. Talks to the /api in server.js.
import { icon } from './icons.js';
import { uicon } from './ficons.js';

export const acct = { server: false, user: null, admin: false, registration: true };
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
    return { ok: r.ok, status: r.status, data, rev: +r.headers.get('x-rev') || 0 };
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
  renderAccountButton();
  onAccountChange?.();
}

function renderAccountButton() {
  const b = $('#btn-acct');
  if (!b) return;
  b.innerHTML = acct.user ? esc(acct.user.slice(0, 2).toUpperCase()) : uicon('user', 15, 1.8);
  b.title = acct.user ? `Signed in as ${acct.user}` : acct.server ? 'Sign in or create an account to save designs to your profile' : 'Accounts need the Sketchy server (docker compose up)';
  b.onclick = (e) => {
    if (!acct.server) return alert('Sign-in is available when Sketchy runs with its server (docker compose up).');
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
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); removeEventListener('keydown', onKey, true); } };
  addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  return { el: back.firstChild, close };
}

/** Resolves true once the user is signed in, false if they cancel. */
export function showAuth(startRegister = false) {
  return new Promise((resolve) => {
    let register = startRegister && acct.registration;
    let done = false;
    const m = modal('<div></div>');
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    m.el.parentElement.addEventListener('pointerdown', (e) => { if (e.target === m.el.parentElement) finish(false); });
    const render = () => {
      m.el.innerHTML = `<div class="modal-title">${register ? 'Create your account' : 'Sign in'}</div>
        <form class="modal-body" autocomplete="on">
          <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32"></label>
          <label>Password<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="${register ? 8 : 1}"></label>
          ${register ? '<div class="hint">Usernames: a–z, 0–9, _ or -. Passwords: at least 8 characters.</div>' : ''}
          <div class="form-err" role="alert"></div>
          <div class="modal-foot"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">${register ? 'Create account' : 'Sign in'}</button></div>
          ${acct.registration ? `<div class="switch">${register ? 'Already have an account? <a href="#">Sign in</a>' : 'New here? <a href="#">Create an account</a>'}</div>` : '<div class="switch">Registration is disabled on this server.</div>'}
        </form>`;
      const form = m.el.querySelector('form');
      form.querySelector('[data-x]').onclick = () => finish(false);
      form.querySelector('.switch a')?.addEventListener('click', (e) => { e.preventDefault(); register = !register; render(); });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type=submit]'); btn.disabled = true;
        const fd = new FormData(form);
        const r = await call('POST', register ? '/register' : '/login', { username: fd.get('username'), password: fd.get('password') });
        btn.disabled = false;
        if (!r.ok) { form.querySelector('.form-err').textContent = r.data?.error || 'Something went wrong.'; return; }
        await refreshAccount();
        finish(true);
      };
      form.username.focus();
    };
    render();
  });
}

export async function requireLogin() { return acct.user ? true : showAuth(); }

/** "My Designs" browser: open or delete designs stored on the server for the signed-in user. */
export async function showDesigns({ onOpen, current }) {
  if (!(await requireLogin())) return;
  const m = modal('<div class="modal-title">My Designs</div><div class="modal-body"><div class="design-list">Loading…</div></div><div class="modal-foot"><button class="btn primary" data-x>Close</button></div>');
  m.el.querySelector('[data-x]').onclick = m.close;
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
        if (!d.ok) return alert(d.data?.error || 'Could not open design.');
        m.close();
        onOpen(typeof d.data === 'string' ? d.data : JSON.stringify(d.data), p.name);
      };
      row.querySelector('[data-d]').onclick = async () => {
        if (!confirm(`Delete "${p.name}" permanently?`)) return;
        await call('DELETE', '/projects/' + encodeURIComponent(p.name));
        load();
      };
      host.appendChild(row);
    }
  };
  load();
}

// ---------------------------------------------------------------- change password
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
    alert('Password changed.');
  };
}

// ---------------------------------------------------------------- admin: users
const fmtBytes = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '—');
export async function showAdmin() {
  const m = modal(`<div class="modal-title">Users</div><div class="modal-body"><label class="chk" style="font-weight:400"><input type="checkbox" id="ad-reg"> Allow new people to register</label><div id="ad-msg" class="hint"></div><div class="ad-table" id="ad-table">Loading…</div></div><div class="modal-foot"><button class="btn primary" data-x>Close</button></div>`);
  m.el.classList.add('wide');
  m.el.querySelector('[data-x]').onclick = m.close;
  const msg = m.el.querySelector('#ad-msg'), host = m.el.querySelector('#ad-table'), reg = m.el.querySelector('#ad-reg');
  const st = await call('GET', '/admin/settings');
  reg.checked = !!st.data?.allowRegistration;
  reg.onchange = async () => { await call('PUT', '/admin/settings', { allowRegistration: reg.checked }); await refreshAccount(); };
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
        if (!confirm(`Reset the password for ${u.name}? They will be signed out everywhere.`)) return;
        const pw = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/password`, {});
        msg.innerHTML = pw.ok ? `Temporary password for <b>${esc(u.name)}</b>: <code>${esc(pw.data.password)}</code> — shown once; ask them to change it after signing in.` : esc(pw.data?.error || 'Failed');
      };
      row.querySelector('[data-a=adm]').onclick = async () => { const a = await call('POST', `/admin/users/${encodeURIComponent(u.name)}/admin`, { admin: !u.admin }); if (!a.ok) msg.textContent = a.data?.error || 'Failed'; await load(); await refreshAccount(); };
      row.querySelector('[data-a=del]')?.addEventListener('click', async () => {
        if (!confirm(`Delete ${u.name} and all of their saved designs? This cannot be undone.`)) return;
        const d = await call('DELETE', `/admin/users/${encodeURIComponent(u.name)}`);
        msg.textContent = d.ok ? `Deleted ${u.name}.` : d.data?.error || 'Failed';
        await load();
      });
      host.appendChild(row);
    }
  };
  load();
}
