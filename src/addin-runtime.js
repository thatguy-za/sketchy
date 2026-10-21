// This file runs INSIDE an add-in's sandbox (a module worker in a sandboxed iframe with no network and no access to the app's
// page, cookies or storage). It is sent to the sandbox as text by src/addins.js. It gives the add-in's main module the `sketchy`
// object and carries calls between the add-in and the app. Everything the add-in can do goes through the app, which checks the
// add-in's permissions on every call.

const CH = 'sketchy';
const handlers = { command: new Map(), importer: new Map(), exporter: new Map() };
const pending = new Map();
let seq = 0, manifest = null;
const post = (m) => postMessage({ ch: CH, ...m });
const call = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); post({ type: 'call', id, method, params }); });

const sketchy = {
  get manifest() { return manifest; },
  ui: {
    toast: (text, isError = false) => call('ui.toast', { text: String(text).slice(0, 300), isError: !!isError }),
    confirm: (text, opts = {}) => call('ui.confirm', { text: String(text).slice(0, 500), ok: opts.ok, danger: !!opts.danger }),
    /** Ask the person for values. fields: [{ name, label, type: 'number'|'text'|'bool'|'select', value, options: [[value, label]] }]. Resolves an object, or null if cancelled. */
    form: (spec) => call('ui.form', spec),
    /** Ask the person to choose a file. Resolves { name, bytes } or null. Needs "files.open". */
    pickFile: (opts = {}) => call('ui.pickFile', { accept: opts.accept || '' }),
  },
  document: {
    /** The open design: { name, units, parameters, bodies: [{ id, name, color, verts, tris }] }. Needs "document.read". */
    read: (opts = {}) => call('document.read', { meshes: opts.meshes !== false }),
    /** Add a mesh as a new body: { name, verts, tris }. Needs "document.write". */
    addBody: (body) => call('document.addBody', body),
  },
  geometry: {
    /** Build a tree of solids (see src/csg-service.js) and get { verts, tris, volume } back, or null if it is empty. Needs "geometry". */
    build: (tree) => call('geometry.build', { tree }),
  },
  files: {
    /** Save a file to the person's computer: { name, text | bytes, mime }. Needs "files.save". */
    save: (file) => call('files.save', file),
  },
  /** Register what an add-in contributes: kind is 'command', 'importer' or 'exporter'; id matches the manifest. */
  on(kind, id, fn) {
    if (!handlers[kind] || typeof id !== 'string' || typeof fn !== 'function') throw new Error('sketchy.on(kind, id, handler): kind must be command, importer or exporter');
    handlers[kind].set(id, fn);
  },
};

// ---- loading the add-in's files: relative imports between its own files are pointed at blob addresses made here
const urls = new Map(), loading = new Set();
const norm = (from, rel) => {
  const parts = from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) { if (seg === '.' || seg === '') continue; if (seg === '..') { if (!parts.length) throw new Error(`"${rel}" climbs out of the add-in`); parts.pop(); } else parts.push(seg); }
  return parts.join('/');
};
function moduleUrl(path, files) {
  if (urls.has(path)) return urls.get(path);
  if (loading.has(path)) throw new Error(`The add-in's files import each other in a circle (${path}). Break the cycle.`);
  if (!(path in files)) throw new Error(`The add-in imports "${path}", which is not in the package.`);
  loading.add(path);
  const src = files[path].replace(/((?:\bfrom|\bimport)\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, pre, q, spec) => `${pre}${q}${moduleUrl(norm(path, spec), files)}${q}`)
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, pre, q, spec) => `${pre}${q}${moduleUrl(norm(path, spec), files)}${q}`);
  loading.delete(path);
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  urls.set(path, url);
  return url;
}

onmessage = async (e) => {
  const m = e.data;
  if (!m || m.ch !== CH) return;
  if (m.type === 'boot') {
    manifest = m.manifest;
    try {
      const mod = await import(moduleUrl(m.main, m.files));
      if (typeof mod.activate !== 'function') throw new Error(`${m.main} must export a function named activate(sketchy)`);
      await mod.activate(sketchy);
      post({ type: 'loaded' });
    } catch (err) { post({ type: 'load-failed', message: String(err && err.message || err).slice(0, 400) }); }
  } else if (m.type === 'reply') {
    const p = pending.get(m.id); pending.delete(m.id);
    if (p) m.ok ? p.resolve(m.value) : p.reject(new Error(m.error || 'The app refused that'));
  } else if (m.type === 'invoke') {
    const fn = handlers[m.kind]?.get(m.handler);
    if (!fn) return post({ type: 'result', id: m.id, ok: false, error: `This add-in has no ${m.kind} called "${m.handler}"` });
    try { post({ type: 'result', id: m.id, ok: true, value: await fn(m.payload) }); }
    catch (err) { post({ type: 'result', id: m.id, ok: false, error: String(err && err.message || err).slice(0, 600) }); }
  }
};
