// Times the exact (B-rep) kernel on a design of 40 features: a full rebuild, then an edit of the last feature and of a feature in the
// middle with the incremental cache, then the import of big meshes. `node scripts/bench-brep.mjs`. Not part of the test suites.
import { initHeadless, evaluate } from '../src/headless.js';
import { loadBrep } from '../src/backend-brep.js';
import { clearKernelCache } from '../src/kernel.js';
export function bigDesign(extra = 0) {
  const f = [{ id: 'base', type: 'primitive', name: 'Base', params: { shape: 'box', pos: [0, 0, 0], op: 'new', sx: 200, sy: 120, sz: 20, radius: 0 } }];
  for (let i = 0; i < 12; i++) f.push({ id: 'h' + i, type: 'hole', name: 'Hole' + i, params: { target: 'base', pos: [-80 + (i % 6) * 32, -30 + Math.floor(i / 6) * 60, 20], dir: [0, 0, 1], kind: i % 3 === 0 ? 'counterbore' : 'simple', diameter: 8, cbDia: 14, cbDepth: 4, through: true, depth: 8 } });
  for (let i = 0; i < 12; i++) {
    f.push({ id: 's' + i, type: 'sketch', name: 'Sketch' + i, params: { plane: 'XY', offset: 20, shapes: [{ t: 'rrect', x: -90 + i * 14, y: -10 + extra * 0, w: 10, h: 20, r: 2 }] } });
    f.push({ id: 'e' + i, type: 'extrude', name: 'Extrude' + i, params: { sketch: 's' + i, profiles: null, extent: 'distance', distance: 6 + (i === 11 ? extra : 0), op: 'join', target: 'base', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } });
  }
  f.push({ id: 'p', type: 'pattern', name: 'Pattern', params: { body: 'base', kind: 'linear', count: 2, spacing: [0, 150, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '' } });
  f.push({ id: 'm', type: 'mirror', name: 'Mirror', params: { body: 'base', plane: 'XZ', offset: 0, join: true } });
  f.push({ id: 'cy', type: 'primitive', name: 'Cyl', params: { shape: 'cylinder', pos: [0, 0, 20], op: 'new', radius: 10, height: 15 } });
  f.push({ id: 'hh', type: 'hole', name: 'Last', params: { target: 'base', pos: [0, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 5, through: false, depth: 6 + 0 } });
  return { features: f, params: [], units: 'mm', nextId: 1000 };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const time = (fn) => { const t = performance.now(); const r = fn(); return [Math.round(performance.now() - t), r]; };
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bench-brep.mjs')) {
await initHeadless();
await loadBrep();
const d = bigDesign();
console.log('features:', d.features.length);
for (const backend of ['brep']) {
  clearKernelCache();
  const [full] = time(() => evaluate(d, { cache: true }));
  const last = clone(d); last.features.at(-1).params.diameter = 6;
  const [tLast, r1] = time(() => evaluate(last, { cache: true }));
  const mid = clone(last); mid.features.find((x) => x.id === 'h5').params.diameter = 9;
  const [tMid, r2] = time(() => evaluate(mid, { cache: true }));
  clearKernelCache();
  const [tNo] = time(() => evaluate(mid, { cache: false }));
  console.log(backend.padEnd(5), `first build ${full} ms | no cache ${tNo} ms | edit last ${tLast} ms (replayed ${r1.result.stats?.steps}) | edit middle ${tMid} ms (replayed ${r2.result.stats?.steps})`, Object.keys(r2.result.errors).length ? 'ERRORS ' + JSON.stringify(r2.result.errors) : '');
}
  // imported meshes: a torus of n x m quads (2nm triangles, no two coplanar) sewn into a faceted solid
  const { encodeFloats } = await import('../src/kernel.js');
  const torus = (n, m) => { const P = (i, j) => { const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m; return [(20 + 5 * Math.cos(v)) * Math.cos(u), (20 + 5 * Math.cos(v)) * Math.sin(u), 5 * Math.sin(v)]; }; const s = []; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1); s.push(...a, ...b, ...e, ...b, ...c, ...e); } return new Float32Array(s); };
  for (const [n, m] of [[40, 20], [80, 40], [120, 60]]) {
    const soup = torus(n, m), doc2 = { features: [{ id: 'i', type: 'import', name: 'i', params: { data: encodeFloats(soup), tris: soup.length / 9 } }], params: [], units: 'mm', nextId: 9 };
    const [ms, r] = time(() => evaluate(doc2));
    console.log(`import ${soup.length / 9} triangles:`, Object.keys(r.result.errors).length ? 'refused: ' + Object.values(r.result.errors)[0].slice(0, 90) : `${ms} ms, ${r.result.bodies[0].faces.length} faces`);
  }
}
