// The modelling kernel in a Web Worker, so a heavy rebuild does not freeze the page. The main thread sends the features and gets
// the bodies back. The kernel keeps its checkpoints here between requests (see kernel.js), so an edit near the end of a long
// timeline only replays the last few steps. A body whose shape did not change is not sent again: the page keeps its mesh by key.
//
// A rebuild is done in pieces (the first third of the features, then two thirds, then all), with a look at the message queue between
// the pieces. The checkpoints make the pieces cost no more than one pass, and a newer request that arrives meanwhile (a value being
// dragged or typed) abandons the old one at the next piece boundary instead of waiting for it to finish: the latest change wins.
import { rebuild, clearKernelCache } from './kernel.js';
import { loadBrep } from './backend-brep.js';

let ready = null, sent = new Set(); // keys of the bodies the page already holds from the last result
let latest = 0, chain = Promise.resolve();
const PIECES = 6;
const yieldToMessages = () => new Promise((r) => setTimeout(r, 0));

async function handle(m) {
  if (m.type === 'init') {
    ready = loadBrep({ locateFile: () => new URL(m.occtUrl, self.location.href).href }); // OpenCascade, fetched here in the worker (the browser caches the file)
    await ready;
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'clear') {
    clearKernelCache(); sent = new Set();
  } else if (m.type === 'rebuild') {
    await ready;
    await yieldToMessages(); // messages that arrived while the last rebuild ran are read first, so that only the newest one is built
    if (m.id !== latest) { self.postMessage({ type: 'superseded', id: m.id }); return; }
    if (m.resend) sent = new Set();
    const t0 = performance.now();
    try {
      const n = Math.min(m.count, m.features.length), pieces = n >= 12 ? PIECES : 1;
      for (let k = 1; k < pieces; k++) {
        rebuild(m.features, Math.round((n * k) / pieces), { ...m.opts, discard: true });
        await yieldToMessages();
        if (m.id !== latest) { self.postMessage({ type: 'superseded', id: m.id }); return; }
      }
      const r = rebuild(m.features, m.count, m.opts);
      const keys = new Set();
      const bodies = r.bodies.map((b) => { keys.add(b.key); return sent.has(b.key) ? { ...b, verts: null, tris: null } : b; });
      sent = keys;
      self.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, result: { ...r, bodies } });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    }
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'rebuild') latest = m.id; // noted at once, even while an older rebuild is between pieces
  chain = chain.then(() => handle(m)).catch((err) => console.error(err));
};
