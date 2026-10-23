// A small pool of worker threads that run the MCP tools which rebuild designs. A job that runs too long is killed and the worker
// replaced; a worker that runs out of memory dies alone instead of taking the server down. Jobs wait in a queue, with a per-person
// limit so one account can't fill it.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerFile = fileURLToPath(new URL('./mcp-worker.js', import.meta.url));
const STORAGE_OPS = new Set(['list', 'read', 'write', 'saveVersion', 'versions', 'readVersion', 'restoreVersion', 'undo', 'requests', 'requestDone', 'live', 'ui']); // all a worker may ask the main thread for
const fail = (kind, message) => Object.assign(new Error(message), { kind });

/**
 * @param {object} o  { storage, size = 2, timeoutMs = 20000, memoryMb = 512, perUser = 3, queueMax = 40 }
 * Limits cover the JavaScript heap and run time. The kernel's WebAssembly memory is outside the heap limit, so the time limit (which
 * kills the whole worker) is what bounds that, together with the size limits on designs and arguments.
 */
export function createPool({ storage, size = 2, timeoutMs = 20000, memoryMb = 512, perUser = 3, queueMax = 40 }) {
  const workers = []; // { w, busy, job }
  const queue = [];
  const perUserCount = new Map();
  let nextJob = 0;

  const spawn = () => {
    const slot = { w: new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } }), busy: false, job: null, ready: false };
    slot.w.on('message', async (m) => {
      if (m.type === 'ready') { slot.ready = true; return; }
      if (m.type === 'storage') {
        try { if (!STORAGE_OPS.has(m.op)) throw new Error('Unknown storage operation.'); slot.w.postMessage({ type: 'storage-result', id: m.id, value: await storage[m.op](...m.args) }); }
        catch (e) { slot.w.postMessage({ type: 'storage-result', id: m.id, error: e.message || String(e) }); }
        return;
      }
      if (m.type === 'done' && slot.job && slot.job.id === m.id) finish(slot, m.error ? { err: new Error(m.error) } : { out: m.out });
    });
    const die = (why) => {
      const job = slot.job;
      workers.splice(workers.indexOf(slot), 1);
      if (job) finish(slot, { err: fail(why === 'memory' ? 'memory' : 'crash', why === 'memory' ? 'That design needs more memory than an assistant request may use. Simplify it or work on it in the app.' : 'The modelling worker stopped unexpectedly. Try again.') }, true);
      if (workers.length < size) spawn();
      pump();
    };
    slot.w.on('error', (e) => die(/memory|heap/i.test(String(e?.code) + String(e?.message)) ? 'memory' : 'crash'));
    slot.w.on('exit', () => { if (workers.includes(slot)) die('crash'); });
    workers.push(slot);
    return slot;
  };

  function finish(slot, r, dead = false) {
    const job = slot.job; slot.job = null; slot.busy = false;
    if (!job) return;
    clearTimeout(job.timer);
    perUserCount.set(job.user, Math.max(0, (perUserCount.get(job.user) || 1) - 1));
    r.err ? job.reject(r.err) : job.resolve(r.out);
    if (!dead) pump();
  }
  function pump() {
    while (queue.length) {
      const slot = workers.find((s) => !s.busy);
      if (!slot) return;
      const job = queue.shift();
      slot.busy = true; slot.job = job;
      job.timer = setTimeout(() => { // too slow: stop the worker (this frees all of its memory) and start a fresh one
        const j = slot.job;
        workers.splice(workers.indexOf(slot), 1);
        slot.w.terminate();
        if (j) finish(slot, { err: fail('timeout', `That took longer than ${Math.round(timeoutMs / 1000)} seconds to rebuild and was stopped. The design is too heavy for an assistant request; simplify it or work on it in the app.`) }, true);
        if (workers.length < size) spawn();
        pump();
      }, timeoutMs);
      slot.w.postMessage({ type: 'run', id: job.id, user: job.user, name: job.name, args: job.args, device: job.device });
    }
  }
  for (let i = 0; i < size; i++) spawn();

  return {
    run(user, name, args, device) {
      if ((perUserCount.get(user) || 0) >= perUser) return Promise.reject(fail('busy', 'You already have several requests running. Wait for them to finish.'));
      if (queue.length >= queueMax) return Promise.reject(fail('busy', 'The server is busy. Try again in a moment.'));
      perUserCount.set(user, (perUserCount.get(user) || 0) + 1);
      return new Promise((resolve, reject) => { queue.push({ id: ++nextJob, user, name, args, device, resolve, reject, timer: null }); pump(); });
    },
    stop() { for (const s of workers) s.w.terminate(); workers.length = 0; },
  };
}
