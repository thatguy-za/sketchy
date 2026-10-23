// Worker thread: runs one MCP tool at a time against the modelling kernel. It has no file access of its own; reads and writes of
// designs go back to the main thread (which owns the storage rules, quotas and name checks) as messages.
import { parentPort } from 'node:worker_threads';
import { createTools } from './mcp-tools.js';

// A request that has to build a heavy design does not start from nothing. The design's saved kernel cache (written by the app, or by an
// earlier request) is read first, the build runs in pieces from where that cache has it, and what a long build reached is saved as it goes:
// a request stopped at the time limit leaves its progress behind, so the next attempt carries on from there instead of starting over.
const KERNEL = process.env.SKETCHY_VERSION || 'dev'; // a cache is only read by the build that wrote it
const SAVE_AFTER_MS = +process.env.SKETCHY_MCP_SAVE_AFTER_MS || 3000; // a build that has taken this long is worth saving
const SAVE_EVERY_MS = +process.env.SKETCHY_MCP_SAVE_EVERY_MS || 5000;
const NO_BUILD = new Set(['list_designs', 'create_design', 'list_requests', 'complete_request', 'get_live_context', 'show_in_app', 'list_versions', 'save_version', 'restore_version', 'describe_feature_types', 'describe_sketch']);
let H = null, K = null, C = null, HC = null, held = '', n = 0;
const waiting = new Map();
const call = (op) => (...args) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); parentPort.postMessage({ type: 'storage', id, op, args }); });
const OPS = ['list', 'read', 'write', 'saveVersion', 'versions', 'readVersion', 'restoreVersion', 'undo', 'requests', 'requestDone', 'live', 'ui', 'readCache', 'writeCache'];
const deps = { storage: Object.fromEntries(OPS.map((op) => [op, call(op)])), device: '' };
const tools = createTools(deps);

/** Have the kernel hold the design's finished states, so that the tool's own evaluate only draws them. */
async function ensureBuilt(user, name) {
  const got = await deps.storage.read(user, name).catch(() => null);
  if (!got) return;
  const doc = got.obj, key = user + '\u0000' + name, t0 = performance.now();
  if (held !== key) { // another design than the last one: start from its saved cache, if there is one
    K.clearKernelCache(); held = key;
    try { const bytes = await deps.storage.readCache(user, name); if (bytes) K.importBrepCache(await C.unpackCache(bytes), { kernel: KERNEL }); } catch { /* none, or none that can be read: build as usual */ }
  }
  let lastSave = performance.now();
  const save = async () => {
    try { const d = K.exportBrepCache({ kernel: KERNEL }); if (d) await deps.storage.writeCache(user, name, await C.packCache(d)); } catch { /* it is only a convenience */ }
    lastSave = performance.now();
  };
  await H.prebuild(doc, { onPiece: async (k, total) => { const now = performance.now(); if (k < total && now - t0 > SAVE_AFTER_MS && now - lastSave > SAVE_EVERY_MS) await save(); } });
  if (performance.now() - t0 > SAVE_AFTER_MS) await save(); // it cost real time: the next request, and the app, start from here
}

parentPort.on('message', async (m) => {
  if (m.type === 'storage-result') {
    const w = waiting.get(m.id); waiting.delete(m.id);
    if (w) m.error ? w.reject(new Error(m.error)) : w.resolve(m.value);
    return;
  }
  if (m.type !== 'run') return;
  try {
    if (!H) {
      H = await import('./src/headless.js'); K = await import('./src/kernel.js'); C = await import('./src/cachefile.js'); await H.initHeadless();
      HC = { ...H, evaluate: (doc, o = {}) => H.evaluate(doc, { cache: true, ...o }) }; // the tools' own builds take the states the kernel holds (an export that needs the shapes still builds fresh)
    }
    deps.device = m.device || '';
    const name = m.args && typeof m.args.design === 'string' ? m.args.design : null;
    if (name && !NO_BUILD.has(m.name)) { try { await ensureBuilt(m.user, name); } catch (e) { held = ''; K.clearKernelCache(); } } // if this fails the tool builds the design itself and reports what is wrong
    const out = await tools[m.name](m.user, m.args, HC);
    parentPort.postMessage({ type: 'done', id: m.id, out });
  } catch (e) {
    parentPort.postMessage({ type: 'done', id: m.id, error: e.message || String(e) });
  }
});
parentPort.postMessage({ type: 'ready' });
