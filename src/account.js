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
        <h3 class="mh3" style="margin-top:14px">Set up your assistant</h3>
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
    const t = tok || 'YOUR_TOKEN', urlTok = `${mcpUrl}/${t}`, secure = location.protocol === 'https:';
    const code = (txt) => `<div class="mcp-snip"><div class="mcp-snip-h"><span></span><button class="btn sm" type="button" data-copy>Copy</button></div><pre>${esc(txt)}</pre></div>`;
    const json = (o) => JSON.stringify(o, null, 2);
    const hdr = { Authorization: `Bearer ${t}` };
    const note = tok ? '' : '<p class="hint">Create a token above first and these steps fill in your token. Until then <b>YOUR_TOKEN</b> stands in for it.</p>';
    const needHttps = secure ? '' : `<p class="ac-warn">You are on <b>${esc(location.origin)}</b>, which isn't a public https address. Claude's website, ChatGPT and other web assistants call Sketchy from their own servers, so they can't reach it. Either <a href="https://github.com/thatguy-za/sketchy/blob/main/docs/HTTPS.md" target="_blank" rel="noopener">put Sketchy behind https</a> or use the local option below.</p>`;
    const sections = [
      ['Claude', `<p>Works in Claude on the web and in the Claude desktop app.</p>${needHttps}${note}
        <ol>
          <li>Create a token above (name it <em>Claude</em>) and copy the <b>connector URL</b>:${code(urlTok)}</li>
          <li>In Claude, open <b>Settings</b> and choose <b>Connectors</b>.</li>
          <li>Choose <b>Add custom connector</b>.</li>
          <li>Set the name to <em>Sketchy</em> and paste the URL into <b>Remote MCP server URL</b>. Leave any advanced or sign-in fields empty, the token in the URL is the sign-in.</li>
          <li>Click <b>Add</b>.</li>
          <li>Start a new chat, open the connectors or tools menu (the <b>+</b> or sliders button by the message box) and switch <b>Sketchy</b> on.</li>
          <li>Ask for something: <em>“Make a 60×30×8 mm bracket with two 10 mm holes and call it Bracket.”</em> Then open <b>Bracket</b> in your library.</li>
        </ol>
        <details class="mcp-sub"><summary>Sketchy only on this computer? Use the Claude desktop app with a local config</summary>
          <ol>
            <li>Install <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a> if you don't have it.</li>
            <li>In the Claude desktop app open <b>Settings</b>, then <b>Developer</b>, then <b>Edit Config</b>.</li>
            <li>Merge this into the file that opens, then save it:${code(json({ mcpServers: { sketchy: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${t}`] } } }))}</li>
            <li>Quit Claude completely and open it again. Sketchy appears in the tools list of a new chat.</li>
          </ol>
        </details>`],
      ['ChatGPT', `<p>Needs a public https address and a ChatGPT plan that offers custom connectors. Menu names change between releases, so look for the closest match.</p>${needHttps}${note}
        <ol>
          <li>Create a token above (name it <em>ChatGPT</em>) and copy the <b>connector URL</b>:${code(urlTok)}</li>
          <li>In ChatGPT open <b>Settings</b>, then <b>Connectors</b> (or <b>Apps</b>), then <b>Advanced settings</b>, and turn on <b>Developer mode</b>.</li>
          <li>Back in Connectors choose <b>Create</b>.</li>
          <li>Name it <em>Sketchy</em>, paste the URL as the <b>MCP server URL</b>, and set authentication to <b>No authentication</b> (the token is in the URL).</li>
          <li>Tick the box confirming you trust the server, then click <b>Create</b>.</li>
          <li>In a new chat, add <b>Sketchy</b> from the tools menu under the message box, then ask for a part to be built.</li>
        </ol>`],
      ['Gemini CLI', `<ol><li>Create a token above.</li><li>Open <code>~/.gemini/settings.json</code> and add:${code(json({ mcpServers: { sketchy: { httpUrl: mcpUrl, headers: hdr } } }))}</li><li>Start <code>gemini</code> and run <code>/mcp</code> to check that <b>sketchy</b> is connected.</li></ol>${note}`],
      ['Cursor', `<ol><li>Create a token above.</li><li>Open <b>Settings</b>, then <b>MCP</b>, then <b>Add new MCP server</b> (this edits <code>~/.cursor/mcp.json</code>), and add:${code(json({ mcpServers: { sketchy: { url: mcpUrl, headers: hdr } } }))}</li><li>Turn <b>sketchy</b> on in the MCP list, then ask the agent to build a part.</li></ol>${note}`],
      ['VS Code (GitHub Copilot)', `<ol><li>Create a token above.</li><li>Run <b>MCP: Open User Configuration</b> from the command palette and add:${code(json({ servers: { sketchy: { type: 'http', url: mcpUrl, headers: hdr } } }))}</li><li>Open Copilot chat in <b>Agent</b> mode, check <b>sketchy</b> under the tools button, and ask for a part.</li></ol>${note}`],
      ['Any other MCP client', `<p>Sketchy speaks standard MCP over HTTP. Give your client either of these:</p><ul><li><b>URL and header:</b> ${code(mcpUrl)}and the header <code>Authorization: Bearer ${esc(t)}</code></li><li><b>URL only</b>, for clients that can't send headers (web assistants must be able to reach it over https):${code(urlTok)}</li></ul>${note}`],
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
    out.innerHTML = `<div class="mcp-token"><b>Copy your token now. It won't be shown again.</b><div class="mcp-url"><code>${esc(tok)}</code><button class="btn sm" type="button" data-c>Copy</button></div>
      <div class="hint">The setup guide below now has this token filled in. Anyone holding it can act as you; treat it like a password.</div></div>`;
    renderGuide(tok, true);
    out.querySelector('[data-c]').onclick = (ev) => copy(tok, ev.currentTarget);
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
  const m = modal(`<div class="modal-title">Server settings</div><div class="modal-body"><h3 class="mh3">Registration</h3><label class="chk" style="font-weight:400"><input type="checkbox" id="ad-reg"> Allow new people to register</label><label class="chk" style="font-weight:400"><input type="checkbox" id="ad-mcp"> Allow AI assistants (MCP) to connect with user tokens</label><h3 class="mh3">Sign-in protection</h3>
    <div class="ad-lock"><label>Lock out after<input type="number" id="ad-max" min="0" max="1000" step="1" inputmode="numeric"></label><span>failed sign-ins within</span><label><span class="sr-only">Minutes counted</span><input type="number" id="ad-win" min="1" max="10080" step="1" inputmode="numeric" aria-label="Minutes in which failed sign-ins are counted"></label><span>minutes, for</span><label><span class="sr-only">Lock-out minutes</span><input type="number" id="ad-lockmin" min="1" max="10080" step="1" inputmode="numeric" aria-label="Minutes a lock-out lasts"></label><span>minutes.</span></div>
    <div class="hint">Counted per address and per username. Use 0 failed sign-ins to turn lock-outs off. Behind a reverse proxy the real address is read from its forwarding header.</div>
    <div id="ad-locks" class="ad-locks" role="status"></div>
    <h3 class="mh3">Users</h3>
    <form class="ad-add" id="ad-add" autocomplete="off"><input name="username" placeholder="Username" aria-label="New username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32"><input name="password" type="text" placeholder="Password (blank = generate one)" aria-label="New password" autocomplete="new-password" minlength="8"><label class="chk" style="font-weight:400"><input type="checkbox" name="admin"> Admin</label><button class="btn primary" type="submit">Add user</button></form>
    <div id="ad-msg" class="hint" role="status"></div><div class="ad-table" id="ad-table">Loading…</div></div>`);
  m.el.classList.add('wide');
  const msg = m.el.querySelector('#ad-msg'), host = m.el.querySelector('#ad-table'), reg = m.el.querySelector('#ad-reg');
  const st = await call('GET', '/admin/settings');
  reg.checked = !!st.data?.allowRegistration;
  reg.onchange = async () => { await call('PUT', '/admin/settings', { allowRegistration: reg.checked }); await refreshAccount(); };
  const mcp = m.el.querySelector('#ad-mcp'); mcp.checked = st.data?.allowMcp !== false;
  mcp.onchange = async () => { await call('PUT', '/admin/settings', { allowMcp: mcp.checked }); };
  const lim = { max: m.el.querySelector('#ad-max'), win: m.el.querySelector('#ad-win'), lock: m.el.querySelector('#ad-lockmin') };
  lim.max.value = st.data?.maxFailedLogins ?? 5; lim.win.value = st.data?.failWindowMinutes ?? 15; lim.lock.value = st.data?.lockoutMinutes ?? 15;
  const saveLimits = async () => {
    const r = await call('PUT', '/admin/settings', { maxFailedLogins: +lim.max.value, failWindowMinutes: +lim.win.value, lockoutMinutes: +lim.lock.value });
    if (!r.ok) { msg.textContent = r.data?.error || 'Could not save.'; return; }
    msg.textContent = 'Sign-in protection saved.';
  };
  Object.values(lim).forEach((el) => (el.onchange = saveLimits));
  const locks = m.el.querySelector('#ad-locks');
  const loadLocks = async () => {
    const r = await call('GET', '/admin/lockouts');
    locks.innerHTML = '';
    if (!r.ok || !r.data.length) return;
    for (const l of r.data) {
      const row = document.createElement('div');
      row.className = 'ad-lockrow';
      row.innerHTML = `<span>Locked: <b>${esc(l.name)}</b> (${l.kind}), ${l.minutes} min left</span><button class="btn sm" type="button">Unlock</button>`;
      row.querySelector('button').onclick = async () => { await call('DELETE', '/admin/lockouts?key=' + encodeURIComponent(l.key)); loadLocks(); };
      locks.appendChild(row);
    }
  };
  loadLocks();
  const add = m.el.querySelector('#ad-add');
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
