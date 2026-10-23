// The saved kernel cache: write it, read it back in a fresh state, and check that opening a design from it gives the same bodies as
// building it from scratch, faster, and that a cache which does not fit (another build, an edited design, damaged data) never gives a
// wrong result. Run with `npm run test:cache-kernel`.
import { initHeadless, evaluate, resolveDoc, prebuild } from '../src/headless.js';
import { clearKernelCache, exportBrepCache, importBrepCache, cacheReach, rebuild } from '../src/kernel.js';
import { packCache, unpackCache } from '../src/cachefile.js';
import { bigDesign } from './bench-brep.mjs';

await initHeadless();
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + extra}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const d0 = bigDesign(); const feats0 = Array.isArray(d0) ? d0 : d0.features;
const design = (f = feats0) => ({ features: clone(f), params: [], units: 'mm', nextId: 900 });
const build = (doc) => { const t = performance.now(); const r = evaluate(doc, { cache: true }); return { r, ms: performance.now() - t }; };
const same = (a, b) => {
  const A = [...a.result.bodies].sort((x, y) => x.id.localeCompare(y.id)), B = [...b.result.bodies].sort((x, y) => x.id.localeCompare(y.id));
  if (A.length !== B.length) return `body count ${A.length} vs ${B.length}`;
  for (let i = 0; i < A.length; i++) {
    if (A[i].id !== B[i].id) return `id ${A[i].id} vs ${B[i].id}`;
    if (Math.abs(A[i].volume - B[i].volume) > 1e-6 * Math.max(1, A[i].volume)) return `volume ${A[i].volume} vs ${B[i].volume}`;
    if (A[i].bbox.min.some((v, k) => Math.abs(v - B[i].bbox.min[k]) > 1e-6) || A[i].bbox.max.some((v, k) => Math.abs(v - B[i].bbox.max[k]) > 1e-6)) return 'bounding box';
    if (A[i].faces?.length !== B[i].faces?.length) return `faces ${A[i].faces?.length} vs ${B[i].faces?.length}`;
  }
  const ea = Object.keys(a.result.errors).sort().join(), eb = Object.keys(b.result.errors).sort().join();
  return ea === eb ? '' : `errors ${ea} vs ${eb}`;
};
const KERNEL = 'test-1';

console.log('Writing and reading the cache');
clearKernelCache();
const cold = build(design());
check('the design builds', !Object.keys(cold.r.result.errors).length && cold.r.result.bodies.length > 0, JSON.stringify(cold.r.result.errors));
const data = exportBrepCache({ kernel: KERNEL });
check('there is something to save', !!data && data.cps.length >= 2 && data.shapes.length > 0, JSON.stringify(data && Object.keys(data)));
check('the last state and the one before it are kept', data.cps.some((c) => c.i === feats0.length) && data.cps.some((c) => c.i === feats0.length - 1));
check('only some states are kept (not one per feature)', data.cps.length < feats0.length / 2, `${data.cps.length} of ${feats0.length}`);
const bytes = await packCache(data);
console.log(`      ${data.cps.length} states, ${data.shapes.length} shapes, ${(bytes.length / 1048576).toFixed(2)} MB gzipped`);
check('it is gzip data', bytes[0] === 0x1f && bytes[1] === 0x8b);
check('it survives the round trip through gzip and JSON', JSON.stringify((await unpackCache(bytes)).feats) === JSON.stringify(data.feats));

clearKernelCache();
const back = await unpackCache(bytes);
let t = performance.now(); const ok = importBrepCache(back, { kernel: KERNEL }); const readMs = performance.now() - t;
check('the cache is read back', ok === true);
const warm = build(design());
check('opening from the cache gives the same bodies as building from scratch', same(cold.r, warm.r) === '', same(cold.r, warm.r));
console.log(`      from scratch ${cold.ms.toFixed(0)} ms, read ${readMs.toFixed(0)} ms + open ${warm.ms.toFixed(0)} ms`);
check('and is faster than building from scratch', readMs + warm.ms < cold.ms * 0.6, `${(readMs + warm.ms).toFixed(0)} vs ${cold.ms.toFixed(0)} ms`);

console.log('Editing after opening from the cache');
const edit = (idx, patch) => { const f = clone(feats0); Object.assign(f[idx].params, patch); return f; };
const lastIdx = feats0.length - 1;
for (const [label, idx, patch] of [['the last feature', lastIdx, { diameter: 7 }], ['a feature in the middle', 20, { diameter: 9 }], ['the first feature', 0, { sx: 180 }]]) {
  const pf = edit(idx, patch);
  if (!feats0[idx].params) continue;
  clearKernelCache(); importBrepCache(await unpackCache(bytes), { kernel: KERNEL });
  const viaCache = build(design(pf));
  clearKernelCache();
  const scratch = build(design(pf));
  check(`editing ${label}: same result as a build from scratch`, same(scratch.r, viaCache.r) === '', same(scratch.r, viaCache.r));
  console.log(`      ${label}: ${viaCache.ms.toFixed(0)} ms via the cache, ${scratch.ms.toFixed(0)} ms from scratch`);
}

console.log('A cache that does not fit');
clearKernelCache();
check('another build\'s cache is refused', importBrepCache(await unpackCache(bytes), { kernel: 'other' }) === false);
const after = build(design());
check('and the design still builds right afterwards', same(cold.r, after.r) === '', same(cold.r, after.r));
clearKernelCache();
const bad = await unpackCache(bytes); bad.cps[0].live[0].sh = 99999;
check('a cache pointing at a missing shape is refused', importBrepCache(bad, { kernel: KERNEL }) === false);
const bad2 = await unpackCache(bytes); bad2.shapes[0] = 'this is not a shape';
let threw = false, res2 = false; try { res2 = importBrepCache(bad2, { kernel: KERNEL }); } catch { threw = true; }
check('damaged shape data is refused without crashing', !threw && res2 === false);
check('a damaged cache leaves nothing behind', build(design()).r && same(cold.r, build(design()).r) === '');
check('data of the wrong kind is refused', [null, {}, { format: 1 }, { format: 2, kernel: KERNEL }, 'text', 7].every((x) => importBrepCache(x, { kernel: KERNEL }) === false));
clearKernelCache();
importBrepCache(await unpackCache(bytes), { kernel: KERNEL });
const other = clone(feats0).slice(0, 15).map((f) => ({ ...f, params: { ...f.params } }));
other[3].params.diameter = (other[3].params.diameter || 5) + 1;
const stale = build(design(other)); clearKernelCache(); const fresh = build(design(other));
check('a cache from a longer or different design is reused only where it fits', same(fresh.r, stale.r) === '', same(fresh.r, stale.r));

console.log('A build that was cut short');
clearKernelCache();
const resolved = resolveDoc(design()).feats;
rebuild(resolved, 24, { cache: true, discard: true }); // a build that got 24 features in before it was stopped
const partial = exportBrepCache({ kernel: KERNEL });
check('what a build reached is saved', !!partial && partial.cps[0].i === 24 && partial.out.length === 24, JSON.stringify(partial && partial.cps.map((c) => c.i)));
clearKernelCache();
check('and read back', importBrepCache(await unpackCache(await packCache(partial)), { kernel: KERNEL }) === true);
check('the cache knows how far it reaches into the design', cacheReach(resolved, null) === 24, String(cacheReach(resolved, null)));
check('but not into one that differs before that point', (() => { const f = clone(resolved); f[10].params = { ...f[10].params, diameter: 99 }; return cacheReach(f, null) <= 10; })());
const resumed = build(design());
check('finishing from it gives the same bodies as building from scratch', same(cold.r, resumed.r) === '', same(cold.r, resumed.r));
console.log(`      ${resumed.ms.toFixed(0)} ms from the partial cache, ${cold.ms.toFixed(0)} ms from scratch`);
clearKernelCache();
const pieces = []; await prebuild(design(), { onPiece: (k, total) => pieces.push([k, total]) });
check('a design is built in pieces, each of which can be saved', pieces.length > 1 && pieces.at(-1)[0] === pieces.at(-1)[1], JSON.stringify(pieces));
check('and the pieces add up to the same design', same(cold.r, build(design()).r) === '');
clearKernelCache();
importBrepCache(await unpackCache(await packCache(partial)), { kernel: KERNEL });
const fromPartial = []; const info = await prebuild(design(), { onPiece: (k, total) => fromPartial.push(k) });
check('starting from a partial cache, only the rest is built', info.from === 24 && info.features === feats0.length, JSON.stringify(info));

clearKernelCache();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
