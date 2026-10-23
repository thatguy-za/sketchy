// The modelling kernel in a Web Worker, so a heavy rebuild does not freeze the page. The main thread sends the features and gets
// the bodies back. The kernel keeps its checkpoints here between requests (see kernel.js), so an edit near the end of a long
// timeline only replays the last few steps. A body whose shape did not change is not sent again: the page keeps its mesh by key.
import { initKernel, rebuild, clearKernelCache } from './kernel.js';

let ready = null, sent = new Set(); // keys of the bodies the page already holds from the last result
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ready = initKernel({ locateFile: () => new URL(m.wasmUrl, self.location.href).href });
    await ready;
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'clear') {
    clearKernelCache(); sent = new Set();
  } else if (m.type === 'rebuild') {
    await ready;
    if (m.resend) sent = new Set();
    const t0 = performance.now();
    try {
      const r = rebuild(m.features, m.count, m.opts);
      const keys = new Set();
      const bodies = r.bodies.map((b) => { keys.add(b.key); return sent.has(b.key) ? { ...b, verts: null, tris: null } : b; });
      sent = keys;
      self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, result: { ...r, bodies } });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    }
  }
};
