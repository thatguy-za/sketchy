// Worker thread: runs one MCP tool at a time against the modelling kernel. It has no file access of its own; reads and writes of
// designs go back to the main thread (which owns the storage rules, quotas and name checks) as messages.
import { parentPort } from 'node:worker_threads';
import { createTools } from './mcp-tools.js';

let H = null, n = 0;
const waiting = new Map();
const call = (op) => (...args) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); parentPort.postMessage({ type: 'storage', id, op, args }); });
const deps = { storage: { list: call('list'), read: call('read'), write: call('write') }, device: '' };
const tools = createTools(deps);

parentPort.on('message', async (m) => {
  if (m.type === 'storage-result') {
    const w = waiting.get(m.id); waiting.delete(m.id);
    if (w) m.error ? w.reject(new Error(m.error)) : w.resolve(m.value);
    return;
  }
  if (m.type !== 'run') return;
  try {
    if (!H) { H = await import('./src/headless.js'); await H.initHeadless(); }
    deps.device = m.device || '';
    const out = await tools[m.name](m.user, m.args, H);
    parentPort.postMessage({ type: 'done', id: m.id, out });
  } catch (e) {
    parentPort.postMessage({ type: 'done', id: m.id, error: e.message || String(e) });
  }
});
parentPort.postMessage({ type: 'ready' });
