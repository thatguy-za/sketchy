// The worker pool must stop a runaway design (time limit) and keep serving afterwards. Run with `npm run test:mcp-limits`.
import { createPool } from '../mcp-pool.js';

const designs = {
  Light: { name: 'Light', format: 'sketchy', features: [{ id: 'f1', type: 'primitive', name: 'Box1', params: { shape: 'box', sx: 10, sy: 10, sz: 10, radius: 0, pos: [0, 0, 0], op: 'new' } }], nextId: 2, params: [], appearance: {}, units: 'mm' },
  Heavy: { name: 'Heavy', format: 'sketchy', features: [
    { id: 'f1', type: 'primitive', name: 'Sphere1', params: { shape: 'sphere', r: 20, pos: [0, 0, 0], op: 'new' } },
    { id: 'f2', type: 'pattern', name: 'Pattern1', params: { body: 'f1', kind: 'linear', count: 4000, spacing: [1, 0, 0], axis: 'Z', angle: 360, path: '', face: null, countU: 3, countV: 2, spacingU: 20, spacingV: 20, op: 'join' } },
  ], nextId: 3, params: [], appearance: {}, units: 'mm' },
};
const storage = { async list() { return []; }, async read(u, n) { return designs[n] ? { obj: structuredClone(designs[n]), rev: 1 } : null; }, async write() { return 2; } };
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };

const pool = createPool({ storage, size: 1, timeoutMs: 1500, perUser: 2 }); // a short limit so the test is quick; the 4000-sphere pattern takes about 2 seconds
try {
  let light; for (let i = 0; i < 4 && !light; i++) { try { light = await pool.run('u', 'inspect_design', { design: 'Light' }, 'test'); } catch { /* the first call also starts the kernel, which can exceed a short limit */ } }
  check('a normal design builds in a worker', /Box1|volume/.test(JSON.stringify(light)) && !light.isError, JSON.stringify(light).slice(0, 200));
  const t0 = Date.now();
  let err = null; try { await pool.run('u', 'inspect_design', { design: 'Heavy' }, 'test'); } catch (e) { err = e; }
  const took = Date.now() - t0;
  check('a runaway design is stopped by the time limit', err?.kind === 'timeout' && took < 5000, `${err?.kind} after ${took} ms (${err?.message})`);
  const after = await pool.run('u', 'inspect_design', { design: 'Light' }, 'test');
  check('the pool still works afterwards', /volume/.test(JSON.stringify(after)), JSON.stringify(after).slice(0, 160));
  const slow = [pool.run('v', 'inspect_design', { design: 'Heavy' }, 't').catch((e) => e), pool.run('v', 'inspect_design', { design: 'Heavy' }, 't').catch((e) => e)];
  let busy = null; try { await pool.run('v', 'inspect_design', { design: 'Light' }, 't'); } catch (e) { busy = e; }
  check('one person cannot queue more than the per-person limit', busy?.kind === 'busy', String(busy?.kind));
  await Promise.all(slow);
} finally { pool.stop(); }
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
