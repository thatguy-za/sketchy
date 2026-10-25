// Add-ins: small JavaScript packages that extend Sketchy (an importer or exporter for another file type, a command, a tool).
//
// Each running add-in lives in a sandbox: a worker inside a sandboxed iframe that the browser gives no address of its own. It has
// no network, cannot read the page, your cookies or your designs, and cannot call the server. The ONLY way out is a message to this
// file, which checks the add-in's permission for that call and hands back just what was asked for. Stopping an add-in removes the
// iframe, which ends everything it was doing, even a loop that never ends.
//
// (Fusion 360 add-ins are Python or C++ programs written for Autodesk's own API and cannot run here. Sketchy add-ins use the API below.)
import { validatePackage, PERMISSIONS } from '../addin-validate.js';

const CH = 'sketchy';
const METHOD_PERMISSION = { 'ui.pickFile': 'files.open', 'document.read': 'document.read', 'document.addBody': 'document.write', 'geometry.build': 'geometry', 'files.save': 'files.save' };
const TIMEOUT = { start: 30e3, invoke: 5 * 60e3 };
const MAX_CALLS_PER_SECOND = 400;
const MAX_BYTES = 64e6;

/**
 * @param o.runtime  the text of src/addin-runtime.js (what runs inside the sandbox)
 * @param o.hooks    what the app lets an add-in do: toast, confirm, form, pickFile, readDocument, addBody, buildGeometry, saveFile (all async)
 * @param o.frameSrc where the sandbox page is
 */
export function createAddinHost({ runtime, hooks, frameSrc = '/addin-sandbox.html', doc = globalThis.document }) {
  const running = new Map(); // id -> { pkg, frame, status, error, ready, pending, calls }
  const listeners = new Set();
  const changed = (id) => listeners.forEach((fn) => { try { fn(id); } catch { /* a listener must not break the host */ } });

  const frameOf = (e) => { for (const r of running.values()) if (r.frame.contentWindow === e.source) return r; return null; };

  const answer = (r, id, ok, value, error) => { try { r.frame.contentWindow?.postMessage({ ch: CH, type: 'reply', id, ok, ...(ok ? { value } : { error }) }, '*'); } catch { /* the frame went away */ } };

  /** What an add-in asked the app to do. Returns the answer, or throws a message for the add-in. */
  async function serve(r, method, p) {
    const need = METHOD_PERMISSION[method];
    if (need && !(r.pkg.manifest.permissions || []).includes(need)) throw new Error(`This add-in did not ask for the "${need}" permission, so it cannot do that.`);
    if (!p || typeof p !== 'object') throw new Error('Bad request');
    switch (method) {
      case 'ui.toast': hooks.toast(`${r.pkg.manifest.name}: ${String(p.text).slice(0, 300)}`, !!p.isError); return null;
      case 'ui.confirm': return !!(await hooks.confirm(String(p.text).slice(0, 500), { ok: typeof p.ok === 'string' ? p.ok.slice(0, 30) : undefined, danger: !!p.danger, title: r.pkg.manifest.name }));
      case 'ui.form': return hooks.form(cleanForm(p, r.pkg.manifest.name));
      case 'ui.pickFile': { const f = await hooks.pickFile({ accept: typeof p.accept === 'string' ? p.accept.replace(/[^A-Za-z0-9.,/*+-]/g, '').slice(0, 100) : '' }); return f ? { name: f.name, bytes: f.bytes } : null; }
      case 'document.read': return hooks.readDocument({ meshes: p.meshes !== false });
      case 'document.addBody': {
        if (!(p.verts instanceof Float32Array) || !(p.tris instanceof Uint32Array) || p.verts.length % 3 || p.tris.length % 3 || p.verts.length > 6e7 / 4 || p.tris.length > 6e7 / 4) throw new Error('addBody needs { name, verts: Float32Array, tris: Uint32Array }, within size limits');
        return hooks.addBody({ name: String(p.name || r.pkg.manifest.name).slice(0, 60), verts: p.verts, tris: p.tris });
      }
      case 'geometry.build': return hooks.buildGeometry(p.tree);
      case 'files.save': {
        const bytes = p.bytes instanceof Uint8Array || p.bytes instanceof ArrayBuffer ? p.bytes : typeof p.text === 'string' ? new TextEncoder().encode(p.text) : null;
        if (!bytes) throw new Error('files.save needs text or bytes');
        if ((bytes.byteLength ?? bytes.length) > MAX_BYTES) throw new Error('That file is too large to save');
        return hooks.saveFile({ name: String(p.name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 100), bytes, mime: typeof p.mime === 'string' ? p.mime.slice(0, 60) : 'application/octet-stream' });
      }
      default: throw new Error(`Unknown request "${String(method).slice(0, 40)}"`);
    }
  }

  /** The form an add-in asked for, cut down to what the app will show: short labels, known field types, bounded lists. */
  function cleanForm(p, title) {
    const fields = Array.isArray(p.fields) ? p.fields.slice(0, 40) : [];
    return {
      title: String(p.title || title).slice(0, 80), ok: typeof p.ok === 'string' ? p.ok.slice(0, 30) : 'OK', intro: typeof p.intro === 'string' ? p.intro.slice(0, 400) : '',
      fields: fields.filter((f) => f && typeof f.name === 'string' && /^[A-Za-z_$][\w$]{0,40}$/.test(f.name)).map((f) => ({
        name: f.name, label: String(f.label ?? f.name).slice(0, 80), type: ['number', 'text', 'bool', 'select'].includes(f.type) ? f.type : 'text',
        value: f.type === 'number' ? (Number.isFinite(f.value) ? f.value : 0) : f.type === 'bool' ? !!f.value : String(f.value ?? '').slice(0, 200),
        options: f.type === 'select' && Array.isArray(f.options) ? f.options.slice(0, 50).map((o) => (Array.isArray(o) ? [String(o[0]).slice(0, 80), String(o[1] ?? o[0]).slice(0, 80)] : [String(o).slice(0, 80), String(o).slice(0, 80)])) : undefined,
      })),
    };
  }

  const onMessage = (e) => {
    const r = frameOf(e);
    if (!r || e.origin !== 'null') return; // only the add-in's own sandboxed frame (which has no origin)
    const m = e.data;
    if (!m || m.ch !== CH) return;
    switch (m.type) {
      case 'frame-ready': r.frameReady?.(); break;
      case 'loaded': r.status = 'running'; r.ready?.resolve(); changed(r.pkg.manifest.id); break;
      case 'load-failed': case 'crash': { const msg = String(m.message || 'The add-in failed to start'); if (r.status === 'starting') { r.ready?.reject(new Error(msg)); } fail(r, msg); break; }
      case 'call': {
        const now = Date.now(); r.calls = (r.calls || []).filter((t) => now - t < 1000); r.calls.push(now);
        if (r.calls.length > MAX_CALLS_PER_SECOND) { fail(r, 'The add-in made too many requests at once and was stopped.'); break; }
        serve(r, m.method, m.params).then((v) => answer(r, m.id, true, v), (err) => answer(r, m.id, false, undefined, String(err && err.message || err).slice(0, 400)));
        break;
      }
      case 'result': { const p = r.pending.get(m.id); r.pending.delete(m.id); if (p) { clearTimeout(p.timer); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'The add-in failed')); } break; }
      default:
    }
  };
  doc?.defaultView?.addEventListener('message', onMessage);
  if (!doc && typeof addEventListener === 'function') addEventListener('message', onMessage);

  function fail(r, message) {
    r.status = 'failed'; r.error = message;
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    r.pending.clear();
    r.frame.remove();
    changed(r.pkg.manifest.id);
  }

  /** Start an add-in's sandbox (does nothing if it is already running). pkg: { manifest, files }. Resolves when its activate() has finished. */
  async function start(pkg) {
    const bad = validatePackage(pkg.manifest, pkg.files);
    if (bad) throw new Error(bad);
    const id = pkg.manifest.id, have = running.get(id);
    if (have && (have.status === 'running' || have.status === 'starting')) return have.readyPromise;
    if (have) have.frame.remove();
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: the frame has no origin, so no cookies, storage or access to the app
    frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('title', `Add-in: ${pkg.manifest.name}`);
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-10px;top:-10px;visibility:hidden';
    frame.src = frameSrc;
    const r = { pkg, frame, status: 'starting', error: '', pending: new Map(), calls: [] };
    r.readyPromise = new Promise((resolve, reject) => { r.ready = { resolve, reject }; });
    r.readyPromise.catch(() => {}); // the caller handles it; an unobserved rejection must not become a console error
    running.set(id, r); changed(id);
    const frameReady = new Promise((resolve) => { r.frameReady = resolve; });
    doc.body.appendChild(frame);
    const timer = setTimeout(() => { if (r.status === 'starting') { r.ready.reject(new Error('The add-in took too long to start.')); fail(r, 'The add-in took too long to start.'); } }, TIMEOUT.start);
    r.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    frameReady.then(() => frame.contentWindow.postMessage({ ch: CH, type: 'boot', runtime, manifest: pkg.manifest, main: pkg.manifest.main || 'main.js', files: pkg.files }, '*'));
    return r.readyPromise;
  }

  function stop(id) {
    const r = running.get(id); if (!r) return;
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The add-in was stopped.')); }
    r.pending.clear(); r.frame.remove(); running.delete(id); changed(id);
  }

  /** Run something the add-in registered (kind: command | importer | exporter) and get its answer. Starts the add-in first if needed. */
  async function invoke(pkg, kind, handler, payload, timeout = TIMEOUT.invoke) {
    await start(pkg);
    const r = running.get(pkg.manifest.id);
    if (!r || r.status !== 'running') throw new Error(r?.error || 'The add-in is not running.');
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => { r.pending.delete(id); stop(pkg.manifest.id); reject(new Error(`${pkg.manifest.name} did not finish in time and was stopped.`)); }, timeout);
      r.pending.set(id, { resolve, reject, timer });
      r.frame.contentWindow.postMessage({ ch: CH, type: 'invoke', id, kind, handler, payload }, '*');
    });
  }

  return {
    start, stop, invoke,
    status: (id) => running.get(id)?.status || 'stopped',
    error: (id) => running.get(id)?.error || '',
    isRunning: (id) => running.get(id)?.status === 'running',
    stopAll: () => [...running.keys()].forEach(stop),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** The plain-language list of what an add-in may do, for the permission lines in the dialog. */
export const describePermissions = (m) => (m.permissions || []).map((p) => PERMISSIONS[p] || p);

// ---------------------------------------------------------------------------------------- reading an add-in from files

/** Read a zip archive (stored or deflated entries) into { path: Uint8Array }. Only what an add-in package needs. */
export async function unzip(buffer, { maxFiles = 200, maxBytes = 20e6 } = {}) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That is not a zip file.');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  if (n > maxFiles) throw new Error('That zip has too many files.');
  const out = {}; let total = 0;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    total += usize; if (total > maxBytes) throw new Error('That zip is too large.');
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true), start = off + 30 + lnl + lel;
    const data = u8.subarray(start, start + csize);
    if (method === 0) out[name] = data.slice();
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const res = new Response(new Blob([data]).stream().pipeThrough(ds));
      out[name] = new Uint8Array(await res.arrayBuffer());
    } else throw new Error(`"${name}" uses a zip compression this reader does not support.`);
  }
  return out;
}

/**
 * Turn a chosen zip (or a set of loose files) into a package { manifest, files }. If everything sits inside one folder, that
 * folder is treated as the root. Throws a message that says what is wrong.
 */
export async function packageFromFiles(fileList) {
  const entries = {};
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) Object.assign(entries, await unzip(await f.arrayBuffer()));
    else entries[f.webkitRelativePath || f.name] = new Uint8Array(await f.arrayBuffer());
  }
  let names = Object.keys(entries).filter((n) => !/(^|\/)(__MACOSX|\.DS_Store)/.test(n));
  const mp = names.find((n) => /(^|\/)manifest\.json$/.test(n) && n.split('/').length <= 2);
  if (!mp) throw new Error('There is no manifest.json. An add-in needs one at its top level.');
  const root = mp.includes('/') ? mp.slice(0, mp.lastIndexOf('/') + 1) : '';
  let manifest; try { manifest = JSON.parse(new TextDecoder().decode(entries[mp])); } catch { throw new Error('manifest.json is not valid JSON.'); }
  const files = {};
  for (const n of names) { if (!n.startsWith(root) || n === mp) continue; try { files[n.slice(root.length)] = new TextDecoder('utf-8', { fatal: true }).decode(entries[n]); } catch { throw new Error(`"${n}" is not a text file. Add-ins can only hold text files.`); } }
  const bad = validatePackage(manifest, files);
  if (bad) throw new Error(bad);
  return { manifest, files };
}
