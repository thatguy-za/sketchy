// Times what the person waits for, on the kernel side (the part that can be measured without a browser): rebuilds after typical edits
// on a 20 and a 41 feature design, opening a saved design, importing meshes by size, and the tessellation and sewing that follow.
// The browser-side numbers (first paint, interactive, orbit and drag frame rates) come from scripts/profile-ui-browser.js, which is
// pasted into the page console or run with the browser tool. `node scripts/profile-ui.mjs [--json]` prints a table.
import { initHeadless, evaluate } from '../src/headless.js';
import { clearKernelCache, encodeFloats } from '../src/kernel.js';
import { parseSTL } from '../src/stl.js';
import { parseOBJ } from '../src/importers.js';
import { repairSoup } from '../src/meshrepair.js';
import { bigDesign } from './bench-brep.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const now = () => performance.now();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = [];
const row = (group, what, ms, note = '') => { rows.push({ group, what, ms: Math.round(ms * 10) / 10, note }); };
const time = (fn, n = 3) => { const t = []; let r; for (let i = 0; i < n; i++) { const t0 = now(); r = fn(i); t.push(now() - t0); } return [med(t), r]; };

await initHeadless();

// ---- designs ---------------------------------------------------------------
const small = (() => { const d = bigDesign(); d.features = d.features.filter((f, i) => i < 27); return d; })(); // 27 features
for (const [name, d] of [['27 features', small], ['41 features', bigDesign()]]) {
  const ids = d.features.map((f) => f.id);
  const tweak = (doc, id) => { const f = doc.features.find((x) => x.id === id); const k = f.params.diameter !== undefined ? 'diameter' : f.params.distance !== undefined ? 'distance' : f.params.sx !== undefined ? 'sx' : null; if (k) f.params[k] += 1; return doc; };
  const target = (frac) => { const cands = d.features.filter((f) => ['hole', 'extrude', 'primitive'].includes(f.type)); return cands[Math.min(cands.length - 1, Math.floor(frac * cands.length))].id; };
  const [cold] = time(() => { clearKernelCache(); evaluate(d, { cache: true }); }, 3);
  row('rebuild ' + name, 'cold build (nothing cached)', cold);
  const json = JSON.stringify(d);
  const [open] = time(() => { clearKernelCache(); evaluate(JSON.parse(json), { cache: true }); }, 3);
  row('rebuild ' + name, `open a saved design (${(json.length / 1024).toFixed(0)} KB JSON parse + build)`, open);
  for (const [label, frac] of [['dimension of the first feature', 0], ['dimension of a middle feature', 0.5], ['dimension of the last feature', 1]]) {
    const times = [];
    for (let i = 0; i < 3; i++) { clearKernelCache(); evaluate(d, { cache: true }); const e = tweak(clone(d), target(frac)); const t0 = now(); const r = evaluate(e, { cache: true }); times.push(now() - t0); if (i === 0) row('rebuild ' + name, label + ' (steps replayed)', 0, String(r.result.stats?.steps)); }
    rows.pop(); row('rebuild ' + name, label, med(times), 'replayed ' + (() => { clearKernelCache(); evaluate(d, { cache: true }); return evaluate(tweak(clone(d), target(frac)), { cache: true }).result.stats?.steps; })() + ' of ' + d.features.length);
  }
  { // add a feature at the end, then undo it (the cache still holds the earlier state)
    const add = clone(d); add.features.push({ id: 'zz', type: 'hole', name: 'New hole', params: { target: 'base', pos: [10, 10, 20], dir: [0, 0, 1], kind: 'simple', diameter: 4, through: false, depth: 4 } });
    clearKernelCache(); evaluate(d, { cache: true });
    let t0 = now(); evaluate(add, { cache: true }); row('rebuild ' + name, 'add a hole at the end', now() - t0);
    t0 = now(); evaluate(d, { cache: true }); row('rebuild ' + name, 'undo it', now() - t0);
    t0 = now(); evaluate(add, { cache: true }); row('rebuild ' + name, 'redo it', now() - t0);
  }
}

// ---- a design of 100 separate bodies: an edit rebuilds only what depends on it
{
  const prim = (id, shape, params) => ({ id, type: 'primitive', name: id, params: { shape, pos: [0, 0, 0], op: 'new', ...params } });
  const f = []; for (let i = 0; i < 100; i++) f.push(prim('b' + i, i % 2 ? 'sphere' : 'box', i % 2 ? { radius: 8, pos: [(i % 10) * 20, Math.floor(i / 10) * 20, 0] } : { sx: 10, sy: 10, sz: 10, pos: [(i % 10) * 20, Math.floor(i / 10) * 20, 0] }));
  const d = { features: f, params: [], units: 'mm', nextId: 999 };
  const [cold] = time(() => { clearKernelCache(); evaluate(d, { cache: true }); }, 3);
  row('rebuild 100 separate bodies', 'cold build', cold);
  for (const [label, id] of [['dimension of the first body', 'b0'], ['dimension of a middle body', 'b51'], ['dimension of the last body', 'b99']]) {
    const times = []; let info = '';
    for (let i = 0; i < 3; i++) { clearKernelCache(); evaluate(d, { cache: true }); const e = clone(d); const fe = e.features.find((x) => x.id === id); fe.params[fe.params.radius ? 'radius' : 'sx'] += 1; const t0 = now(); const r = evaluate(e, { cache: true }); times.push(now() - t0); info = `built ${r.result.stats.steps}, taken from the last run ${r.result.stats.reused}`; }
    row('rebuild 100 separate bodies', label, med(times), info);
  }
}

// ---- imports ----------------------------------------------------------------
const torus = (n, m) => { const P = (i, j) => { const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m; return [(20 + 5 * Math.cos(v)) * Math.cos(u), (20 + 5 * Math.cos(v)) * Math.sin(u), 5 * Math.sin(v)]; }; const s = []; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1); s.push(...a, ...b, ...e, ...b, ...c, ...e); } return new Float32Array(s); };
const stlBytes = (soup) => { const n = soup.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf); dv.setUint32(80, n, true); for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, soup[t * 9 + k], true); return buf; };
const objText = (soup) => { const v = [], f = []; for (let t = 0; t < soup.length / 9; t++) { for (let k = 0; k < 3; k++) v.push(`v ${soup[t * 9 + k * 3]} ${soup[t * 9 + k * 3 + 1]} ${soup[t * 9 + k * 3 + 2]}`); f.push(`f ${t * 3 + 1} ${t * 3 + 2} ${t * 3 + 3}`); } return v.join('\n') + '\n' + f.join('\n'); };
for (const [n, m] of [[40, 20], [80, 40], [120, 60]]) {
  const soup = torus(n, m), tris = soup.length / 9, label = `import ${tris.toLocaleString()} triangles`;
  const bytes = stlBytes(soup), text = objText(soup);
  row(label, 'parse STL (binary)', time(() => parseSTL(bytes))[0]);
  row(label, 'parse OBJ', time(() => parseOBJ(text))[0]);
  row(label, 'repair check (weld, shells, holes)', time(() => repairSoup(soup), 1)[0]);
  const doc = { features: [{ id: 'i', type: 'import', name: 'i', params: { data: encodeFloats(soup), tris } }], params: [], units: 'mm', nextId: 9 };
  clearKernelCache();
  const t0 = now(); const r = evaluate(doc); const ms = now() - t0;
  row(label, 'sew into a solid and tessellate', ms, Object.keys(r.result.errors).length ? 'refused: ' + Object.values(r.result.errors)[0].slice(0, 60) : `${r.result.bodies[0].faces.length} faces`);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else { let g = ''; for (const r of rows) { if (r.group !== g) { g = r.group; console.log('\n' + g); } console.log('  ' + r.what.padEnd(58) + String(r.ms).padStart(9) + ' ms' + (r.note ? '   ' + r.note : '')); } }
