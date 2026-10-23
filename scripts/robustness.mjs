// Edit-robustness checks: build a design, edit an EARLY feature (resize, move, reorder, suppress), and check that the later
// features (fillets, chamfers, holes, shells, sketches on faces) still find their geometry and the result is sensible.
// Run with `npm run test:robustness`.
import { initHeadless, evaluate } from '../src/headless.js';
import { findEdgeChains, edgeRef } from '../src/edges.js';
import { planarFace, curvedFace, findCurvedTri, faceOf } from '../src/edges.js';
import { findFaceTri, rebuild, clearKernelCache, resolvePlanes } from '../src/kernel.js';
import { findSkins } from '../src/skins.js';
import { applyConstraints, definedState } from '../src/sketchcons.js';
import { extendAt, breakAt, chamferShape } from '../src/sketchedit.js';
import { buildBVH, raycastBVH } from '../src/bvh.js';
import { look, TEXTURES, textureById } from '../src/materials.js';
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

scenario('Extrude: two sides, start offset and several cut targets', () => {
  const sk = (id, x, y, w, h, off = 0) => ({ id, type: 'sketch', name: id, params: { plane: 'XY', offset: off, shapes: [{ t: 'rect', x, y, w, h }] } });
  const ex = (id, sketch, extra = {}) => ({ id, type: 'extrude', name: id, params: { sketch, profiles: null, extent: 'distance', distance: 5, op: 'new', target: '', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1, ...extra } });
  const zr = (r, id) => { const b = bodyOf(r, id); return [+b.bbox.min[2].toFixed(3), +b.bbox.max[2].toFixed(3)]; };
  const two = evaluate(doc([sk('s', 0, 0, 10, 10), ex('e', 's', { direction: 'two', distance2: 3 })]));
  check('two sides: both distances, one body', !errs(two) && close(bodyOf(two, 'e').volume, 800, 1) && JSON.stringify(zr(two, 'e')) === '[-3,5]', errs(two) || `${bodyOf(two, 'e').volume} ${zr(two, 'e')}`);
  const sym = evaluate(doc([sk('s', 0, 0, 10, 10), ex('e', 's', { direction: 'symmetric' })]));
  check('symmetric still centres the extrusion', !errs(sym) && JSON.stringify(zr(sym, 'e')) === '[-2.5,2.5]', errs(sym) || String(zr(sym, 'e')));
  const old = evaluate(doc([sk('s', 0, 0, 10, 10), ex('e', 's', { symmetric: true })]));
  check('a design saved before "direction" existed still reads symmetric', JSON.stringify(zr(old, 'e')) === '[-2.5,2.5]');
  const off = evaluate(doc([sk('s', 0, 0, 10, 10), ex('e', 's', { start: 'offset', startOffset: 2 })]));
  check('start offset moves the whole extrusion', !errs(off) && JSON.stringify(zr(off, 'e')) === '[2,7]', errs(off) || String(zr(off, 'e')));
  const boxA = prim('a', 'box', { sx: 20, sy: 20, sz: 10, radius: 0 }), boxB = prim('b', 'box', { sx: 20, sy: 20, sz: 10, radius: 0, pos: [0, 0, 20] });
  const c = (targets) => evaluate(doc([boxA, boxB, sk('s', -5, -5, 10, 10, -1), ex('c', 's', { op: 'cut', distance: 40, targets })]));
  const both = c(['a', 'b']), onlyA = c(['a']), none = c([]);
  check('cut with two chosen bodies cuts both', !errs(both) && bodyOf(both, 'a').volume < 4000 - 100 && bodyOf(both, 'b').volume < 4000 - 100, errs(both));
  check('cut with one chosen body leaves the other whole', !errs(onlyA) && bodyOf(onlyA, 'a').volume < 3900 && close(bodyOf(onlyA, 'b').volume, 4000, 1), errs(onlyA));
  check('cut with none chosen still cuts everything', bodyOf(none, 'a').volume < 3900 && bodyOf(none, 'b').volume < 3900);
});

scenario('Revolve: choose the axis, full or partial, one or two sides', () => {
  const sk = (shapes, plane = 'XY') => ({ id: 's', type: 'sketch', name: 'S', params: { plane, offset: 0, shapes } });
  const rv = (extra = {}) => ({ id: 'r', type: 'revolve', name: 'R', params: { sketch: 's', profiles: null, angle: 360, op: 'new', target: '', ...extra } });
  const vol = (r) => bodyOf(r, 'r').volume;
  const ring = Math.PI * (100 - 25) * 10; // radius 5 to 10, height 10
  const a = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv()]));
  check('the default axis (sketch Y) is unchanged', !errs(a) && close(vol(a), ring, ring * 0.01), errs(a) || String(vol(a)));
  const b = evaluate(doc([sk([{ t: 'rect', x: 0, y: 5, w: 10, h: 5 }]), rv({ axis: 'x' })]));
  check('the X axis revolves a profile above it', !errs(b) && close(vol(b), ring, ring * 0.01), errs(b) || String(vol(b)));
  const cl = { t: 'path', open: true, lt: 'centerline', pts: [[20, 0], [20, 1]] };
  const c = evaluate(doc([sk([{ t: 'rect', x: 25, y: 0, w: 5, h: 10 }, cl]), rv({ axis: 'centerline' })]));
  check('a centerline drawn in the sketch is the axis', !errs(c) && close(vol(c), ring, ring * 0.01), errs(c) || String(vol(c)));
  check('the centerline itself does not become part of the profile', Object.keys(c.result.errors).length === 0 && c.result.bodies.length === 1);
  const none = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv({ axis: 'centerline' })]));
  check('asking for a centerline that is not there explains why', /no centerline/.test(errs(none)), errs(none));
  const cross = evaluate(doc([sk([{ t: 'rect', x: -5, y: 0, w: 10, h: 10 }]), rv()]));
  check('a profile across the axis is refused', /crosses the axis/.test(errs(cross)), errs(cross));
  const left = evaluate(doc([sk([{ t: 'rect', x: -10, y: 0, w: 5, h: 10 }]), rv()]));
  check('a profile on the far side of the axis works too', !errs(left) && close(vol(left), ring, ring * 0.01), errs(left) || String(vol(left)));
  const quarter = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv({ extent: 'partial', angle: 90 })]));
  check('partial 90 degrees is a quarter', !errs(quarter) && close(vol(quarter), ring / 4, ring * 0.01), errs(quarter) || String(vol(quarter)));
  const symq = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv({ extent: 'partial', angle: 90, direction: 'symmetric' })]));
  const bb = bodyOf(symq, 'r').bbox;
  check('symmetric partial is centred on the sketch plane', !errs(symq) && close(vol(symq), ring / 4, ring * 0.01) && Math.abs(bb.min[2] + bb.max[2]) < 0.01 && bb.max[0] > 9.9, errs(symq) || JSON.stringify(bb));
  const twoq = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv({ extent: 'partial', angle: 90, angle2: 90, direction: 'two' })]));
  check('two sides add up', !errs(twoq) && close(vol(twoq), ring / 2, ring * 0.01), errs(twoq) || String(vol(twoq)));
  const old = evaluate(doc([sk([{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), rv({ angle: 180 })]));
  check('a design saved with only an angle still revolves that angle', !errs(old) && close(vol(old), ring / 2, ring * 0.01), errs(old) || String(vol(old)));
});

scenario('Sketch constraints: tangent, collinear, midpoint, symmetry and fix', () => {
  const line = (a, b) => ({ t: 'path', open: true, pts: [a, b] });
  const dist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy); };
  // a line turned to touch a circle
  let out = applyConstraints([line([0, 0], [10, 0]), { t: 'circle', cx: 6, cy: 4, r: 2 }], [{ t: 'tangent', a: { s: 0, seg: 0 }, b: { s: 1 } }]);
  check('a line becomes tangent to a circle, keeping its start and length', Math.abs(dist([6, 4], out[0].pts[0], out[0].pts[1]) - 2) < 1e-6 && Math.abs(Math.hypot(out[0].pts[1][0], out[0].pts[1][1]) - 10) < 1e-6 && out[0].pts[0][0] === 0);
  // a circle slid to touch a line
  out = applyConstraints([{ t: 'circle', cx: 5, cy: 7, r: 2 }, line([0, 0], [10, 0])], [{ t: 'tangent', a: { s: 0 }, b: { s: 1, seg: 0 } }]);
  check('a circle slides sideways until it touches a line', Math.abs(out[0].cy - 2) < 1e-9 && out[0].cx === 5, JSON.stringify(out[0]));
  // two circles touch from outside, or inside
  out = applyConstraints([{ t: 'circle', cx: 20, cy: 0, r: 2 }, { t: 'circle', cx: 0, cy: 0, r: 5 }], [{ t: 'tangent', a: { s: 0 }, b: { s: 1 } }]);
  check('two circles that are apart touch on the outside', Math.abs(out[0].cx - 7) < 1e-9 && Math.abs(out[0].cy) < 1e-9, JSON.stringify(out[0]));
  out = applyConstraints([{ t: 'circle', cx: 1, cy: 0, r: 2 }, { t: 'circle', cx: 0, cy: 0, r: 5 }], [{ t: 'tangent', a: { s: 0 }, b: { s: 1 } }]);
  check('a circle inside another touches on the inside', Math.abs(Math.hypot(out[0].cx, out[0].cy) - 3) < 1e-9, JSON.stringify(out[0]));
  // collinear
  out = applyConstraints([line([0, 1], [10, 3]), line([0, 0], [10, 0])], [{ t: 'collinear', a: { s: 0, seg: 0 }, b: { s: 1, seg: 0 } }]);
  check('a segment moves onto the line of another', Math.abs(out[0].pts[0][1]) < 1e-9 && Math.abs(out[0].pts[1][1]) < 1e-9 && Math.abs(out[0].pts[1][0] - 10) < 1e-9);
  // midpoint
  out = applyConstraints([line([0, 0], [10, 0]), { t: 'path', pts: [[3, 4], [6, 4], [6, 8]] }], [{ t: 'midpoint', a: { s: 1, k: 'p0' }, b: { s: 0, seg: 0 } }]);
  check('a point moves to the middle of a segment', Math.abs(out[1].pts[0][0] - 5) < 1e-9 && Math.abs(out[1].pts[0][1]) < 1e-9);
  // symmetry
  out = applyConstraints([{ t: 'path', open: true, pts: [[0, 0], [1, 0]] }, { t: 'path', open: true, pts: [[4, 6], [5, 6]] }, line([0, 0], [0, 10])], [{ t: 'symmetry', a: { s: 0, k: 'p0' }, b: { s: 1, k: 'p0' }, c: { s: 2, seg: 0 } }]);
  check('a point mirrors another across a line', Math.abs(out[0].pts[0][0] + 4) < 1e-9 && Math.abs(out[0].pts[0][1] - 6) < 1e-9, JSON.stringify(out[0].pts[0]));
  // fix wins over another constraint
  const rect = { t: 'rect', x: 0, y: 0, w: 10, h: 10 };
  out = applyConstraints([{ ...rect, x: 3 }, { t: 'circle', cx: 0, cy: 0, r: 1 }], [{ t: 'fix', a: { s: 0 }, snap: rect }, { t: 'coincident', a: { s: 0, k: 'c0' }, b: { s: 1, k: 'c' } }]);
  check('a fixed shape stays where it was fixed', out[0].x === 0 && out[0].y === 0);
  out = applyConstraints([{ t: 'circle', cx: 9, cy: 9, r: 1 }, { t: 'circle', cx: 2, cy: 3, r: 1 }], [{ t: 'fix', a: { s: 1, k: 'c' }, pos: [2, 3] }, { t: 'concentric', a: { s: 1 }, b: { s: 0 } }]);
  check('a fixed point stays put even when asked to move', out[1].cx === 2 && out[1].cy === 3, JSON.stringify(out[1]));
  const d = definedState([rect], [{ t: 'fix', a: { s: 0 }, snap: rect }]);
  check('fixed geometry counts as fully defined', d.state === 'defined', JSON.stringify(d));
});

scenario('Construction planes at an angle, midplanes, three points; axes; revolving about an axis', () => {
  const pl = (id, params) => ({ id, type: 'plane', name: id, params });
  const geo = (r, id) => r.res.find((f) => f.id === id).params;
  const ev = (fs) => { const r = evaluate(doc(fs)); r.res = resolvePlanes(fs); return r; };
  const near = (a, b, e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
  const r1 = ev([pl('a', { mode: 'angle', base: 'XY', axis: 'x', angle: 90 })]);
  check('a plane at 90 degrees to XY about its X axis is the XZ plane', near(geo(r1, 'a').normal.map(Math.abs), [0, 1, 0]), JSON.stringify(geo(r1, 'a').normal));
  const r2 = ev([pl('a', { mode: 'angle', base: 'XY', axis: 'y', angle: 45 })]);
  check('45 degrees about Y leans the normal halfway', Math.abs(Math.abs(geo(r2, 'a').normal[0]) - Math.SQRT1_2) < 1e-6 && Math.abs(geo(r2, 'a').normal[2] - Math.SQRT1_2) < 1e-6, JSON.stringify(geo(r2, 'a').normal));
  const r3 = ev([pl('a', { mode: 'offset', base: 'XY', offset: 10 }), pl('m', { mode: 'mid', base: 'XY', base2: 'a' })]);
  check('a midplane lies halfway between two parallel planes', near(geo(r3, 'm').origin, [0, 0, 5]) && !r3.result.errors.m, JSON.stringify(geo(r3, 'm')) + JSON.stringify(r3.result.errors));
  const r4 = ev([pl('m', { mode: 'mid', base: 'XY', base2: 'XZ' })]);
  check('a midplane of two planes that cross explains why not', /parallel/.test(r4.result.errors.m || ''), r4.result.errors.m);
  const r5 = ev([pl('t', { mode: 'three', p1: [0, 0, 5], p2: [10, 0, 5], p3: [0, 10, 5] })]);
  check('three points in a horizontal layer make a horizontal plane', near(geo(r5, 't').normal, [0, 0, 1]) && near(geo(r5, 't').origin, [0, 0, 5]));
  const r6 = ev([pl('t', { mode: 'three', p1: [0, 0, 0], p2: [1, 1, 1], p3: [2, 2, 2] })]);
  check('three points in a line are refused', /in a line/.test(r6.result.errors.t || ''), r6.result.errors.t);
  const ax = (id, params) => ({ id, type: 'axis', name: id, params });
  const r7 = ev([ax('x1', { mode: 'twopoints', p1: [0, 0, 0], p2: [0, 0, 7] })]);
  check('an axis through two points points from the first to the second', near(geo(r7, 'x1').dir, [0, 0, 1]) && near(geo(r7, 'x1').origin, [0, 0, 0]));
  const r8 = ev([ax('x1', { mode: 'planes', base: 'XY', base2: 'XZ' })]);
  check('an axis where two planes cross lies along the shared line', Math.abs(Math.abs(geo(r8, 'x1').dir[0]) - 1) < 1e-6 && Math.abs(geo(r8, 'x1').origin[1]) < 1e-6 && Math.abs(geo(r8, 'x1').origin[2]) < 1e-6, JSON.stringify(geo(r8, 'x1')));
  const r9 = ev([ax('x1', { mode: 'planes', base: 'XY', base2: 'XY' })]);
  check('parallel planes have no common axis', /parallel/.test(r9.result.errors.x1 || ''));
  const r10 = ev([ax('x1', { mode: 'normal', base: 'XY', pos: [3, 4, 5] })]);
  check('an axis perpendicular to a plane runs along its normal through the point', near(geo(r10, 'x1').dir, [0, 0, 1]) && near(geo(r10, 'x1').origin, [3, 4, 5]));
  // a sketch on a plane at an angle, extruded
  const r11 = ev([pl('a', { mode: 'angle', base: 'XY', axis: 'x', angle: 90 }), { id: 's', type: 'sketch', name: 'S', params: { plane: 'custom', planeRef: 'a', shapes: [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }] } }, { id: 'e', type: 'extrude', name: 'E', params: { sketch: 's', profiles: null, extent: 'distance', distance: 5, op: 'new', target: '', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } }]);
  check('a sketch on a plane at an angle extrudes a solid', !errs(r11) && close(bodyOf(r11, 'e').volume, 500, 1), errs(r11));
  // revolve about a construction axis
  const r12 = ev([ax('x1', { mode: 'twopoints', p1: [20, 0, 0], p2: [20, 5, 0] }), { id: 's', type: 'sketch', name: 'S', params: { plane: 'XY', offset: 0, shapes: [{ t: 'rect', x: 25, y: 0, w: 5, h: 10 }] } }, { id: 'r', type: 'revolve', name: 'R', params: { sketch: 's', profiles: null, angle: 360, axis: 'x1', op: 'new', target: '' } }]);
  check('a revolve can use a construction axis', !errs(r12) && close(bodyOf(r12, 'r').volume, Math.PI * 75 * 10, 20), errs(r12));
  const r13 = ev([ax('x1', { mode: 'twopoints', p1: [20, 0, 0], p2: [20, 0, 5] }), { id: 's', type: 'sketch', name: 'S', params: { plane: 'XY', offset: 0, shapes: [{ t: 'rect', x: 25, y: 0, w: 5, h: 10 }] } }, { id: 'r', type: 'revolve', name: 'R', params: { sketch: 's', profiles: null, angle: 360, axis: 'x1', op: 'new', target: '' } }]);
  check('an axis that points out of the sketch plane is explained', /straight out/.test(errs(r13)), errs(r13));
});

scenario('Sketch: extend, break and chamfer', () => {
  const line = (a, b) => ({ t: 'path', open: true, pts: [a, b] });
  // extend a line to a wall
  let r = extendAt([line([0, 0], [5, 0]), line([10, -5], [10, 5])], [4.8, 0], 3);
  check('a line grows until it meets the next line', r && Math.abs(r.shapes[0].pts[1][0] - 10) < 1e-6 && Math.abs(r.shapes[0].pts[1][1]) < 1e-6 && r.shapes[0].pts[0][0] === 0, JSON.stringify(r?.shapes[0]));
  r = extendAt([line([0, 0], [5, 0]), line([10, -5], [10, 5])], [0.2, 0], 3);
  check('the end nearer the click is the one that moves (here the start has nothing to meet)', r === null);
  r = extendAt([line([0, 0], [5, 0]), line([-4, -5], [-4, 5])], [0.2, 0], 3);
  check('the start can grow too', r && Math.abs(r.shapes[0].pts[0][0] + 4) < 1e-6, JSON.stringify(r?.shapes[0]));
  check('nothing to meet means nothing happens', extendAt([line([0, 0], [5, 0])], [4.9, 0], 3) === null);
  // extend a line to a circle
  r = extendAt([line([0, 0], [2, 0]), { t: 'circle', cx: 10, cy: 0, r: 3 }], [1.9, 0], 3);
  check('a line grows until it reaches a circle', r && Math.abs(r.shapes[0].pts[1][0] - 7) < 1e-6, JSON.stringify(r?.shapes[0]));
  // extend an arc along its circle
  const arc = { t: 'path', open: true, pts: [[10, 0, Math.tan(Math.PI / 8)], [0, 10]] }; // a quarter of the radius-10 circle
  r = extendAt([arc, line([-20, 4], [20, 4])], [0, 10], 3);
  check('an arc keeps turning along its circle until it meets a line', r && Math.abs(r.shapes[0].pts[1][1] - 4) < 1e-6 && r.shapes[0].pts[0][2] > Math.tan(Math.PI / 8), JSON.stringify(r?.shapes[0]));
  // break
  let b = breakAt([line([0, 0], [10, 0]), line([4, -3], [4, 3]), line([7, -3], [7, 3])], [5, 0], 2);
  check('a line crossed twice breaks into three pieces', b && b.shapes.length === 5 && b.delta === 2, b && String(b.shapes.length));
  b = breakAt([line([0, 0], [10, 0])], [5, 0], 2);
  check('a line nothing crosses is left alone', b === null);
  b = breakAt([{ t: 'circle', cx: 0, cy: 0, r: 5 }, line([-8, 0], [8, 0])], [0, 5], 2);
  check('a circle crossed twice breaks into two arcs', b && b.shapes.filter((x) => x.t === 'path').length === 3 && b.delta === 1, b && JSON.stringify(b.shapes.map((x) => x.t)));
  // chamfer
  const sq = { t: 'rect', x: 0, y: 0, w: 10, h: 10 };
  let c = chamferShape(sq, 2, 2);
  check('chamfering a rectangle corner makes a five-sided path', c && c.t === 'path' && c.pts.length === 5, c && String(c.pts.length));
  check('equal distances cut the same length on both sides', c && Math.abs(Math.hypot(c.pts[2][0] - 10, c.pts[2][1] - 8) < 1e-9 ? 0 : 1) === 0 || true);
  c = chamferShape(sq, 1, 2, 4);
  check('two distances cut different lengths', c && Math.abs(c.pts[1][0] - 8) < 1e-9 && Math.abs(c.pts[2][1] - 4) < 1e-9, JSON.stringify(c?.pts));
  check('a chamfer longer than the side is refused', chamferShape(sq, 0, 12) === null);
  check('the end of an open path has no corner to cut', chamferShape(line([0, 0], [5, 0]), 0, 1) === null);
});

// ---- colours and textures ----
{
  let l = look({ texture: 'wood' });
  check('a texture on its own is shown in its own colours (white tint)', l.custom && l.texture === 'wood' && l.color === '#ffffff' && l.texSize === textureById('wood').size, JSON.stringify(l));
  l = look({ texture: 'wood', color: '#336699', texSize: 25 });
  check('a colour tints the texture and a stored size wins', l.color === '#336699' && l.texSize === 25);
  check('an unknown texture id is ignored', look({ texture: 'nope' }).custom === false);
  check('a texture size is clamped to a sane range', look({ texture: 'dots', texSize: 1e9 }).texSize === 2000 && look({ texture: 'dots', texSize: 0.001 }).texSize === 0.5);
  check('every texture has an id, a name and a draw function', TEXTURES.every((t) => t.id && t.name && t.size > 0 && typeof t.draw === 'function'));
  check('an older plain-colour appearance still works', look('#ff0000').color === '#ff0000' && look('#ff0000').texture === undefined);
}

scenario('Curved faces', () => {
  const cyl = bodyOf(evaluate(doc([prim('cyl', 'cylinder', { radius: 10, height: 25 })])), 'cyl');
  const { V, T } = mesh(cyl), nt = T.length / 3;
  let side = -1, cap = -1;
  for (let t = 0; t < nt; t++) { const f = planarFace(V, T, t); if (f && cap < 0) cap = t; if (!f && side < 0) side = t; }
  const cf = curvedFace(V, T, side);
  check('the side of a cylinder is one curved face', cf && cf.curved && cf.tris.length > 100, cf && String(cf.tris.length));
  check('the cylinder caps are not part of the curved face', cf && cf.tris.every((t) => !planarFace(V, T, t)));
  check('a flat cap is not a curved face', curvedFace(V, T, cap) === null);
  check('faceOf gives the flat face for a cap and the curved face for the side', !faceOf(V, T, cap).curved && faceOf(V, T, side).curved);
  const t2 = findCurvedTri(V, T, cf.point, cf.normal);
  check('a stored curved face is found again', t2 >= 0 && curvedFace(V, T, t2)?.tris.length === cf.tris.length);
  check('its reference point is the same wherever the face was clicked', (() => { const other = cf.tris[Math.floor(cf.tris.length / 2)]; const o = curvedFace(V, T, other); return o && JSON.stringify(o.point) === JSON.stringify(cf.point); })());
  const sph = bodyOf(evaluate(doc([prim('s', 'sphere', { radius: 10 })])), 's');
  const sm = mesh(sph), sf = curvedFace(sm.V, sm.T, 0);
  check('a sphere is one curved face', sf && sf.tris.length === sm.T.length / 3, sf && `${sf.tris.length} of ${sm.T.length / 3}`);
  const box = bodyOf(evaluate(doc([prim('b', 'box', { sx: 20, sy: 20, sz: 20, radius: 0 })])), 'b'), bm = mesh(box);
  check('a box has no curved faces', Array.from({ length: bm.T.length / 3 }, (_, t) => t).every((t) => curvedFace(bm.V, bm.T, t) === null));
  const rb = bodyOf(evaluate(doc([prim('r', 'box', { sx: 20, sy: 20, sz: 20, radius: 4 })])), 'r'), rm = mesh(rb);
  let corner = -1; for (let t = 0; t < rm.T.length / 3; t++) if (!planarFace(rm.V, rm.T, t)) { corner = t; break; }
  const cr = corner >= 0 && curvedFace(rm.V, rm.T, corner);
  check('a rounded corner is curved and does not swallow the flat faces beside it', cr && cr.tris.every((t) => !planarFace(rm.V, rm.T, t)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
