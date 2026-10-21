// Where add-ins come from and what the person has chosen about them.
//   built-in: shipped with Sketchy under /addins/ (listed in /addins/index.json), always available, never editable
//   installed: put there by the person (a zip or a folder), stored on their account on the server, or in this browser without a server
// What is stored per person, in this browser: which add-ins are switched on and which start with Sketchy.
import { call, acct } from './account.js';
import { validatePackage } from '../addin-validate.js';

const stateKey = () => 'sketchy.addins.' + (acct.user || '');
const readState = () => { try { const o = JSON.parse(localStorage.getItem(stateKey()) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const writeState = (s) => { try { localStorage.setItem(stateKey(), JSON.stringify(s)); } catch { /* storage unavailable */ } };

// no server: installed add-ins live in this browser (localStorage, text only, a few MB at most)
const localKey = () => 'sketchy.addins.installed.' + (acct.user || '');
const readLocal = () => { try { const o = JSON.parse(localStorage.getItem(localKey()) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

/** Everything available: built-in and installed, each { manifest, builtin, enabled, runOnStartup, files? }. Files are loaded on demand (see packageOf). */
export async function listAddins() {
  const state = readState(), out = [];
  let index = []; try { const r = await fetch('/addins/index.json', { cache: 'no-cache' }); if (r.ok) index = (await r.json()).addins || []; } catch { /* no built-ins reachable */ }
  for (const b of index) {
    try {
      const m = await (await fetch(`/addins/${b.id}/manifest.json`, { cache: 'no-cache' })).json();
      out.push({ manifest: m, builtin: true, files: b.files, enabled: state[m.id]?.enabled ?? true, runOnStartup: !!(state[m.id]?.runOnStartup ?? m.runOnStartup) });
    } catch { /* a built-in that cannot be read is left out */ }
  }
  let allowed = true;
  if (acct.server) {
    const r = await call('GET', '/addins');
    if (r.ok) { allowed = r.data.enabled !== false; for (const a of r.data.addins || []) out.push({ manifest: a.manifest, builtin: false, enabled: state[a.manifest.id]?.enabled ?? true, runOnStartup: !!state[a.manifest.id]?.runOnStartup }); }
  } else for (const p of Object.values(readLocal())) out.push({ manifest: p.manifest, builtin: false, enabled: state[p.manifest.id]?.enabled ?? true, runOnStartup: !!state[p.manifest.id]?.runOnStartup });
  return { addins: out, canInstall: allowed };
}

/** The files of an add-in as { manifest, files }. */
export async function packageOf(entry) {
  if (entry.builtin) {
    const files = {};
    for (const f of entry.files || []) { if (f === 'manifest.json') continue; const r = await fetch(`/addins/${entry.manifest.id}/${f}`, { cache: 'no-cache' }); if (!r.ok) throw new Error(`Could not load ${f}`); files[f] = await r.text(); }
    return { manifest: entry.manifest, files };
  }
  if (acct.server) { const r = await call('GET', '/addins/' + encodeURIComponent(entry.manifest.id)); if (!r.ok) throw new Error(r.data?.error || 'Could not load the add-in'); return { manifest: r.data.manifest, files: r.data.files }; }
  const p = readLocal()[entry.manifest.id]; if (!p) throw new Error('Could not find the add-in'); return p;
}

export async function installAddin(pkg) {
  const bad = validatePackage(pkg.manifest, pkg.files); if (bad) throw new Error(bad);
  if (acct.server) {
    const r = await call('PUT', '/addins/' + encodeURIComponent(pkg.manifest.id), pkg);
    if (!r.ok) throw new Error(r.data?.error || 'The server did not accept the add-in');
  } else {
    const all = readLocal(); all[pkg.manifest.id] = pkg;
    try { localStorage.setItem(localKey(), JSON.stringify(all)); } catch { throw new Error('This browser has no room to keep the add-in.'); }
  }
}
export async function removeAddin(id) {
  if (acct.server) await call('DELETE', '/addins/' + encodeURIComponent(id));
  else { const all = readLocal(); delete all[id]; localStorage.setItem(localKey(), JSON.stringify(all)); }
  const s = readState(); delete s[id]; writeState(s);
}
export function setAddinState(id, patch) { const s = readState(); s[id] = { ...(s[id] || {}), ...patch }; writeState(s); }
