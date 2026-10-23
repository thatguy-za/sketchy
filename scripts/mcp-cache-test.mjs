// An assistant's request on a design too heavy to build within the time limit must not start from nothing every time: the build is
// saved as it goes, so each attempt carries on from the last, and a design the app already cached is read from it. Run with
// `npm run test:mcp-cache`.
process.env.SKETCHY_VERSION = 'test'; process.env.SKETCHY_MCP_SAVE_AFTER_MS = '150'; process.env.SKETCHY_MCP_SAVE_EVERY_MS = '150';
const { createPool } = await import('../mcp-pool.js');
const { bigDesign } = await import('./bench-brep.mjs');
const { initHeadless, evaluate } = await import('../src/headless.js');
const { clearKernelCache } = await import('../src/kernel.js');

const d = bigDesign();
const heavy = { name: 'Heavy', format: 'sketchy', ...JSON.parse(JSON.stringify(d)), params: [], appearance: {}, units: 'mm' };
const light = { name: 'Light', format: 'sketchy', features: [{ id: 'f1', type: 'primitive', name: 'Box1', params: { shape: 'box', sx: 10, sy: 10, sz: 10, radius: 0, pos: [0, 0, 0], op: 'new' } }], nextId: 2, params: [], appearance: {}, units: 'mm' };
const designs = { Heavy: heavy, Light: light };
const caches = new Map(), log = [];
const storage = {
  async list() { return []; },
  async read(u, n) { return designs[n] ? { obj: structuredClone(designs[n]), rev: 1 } : null; },
  async write() { return 2; },
  async readCache(u, n) { log.push('read ' + n); return caches.get(n) || null; },
  async writeCache(u, n, bytes) { const b = Buffer.from(bytes); if (b[0] !== 0x1f || b[1] !== 0x8b) return false; caches.set(n, b); log.push(`write ${n} ${b.length}`); return true; },
};
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };

// the answer a build from scratch gives, to compare with
await initHeadless(); clearKernelCache();
const t = performance.now(); const ref = evaluate(structuredClone(heavy)); const cold = performance.now() - t;
const refVol = Math.round(ref.result.bodies.reduce((a, b) => a + b.volume, 0)); clearKernelCache();
console.log(`  (a build from scratch takes ${cold.toFixed(0)} ms here)`);

// A fresh worker has to start the kernel inside the limit before it can build anything (about a second here), so the limit is that plus a
// part of a build: too little to finish in one attempt, enough to get somewhere.
const probe = createPool({ storage, size: 1, timeoutMs: 30000 });
let startup = 0; { const s0 = Date.now(); await probe.run('u', 'inspect_design', { design: 'Light' }, 'test').catch(() => null); startup = Date.now() - s0; probe.stop(); }
const limit = Math.round(startup + cold * 0.5);
const pool = createPool({ storage, size: 1, timeoutMs: limit, perUser: 3 });
const volOf = (r) => { try { const j = JSON.parse(r.content.find((c) => c.type === 'text').text); return Math.round((j.model.bodies || []).reduce((a, b) => a + (b.volume_mm3 || 0), 0)); } catch { return null; } };
try {
  let warm; for (let i = 0; i < 5 && !warm; i++) { try { warm = await pool.run('u', 'inspect_design', { design: 'Light' }, 'test'); } catch { /* the first call also starts the kernel */ } }
  check('the kernel is running', !!warm);
  check('a light design saves no cache (nothing was worth keeping)', caches.size === 0, JSON.stringify([...caches.keys()]));

  console.log(`Attempts on a design that needs about ${(cold / 1000).toFixed(1)} s, with a ${(limit / 1000).toFixed(1)} s limit (${(startup / 1000).toFixed(1)} s of it is the worker starting)`);
  let result = null, timeouts = 0, attempts = 0; const sizes = [];
  while (!result && attempts < 10) {
    attempts++; const a0 = Date.now();
    try { result = await pool.run('u', 'inspect_design', { design: 'Heavy' }, 'test'); console.log(`    attempt ${attempts}: finished in ${Date.now() - a0} ms`); }
    catch (e) { if (e.kind !== 'timeout') throw e; timeouts++; sizes.push(caches.get('Heavy')?.length || 0); console.log(`    attempt ${attempts}: stopped at the limit; saved ${((caches.get('Heavy')?.length || 0) / 1024).toFixed(0)} KB so far`); }
  }
  check('the design is built within a few attempts', !!result && attempts <= 6, `${attempts} attempts`);
  check('the first attempt did not finish (the premise)', timeouts >= 1, 'it finished at once: the machine is too fast for this limit');
  check('progress was saved by an attempt that was stopped', sizes.length === 0 || sizes[0] > 0, JSON.stringify(sizes));
  check('each stopped attempt left at least as much saved as the one before', sizes.every((s, i) => i === 0 || s >= sizes[i - 1]), JSON.stringify(sizes));
  check('the answer is the same as building from scratch', volOf(result) === refVol, `${volOf(result)} vs ${refVol}`);
  check('the finished build is saved for the next request and the app', caches.has('Heavy') && caches.get('Heavy').length > 1000);

  console.log('With the cache in place');
  const t1 = Date.now(); const again = await pool.run('u', 'inspect_design', { design: 'Heavy' }, 'test'); const ms = Date.now() - t1;
  check('the next request is answered well inside the limit', ms < limit, `${ms} ms against ${limit} ms`);
  check('and gives the same answer', volOf(again) === refVol, `${volOf(again)} vs ${refVol}`);
  console.log(`    ${ms} ms (from scratch: ${cold.toFixed(0)} ms)`);

  console.log('A damaged cache');
  caches.set('Heavy', Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
  // a different worker has to take it: stop the one that has the design in memory
  const lightFirst = await pool.run('u', 'inspect_design', { design: 'Light' }, 'test').catch(() => null); // makes the worker let go of Heavy
  let after = null, tries = 0; while (!after && tries < 10) { tries++; try { after = await pool.run('u', 'inspect_design', { design: 'Heavy' }, 'test'); } catch (e) { if (e.kind !== 'timeout') throw e; } }
  check('is ignored: the design still builds, from scratch if need be', !!after && volOf(after) === refVol, `${tries} tries, ${after && volOf(after)}`);
  check('and the light design was still fine', !!lightFirst);

  console.log('A different design');
  check('a request for another design does not use the first one\'s states', volOf(await pool.run('u', 'inspect_design', { design: 'Light' }, 'test')) !== refVol);
} finally { pool.stop(); }
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
