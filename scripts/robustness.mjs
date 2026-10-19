// Edit-robustness checks: build a design, edit an EARLY feature (resize, move, reorder, suppress), and check that the later
// features (fillets, chamfers, holes, shells, sketches on faces) still find their geometry and the result is sensible.
// Run with `npm run test:robustness`.
import { initHeadless, evaluate } from '../src/headless.js';
import { findEdgeChains, edgeRef } from '../src/edges.js';
import { planarFace } from '../src/edges.js';
import { findFaceTri, rebuild, clearKernelCache } from '../src/kernel.js';
import { findSkins } from '../src/skins.js';
import { buildBVH, raycastBVH } from '../src/bvh.js';
import { clusterMesh } from '../src/lod.js';

await initHeadless();
let failed = 0, passed = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const prim = (id, shape, params, extra = {}) => ({ id, type: 'primitive', name: id, params: { shape, pos: [0, 0, 0], op: 'new', ...params, ...extra } });
const bodyOf = (res, id) => res.result.bodies.find((b) => b.id === id) || res.result.bodies[0];
const mesh = (b) => ({ V: b.verts, T: b.tris });
const doc = (features) => ({ features, params: [], units: 'mm', nextId: 100 });

/** Edge chains of a body that satisfy a test on their points. */
function edgesWhere(res, bid, test) {
  const b = bodyOf(res, bid);
  return findEdgeChains(b.verts, 3, b.tris).filter((c) => test(c.pts)).map((c) => edgeRef(b.id, c));
}
/** A planar face reference {point, normal} for the face with the given normal and extreme coordinate along it. */
function faceRef(res, bid, normal, pick = 'max') {
  const b = bodyOf(res, bid), { V, T } = mesh(b);
  let best = null;
  for (let i = 0; i < T.length / 3; i++) {
    const a = [0, 1, 2].map((k) => V[T[i * 3] * 3 + k]), c = [0, 1, 2].map((k) => V[T[i * 3 + 1] * 3 + k]), d = [0, 1, 2].map((k) => V[T[i * 3 + 2] * 3 + k]);
    const u = c.map((v, k) => v - a[k]), w = d.map((v, k) => v - a[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n);
    if (l < 1e-9) continue;
    const nn = n.map((v) => v / l);
    if (nn[0] * normal[0] + nn[1] * normal[1] + nn[2] * normal[2] < 0.999) continue;
    const off = a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2];
    const ctr = a.map((v, k) => (v + c[k] + d[k]) / 3);
    if (!best || (pick === 'max' ? off > best.off : off < best.off)) best = { off, point: ctr.map((v) => +v.toFixed(3)) };
  }
  return best && { point: best.point, normal };
}
const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const close = (a, b, abs = 1) => Math.abs(a - b) <= abs; // absolute tolerance, for volume differences
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const errs = (res) => Object.entries(res.result.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
const set = (d, id, patch) => { const f = d.features.find((x) => x.id === id); f.params = { ...f.params, ...patch }; return d; };

function scenario(title, fn) { console.log(title); try { fn(); } catch (e) { failed++; console.log('  FAIL threw: ' + e.stack.split('\n').slice(0, 3).join(' | ')); } }

// ------------------------------------------------------------------
scenario('Fillet on the top edges, then resize the box', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const r0 = evaluate(base);
  const edges = edgesWhere(r0, 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3));
  check('picked 4 top edges', edges.length === 4, String(edges.length));
  const d = doc([...base.features, { id: 'fil', type: 'fillet', name: 'Fillet', params: { edges, radius: 3, tangent: false, variable: false } }]);
  const v0 = bodyOf(evaluate(d), 'box').volume;
  for (const [label, patch] of [['wider', { sx: 60 }], ['deeper', { sy: 45 }], ['taller', { sz: 35 }], ['shorter', { sz: 12 }], ['all three', { sx: 55, sy: 38, sz: 26 }]]) {
    const r = evaluate(set(clone(d), 'box', patch));
    const b = bodyOf(r, 'box'), p = { sx: 40, sy: 30, sz: 20, ...patch };
    const full = p.sx * p.sy * p.sz, lost = (4 - Math.PI) * 9 / 4 * 0 + (1 - Math.PI / 4) * 9 * (2 * p.sx + 2 * p.sy);
    check(`${label}: fillet still applied`, !errs(r) && approx(b.volume, full - lost, 0.02), errs(r) || `volume ${b.volume.toFixed(0)} vs ${(full - lost).toFixed(0)}`);
  }
  check('baseline has a fillet', v0 < 40 * 30 * 20);
});

scenario('Chamfer on vertical edges, then resize', () => {
  const base = doc([prim('box', 'box', { sx: 30, sy: 30, sz: 20, radius: 0 })]);
  const r0 = evaluate(base);
  const edges = edgesWhere(r0, 'box', (p) => Math.abs(p[0][0] - p[1][0]) < 1e-3 && Math.abs(p[0][1] - p[1][1]) < 1e-3);
  check('picked 4 vertical edges', edges.length === 4, String(edges.length));
  const d = doc([...base.features, { id: 'ch', type: 'chamfer', name: 'Chamfer', params: { edges, distance: 2, tangent: false } }]);
  for (const patch of [{ sx: 50 }, { sz: 40 }, { sx: 45, sy: 35 }]) {
    const r = evaluate(set(clone(d), 'box', patch));
    check(`resize ${JSON.stringify(patch)}`, !errs(r) && r.result.bodies.length === 1, errs(r));
  }
});

scenario('Hole on a top face, then change the height', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 40, sz: 20, radius: 0 })]);
  const d = doc([...base.features, { id: 'h', type: 'hole', name: 'Hole', params: { target: 'box', pos: [0, 0, 20], face: { id: 'box', point: [0, 0, 20], normal: [0, 0, 1] }, dir: [0, 0, 1], kind: 'simple', diameter: 6, through: false, depth: 8 } }]);
  const r0 = evaluate(d), b0 = bodyOf(r0, 'box');
  const hv = Math.PI * 9 * 8;
  check('baseline hole removes material', approx(40 * 40 * 20 - b0.volume, hv, 0.05), `removed ${(32000 - b0.volume).toFixed(0)} expected ${hv.toFixed(0)}`);
  for (const [label, patch] of [['taller', { sz: 35 }], ['shorter', { sz: 12 }]]) {
    const r = evaluate(set(clone(d), 'box', patch)), b = bodyOf(r, 'box');
    const removed = 40 * 40 * (patch.sz) - b.volume;
    const b2 = bodyOf(r, 'box'); let open = false; for (let i = 0; i < b2.verts.length / 3; i++) if (Math.hypot(b2.verts[i * 3], b2.verts[i * 3 + 1]) < 3.05 && Math.abs(b2.verts[i * 3 + 2] - patch.sz) < 1e-3) open = true;
    check(`hole follows the top face when ${label}`, !errs(r) && open && approx(removed, hv, 0.05), errs(r) || `open=${open} removed ${removed.toFixed(0)} expected ${hv.toFixed(0)}`);
  }
});

scenario('Shell with the top face open, then resize', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const top = faceRef(evaluate(base), 'box', [0, 0, 1]);
  const d = doc([...base.features, { id: 'sh', type: 'shell', name: 'Shell', params: { body: 'box', thickness: 2, open: [{ ...top, id: 'box' }], side: 'inside' } }]);
  const r0 = evaluate(d);
  check('baseline shelled', !errs(r0) && bodyOf(r0, 'box').volume < 40 * 30 * 20 * 0.5, errs(r0));
  for (const patch of [{ sz: 35 }, { sx: 60 }, { sz: 12, sy: 20 }]) {
    const r = evaluate(set(clone(d), 'box', patch)), b = bodyOf(r, 'box'), p = { sx: 40, sy: 30, sz: 20, ...patch };
    const exp = p.sx * p.sy * p.sz - (p.sx - 4) * (p.sy - 4) * (p.sz - 2);
    check(`open top follows ${JSON.stringify(patch)}`, !errs(r) && approx(b.volume, exp, 0.03), errs(r) || `volume ${b.volume.toFixed(0)} expected ${exp.toFixed(0)}`);
  }
});

scenario('Sketch on a face, extrude, then change the base height', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 40, sz: 20, radius: 0 })]);
  const top = faceRef(evaluate(base), 'box', [0, 0, 1]);
  const sk = { id: 'sk', type: 'sketch', name: 'Sketch', params: { plane: 'custom', offset: 0, origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0], faceRef: { ...top, id: 'box' }, shapes: [{ t: 'rect', x: 10, y: 10, w: 10, h: 10 }] } };
  const ex = { id: 'ex', type: 'extrude', name: 'Extrude', params: { sketch: 'sk', profiles: null, extent: 'distance', distance: 5, thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, op: 'join', target: 'box' } };
  const d = doc([...base.features, sk, ex]);
  const r0 = evaluate(d);
  check('baseline boss added', !errs(r0) && close(bodyOf(r0, 'box').volume, 40 * 40 * 20 + 500, 5), errs(r0));
  for (const [label, patch] of [['taller', { sz: 35 }], ['shorter', { sz: 12 }]]) {
    const r = evaluate(set(clone(d), 'box', patch)), b = bodyOf(r, 'box');
    check(`boss stays on the top face when ${label}`, !errs(r) && r.result.bodies.length === 1 && close(b.volume, 40 * 40 * patch.sz + 500, 5), errs(r) || `bodies ${r.result.bodies.length} volume ${b.volume.toFixed(0)}`);
  }
});

scenario('Fillet the edges of a boss, then edit the base', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 40, sz: 10, radius: 0 })]);
  const top = faceRef(evaluate(base), 'box', [0, 0, 1]);
  const sk = { id: 'sk', type: 'sketch', name: 'Sketch', params: { plane: 'custom', offset: 0, origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0], faceRef: { ...top, id: 'box' }, shapes: [{ t: 'rect', x: 10, y: 10, w: 10, h: 10 }] } };
  const ex = { id: 'ex', type: 'extrude', name: 'Extrude', params: { sketch: 'sk', profiles: null, extent: 'distance', distance: 15, thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, op: 'join', target: 'box' } };
  const d0 = doc([...base.features, sk, ex]);
  const r0 = evaluate(d0);
  const edges = edgesWhere(r0, 'box', (p) => p.length === 2 && Math.abs(p[0][0] - p[1][0]) < 1e-3 && Math.abs(p[0][1] - p[1][1]) < 1e-3 && Math.max(p[0][2], p[1][2]) > 24.9);
  check('found the boss edges', edges.length === 4, String(edges.length));
  const d = doc([...d0.features, { id: 'f', type: 'fillet', name: 'Fillet', params: { edges, radius: 2, tangent: false, variable: false } }]);
  check('baseline fillet ok', !errs(evaluate(d)), errs(evaluate(d)));
  for (const patch of [{ sz: 16 }, { sx: 60 }, { sz: 6, sy: 50 }]) {
    const r = evaluate(set(clone(d), 'box', patch));
    check(`base ${JSON.stringify(patch)}`, !errs(r) && r.result.bodies.length === 1, errs(r));
  }
});

scenario('Sketch on a side face, then widen the box', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 40, sz: 20, radius: 0 })]);
  const side = faceRef(evaluate(base), 'box', [1, 0, 0]);
  const sk = { id: 'sk', type: 'sketch', name: 'Sketch', params: { plane: 'custom', offset: 0, origin: [20, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0], faceRef: { ...side, id: 'box' }, shapes: [{ id: 's1', t: 'rect', x: -5, y: 5, w: 10, h: 10 }] } };
  const ex = { id: 'ex', type: 'extrude', name: 'Extrude', params: { sketch: 'sk', profiles: null, extent: 'distance', distance: 5, thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, op: 'join', target: 'box', taper: 0, twist: 0, scaleTop: 1 } };
  const d = doc([...base.features, sk, ex]);
  const r0 = evaluate(d);
  check('baseline side boss', !errs(r0) && close(bodyOf(r0, 'box').volume, 32000 + 500, 5), errs(r0) || String(bodyOf(r0, 'box').volume));
  for (const patch of [{ sx: 60 }, { sx: 30 }]) {
    const r = evaluate(set(clone(d), 'box', patch)), b = bodyOf(r, 'box');
    check(`side boss follows ${JSON.stringify(patch)}`, !errs(r) && r.result.bodies.length === 1 && close(b.volume, patch.sx * 40 * 20 + 500, 5), errs(r) || `bodies ${r.result.bodies.length} volume ${b.volume.toFixed(0)}`);
  }
});

scenario('One fillet on one edge keeps that edge when the box is resized a lot', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const edges = edgesWhere(evaluate(base), 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3 && Math.abs(q[0] - 20) < 1e-3));
  check('picked the +X top edge', edges.length === 1, String(edges.length));
  const d = doc([...base.features, { id: 'f', type: 'fillet', name: 'Fillet', params: { edges, radius: 3, tangent: false, variable: false } }]);
  for (const patch of [{ sx: 200 }, { sz: 100 }, { sy: 10 }]) {
    const r = evaluate(set(clone(d), 'box', patch)), b = bodyOf(r, 'box'), p = { sx: 40, sy: 30, sz: 20, ...patch };
    const lost = (1 - Math.PI / 4) * 9 * p.sy;
    check(`one edge fillet ${JSON.stringify(patch)}`, !errs(r) && close(b.volume, p.sx * p.sy * p.sz - lost, p.sx * p.sy * p.sz * 0.003), errs(r) || `volume ${b.volume.toFixed(0)} vs ${(p.sx * p.sy * p.sz - lost).toFixed(0)}`);
  }
});

scenario('Suppress and reorder an early feature', () => {
  const d0 = doc([prim('box', 'box', { sx: 30, sy: 30, sz: 20, radius: 0 }), { id: 'h', type: 'hole', name: 'Hole', params: { target: 'box', pos: [0, 0, 20], face: { id: 'box', point: [0, 0, 20], normal: [0, 0, 1] }, dir: [0, 0, 1], kind: 'simple', diameter: 5, through: true, depth: 8 } }]);
  const r = evaluate(d0);
  check('through hole removes material', !errs(r) && bodyOf(r, 'box').volume < 18000 - 300, errs(r));
  const sup = clone(d0); sup.features[1].suppressed = true;
  const rs = evaluate(sup);
  check('suppressing the hole restores the solid', !errs(rs) && approx(bodyOf(rs, 'box').volume, 18000, 0.001), errs(rs));
});

scenario('Failures and warnings explain themselves', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const top = edgesWhere(evaluate(base), 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3 && Math.abs(q[0] - 20) < 1e-3));
  const ghost = { body: 'box', pts: [[500, 500, 500], [500, 500, 600]], nrm: [[1, 0, 0]] };
  const part = evaluate(doc([...base.features, { id: 'f', type: 'fillet', name: 'Fillet', params: { edges: [...top, ghost], radius: 3, tangent: false, variable: false } }]));
  check('a fillet with one missing edge still builds', !part.result.errors.f && part.result.warnings.f?.[0]?.action === 'repick', JSON.stringify(part.result.warnings));
  check('and says which edge was not found', JSON.stringify(part.result.lost.f) === '[1]', JSON.stringify(part.result.lost));
  const none = evaluate(doc([...base.features, { id: 'f', type: 'fillet', name: 'Fillet', params: { edges: [ghost], radius: 3, tangent: false, variable: false } }]));
  check('all edges missing is an error that says what to do', /Pick the edges again/.test(none.result.errors.f || ''), none.result.errors.f);
  const sk = { id: 's', type: 'sketch', name: 'Sketch', params: { plane: 'XY', offset: 0, shapes: [{ t: 'rect', x: 200, y: 200, w: 10, h: 10 }] } };
  const cut = evaluate(doc([...base.features, sk, { id: 'e', type: 'extrude', name: 'Cut', params: { sketch: 's', profiles: null, extent: 'distance', distance: 5, op: 'cut', target: 'box', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } }]));
  check('a cut that misses the body warns', /does not touch any body/.test(cut.result.warnings.e?.[0]?.text || ''), JSON.stringify(cut.result.warnings));
  check('an extrude says what it acts on', !!cut.result.notes.e?.text, JSON.stringify(cut.result.notes));
});

scenario('Tools that meet at the same height leave no skin between them', () => {
  const plate = prim('p', 'box', { sx: 60, sy: 60, sz: 4.65, radius: 0 });
  const sk = (id, off, w) => ({ id, type: 'sketch', name: id, params: { plane: 'XY', offset: off, shapes: [{ t: 'rect', x: -w / 2, y: -w / 2, w, h: w }] } });
  const cut = (id, s, d) => ({ id, type: 'extrude', name: id, params: { sketch: s, profiles: null, extent: 'distance', distance: d, op: 'cut', target: 'p', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } });
  for (const [label, off] of [['0.7', 0.7], ['4.65 - 3.95', 4.65 - 3.95], ['0.1 + 0.6', 0.1 + 0.6]]) {
    const r = evaluate(doc([plate, sk('s1', 0, 20), cut('c1', 's1', 0.7), sk('s2', off, 30), cut('c2', 's2', 3.95)]));
    const b = bodyOf(r, 'p'), V = b.verts, T = b.tris;
    let hits = 0;
    for (let i = 0; i < T.length; i += 3) { // a vertical line through the middle of the opening: nothing should be in the way
      const a = [0, 1, 2].map((k) => V[T[i] * 3 + k]), c = [0, 1, 2].map((k) => V[T[i + 1] * 3 + k]), d = [0, 1, 2].map((k) => V[T[i + 2] * 3 + k]);
      const den = (c[1] - d[1]) * (a[0] - d[0]) + (d[0] - c[0]) * (a[1] - d[1]); if (Math.abs(den) < 1e-12) continue;
      const l1 = ((c[1] - d[1]) * (0.3 - d[0]) + (d[0] - c[0]) * (0.2 - d[1])) / den, l2 = ((d[1] - a[1]) * (0.3 - d[0]) + (a[0] - d[0]) * (0.2 - d[1])) / den;
      if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) hits++;
    }
    check(`pocket meets the hole at ${label}: nothing left in the opening`, !errs(r) && hits === 0, `${hits} faces in the way`);
  }
});

scenario('Zero-thickness walls are found and a healthy solid has none', () => {
  const cube = [Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]), Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])];
  check('a cube has no zero-thickness walls', findSkins(...cube).size === 0);
  // the same cube plus a square sheet inside it that faces both ways: two triangles up, two down, on the same plane
  const v = Float32Array.from([...cube[0], 0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0.5]);
  const t = Uint32Array.from([...cube[1], 8, 9, 10, 8, 10, 11, 8, 10, 9, 8, 11, 10]);
  check('a two-sided sheet is found', findSkins(v, t).size === 4, String(findSkins(v, t).size));
});

scenario('Resuming from a checkpoint gives the same result as rebuilding everything', () => {
  const plate = prim('p', 'box', { sx: 200, sy: 200, sz: 10, radius: 0 });
  const peg = (i, r = 4) => prim('h' + i, 'cylinder', { pos: [-90 + (i % 10) * 20, -90 + Math.floor(i / 10) * 20, 10], radius: r, height: 6 });
  const join = (i) => ({ id: 'j' + i, type: 'combine', name: 'J' + i, params: { target: 'p', tool: 'h' + i, op: 'join', keepTool: false } });
  const sk = { id: 's', type: 'sketch', name: 'S', params: { plane: 'XY', offset: 0, shapes: [{ t: 'rect', x: 500, y: 500, w: 10, h: 10 }] } };
  const cut = { id: 'c', type: 'extrude', name: 'Cut', params: { sketch: 's', profiles: null, extent: 'distance', distance: 5, op: 'cut', target: 'p', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } };
  const build = (n, edit = {}) => { const f = [plate]; for (let i = 0; i < n; i++) f.push(peg(i, edit[i] ?? 4), join(i)); f.push(sk, cut); return f; };
  const sig = (r) => JSON.stringify({ b: r.result.bodies.map((b) => [b.id, +b.volume.toFixed(3), b.bbox.min.map((v) => +v.toFixed(3)), b.bbox.max.map((v) => +v.toFixed(3)), b.tris.length]), e: r.result.errors, w: r.result.warnings, n: Object.keys(r.result.notes), s: [...r.result.sketchUsed], sn: r.result.snaps.length });
  const run = (feats, cache, extra = {}) => evaluate(doc(feats), { cache, ...extra });
  const steps = [[{}], [{ 29: 5 }], [{ 29: 5, 15: 3 }], [{ 0: 6, 29: 5, 15: 3 }], [{ 0: 6, 29: 5, 15: 3 }], [{ 15: 2 }]];
  steps.forEach(([edit], k) => {
    const feats = build(30, edit), inc = run(feats, true), full = run(feats, false);
    check(`edit step ${k + 1}: same bodies, errors, notes and snapshots as a full rebuild`, sig(inc) === sig(full), `${sig(inc).slice(0, 120)} vs ${sig(full).slice(0, 120)}`);
  });
  const feats = build(30, {});
  run(feats, true);
  const again = run(feats, true);
  check('an unchanged design replays nothing', again.result.stats.steps === 0, JSON.stringify(again.result.stats));
  const e2 = build(30, { 29: 7 }); const last = run(e2, true);
  check('editing a late feature replays only a few steps', last.result.stats.steps < 12, JSON.stringify(last.result.stats));
  // the marker: roll back, then forward again
  const back = run(build(30, { 29: 7 }).slice(0, 20), true), fullBack = run(build(30, { 29: 7 }).slice(0, 20), false);
  check('shortening the timeline still matches', sig(back) === sig(fullBack));
  const fwd = run(build(30, { 29: 7 }), true), fullFwd = run(build(30, { 29: 7 }), false);
  check('and so does growing it back', sig(fwd) === sig(fullFwd));
  // suppressing, deleting and reordering
  const sup = build(30, {}); sup[11] = { ...sup[11], suppressed: true };
  check('suppressing a feature matches', sig(run(sup, true)) === sig(run(sup, false)));
  const del = build(30, {}); del.splice(5, 2);
  check('deleting features matches', sig(run(del, true)) === sig(run(del, false)));
  const dialogPreview = run(build(30, { 29: 7 }), true, {}), withPreview = evaluate(doc(build(30, { 29: 7 })), { cache: true });
  void dialogPreview; void withPreview;
});

scenario('Dialog data (picked-edge capture and extrude preview) is the same from a checkpoint', () => {
  clearKernelCache();
  const plate = prim('p', 'box', { sx: 100, sy: 100, sz: 10, radius: 0 });
  const peg = (i) => prim('h' + i, 'cylinder', { pos: [-40 + i * 20, 0, 10], radius: 4, height: 6 });
  const join = (i) => ({ id: 'j' + i, type: 'combine', name: 'J' + i, params: { target: 'p', tool: 'h' + i, op: 'join', keepTool: false } });
  const sk = { id: 's', type: 'sketch', name: 'S', params: { plane: 'XY', offset: 10, shapes: [{ t: 'rect', x: -5, y: -30, w: 10, h: 10 }] } };
  const ex = { id: 'e', type: 'extrude', name: 'E', params: { sketch: 's', profiles: null, extent: 'distance', distance: 4, op: 'join', target: 'p', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } };
  const feats = [plate]; for (let i = 0; i < 9; i++) feats.push(peg(i), join(i)); feats.push(sk, ex);
  const idx = feats.findIndex((f) => f.id === 'e');
  rebuild(feats, feats.length, {}); // everything cached, no dialog open
  const a = rebuild(feats, feats.length, { previewId: 'e', capture: idx });
  const b = rebuild(feats, feats.length, { previewId: 'e', capture: idx, cache: false });
  check('the preview comes back and matches', !!a.preview && a.preview.op === b.preview.op && a.preview.tris.length === b.preview.tris.length, JSON.stringify([a.preview?.op, b.preview?.op]));
  check('the captured bodies match', JSON.stringify(a.captured?.map((x) => [x.id, x.tris.length])) === JSON.stringify(b.captured?.map((x) => [x.id, x.tris.length])) && a.captured.length > 0);
  clearKernelCache();
});

scenario('Picking through the tree matches testing every triangle, and the coarse copy is smaller', () => {
  const sphere = (nu, nv, r = 50) => { const v = [], t = []; for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const th = (j / nv) * Math.PI, ph = (i / nu) * 2 * Math.PI; v.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)); } for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; if (j > 0) t.push(a, c, b); if (j < nv - 1) t.push(b, c, d); } return { verts: Float32Array.from(v), tris: Uint32Array.from(t) }; };
  const brute = (m, o, d, back) => { let best = Infinity, hit = -1; const V = m.verts, T = m.tris; for (let i = 0; i < T.length; i += 3) { const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3; const e1 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]]; const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]; if ((!back && dn > 0) || dn === 0) continue; const t = ((V[a] - o[0]) * n[0] + (V[a + 1] - o[1]) * n[1] + (V[a + 2] - o[2]) * n[2]) / dn; if (t <= 1e-9 || t >= best) continue; const p = [o[0] + d[0] * t - V[a], o[1] + d[1] * t - V[a + 1], o[2] + d[2] * t - V[a + 2]]; const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2], d20 = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], d21 = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]; const den = d00 * d11 - d01 * d01, u = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den; if (u < 0 || w < 0 || u + w > 1) continue; best = t; hit = i / 3; } return hit < 0 ? null : { t: best, tri: hit }; };
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (const [nu, nv] of [[24, 12], [90, 45]]) {
    const m = sphere(nu, nv), bvh = buildBVH(m.verts, m.tris); let bad = 0, hits = 0;
    for (let k = 0; k < 300; k++) {
      const o = [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200, 90 + rnd() * 50], tg = [(rnd() - 0.5) * 90, (rnd() - 0.5) * 90, (rnd() - 0.5) * 40], d = [tg[0] - o[0], tg[1] - o[1], tg[2] - o[2]], l = Math.hypot(...d); d[0] /= l; d[1] /= l; d[2] /= l;
      for (const back of [false, true]) { const a = brute(m, o, d, back), b = raycastBVH(bvh, o[0], o[1], o[2], d[0], d[1], d[2], Infinity, back); if (a) hits++; if ((a === null) !== (b === null) || (a && Math.abs(a.t - b.t) > 1e-6)) bad++; }
    }
    check(`${m.tris.length / 3} triangles: ${hits} hits agree with the slow way`, bad === 0 && hits > 100, `${bad} differ`);
  }
  const big = sphere(300, 200), c = clusterMesh(big.verts, big.tris, 40);
  check('the coarse copy has far fewer triangles but is still a surface', c.tris.length > 300 && c.tris.length < big.tris.length / 8, `${big.tris.length / 3} -> ${c.tris.length / 3}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
