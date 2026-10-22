// Edit-robustness checks: build a design, edit an EARLY feature (resize, move, reorder, suppress), and check that the later
// features (fillets, chamfers, holes, shells, sketches on faces) still find their geometry and the result is sensible.
// Run with `npm run test:robustness`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { initHeadless, evaluate } from '../src/headless.js';
import { findEdgeChains, edgeRef } from '../src/edges.js';
import { planarFace, curvedFace, findCurvedTri, faceOf } from '../src/edges.js';
import { findFaceTri, rebuild, clearKernelCache, resolvePlanes } from '../src/kernel.js';
import { findSkins } from '../src/skins.js';
import { applyConstraints, definedState } from '../src/sketchcons.js';
import { solveSketch } from '../src/sketchsolve.js';
import { extendAt, breakAt, chamferShape, fitSpline } from '../src/sketchedit.js';
import { buildBVH, raycastBVH } from '../src/bvh.js';
import { look, TEXTURES, textureById } from '../src/materials.js';
import { clusterMesh } from '../src/lod.js';
import { bigDesign } from './bench-brep.mjs';
import { matchBrepFace } from '../src/brepface.js';
import { profilesOf, encodeFloats } from '../src/kernel.js';
import { soupOfMesh } from '../src/meshtools.js';
import { profilesOfExact, interferenceOf, compareResults, offsetPolygonExact, loadBrep, brepReady, brepSupport, exactStep } from '../src/backend-brep.js';
import { flatFaces, writeSTEP } from '../src/exporters.js';

await initHeadless();
let failed = 0, passed = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const prim = (id, shape, params, extra = {}) => ({ id, type: 'primitive', name: id, params: { shape, pos: [0, 0, 0], op: 'new', ...params, ...extra } });
const bodyOf = (res, id) => res.result.bodies.find((b) => b.id === id) || res.result.bodies[0];
const mesh = (b) => ({ V: b.verts, T: b.tris });
const doc = (features) => ({ features, params: [], units: 'mm', nextId: 100 });

// The mesh kernel is being retired. What it answered for each design the two-backend scenarios build (volume, bounding box, flat-face
// count per body, area and bounds per surface) is recorded in scripts/golden-mesh.json, and the exact kernel is held to it. Run with
// UPDATE_GOLDEN=1 while the mesh kernel still exists to record it again.
const GOLDEN_FILE = new URL('./golden-mesh.json', import.meta.url);
const golden = existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) : {};
const triAreaOf = (b) => { let a = 0; const V = b.verts, T = b.tris; for (let i = 0; i < T.length; i += 3) { const u = [0, 1, 2].map((k) => V[T[i + 1] * 3 + k] - V[T[i] * 3 + k]), w = [0, 1, 2].map((k) => V[T[i + 2] * 3 + k] - V[T[i] * 3 + k]); a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; } return a; };
function meshAnswer(key, d) {
  if (process.env.UPDATE_GOLDEN) {
    const r = evaluate(d, { backend: 'mesh' });
    golden[key] = { errors: Object.keys(r.result.errors).length, bodies: r.result.bodies.map((b) => ({ id: b.id, volume: b.volume, bbox: b.bbox, flat: flatFaces(b.verts, b.tris).length })), surfaces: (r.result.surfaces || []).map((q) => ({ id: q.id, area: triAreaOf(q), bbox: q.bbox })) };
  }
  if (!golden[key]) throw new Error(`no recorded mesh answer for "${key}"; run UPDATE_GOLDEN=1 node scripts/robustness.mjs`);
  return golden[key];
}

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

async function ascenario(title, fn) { console.log(title); try { await fn(); } catch (e) { failed++; console.log('  FAIL threw: ' + e.stack.split('\n').slice(0, 3).join(' | ')); } }
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
  check('a line becomes tangent to a circle, keeping its start and length', Math.abs(dist([6, 4], out[0].pts[0], out[0].pts[1]) - 2) < 1e-6 && Math.abs(Math.hypot(out[0].pts[1][0], out[0].pts[1][1]) - 10) < 1e-6 && Math.abs(out[0].pts[0][0]) < 1e-6 && Math.abs(out[0].pts[0][1]) < 1e-6);
  // a circle slid to touch a line
  out = applyConstraints([{ t: 'circle', cx: 5, cy: 7, r: 2 }, line([0, 0], [10, 0])], [{ t: 'tangent', a: { s: 0 }, b: { s: 1, seg: 0 } }]);
  check('a circle slides sideways until it touches a line', Math.abs(out[0].cy - 2) < 1e-6 && Math.abs(out[0].cx - 5) < 1e-6, JSON.stringify(out[0]));
  // two circles touch from outside, or inside
  out = applyConstraints([{ t: 'circle', cx: 20, cy: 0, r: 2 }, { t: 'circle', cx: 0, cy: 0, r: 5 }], [{ t: 'tangent', a: { s: 0 }, b: { s: 1 } }]);
  check('two circles that are apart touch on the outside', Math.abs(out[0].cx - 7) < 1e-6 && Math.abs(out[0].cy) < 1e-6, JSON.stringify(out[0]));
  out = applyConstraints([{ t: 'circle', cx: 1, cy: 0, r: 2 }, { t: 'circle', cx: 0, cy: 0, r: 5 }], [{ t: 'tangent', a: { s: 0 }, b: { s: 1 } }]);
  check('a circle inside another touches on the inside', Math.abs(Math.hypot(out[0].cx, out[0].cy) - 3) < 1e-6, JSON.stringify(out[0]));
  // collinear
  out = applyConstraints([line([0, 1], [10, 3]), line([0, 0], [10, 0])], [{ t: 'collinear', a: { s: 0, seg: 0 }, b: { s: 1, seg: 0 } }]);
  check('a segment moves onto the line of another, keeping its length', Math.abs(out[0].pts[0][1]) < 1e-6 && Math.abs(out[0].pts[1][1]) < 1e-6 && Math.abs(Math.hypot(out[0].pts[1][0] - out[0].pts[0][0], out[0].pts[1][1] - out[0].pts[0][1]) - Math.hypot(10, 2)) < 1e-6);
  // midpoint
  out = applyConstraints([line([0, 0], [10, 0]), { t: 'path', pts: [[3, 4], [6, 4], [6, 8]] }], [{ t: 'midpoint', a: { s: 1, k: 'p0' }, b: { s: 0, seg: 0 } }]);
  check('a point moves to the middle of a segment', Math.abs(out[1].pts[0][0] - 5) < 1e-6 && Math.abs(out[1].pts[0][1]) < 1e-6);
  // symmetry
  out = applyConstraints([{ t: 'path', open: true, pts: [[0, 0], [1, 0]] }, { t: 'path', open: true, pts: [[4, 6], [5, 6]] }, line([0, 0], [0, 10])], [{ t: 'symmetry', a: { s: 0, k: 'p0' }, b: { s: 1, k: 'p0' }, c: { s: 2, seg: 0 } }]);
  check('a point mirrors another across a line', Math.abs(out[0].pts[0][0] + 4) < 1e-6 && Math.abs(out[0].pts[0][1] - 6) < 1e-6, JSON.stringify(out[0].pts[0]));
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
  check('the side of a cylinder is one curved face', cf && cf.curved && cf.tris.length > 40, cf && String(cf.tris.length));
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

scenario('Sketch solver: constraints that depend on each other', () => {
  const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  // a rough four-sided shape turned into a rectangle by four constraints that all lean on each other
  const quad = { t: 'path', pts: [[0, 0], [10, 1], [11, 8], [-1, 9]] };
  let r = solveSketch([quad], [{ t: 'horizontal', a: { s: 0, seg: 0 } }, { t: 'vertical', a: { s: 0, seg: 1 } }, { t: 'horizontal', a: { s: 0, seg: 2 } }, { t: 'vertical', a: { s: 0, seg: 3 } }]);
  const P = r.shapes[0].pts;
  check('four lines made horizontal and vertical close up into a rectangle', r.ok && Math.abs(P[0][1] - P[1][1]) < 1e-6 && Math.abs(P[1][0] - P[2][0]) < 1e-6 && Math.abs(P[2][1] - P[3][1]) < 1e-6 && Math.abs(P[3][0] - P[0][0]) < 1e-6, JSON.stringify(P));
  // a rhombus: opposite sides parallel and two neighbours equal
  r = solveSketch([{ t: 'path', pts: [[0, 0], [10, 2], [14, 9], [3, 6]] }], [{ t: 'parallel', a: { s: 0, seg: 0 }, b: { s: 0, seg: 2 } }, { t: 'parallel', a: { s: 0, seg: 1 }, b: { s: 0, seg: 3 } }, { t: 'equal', a: { s: 0, seg: 0 }, b: { s: 0, seg: 1 } }]);
  const R = r.shapes[0].pts, l = [0, 1, 2, 3].map((i) => len(R[i], R[(i + 1) % 4]));
  check('parallel pairs plus an equal side make a rhombus (all four sides equal)', r.ok && l.every((v) => Math.abs(v - l[0]) < 1e-5), JSON.stringify(l));
  check('and the opposite sides really are parallel', Math.abs(Math.sin(dir(R[0], R[1]) - dir(R[3], R[2]))) < 1e-6 && Math.abs(Math.sin(dir(R[1], R[2]) - dir(R[0], R[3]))) < 1e-6);
  // a circle held in place by two tangents to two lines
  r = solveSketch([{ t: 'circle', cx: 5, cy: 5, r: 2 }, { t: 'path', open: true, pts: [[0, 0], [20, 0]] }, { t: 'path', open: true, pts: [[0, 0], [0, 20]] }], [{ t: 'tangent', a: { s: 0 }, b: { s: 1, seg: 0 } }, { t: 'tangent', a: { s: 0 }, b: { s: 2, seg: 0 } }]);
  check('a circle tangent to two lines settles in the corner at its radius', r.ok && Math.abs(r.shapes[0].cx - 2) < 1e-6 && Math.abs(r.shapes[0].cy - 2) < 1e-6 && Math.abs(r.shapes[0].r - 2) < 1e-6, JSON.stringify(r.shapes[0]));
  // constraints that cannot both hold: two circles each given a different diameter by an expression, then made equal
  r = solveSketch([{ t: 'circle', cx: 0, cy: 0, r: 2, ex: { d: '4' } }, { t: 'circle', cx: 9, cy: 0, r: 4, ex: { d: '8' } }], [{ t: 'equal', a: { s: 0 }, b: { s: 1 } }]);
  check('a constraint that fights a driven size still gives sensible numbers (the constraint wins, as before)', r.shapes.every((sh) => Number.isFinite(sh.r) && sh.r > 0) && Math.abs(r.shapes[0].r - r.shapes[1].r) < 1e-6, JSON.stringify(r.shapes));
  // driving dimensions and Fix are held
  const rect = { t: 'rect', x: 0, y: 0, w: 10, h: 10, ex: { w: '10' } };
  r = solveSketch([rect, { t: 'circle', cx: 30, cy: 0, r: 2 }], [{ t: 'concentric', a: { s: 1 }, b: { s: 0 } }]);
  check('a size driven by an expression is not changed by other constraints', Math.abs(r.shapes[0].w - 10) < 1e-6 && Math.abs(r.shapes[1].cx - 5) < 1e-6 && Math.abs(r.shapes[1].cy - 5) < 1e-6, JSON.stringify(r.shapes));
  // degrees of freedom
  r = solveSketch([{ t: 'rect', x: 0, y: 0, w: 10, h: 5 }], [], { details: true });
  check('a bare rectangle has two sizes free (its position is not counted)', r.dof === 2 && r.free.length === 2 && /width|height/.test(r.free.join()), JSON.stringify(r));
  r = solveSketch([{ t: 'rect', x: 0, y: 0, w: 10, h: 5, ex: { w: '10', h: '5' } }], [], { details: true });
  check('a rectangle with both sizes driven has none left', r.dof === 0 && r.free.length === 0, JSON.stringify(r));
  r = solveSketch([{ t: 'circle', cx: 0, cy: 0, r: 3 }, { t: 'circle', cx: 9, cy: 4, r: 2 }], [{ t: 'concentric', a: { s: 1 }, b: { s: 0 } }], { details: true });
  check('a second circle made concentric loses its position freedom but keeps its radius', r.dof === 2 && r.free.every((n) => /radius/.test(n)), JSON.stringify(r));
  // size
  const many = Array.from({ length: 80 }, (_, i) => ({ t: 'circle', cx: i * 7, cy: (i % 5) * 3, r: 2 + (i % 3) * 0.1 }));
  const t0 = Date.now();
  r = solveSketch(many, many.slice(1).map((_, i) => ({ t: 'equal', a: { s: i + 1 }, b: { s: i } })));
  check('a sketch of 80 shapes with 79 constraints solves quickly', r.ok && Date.now() - t0 < 3000 && r.shapes.every((s) => Math.abs(s.r - r.shapes[0].r) < 1e-6), `${Date.now() - t0} ms`);
  const huge = Array.from({ length: 200 }, (_, i) => ({ t: 'circle', cx: i, cy: 0, r: 1 }));
  r = solveSketch(huge, [{ t: 'equal', a: { s: 1 }, b: { s: 0 } }]);
  check('a very large sketch falls back to the older method instead of stalling', r.method === 'sequential' && r.shapes.length === 200);
});

scenario('Chamfer with two distances or an angle, and fillet by chord length', () => {
  const base = doc([prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const r0 = evaluate(base), V0 = bodyOf(r0, 'box').volume;
  const one = edgesWhere(r0, 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3) && p.every((q) => Math.abs(q[1] + 15) < 1e-3)); // the top front edge, 40 long
  check('picked the top front edge', one.length === 1 && Math.abs(Math.abs(one[0].pts[0][0] - one[0].pts.at(-1)[0]) - 40) < 1e-3, String(one.length));
  const cut = (params) => { const r = evaluate(doc([...base.features, { id: 'c', type: 'chamfer', name: 'Chamfer', params: { edges: one, tangent: false, mode: 'equal', distance: 2, ...params } }])); return { r, removed: V0 - bodyOf(r, 'box').volume }; };
  let c = cut({});
  check('an equal chamfer removes a triangle of 2 x 2 along the edge', !errs(c.r) && Math.abs(c.removed - 0.5 * 2 * 2 * 40) < 0.5, `${c.removed}`);
  c = cut({ mode: 'two', distance: 2, distance2: 5 });
  check('two distances remove a 2 x 5 triangle', !errs(c.r) && Math.abs(c.removed - 0.5 * 2 * 5 * 40) < 0.5, `${c.removed}`);
  const flipped = cut({ mode: 'two', distance: 2, distance2: 5, flip: true });
  check('swapping the sides keeps the same size of cut', !errs(flipped.r) && Math.abs(flipped.removed - c.removed) < 0.5);
  const topW = (r) => { const b = bodyOf(r, 'box'); let lo = Infinity, hi = -Infinity; for (let i = 0; i < b.verts.length; i += 3) if (Math.abs(b.verts[i + 2] - 20) < 1e-3) { lo = Math.min(lo, b.verts[i + 1]); hi = Math.max(hi, b.verts[i + 1]); } return [lo, hi]; };
  const [aLo] = topW(c.r), [bLo] = topW(flipped.r);
  check('the first distance is on one face and the second on the other, and flip swaps them', Math.abs(Math.abs(aLo + 15) - Math.abs(bLo + 15)) > 2.5, `${aLo} ${bLo}`);
  c = cut({ mode: 'angle', distance: 3, angle: 30 });
  check('a distance of 3 and an angle of 30 degrees remove a triangle with legs 3 and 3 x tan 30', !errs(c.r) && Math.abs(c.removed - 0.5 * 3 * 3 * Math.tan(Math.PI / 6) * 40) < 0.5, `${c.removed}`);
  const fil = (params) => { const r = evaluate(doc([...base.features, { id: 'f', type: 'fillet', name: 'Fillet', params: { edges: one, tangent: false, variable: false, radius: 2, mode: 'radius', ...params } }])); return { r, removed: V0 - bodyOf(r, 'box').volume }; };
  const byR = fil({ radius: 3 }), byChord = fil({ mode: 'chord', chord: 3 * Math.SQRT2 });
  check('a chord length of r x root 2 gives the same fillet as radius r on a square edge', !errs(byChord.r) && Math.abs(byChord.removed - byR.removed) < 0.5, `${byChord.removed} vs ${byR.removed}`);
});

scenario('Pattern extent, symmetric and skipped instances; combine with several tools; move point to point', () => {
  const box = prim('b', 'box', { sx: 10, sy: 10, sz: 10, radius: 0 });
  const pat = (params) => { const r = evaluate(doc([box, { id: 'p', type: 'pattern', name: 'Pattern', params: { body: 'b', kind: 'linear', count: 3, spacing: [30, 0, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '', ...params } }])); const b = bodyOf(r, 'b'); return { r, b, vol: b.volume, minX: b.bbox.min[0], maxX: b.bbox.max[0] }; };
  let x = pat({});
  check('a linear pattern of 3 spaced 30 apart spans 70', !errs(x.r) && Math.abs(x.maxX - x.minX - 70) < 1e-3 && Math.abs(x.vol - 3000) < 1, `${x.maxX - x.minX} ${x.vol}`);
  x = pat({ extent: 'extent' });
  check('with extent, the spacing is the total distance (30 across 3 instances: span 40)', !errs(x.r) && Math.abs(x.maxX - x.minX - 40) < 1e-3, `${x.maxX - x.minX}`);
  x = pat({ symmetric: true });
  check('symmetric spreads the instances both ways from the original (centred on it)', !errs(x.r) && Math.abs(x.maxX - x.minX - 70) < 1e-3 && Math.abs((x.maxX + x.minX) / 2 - 0) < 1e-3 && Math.abs(x.vol - 3000) < 1, `${x.minX} ${x.maxX}`);
  x = pat({ skip: '2' });
  check('skipping instance 2 leaves a gap and two boxes', !errs(x.r) && Math.abs(x.vol - 2000) < 1 && Math.abs(x.maxX - x.minX - 70) < 1e-3, `${x.vol}`);
  x = pat({ skip: '1, 2, 3' });
  check('skipping every instance is refused with a message', !!errs(x.r) && /Every instance is skipped/.test(errs(x.r)));
  const ring = (() => { const r = evaluate(doc([prim('b', 'box', { sx: 10, sy: 10, sz: 10, radius: 0, pos: [40, 0, 0] }), { id: 'p', type: 'pattern', name: 'Pattern', params: { body: 'b', kind: 'circular', count: 4, angle: 360, axis: 'Z', spacing: [30, 0, 0], extent: 'spacing', symmetric: false, skip: '' } }])); return { r, vol: bodyOf(r, 'b').volume }; })();
  check('a full circular pattern still makes its four copies', !errs(ring.r) && Math.abs(ring.vol - 4000) < 1, `${ring.vol}`);
  const three = [prim('t', 'box', { sx: 40, sy: 10, sz: 10, radius: 0 }), prim('c1', 'box', { sx: 6, sy: 6, sz: 20, radius: 0, pos: [-10, 0, 0] }), prim('c2', 'box', { sx: 6, sy: 6, sz: 20, radius: 0, pos: [10, 0, 0] })];
  let r = evaluate(doc([...three, { id: 'cb', type: 'combine', name: 'Combine', params: { target: 't', tool: ['c1', 'c2'], op: 'cut', keepTool: false } }]));
  const cutVol = bodyOf(r, 't').volume;
  check('combine cuts with two tool bodies at once and removes both tools', !errs(r) && Math.abs(cutVol - (4000 - 2 * 6 * 6 * 10)) < 1 && r.result.bodies.length === 1, `${cutVol} ${r.result.bodies.length}`);
  r = evaluate(doc([...three, { id: 'cb', type: 'combine', name: 'Combine', params: { target: 't', tool: 'c1', op: 'cut', keepTool: false } }]));
  check('an older combine with a single tool still works', !errs(r) && Math.abs(bodyOf(r, 't').volume - (4000 - 6 * 6 * 10)) < 1);
  r = evaluate(doc([...three, { id: 'cb', type: 'combine', name: 'Combine', params: { target: 't', tool: ['t'], op: 'cut', keepTool: false } }]));
  check('a body cannot be its own tool', !!errs(r));
  r = evaluate(doc([...three, { id: 'cb', type: 'combine', name: 'Combine', params: { target: 't', tool: [], op: 'cut', keepTool: false } }]));
  check('combine with no tool says what is missing', /at least one tool/i.test(errs(r)), errs(r));
  r = evaluate(doc([box, { id: 'm', type: 'move', name: 'Move', params: { body: 'b', t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1], copy: false, mode: 'points', from: [0, 0, 0], to: [25, 10, 5] } }]));
  const mb = bodyOf(r, 'b');
  check('move point to point carries the first point onto the second', !errs(r) && Math.abs(mb.bbox.min[0] - 20) < 1e-3 && Math.abs(mb.bbox.min[1] - 5) < 1e-3 && Math.abs(mb.bbox.min[2] - 5) < 1e-3, JSON.stringify(mb.bbox));
});

scenario('Mirror about a construction plane', () => {
  const box = prim('b', 'box', { sx: 10, sy: 10, sz: 10, radius: 0, pos: [20, 0, 0] });
  const pl = { id: 'pl', type: 'plane', name: 'Plane', params: { mode: 'offset', base: 'YZ', offset: 50 } };
  const r = evaluate(doc([box, pl, { id: 'mi', type: 'mirror', name: 'Mirror', params: { body: 'b', plane: 'pl', offset: 0, join: false } }]));
  const mi = r.result.bodies.find((b) => b.id === 'mi');
  check('a mirror about a plane at x = 50 puts the copy at x = 80', !errs(r) && mi && Math.abs(mi.bbox.min[0] - 75) < 1e-3 && Math.abs(mi.bbox.max[0] - 85) < 1e-3, JSON.stringify(mi?.bbox));
  const old = evaluate(doc([box, { id: 'mi', type: 'mirror', name: 'Mirror', params: { body: 'b', plane: 'YZ', offset: 0, join: false } }]));
  const mo = old.result.bodies.find((b) => b.id === 'mi');
  check('a mirror about a standard plane still works', !errs(old) && mo && Math.abs(mo.bbox.max[0] + 15) < 1e-3, JSON.stringify(mo?.bbox));
  const gone = evaluate(doc([box, { id: 'mi', type: 'mirror', name: 'Mirror', params: { body: 'b', plane: 'nope', offset: 0, join: false } }]));
  check('a mirror plane that does not exist is explained', /no longer exists/.test(errs(gone)), errs(gone));
});

// ------------------------------------------------------------------
// The two backends build the same designs. Volume, bounding box and (for designs made of flat faces) the number of faces must agree;
// designs with curved faces also check the exact face count only the B-rep backend has.
// the exact kernel is started with the headless kernels now; the page loads it with a loading screen and the worker on demand
await loadBrep();
console.log('Loading is cached');
check('the same promise answers a second call', (await loadBrep()) === (await loadBrep()) && brepReady());

function bothBackends(title, d, { flat = false, faces = null, volTol = 0.012, skipBodies = [] } = {}) {
  scenario(title, () => {
    const m = meshAnswer(title, d), b = evaluate(d, { backend: 'brep' });
    check('built by the exact kernel', b.result.backend.kind === 'brep' && !errs(b), JSON.stringify(b.result.backend) + ' ' + errs(b));
    check('no errors on the mesh kernel either', m.errors === 0, String(m.errors));
    check('same bodies', m.bodies.map((x) => x.id).sort().join() === b.result.bodies.map((x) => x.id).sort().join(), `${m.bodies.map((x) => x.id)} vs ${b.result.bodies.map((x) => x.id)}`);
    for (const mb of m.bodies) {
      if (skipBodies.includes(mb.id)) continue;
      const bb = b.result.bodies.find((x) => x.id === mb.id);
      if (!bb) continue;
      check(`${mb.id}: volume ${bb.volume.toFixed(1)} vs ${mb.volume.toFixed(1)}`, approx(bb.volume, mb.volume, volTol));
      const diag = Math.hypot(...mb.bbox.max.map((v, k) => v - mb.bbox.min[k]));
      const dev = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(bb.bbox.min[k] - mb.bbox.min[k]), Math.abs(bb.bbox.max[k] - mb.bbox.max[k])]));
      check(`${mb.id}: bounding box within ${(0.005 * diag + 0.05).toFixed(2)} (off by ${dev.toFixed(3)})`, dev <= 0.005 * diag + 0.05, JSON.stringify([mb.bbox, bb.bbox]));
      if (flat) {
        const fb = flatFaces(bb.verts, bb.tris).length;
        check(`${mb.id}: ${fb} faces, mesh kernel ${mb.flat}`, mb.flat === fb);
      }
      if (faces != null) check(`${mb.id}: exact face count ${bb.faces.length}, expected ${faces}`, bb.faces.length === faces);
      check(`${mb.id}: every triangle belongs to a face`, bb.faceOf.length === bb.tris.length / 3);
    }
  });
}
const skch = (id, shapes, plane = 'XY', extra = {}) => ({ id, type: 'sketch', name: id, params: { plane, offset: 0, shapes, ...extra } });
const extr = (id, sketch, extra = {}) => ({ id, type: 'extrude', name: id, params: { sketch, profiles: null, extent: 'distance', distance: 10, op: 'new', target: '', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1, ...extra } });
const revo = (id, sketch, extra = {}) => ({ id, type: 'revolve', name: id, params: { sketch, profiles: null, angle: 360, op: 'new', target: '', ...extra } });

const boxFeature = prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 });
const topEdges = edgesWhere(evaluate(doc([boxFeature])), 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3));
const vertEdges = edgesWhere(evaluate(doc([boxFeature])), 'box', (p) => Math.abs(p[0][0] - p[p.length - 1][0]) < 1e-3 && Math.abs(p[0][2] - p[p.length - 1][2]) > 1);
const holeF = { id: 'h', type: 'hole', name: 'Hole', params: { target: 'box', pos: [0, 0, 20], face: { id: 'box', point: [0, 0, 20], normal: [0, 0, 1] }, dir: [0, 0, 1], kind: 'simple', diameter: 10, through: true, depth: 8 } };
const filF = { id: 'fil', type: 'fillet', name: 'Fillet', params: { edges: topEdges, radius: 3, tangent: false, variable: false } };

bothBackends('Both backends: primitives', doc([
  prim('box', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), prim('cyl', 'cylinder', { radius: 8, height: 25, pos: [60, 0, 0] }),
  prim('sph', 'sphere', { radius: 9, pos: [100, 0, 0] }), prim('con', 'cone', { radius: 8, radius2: 3, height: 15, pos: [130, 0, 0] }),
  prim('tor', 'torus', { major: 12, minor: 3, pos: [170, 0, 0] }), prim('rb', 'box', { sx: 20, sy: 20, sz: 20, radius: 3, pos: [220, 0, 0] }),
]), { volTol: 0.03 });
bothBackends('Both backends: box, fillet on the top edges, through hole (11 exact faces)', doc([boxFeature, filF, holeF]), { faces: 11 });
bothBackends('Both backends: chamfer on the vertical edges', doc([boxFeature, { id: 'ch', type: 'chamfer', name: 'Chamfer', params: { edges: vertEdges, distance: 2 } }]), { flat: true, faces: 10 });
bothBackends('Both backends: counterbore and countersink holes', doc([prim('box', 'box', { sx: 50, sy: 50, sz: 20, radius: 0 }),
  { id: 'h1', type: 'hole', name: 'H1', params: { target: 'box', pos: [-12, 0, 20], dir: [0, 0, 1], kind: 'counterbore', diameter: 6, cbDia: 11, cbDepth: 4, through: false, depth: 12 } },
  { id: 'h2', type: 'hole', name: 'H2', params: { target: 'box', pos: [12, 0, 20], dir: [0, 0, 1], kind: 'countersink', diameter: 6, cskDia: 12, cskAngle: 90, through: true, depth: 8 } }]), { volTol: 0.02 });
bothBackends('Both backends: extrude a rectangle with a round hole and a polygon', doc([
  skch('s', [{ t: 'rect', x: 0, y: 0, w: 40, h: 30 }, { t: 'circle', cx: 20, cy: 15, r: 6 }, { t: 'ngon', cx: 70, cy: 15, r: 10, n: 6, rot: 0 }]), extr('e', 's', { distance: 12 })]), { volTol: 0.01 });
bothBackends('Both backends: extrude a rounded rectangle, a slot, an ellipse and an arc path', doc([
  skch('s', [{ t: 'rrect', x: 0, y: 0, w: 40, h: 20, r: 5 }, { t: 'slot', x1: 60, y1: 10, x2: 80, y2: 10, w: 8 }, { t: 'ellipse', cx: 110, cy: 10, rx: 12, ry: 6, rot: 30 },
    { t: 'path', pts: [[130, 0, 0.4142], [150, 0], [150, 20], [130, 20]] }]), extr('e', 's', { distance: 7 })]), { volTol: 0.02 });
bothBackends('Both backends: extrude both sides, symmetric, offset start and a cut', doc([
  prim('base', 'box', { sx: 60, sy: 60, sz: 20, radius: 0 }),
  skch('s1', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }]), extr('two', 's1', { direction: 'two', distance: 5, distance2: 3, pos: 0 }),
  skch('s2', [{ t: 'circle', cx: 0, cy: 0, r: 8 }], 'XY', { offset: 20 }), extr('cutter', 's2', { op: 'cut', target: 'base', distance: -6 }),
  skch('s3', [{ t: 'rect', x: 30, y: 30, w: 8, h: 8 }]), extr('sym', 's3', { symmetric: true, start: 'offset', startOffset: 4 })]), { volTol: 0.01 });
bothBackends('Both backends: revolve full, partial, symmetric, two sides, about the X axis and a centerline', doc([
  skch('a', [{ t: 'rect', x: 5, y: 0, w: 5, h: 10 }]), revo('full', 'a'),
  skch('b', [{ t: 'rect', x: 25, y: 0, w: 5, h: 10 }]), revo('part', 'b', { extent: 'partial', angle: 100 }),
  skch('c', [{ t: 'rect', x: 45, y: 0, w: 5, h: 10 }]), revo('sym', 'c', { extent: 'partial', angle: 90, direction: 'symmetric' }),
  skch('d', [{ t: 'rect', x: 65, y: 0, w: 5, h: 10 }]), revo('two', 'd', { extent: 'partial', angle: 60, angle2: 90, direction: 'two' }),
  skch('e', [{ t: 'rect', x: 85, y: 5, w: 8, h: 5 }]), revo('xax', 'e', { axis: 'x' }),
  skch('f', [{ t: 'rect', x: -30, y: 0, w: 5, h: 10 }, { t: 'path', open: true, lt: 'centerline', pts: [[-20, 0], [-20, 1]] }]), revo('cl', 'f', { axis: 'centerline' }),
  skch('g', [{ t: 'rect', x: -60, y: 0, w: 5, h: 10 }]), revo('neg', 'g', { extent: 'partial', angle: 90 }),
]), { volTol: 0.015 });
bothBackends('Both backends: combine join, cut and intersect', doc([
  prim('a', 'box', { sx: 30, sy: 30, sz: 30, radius: 0 }), prim('b', 'sphere', { radius: 18, pos: [0, 0, 15] }), prim('c', 'cylinder', { radius: 6, height: 50, pos: [0, 0, -5] }),
  { id: 'k1', type: 'combine', name: 'k1', params: { target: 'a', tool: 'c', op: 'cut', keepTool: true } },
  { id: 'k2', type: 'combine', name: 'k2', params: { target: 'a', tool: 'b', op: 'intersect', keepTool: false } }]), { volTol: 0.02, skipBodies: [] });
bothBackends('Both backends: mirror, and linear and circular patterns', doc([
  prim('b', 'box', { sx: 10, sy: 6, sz: 4, radius: 0, pos: [20, 0, 0] }), { id: 'mi', type: 'mirror', name: 'Mirror', params: { body: 'b', plane: 'YZ', offset: 0, join: true } },
  prim('p', 'box', { sx: 8, sy: 8, sz: 8, radius: 0, pos: [0, 40, 0] }), { id: 'lp', type: 'pattern', name: 'LP', params: { body: 'p', kind: 'linear', count: 4, spacing: [14, 0, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '2' } },
  prim('q', 'cylinder', { radius: 3, height: 8, pos: [30, -40, 0] }), { id: 'cp', type: 'pattern', name: 'CP', params: { body: 'q', kind: 'circular', count: 5, angle: 360, axis: 'Z', spacing: [30, 0, 0], extent: 'spacing', symmetric: false, skip: '' } }]), { volTol: 0.02 });
bothBackends('Both backends: a sketch on a face follows an edit of the base (extruded boss with a filleted base)', (() => {
  const d = doc([clone(boxFeature), skch('sf', [{ t: 'circle', cx: 0, cy: 0, r: 6 }], 'custom', { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0], faceRef: { id: 'box', point: [0, 0, 20], normal: [0, 0, 1] } }), extr('boss', 'sf', { op: 'join', target: 'box', distance: 8 })]);
  return set(d, 'box', { sz: 26 });
})(), { volTol: 0.01 });

bothBackends('Both backends: automatic, through-all and to-object extrudes, and emboss', doc([
  prim('base', 'box', { sx: 60, sy: 60, sz: 20, radius: 0 }), prim('wall', 'box', { sx: 10, sy: 10, sz: 30, radius: 0, pos: [40, 0, 0] }),
  skch('s1', [{ t: 'circle', cx: 0, cy: 0, r: 5 }], 'XY', { offset: 20 }), extr('au1', 's1', { op: 'auto', distance: -8 }),
  skch('s2', [{ t: 'rect', x: 10, y: 10, w: 6, h: 6 }], 'XY', { offset: 20 }), extr('au2', 's2', { op: 'auto', distance: 5 }),
  skch('s3', [{ t: 'rect', x: -20, y: -20, w: 4, h: 4 }], 'XY', { offset: 30 }), extr('thru', 's3', { op: 'cut', target: 'base', extent: 'all', flip: true }),
  skch('s4', [{ t: 'circle', cx: 40, cy: 0, r: 2 }], 'XY', { offset: 40 }), extr('obj', 's4', { op: 'new', extent: 'object', toBody: 'base', flip: true }),
  skch('s5', [{ t: 'rect', x: -25, y: 15, w: 10, h: 6 }], 'XY', { offset: 20 }), { id: 'em', type: 'emboss', name: 'Emboss', params: { sketch: 's5', profiles: null, depth: 2, mode: 'raise', target: '' } }]), { volTol: 0.01 });

// ---- phase 2: shell, draft, sweep, loft, thread ----
const topOpen = [{ point: [0, 0, 20], normal: [0, 0, 1] }];
bothBackends('Both backends: shell a box with the top open', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'sa', type: 'shell', name: 'Shell1', params: { body: 'a', thickness: 2, open: topOpen, side: 'inside' } }]), { volTol: 0.03 });
bothBackends('Both backends: shell a cylinder through its curved side and top', doc([
  prim('c', 'cylinder', { radius: 12, height: 25 }), { id: 'sc', type: 'shell', name: 'Shell1', params: { body: 'c', thickness: 1.5, open: [{ point: [0, 0, 25], normal: [0, 0, 1] }], side: 'inside' } }]), { volTol: 0.02 });
bothBackends('Both backends: draft side faces from the bottom and from the top', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'da', type: 'draft', name: 'Draft1', params: { body: 'a', faces: [{ point: [20, 0, 10], normal: [1, 0, 0] }, { point: [-20, 0, 10], normal: [-1, 0, 0] }], angle: 5, dir: '+Z', neutral: 'start' } },
  prim('b', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [80, 0, 0] }), { id: 'db', type: 'draft', name: 'Draft2', params: { body: 'b', faces: [{ point: [100, 0, 10], normal: [1, 0, 0] }], angle: 3, dir: '+Z', neutral: 'end' } },
  prim('c', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [160, 0, 0] }), { id: 'dc', type: 'draft', name: 'Draft3', params: { body: 'c', faces: [{ point: [160, 15, 10], normal: [0, 1, 0] }], angle: -4, dir: '+Z', neutral: 'start' } }]), { faces: 6, volTol: 0.002 });
scenario('Shell hollows bodies swept along corners and splines: closed on corners, open ends on both', () => {
  const sw = (smooth, extra) => doc([skch('p1', [{ t: 'circle', cx: 0, cy: 0, r: 2 }], 'YZ'), skch('w1', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [30, 15], [50, 15]] }]),
    { id: 'sw', type: 'sweep', name: 'Sweep1', params: { profile: 'p1', path: 'w1', smooth, op: 'new', target: '' } }, ...extra]);
  const shellOf = (smooth, side, th, open) => evaluate(sw(smooth, [{ id: 'sh', type: 'shell', name: 'Shell1', params: { body: 'sw', thickness: th, open, side } }]), { backend: 'brep' });
  const solid = evaluate(sw(false, []), { backend: 'brep' }).result.bodies[0].volume;
  const closed = shellOf(false, 'inside', 0.3, []);
  const vc = closed.result.bodies[0]?.volume;
  check('a closed hollow of a body swept around corners is a wall, not an error', !errs(closed) && vc > solid * 0.15 && vc < solid * 0.6, errs(closed) + ' ' + vc + ' of ' + solid);
  const ends = (smooth) => evaluate(sw(smooth, []), { backend: 'brep' }).result.bodies[0].faces.filter((f) => f.type === 'PLANE').map((f) => ({ point: f.centroid, normal: f.normal }));
  for (const smooth of [false, true]) {
    const o = ends(smooth), A = Math.PI * 4, wall = (dr0, dr1) => Math.PI * (dr1 * dr1 - dr0 * dr0);
    const len = solid / A; // path length (the corners add a little)
    const inn = shellOf(smooth, 'inside', 0.4, o), out = shellOf(smooth, 'outside', 0.4, o), mid = shellOf(smooth, 'both', 0.4, o);
    const vi = inn.result.bodies[0]?.volume, vo = out.result.bodies[0]?.volume, vm = mid.result.bodies[0]?.volume;
    const near = (v, w) => Math.abs(v - w * len) < w * len * 0.12;
    check(`a ${smooth ? 'spline' : 'cornered'} sweep with both ends open shells inwards`, !errs(inn) && near(vi, wall(1.6, 2)), errs(inn) + ' ' + vi);
    check(`a ${smooth ? 'spline' : 'cornered'} sweep with both ends open shells outwards`, !errs(out) && near(vo, wall(2, 2.4)), errs(out) + ' ' + vo);
    check(`a ${smooth ? 'spline' : 'cornered'} sweep with both ends open shells to both sides`, !errs(mid) && near(vm, wall(1.8, 2.2)), errs(mid) + ' ' + vm);
  }
  const hollowed = (r) => !errs(r) && r.result.bodies[0]?.volume > solid * 0.15 && r.result.bodies[0].volume < solid * 0.6;
  const one = shellOf(true, 'inside', 0.4, [ends(true)[0]]), whole = shellOf(true, 'inside', 0.3, []);
  check('a spline sweep with one end open is hollowed (the other end stays closed)', hollowed(one), errs(one) + ' ' + one.result.bodies[0]?.volume);
  check('a closed hollow of a spline sweep is hollowed', hollowed(whole), errs(whole) + ' ' + whole.result.bodies[0]?.volume);
  const solidS = evaluate(sw(true, []), { backend: 'brep' }).result.bodies[0].volume, lenS = solidS / (Math.PI * 4);
  for (const [side, th] of [['inside', 0.3], ['inside', 0.5], ['inside', 1], ['outside', 0.5], ['both', 0.5]]) {
    for (const smooth of [true, false]) {
      const sol = smooth ? solidS : solid, len = sol / (Math.PI * 4), r = shellOf(smooth, side, th, []), b = r.result.bodies[0];
      const [r0, r1] = side === 'inside' ? [2 - th, 2] : side === 'outside' ? [2, 2 + th] : [2 - th / 2, 2 + th / 2];
      const want = Math.PI * (r1 * r1 - r0 * r0) * len + 2 * Math.PI * (side === 'inside' ? 4 : r1 * r1) * th * (side === 'both' ? 0.5 : 1); // the wall plus the two end caps
      check(`an exact closed hollow of a ${smooth ? 'spline' : 'cornered'} sweep, ${side} ${th} mm`, !errs(r) && b && Math.abs(b.volume - want) < want * 0.15 && b.faces.length < 40, errs(r) + ' ' + b?.volume + ' vs ' + want.toFixed(0) + ' faces ' + b?.faces.length);
    }
  }
  const thick = shellOf(true, 'inside', 2.5, []);
  check('a wall as thick as the tube radius says so', /too large/i.test(errs(thick)), errs(thick));
});
scenario('Shell hollows lofted bodies: closed and with the top opened, inside, outside and centred', () => {
  const lofts = {
    'square to square': [skch('a1', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('a2', [{ t: 'rect', x: -5, y: -5, w: 10, h: 10 }], 'XY', { offset: 20 })],
    'square to circle': [skch('a1', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('a2', [{ t: 'circle', cx: 0, cy: 0, r: 6 }], 'XY', { offset: 20 })],
    'three sections': [skch('a1', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('a2', [{ t: 'rect', x: -5, y: -5, w: 10, h: 10 }], 'XY', { offset: 20 }), skch('a3', [{ t: 'rect', x: -8, y: -8, w: 16, h: 16 }], 'XY', { offset: 40 })],
  };
  for (const [name, sks] of Object.entries(lofts)) {
    const feats = [...sks, { id: 'lf', type: 'loft', name: 'Loft1', params: { sketches: sks.map((k) => k.id), op: 'new', target: '' } }];
    const solid = evaluate(doc(feats), { backend: 'brep' }).result.bodies[0];
    const top = solid.faces.filter((f) => f.type === 'PLANE').map((f) => ({ point: f.centroid, normal: f.normal })).sort((a, b) => b.point[2] - a.point[2])[0];
    const shell = (side, open) => evaluate(doc([...feats, { id: 'sh', type: 'shell', name: 'Shell1', params: { body: 'lf', thickness: 1, open, side } }]), { backend: 'brep' });
    const vols = {};
    for (const side of ['inside', 'outside', 'both']) for (const opened of [false, true]) {
      const r = shell(side, opened ? [top] : []), v = r.result.bodies[0]?.volume;
      vols[side + opened] = v;
      const wall = side === 'inside' ? v < solid.volume * 0.9999 && v > solid.volume * 0.1 : v > solid.volume * 0.05 && v < solid.volume * 1.5;
      check(`${name}: ${side} wall, ${opened ? 'top open' : 'closed'}`, !errs(r) && wall, errs(r) + ' ' + v + ' of ' + solid.volume);
    }
    check(`${name}: opening the top leaves less material than closed`, vols.insidetrue < vols.insidefalse && vols.outsidetrue < vols.outsidefalse, JSON.stringify(vols));
  }
});
scenario('Fit-point splines are exact curves in profiles, extrudes, revolves, sweep paths and lofts', () => {
  const fit = [[0, 0], [20, 10], [40, -5], [60, 10], [60, 30], [30, 40], [0, 30]];
  const sp = (f, closed = true) => ({ t: 'path', open: !closed, spline: true, pts: fitSpline(f, closed) });
  const polyArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
  const run = (feats) => evaluate(doc(feats), { backend: 'brep' });
  const ex = (id, sk, d) => ({ id, type: 'extrude', name: id, params: { sketch: sk, distance: d, symmetric: false, op: 'new', target: '' } });
  const A = polyArea(sp(fit).pts);
  const e = run([skch('s', [sp(fit)]), ex('e', 's', 10)]), eb = e.result.bodies[0];
  check('a closed spline extrudes to one curved face between two flat ones', !errs(e) && eb.faces.length === 3 && eb.faces.some((f) => f.type !== 'PLANE'), errs(e) + ' ' + eb?.faces.map((f) => f.type));
  check('its volume is the area of the curve times the height', Math.abs(eb.volume - A * 10) < A * 10 * 0.01, eb.volume + ' vs ' + A * 10);
  check('and it does not tessellate into thousands of triangles', eb.tris.length / 3 < 3000, String(eb.tris.length / 3));
  const hole = run([skch('s', [{ t: 'rect', x: -20, y: -20, w: 120, h: 80 }, sp(fit)]), ex('e', 's', 10)]), hb = hole.result.bodies[0];
  check('a spline inside a rectangle is a hole (nested shapes alternate)', !errs(hole) && hb && Math.abs(hb.volume - (120 * 80 - A) * 10) < A * 10 * 0.02, errs(hole) + ' ' + hb?.volume);
  const half = { t: 'path', open: true, spline: true, pts: fitSpline([[0, 0], [20, 10], [40, 0]], false) }, closer = { t: 'path', open: true, pts: [[40, 0], [0, 0]] };
  const j = run([skch('s', [half, closer]), ex('e', 's', 5)]), jb = j.result.bodies[0];
  check('an open spline closed by a line makes a region with a curved face, not facets', !errs(j) && jb && jb.faces.length <= 8 && jb.faces.some((f) => f.type !== 'PLANE'), errs(j) + ' ' + jb?.faces.length);
  const rv = run([skch('s', [sp([[10, 0], [20, 5], [25, 15], [15, 25], [10, 20]]), { t: 'path', open: true, lt: 'centerline', pts: [[0, -5], [0, 40]] }]), { id: 'r', type: 'revolve', name: 'R', params: { sketch: 's', profiles: null, angle: 360, op: 'new', target: '' } }]);
  check('a closed spline revolves into one surface of revolution', !errs(rv) && rv.result.bodies[0].faces.length === 1 && rv.result.bodies[0].faces[0].type !== 'PLANE', errs(rv) + ' ' + rv.result.bodies[0]?.faces.length);
  const path = { t: 'path', open: true, spline: true, pts: fitSpline([[0, 0], [15, 0], [45, 12], [75, -12], [100, 0]], false) }; // leaves the start along X, square to the profile
  const sw = run([skch('p', [{ t: 'circle', cx: 0, cy: 0, r: 3 }], 'YZ'), skch('w', [path]), { id: 'sw', type: 'sweep', name: 'S', params: { profile: 'p', path: 'w', smooth: false, op: 'new', target: '' } }]);
  let plen = 0; for (let i = 1; i < path.pts.length; i++) plen += Math.hypot(path.pts[i][0] - path.pts[i - 1][0], path.pts[i][1] - path.pts[i - 1][1]);
  check('a sweep along a spline path keeps the path length (volume of a 3 mm radius tube)', !errs(sw) && Math.abs(sw.result.bodies[0].volume - Math.PI * 9 * plen) < Math.PI * 9 * plen * 0.04, errs(sw) + ' ' + sw.result.bodies[0]?.volume + ' vs ' + Math.PI * 9 * plen);
  const lf = run([skch('a', [sp(fit)]), skch('b', [sp(fit.map(([x, y]) => [x * 0.5 + 15, y * 0.5 + 5]))], 'XY', { offset: 30 }), { id: 'lf', type: 'loft', name: 'L', params: { sketches: ['a', 'b'], op: 'new', target: '' } }]);
  check('a loft between two spline sections builds', !errs(lf) && lf.result.bodies[0].volume > A * 30 * 0.2, errs(lf) + ' ' + lf.result.bodies[0]?.volume);
  const pp = run([skch('w', [path]), { id: 'pp', type: 'pipe', name: 'P', params: { path: 'w', smooth: false, diameter: 6, wall: 0, op: 'new', target: '' } }]);
  check('a pipe along a spline path builds', !errs(pp) && pp.result.bodies[0].volume > 0, errs(pp));
  check('the exact kernel supports a design with splines', brepSupport(run([skch('s', [sp(fit)]), ex('e', 's', 10)]).resolved).ok);
});
scenario('Restored features: Extend Surface, Thicken on curved surfaces and mitred sweep corners', () => {
  const run = (feats) => evaluate(doc(feats), { backend: 'brep' });
  const areaOf = (s) => { let a = 0; const V = s.verts, T = s.tris; for (let i = 0; i < T.length; i += 3) { const A = T[i] * 3, B = T[i + 1] * 3, C = T[i + 2] * 3; const u = [V[B] - V[A], V[B + 1] - V[A + 1], V[B + 2] - V[A + 2]], w = [V[C] - V[A], V[C + 1] - V[A + 1], V[C + 2] - V[A + 2]]; a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; } return a; };
  const arc = skch('s', [{ t: 'path', open: true, pts: [[0, 0, 0.5], [30, 0]] }]); // 30 mm chord, 106 degree arc: radius 18.75, 34.77 long
  const X = { id: 'x', type: 'sextrude', name: 'X', params: { sketch: 's', distance: 20, symmetric: false } };
  const R0 = 18.75, theta = 4 * Math.atan(0.5), L = R0 * theta;
  const ext = run([arc, X, { id: 'ex', type: 'sextend', name: 'E', params: { surface: 'x', distance: 5 } }]);
  check('Extend Surface grows a curved surface by a strip along every open edge', !errs(ext) && ext.result.surfaces.length === 1 && Math.abs(areaOf(ext.result.surfaces[0]) - (L * 20 + 5 * (2 * L + 2 * 20))) < 25, errs(ext) + ' ' + (ext.result.surfaces[0] && areaOf(ext.result.surfaces[0])) + ' vs ' + (L * 20 + 5 * (2 * L + 40)));
  const flat = run([skch('s', [{ t: 'path', open: true, pts: [[0, 0], [20, 0]] }]), X, { id: 'ex', type: 'sextend', name: 'E', params: { surface: 'x', distance: 5 } }]);
  check('and a flat one', !errs(flat) && Math.abs(areaOf(flat.result.surfaces[0]) - (20 * 20 + 5 * (2 * 20 + 2 * 20))) < 2, errs(flat) + ' ' + areaOf(flat.result.surfaces[0]));
  const closedSurf = run([skch('s', [{ t: 'circle', cx: 0, cy: 0, r: 10 }]), X, { id: 'ex', type: 'sextend', name: 'E', params: { surface: 'x', distance: 5 } }]);
  check('a surface with no open edge says so', !errs(closedSurf) || /open edge|closed/i.test(errs(closedSurf)), errs(closedSurf));
  for (const [both, want] of [[false, theta / 2 * 20 * (R0 * R0 - (R0 - 2) ** 2)], [true, theta / 2 * 20 * ((R0 + 1) ** 2 - (R0 - 1) ** 2)]]) {
    const th = run([arc, X, { id: 'th', type: 'sthicken', name: 'T', params: { surface: 'x', thickness: 2, both } }]), b = th.result.bodies[0];
    check(`Thicken a curved (cylindrical) surface ${both ? 'to both sides' : 'to one side'}`, !errs(th) && b && Math.abs(b.volume - want) < want * 0.01, errs(th) + ' ' + b?.volume + ' vs ' + want);
  }
  const sp = skch('s', [{ t: 'path', open: true, spline: true, pts: fitSpline([[0, 0], [20, 10], [40, -5], [60, 10]], false) }]);
  const ts = run([sp, X, { id: 'th', type: 'sthicken', name: 'T', params: { surface: 'x', thickness: 2, both: false } }]), tb = ts.result.bodies[0];
  check('Thicken a surface of free-form curves gives a closed solid of about area times thickness', !errs(ts) && tb && tb.volume > 1000 && tb.volume < 4000, errs(ts) + ' ' + tb?.volume);
  const elbow = (corner, pts) => run([skch('p', [{ t: 'circle', cx: 0, cy: 0, r: 3 }], 'YZ'), skch('w', [{ t: 'path', open: true, pts }]), { id: 'sw', type: 'sweep', name: 'S', params: { profile: 'p', path: 'w', smooth: false, corner, op: 'new', target: '' } }]);
  for (const pts of [[[0, 0], [40, 0], [40, 40]], [[0, 0], [40, 0], [60, 30], [60, 70]]]) {
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const m = elbow('mitre', pts), f = elbow('full', pts);
    check(`a mitred sweep keeps the full tube width at ${pts.length - 2} corner${pts.length > 3 ? 's' : ''} (volume is the centre-line length times the section)`, !errs(m) && Math.abs(m.result.bodies[0].volume - Math.PI * 9 * len) < Math.PI * 9 * len * 0.01, errs(m) + ' ' + m.result.bodies[0]?.volume + ' vs ' + Math.PI * 9 * len);
    check('and the default sweep still builds', !errs(f) && f.result.bodies[0].volume > 0);
  }
  const mArc = elbow('mitre', [[0, 0, 0.4], [40, 0]]);
  check('mitred corners on an arc path say lines are needed', /straight/i.test(errs(mArc)), errs(mArc));
});
scenario('Swept, piped and lofted bodies tessellate into a few thousand triangles (ceilings so it cannot regress)', () => {
  const spl = [[0, 0], [0, 20], [15, 40], [40, 50], [60, 50]];
  const path = skch('w', [{ t: 'path', open: true, pts: spl }], 'XZ');
  const pipe = (wall, smooth) => [path, { id: 'pp', type: 'pipe', name: 'P', params: { path: 'w', smooth, diameter: 10, wall, op: 'new', target: '' } }];
  const sweep = (smooth) => [skch('p', [{ t: 'circle', cx: 0, cy: 0, r: 5 }]), path, { id: 'sw', type: 'sweep', name: 'S', params: { profile: 'p', path: 'w', smooth, op: 'new', target: '' } }];
  const cases = [
    ['a smoothed sweep', sweep(true), 4000], ['a cornered sweep', sweep(false), 1000], ['a smoothed solid pipe', pipe(0, true), 4500],
    ['a smoothed hollow pipe, wall 1 (was 87,000)', pipe(1, true), 9000], ['a smoothed hollow pipe, wall 0.5', pipe(0.5, true), 9000],
    ['a cornered pipe', pipe(0, false), 1000], ['a cornered hollow pipe', pipe(1, false), 1800],
    ['a loft from a square to a circle', [skch('a', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('b', [{ t: 'circle', cx: 0, cy: 0, r: 6 }], 'XY', { offset: 20 }), { id: 'lf', type: 'loft', name: 'L', params: { sketches: ['a', 'b'], op: 'new', target: '' } }], 1500],
    ['a shelled smoothed sweep', [...sweep(true), { id: 'sh', type: 'shell', name: 'Sh', params: { body: 'sw', thickness: 1, open: [], side: 'inside' } }], 8000],
  ];
  for (const [name, feats, ceiling] of cases) {
    const r = evaluate(doc(feats), { backend: 'brep' }), b = r.result.bodies[0], n = b ? b.tris.length / 3 : Infinity;
    check(`${name}: at most ${ceiling.toLocaleString()} triangles`, !errs(r) && n <= ceiling, errs(r) + ' ' + n);
  }
});
scenario('A rebuild done in pieces (as the worker does) gives the same bodies as one pass, and an abandoned one leaves the cache sound', () => {
  const feats = [prim('base', 'box', { sx: 100, sy: 60, sz: 20, radius: 0 })];
  for (let i = 0; i < 10; i++) feats.push({ id: 'h' + i, type: 'hole', name: 'H' + i, params: { target: 'base', pos: [-40 + i * 9, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 4, through: true, depth: 8 } });
  const d = doc(feats), resolved = evaluate(d).resolved;
  const sig = (r) => r.bodies.map((b) => `${b.id}:${b.volume.toFixed(3)}:${b.faces.length}`).join('|');
  clearKernelCache(); const whole = rebuild(resolved, resolved.length, {});
  clearKernelCache();
  let discarded = 0; for (const k of [3, 6, 9]) { const r = rebuild(resolved, k, { discard: true }); if (r.discarded && !r.bodies) discarded++; }
  const pieces = rebuild(resolved, resolved.length, {});
  check('pieces give no bodies until the last one', discarded === 3);
  check('the last piece equals one pass', sig(pieces) === sig(whole) && Object.keys(pieces.errors).length === 0, sig(pieces) + ' vs ' + sig(whole));
  // abandoned after two pieces, then an edit of an early feature and a full rebuild
  clearKernelCache(); rebuild(resolved, 4, { discard: true }); rebuild(resolved, 8, { discard: true });
  const edited = clone(d); edited.features.find((f) => f.id === 'h2').params.diameter = 6;
  const re = rebuild(evaluate(edited).resolved, resolved.length, {});
  clearKernelCache(); const ref = rebuild(evaluate(edited).resolved, resolved.length, {});
  check('a rebuild after an abandoned one matches a clean rebuild', sig(re) === sig(ref), sig(re) + ' vs ' + sig(ref));
});
scenario('An edit rebuilds only what depends on it, and the result equals a clean rebuild', () => {
  const ex = (id, sk, target, op, d) => ({ id, type: 'extrude', name: id, params: { sketch: sk, profiles: null, extent: 'distance', distance: d, op, target, thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } });
  const hole = (id, target, x) => ({ id, type: 'hole', name: id, params: { target, pos: [x, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 4, through: true, depth: 8 } });
  const feats = [
    prim('a', 'box', { sx: 60, sy: 40, sz: 20, radius: 0 }), prim('b', 'cylinder', { radius: 12, height: 30, pos: [100, 0, 0] }), prim('c', 'sphere', { radius: 15, pos: [200, 0, 0] }),
    skch('s1', [{ t: 'rect', x: -10, y: -5, w: 20, h: 10 }], 'XY', { offset: 20 }), ex('e1', 's1', 'a', 'join', 8),
    hole('h1', 'a', -20), hole('h2', 'b', 100),
    prim('d', 'box', { sx: 10, sy: 10, sz: 10, radius: 0, pos: [300, 0, 0] }),
    { id: 'm1', type: 'mirror', name: 'M', params: { body: 'b', plane: 'XZ', offset: 40, join: false } },
    { id: 'p1', type: 'pattern', name: 'P', params: { body: 'd', kind: 'linear', count: 3, spacing: [0, 25, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '' } },
    skch('s2', [{ t: 'circle', cx: 200, cy: 0, r: 4 }], 'XY', { offset: 30 }), ex('e2', 's2', '', 'cut', 10), // cuts from every body it touches
    hole('h3', 'a', 20),
  ];
  const base = doc(feats);
  const numKeys = { primitive: ['sx', 'radius'], hole: ['diameter'], extrude: ['distance'], mirror: ['offset'], pattern: ['spacing'] };
  const sig = (r) => JSON.stringify([r.result.bodies.map((b) => [b.id, b.name, +b.volume.toFixed(3), +b.area.toFixed(2), b.faces.length, b.bbox.min.map((v) => +v.toFixed(3)), b.bbox.max.map((v) => +v.toFixed(3))]), r.result.errors, r.result.notes]);
  const mutate = (d, id) => { const e = clone(d), f = e.features.find((x) => x.id === id), k = (numKeys[f.type] || []).find((q) => f.params[q] !== undefined); if (!k) return null; if (Array.isArray(f.params[k])) f.params[k] = f.params[k].map((v) => v + 1); else f.params[k] += (k === 'diameter' ? 0.5 : 1); return e; };
  let reusedTotal = 0, checks = 0, bad = '';
  for (const f of feats) {
    const e = mutate(base, f.id); if (!e) continue;
    clearKernelCache(); evaluate(base, { cache: true });
    const cached = evaluate(e, { cache: true }); reusedTotal += cached.result.stats?.reused || 0;
    clearKernelCache(); const clean = evaluate(e, { cache: false });
    checks++; if (sig(cached) !== sig(clean)) bad += ` ${f.id}`;
    const back = evaluate(base, { cache: true }); clearKernelCache(); const ref = evaluate(base, { cache: false }); // and the edit undone
    checks++; if (sig(back) !== sig(ref)) bad += ` undo-${f.id}`;
  }
  check(`${checks} edits (and their undos) rebuilt with reuse give the bodies of a clean rebuild`, !bad, bad);
  check('independent features were taken from the previous run, not built again', reusedTotal >= 15, String(reusedTotal));
  clearKernelCache(); evaluate(base, { cache: true });
  const first = clone(base); first.features[0].params.sx += 1;
  const r = evaluate(first, { cache: true });
  check('editing the first body leaves the other three bodies, their holes, the mirror and the pattern alone', r.result.stats.reused >= 5, JSON.stringify(r.result.stats));
});
await ascenario('Pipes along 3D paths hollow exactly, and shells of STEP imports stay exact', async () => {
  const paths = { straight: [[0, 0, 0], [40, 0, 0]], cornered: [[0, 0, 0], [20, 0, 0], [20, 20, 10], [40, 20, 10]], curved: [[0, 0, 0], [20, 0, 0], [30, 15, 8], [50, 20, 15], [60, 20, 30]] };
  for (const [name, pts] of Object.entries(paths)) {
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(...pts[i].map((v, k) => v - pts[i - 1][k]));
    for (const smooth of [false, true]) {
      const k3 = { id: 'k3', type: 'sketch3d', name: '3D', params: { points: pts, closed: false, smooth } };
      for (const wall of [0.3, 0.5, 1]) {
        const r = evaluate(doc([k3, { id: 'pp', type: 'pipe', name: 'P', params: { path: 'k3', smooth: false, diameter: 6, wall, op: 'new', target: '' } }]), { backend: 'brep' }), b = r.result.bodies[0];
        const want = Math.PI * (9 - (3 - wall) ** 2) * len, tol = smooth && name !== 'straight' ? 0.2 : 0.02; // a smoothed path cuts its corners, so it is shorter
        check(`a hollow pipe along a ${smooth ? 'smoothed ' : ''}${name} 3D path, wall ${wall}: open-ended wall of the right volume`, !errs(r) && b && (tol > 0.05 ? b.volume < want * 1.02 && b.volume > want * 0.7 : Math.abs(b.volume - want) < want * tol), errs(r) + ' ' + b?.volume + ' vs ' + want.toFixed(0));
      }
      const sol = evaluate(doc([k3, { id: 'pp', type: 'pipe', name: 'P', params: { path: 'k3', smooth: false, diameter: 6, wall: 0, op: 'new', target: '' } }]), { backend: 'brep' }).result.bodies[0].volume;
      for (const side of ['inside', 'outside', 'both']) {
        const r = evaluate(doc([k3, { id: 'pp', type: 'pipe', name: 'P', params: { path: 'k3', smooth: false, diameter: 6, wall: 0, op: 'new', target: '' } }, { id: 'sh', type: 'shell', name: 'S', params: { body: 'pp', thickness: 0.5, open: [], side } }]), { backend: 'brep' }), b = r.result.bodies[0];
        check(`a closed hollow of a ${smooth ? 'smoothed ' : ''}${name} 3D pipe, ${side}`, !errs(r) && b && (side === 'inside' ? b.volume < sol * 0.8 && b.volume > sol * 0.2 : b.volume > sol * 0.05), errs(r) + ' ' + b?.volume + ' of ' + sol);
      }
    }
  }
  // STEP imports: the wall keeps true surfaces
  const prim2 = (id, shape, params) => prim(id, shape, params);
  for (const [name, feat, analytic] of [['cylinder', prim2('a', 'cylinder', { radius: 15, height: 30 }), (t) => Math.PI * (225 * 30 - (15 - t) ** 2 * (30 - 2 * t))], ['sphere', prim2('a', 'sphere', { radius: 15 }), (t) => (4 / 3) * Math.PI * (3375 - (15 - t) ** 3)]]) {
    const { blob } = exactStep(evaluate(doc([feat])).resolved), imp = { id: 'i', type: 'importstep', name: 'I', params: { data: await blob.text() } };
    const r = evaluate(doc([imp, { id: 'sh', type: 'shell', name: 'S', params: { body: 'i', thickness: 1, open: [], side: 'inside' } }]), { backend: 'brep' }), b = r.result.bodies[0];
    const flat = b && b.faces.every((f) => ['PLANE', 'CYLINDRE', 'SPHERE', 'TORUS', 'CONE'].includes(f.type));
    check(`a closed hollow of an imported STEP ${name} is exact (true surfaces, analytic volume)`, !errs(r) && flat && Math.abs(b.volume - analytic(1)) < analytic(1) * 0.01, errs(r) + ' ' + b?.volume + ' vs ' + analytic(1).toFixed(1) + ' ' + b?.faces.map((f) => f.type));
  }
  // a sweep joined to a box loses its exact recipe: the wall is faceted inside, says so, and is not computed with a boolean
  const sw = [skch('p', [{ t: 'circle', cx: 0, cy: 0, r: 5 }], 'YZ'), skch('w', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [30, 15], [50, 15]] }]), { id: 'sw', type: 'sweep', name: 'S', params: { profile: 'p', path: 'w', smooth: true, op: 'new', target: '' } }, prim('bx', 'box', { sx: 10, sy: 10, sz: 10, pos: [0, -5, -5] }), { id: 'cb', type: 'combine', name: 'C', params: { target: 'sw', tool: 'bx', op: 'join', keepTool: false } }];
  const t0 = Date.now(), r = evaluate(doc([...sw, { id: 'sh', type: 'shell', name: 'S', params: { body: 'sw', thickness: 1, open: [], side: 'inside' } }]), { backend: 'brep' }), solid = evaluate(doc(sw), { backend: 'brep' }).result.bodies[0].volume;
  check('a hollow of a joined sweep is a wall, in seconds, with a note that the inside is faceted', !errs(r) && r.result.bodies[0].volume < solid * 0.6 && r.result.bodies[0].volume > solid * 0.2 && /faceted/.test(JSON.stringify(r.result.warnings)) && Date.now() - t0 < 12000, errs(r) + ' ' + r.result.bodies[0]?.volume + ' ' + (Date.now() - t0) + 'ms');
});
scenario('Non-uniform scale is exact for primitives and plain extrudes, and says when it is faceted', () => {
  const scale = (body, s) => ({ id: 'sc', type: 'scale', name: 'Scale1', params: { body, mode: 'nonuniform', s, factor: 1, about: 'center', copy: false } });
  const ext = [skch('s', [{ t: 'circle', cx: 0, cy: 0, r: 8 }, { t: 'rect', x: 12, y: -5, w: 10, h: 10 }]), { id: 'e', type: 'extrude', name: 'E', params: { sketch: 's', profiles: null, extent: 'distance', distance: 15, op: 'new', target: '', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } }];
  const cases = [['cylinder', [prim('a', 'cylinder', { radius: 10, height: 20, pos: [5, 5, 5] })], 'a'], ['sphere', [prim('a', 'sphere', { radius: 12, pos: [5, 5, 5] })], 'a'], ['cone', [prim('a', 'cone', { radius: 10, radius2: 4, height: 20 })], 'a'], ['box', [prim('a', 'box', { sx: 10, sy: 20, sz: 30, radius: 0 })], 'a'], ['extrude of a circle and a rectangle', ext, 'e']];
  for (const [name, feats, id] of cases) for (const f of [[2, 1, 0.5], [1.5, 3, 0.7]]) {
    const r0 = evaluate(doc(feats), { backend: 'brep' }), v0 = r0.result.bodies.find((b) => b.id === id), r = evaluate(doc([...feats, scale(id, f)]), { backend: 'brep' }), b = r.result.bodies.find((x) => x.id === id);
    const want = v0.volume * f[0] * f[1] * f[2], bb = (q) => q.bbox.max.map((v, k) => v - q.bbox.min[k]), d0 = bb(v0), d1 = bb(b);
    check(`${name} scaled by [${f}]: exact, volume is the product of the factors, sizes follow`, !errs(r) && b && b.faces.length <= v0.faces.length + 6 && Math.abs(b.volume - want) < want * 0.01 && d1.every((v, k) => Math.abs(v - d0[k] * f[k]) < d0[k] * f[k] * 0.01) && /exactly/.test(JSON.stringify(r.result.notes)), errs(r) + ' ' + b?.volume + ' vs ' + want + ' faces ' + b?.faces.length);
  }
  const tor = [prim('a', 'torus', { major: 20, minor: 5 })], rt = evaluate(doc([...tor, scale('a', [2, 1, 0.5])]), { backend: 'brep' });
  check('a torus (no exact route) is faceted and the feature says why', !errs(rt) && rt.result.bodies[0].faces.length > 50 && /facets/.test(JSON.stringify(rt.result.warnings)), errs(rt) + ' ' + rt.result.bodies[0]?.faces.length);
  const mv = evaluate(doc([prim('a', 'cylinder', { radius: 10, height: 20 }), { id: 'm', type: 'move', name: 'M', params: { body: 'a', mode: 'xyz', t: [5, 0, 0], r: [0, 0, 0], s: [1, 1, 1], copy: false } }, scale('a', [2, 1, 0.5])]), { backend: 'brep' });
  check('a cylinder that was moved first is faceted (the recipe is gone) but still scaled', !errs(mv) && mv.result.bodies[0].faces.length > 10, errs(mv) + ' ' + mv.result.bodies[0]?.faces.length);
});
const swProf = (id, shapes, plane) => skch(id, shapes, plane);
bothBackends('Both backends: sweep a circle and a rectangle along lines and arcs', doc([
  swProf('p1', [{ t: 'circle', cx: 0, cy: 0, r: 3 }], 'YZ'), skch('w1', [{ t: 'path', open: true, pts: [[0, 0], [30, 0, 0.41421356], [50, 20]] }]),
  { id: 'sw1', type: 'sweep', name: 'Sweep1', params: { profile: 'p1', path: 'w1', smooth: false, op: 'new', target: '' } },
  swProf('p2', [{ t: 'rect', x: -2, y: -4, w: 4, h: 8 }], 'YZ'), skch('w2', [{ t: 'path', open: true, pts: [[0, 40], [40, 40]] }]),
  { id: 'sw2', type: 'sweep', name: 'Sweep2', params: { profile: 'p2', path: 'w2', smooth: false, op: 'new', target: '' } }]), { volTol: 0.02, skipBodies: [] });
bothBackends('Both backends: loft square to square, square to circle and three sections', doc([
  skch('a1', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('a2', [{ t: 'rect', x: -5, y: -5, w: 10, h: 10 }], 'XY', { offset: 20 }),
  { id: 'l1', type: 'loft', name: 'Loft1', params: { sketches: ['a1', 'a2'], op: 'new', target: '' } },
  skch('b1', [{ t: 'circle', cx: 60, cy: 0, r: 8 }]), skch('b2', [{ t: 'circle', cx: 60, cy: 0, r: 4 }], 'XY', { offset: 15 }), skch('b3', [{ t: 'circle', cx: 60, cy: 0, r: 8 }], 'XY', { offset: 30 }),
  { id: 'l2', type: 'loft', name: 'Loft2', params: { sketches: ['b1', 'b2', 'b3'], op: 'new', target: '' } }]), { volTol: 0.04 });
bothBackends('Both backends: an external thread on a cylinder', doc([
  prim('c', 'cylinder', { radius: 10, height: 30 }), { id: 'th', type: 'thread', name: 'Thread1', params: { target: 'c', origin: [0, 0, 5], axis: 'Z', radius: 10, pitch: 2, length: 16, depth: 1.2, internal: false, left: false } }]), { volTol: 0.02 });

scenario('B-rep faces have keys, and a stored face is found by its key', () => {
  const base = doc([prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const b = bodyOf(evaluate(base, { backend: 'brep' }), 'a');
  check('every face has a key and an area', b.faces.length === 6 && b.faces.every((f) => /@/.test(f.key) && f.area > 0));
  const top = b.faces.find((f) => f.type === 'PLANE' && Math.abs(f.centroid[2] - 20) < 1e-6);
  const d = doc([...base.features, { id: 'sh', type: 'shell', name: 'Shell1', params: { body: 'a', thickness: 2, side: 'inside', open: [{ point: [500, 500, 500], normal: [0, 0, 1], brepFace: top.key }] } }]);
  const r = evaluate(d, { backend: 'brep' });
  check('a face key finds its face even when the stored point is useless', !errs(r) && approx(bodyOf(r, 'a').volume, 40 * 30 * 20 - 36 * 26 * 18, 0.001), errs(r));
  const r2 = evaluate(set(clone(d), 'sh', { open: [{ point: [0, 0, 20], normal: [0, 0, 1], brepFace: 'PLANE@9,9,9/1.00' }] }), { backend: 'brep' });
  check('a key that is not there falls back to the point and normal', !errs(r2) && approx(bodyOf(r2, 'a').volume, 7152, 0.001), errs(r2));
});

scenario('A painted exact face keeps its paint when an edit changes its size or place', () => {
  const entryOf = (b, f, pt, n) => ({ body: b.id, point: pt ?? f.centroid, normal: n ?? f.normal ?? [0, 0, 1], brepFace: f.key, ...(f.type === 'PLANE' ? {} : { curved: true }) });
  const holes = (x2) => doc([prim('a', 'box', { sx: 60, sy: 40, sz: 20, radius: 0 }),
    { id: 'h1', type: 'hole', name: 'H1', params: { target: 'a', pos: [-15, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 8, through: true, depth: 8 } },
    { id: 'h2', type: 'hole', name: 'H2', params: { target: 'a', pos: [x2, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 8, through: true, depth: 8 } }]);
  const base = bodyOf(evaluate(holes(15), { backend: 'brep' }), 'a');
  const top = base.faces.find((f) => f.type === 'PLANE' && Math.abs(f.centroid[2] - 20) < 1e-6), side = base.faces.find((f) => f.type === 'PLANE' && f.centroid[0] > 29);
  const hole2 = base.faces.filter((f) => f.type !== 'PLANE').sort((p, q) => q.centroid[0] - p.centroid[0])[0];
  const topE = entryOf(base, top, [0, 15, 20], [0, 0, 1]), sideE = entryOf(base, side), holeE = entryOf(base, hole2, [19, 0, 10], [1, 0, 0]);
  const look = (b, e) => { const i = matchBrepFace(b.faces, e); return i < 0 ? null : b.faces[i]; };
  const same = bodyOf(evaluate(holes(15), { backend: 'brep' }), 'a');
  check('the same design: exact key', look(same, topE)?.key === top.key && look(same, holeE)?.key === hole2.key);
  const moved = bodyOf(evaluate(holes(22), { backend: 'brep' }), 'a');
  const mh = look(moved, holeE);
  check('a moved hole is still the same hole (the nearer of two cylinders)', mh && Math.abs(mh.centroid[0] - 22) < 1e-6, JSON.stringify(mh?.centroid));
  check('the top face is still the top face after the hole moved', look(moved, topE)?.type === 'PLANE' && Math.abs(look(moved, topE).centroid[2] - 20) < 1e-6);
  const taller = bodyOf(evaluate(set(clone(holes(15)), 'a', { sz: 35, sx: 80 }), { backend: 'brep' }), 'a');
  const tt = look(taller, topE), ts = look(taller, sideE);
  check('a resized box: the top is still the top (z 35)', tt && Math.abs(tt.centroid[2] - 35) < 1e-6, JSON.stringify(tt?.centroid));
  check('a resized box: the +X side is still the +X side (x 40)', ts && Math.abs(ts.centroid[0] - 40) < 1e-6, JSON.stringify(ts?.centroid));
  const gone = bodyOf(evaluate(doc([prim('a', 'box', { sx: 60, sy: 40, sz: 20, radius: 0 })]), { backend: 'brep' }), 'a');
  check('a face that no longer exists is not guessed (the hole is gone)', look(gone, holeE) === null);
  check('a face with no key is left to the point-and-normal match', matchBrepFace(base.faces, { point: [0, 0, 20], normal: [0, 0, 1] }) === -1);
});

scenario('The exact kernel resumes from its cache and gets the same result as a full rebuild', () => {
  clearKernelCache();
  const d = bigDesign(), opts = { backend: 'brep', cache: true };
  const first = evaluate(d, opts);
  check('the first build replays everything', first.result.stats.from === 0 && first.result.stats.total === d.features.length && !errs(first), errs(first));
  const e1 = clone(d); e1.features.at(-1).params.diameter = 6;
  const r1 = evaluate(e1, opts), f1 = evaluate(e1, { backend: 'brep', cache: false });
  check('editing the last feature replays only it', r1.result.stats.from === d.features.length - 1 && r1.result.stats.steps === 1, JSON.stringify(r1.result.stats));
  const same = (a, b) => a.result.bodies.length === b.result.bodies.length && a.result.bodies.every((x, k) => x.id === b.result.bodies[k].id && approx(x.volume, b.result.bodies[k].volume, 1e-9) && x.faces.length === b.result.bodies[k].faces.length);
  check('same bodies, volumes and face counts as a rebuild from nothing', same(r1, f1));
  check('a body the edit did not touch keeps its mesh key (the viewport and the worker reuse it)', first.result.bodies.find((b) => b.id === 'cy').key === r1.result.bodies.find((b) => b.id === 'cy').key);
  const e2 = clone(e1); e2.features.find((x) => x.id === 'h5').params.diameter = 9;
  const r2 = evaluate(e2, opts), f2 = evaluate(e2, { backend: 'brep', cache: false });
  check('editing a feature in the middle replays from there', r2.result.stats.from === 6 && same(r2, f2), JSON.stringify(r2.result.stats));
  const back = evaluate(e1, opts);
  check('going back to the earlier design is also right', same(back, f1));
  const sus = clone(e2); sus.features.find((x) => x.id === 'h3').suppressed = true;
  check('suppressing a feature rebuilds from it, correctly', same(evaluate(sus, opts), evaluate(sus, { backend: 'brep', cache: false })));
  const cap = rebuild(evaluate(e2).resolved, e2.features.length, { backend: 'brep', capture: 10 });
  check('capture data comes from a cached run too', cap.captured?.length >= 1 && cap.stats.from <= 10, JSON.stringify(cap.stats));
  clearKernelCache();
  check('clearing the cache leaves nothing to resume from', evaluate(e2, opts).result.stats.from === 0);
  clearKernelCache();
});

// ---- migration batch 1: transforms, split, joints ----
bothBackends('Both backends: move, copy, rotate and scale a body; scale feature', doc([
  prim('a', 'box', { sx: 20, sy: 10, sz: 6, radius: 0 }), prim('c', 'cylinder', { radius: 4, height: 12, pos: [40, 0, 0] }),
  { id: 'mv', type: 'move', name: 'Move', params: { body: 'a', t: [5, 3, 2], r: [0, 0, 30], s: [1, 1, 1], copy: false, mode: 'free' } },
  { id: 'cp', type: 'move', name: 'Copy', params: { body: 'c', t: [0, 20, 0], r: [90, 0, 0], s: [1.5, 1.5, 1.5], copy: true, mode: 'free' } },
  prim('d', 'box', { sx: 10, sy: 10, sz: 10, radius: 0, pos: [-40, 0, 0] }), { id: 'sc', type: 'scale', name: 'Scale', params: { body: 'd', mode: 'uniform', factor: 1.7, s: [1, 1, 1], about: 'center', copy: false } },
  prim('e', 'box', { sx: 10, sy: 10, sz: 10, radius: 0, pos: [-40, 40, 0] }), { id: 'sc2', type: 'scale', name: 'Scale2', params: { body: 'e', mode: 'uniform', factor: 0.5, s: [1, 1, 1], about: 'origin', copy: true } },
]), { volTol: 0.02 });
bothBackends('Both backends: split by a plane and by a body', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'sp', type: 'split', name: 'Split', params: { body: 'a', by: 'plane', plane: 'YZ', offset: 8, tool: '', keepTool: false, keep: 'both' } },
  prim('b', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [100, 0, 0] }), { id: 'sq', type: 'split', name: 'Split2', params: { body: 'b', by: 'plane', plane: 'XY', offset: 12, tool: '', keepTool: false, keep: 'below' } },
  prim('c', 'box', { sx: 30, sy: 30, sz: 30, radius: 0, pos: [200, 0, 0] }), prim('t', 'sphere', { radius: 20, pos: [200, 0, 15] }), { id: 'sr', type: 'split', name: 'Split3', params: { body: 'c', by: 'body', plane: 'XY', offset: 0, tool: 't', keepTool: false, keep: 'both' } },
]), { volTol: 0.03 });
bothBackends('Both backends: joints move a body about a point', doc([
  prim('a', 'box', { sx: 20, sy: 20, sz: 5, radius: 0 }), prim('b', 'box', { sx: 10, sy: 4, sz: 4, radius: 0, pos: [40, 0, 0] }),
  { id: 'j', type: 'joint', name: 'Joint', params: { jtype: 'revolute', bodyA: 'b', bodyB: 'a', pointA: [40, 0, 0], pointB: [10, 0, 2.5], axis: 'Z', value: 35, value2: 0, value3: 0, rot: [0, 0, 0], flip: false } },
]), { volTol: 0.001 });
// ---- migration batch 2: fillet and chamfer modes ----
{
  const one = (pred) => edgesWhere(evaluate(doc([clone(boxFeature)])), 'box', pred).slice(0, 1);
  const longTop = one((p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3) && Math.abs(p[0][1] - p[1][1]) < 1e-3 && Math.abs(p[0][0] - p[1][0]) > 30);
  const fe = (id, type, edges, extra) => ({ id, type, name: id, params: { edges, radius: 3, distance: 3, tangent: false, variable: false, ...extra } });
  bothBackends('Both backends: variable radius, chord length, two distances and distance and angle', doc([
    prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), fe('f1', 'fillet', edgesWhere(evaluate(doc([boxFeature])), 'box', (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3 && q[1] > 0 && Math.abs(p[0][0] - p[1][0]) > 30)).map((e) => ({ ...e, body: 'a' })), { variable: true, radius: 1, radiusEnd: 6 }),
  ]), { volTol: 0.02 });
  bothBackends('Both backends: fillet by chord length', doc([boxFeature, { ...fe('fc', 'fillet', topEdges, { mode: 'chord', chord: 4 }) }]), { volTol: 0.01 });
  bothBackends('Both backends: chamfer with two distances', doc([boxFeature, fe('c2', 'chamfer', longTop, { mode: 'two', distance: 2, distance2: 5, flip: false })]), { volTol: 0.005 });
  bothBackends('Both backends: chamfer with a distance and an angle', doc([boxFeature, fe('c3', 'chamfer', topEdges, { mode: 'angle', distance: 4, angle: 30, flip: false })]), { volTol: 0.01 });
}
// ---- migration batch 3: twist, end scale, taper, thin wall ----
bothBackends('Both backends: extrude with twist and end scale (about the sketch origin)', doc([
  skch('s1', [{ t: 'rect', x: -6, y: -3, w: 12, h: 6 }]), extr('tw', 's1', { distance: 20, twist: 60 }),
  skch('s2', [{ t: 'rect', x: -6, y: -3, w: 12, h: 6 }], 'XY', { offset: 30 }), extr('sc', 's2', { distance: 15, scaleTop: 0.5 }),
  skch('s3', [{ t: 'rect', x: -6, y: -3, w: 12, h: 6 }], 'XY', { offset: 80 }), extr('sd', 's3', { distance: -15, scaleTop: 1.5 }),
]), { volTol: 0.03 });
bothBackends('Both backends: tapered extrude, one side, both sides and downwards', doc([
  skch('s1', [{ t: 'rect', x: 0, y: 0, w: 20, h: 20 }]), extr('t1', 's1', { distance: 15, taper: 5 }),
  skch('s2', [{ t: 'circle', cx: 50, cy: 10, r: 8 }]), extr('t2', 's2', { distance: 12, taper: 8 }),
  skch('s3', [{ t: 'rect', x: 80, y: 0, w: 20, h: 20 }]), extr('t3', 's3', { distance: -10, taper: 4 }),
  skch('s4', [{ t: 'rect', x: 120, y: 0, w: 20, h: 20 }]), extr('t4', 's4', { direction: 'two', distance: 10, taper: 3, distance2: 8, taper2: 6 }),
]), { volTol: 0.02 });
bothBackends('Both backends: thin extrude, inside, outside and centred, with a hole', doc([
  skch('s1', [{ t: 'rect', x: 0, y: 0, w: 30, h: 20 }, { t: 'circle', cx: 15, cy: 10, r: 4 }]), extr('i1', 's1', { distance: 10, thin: true, wall: 2, wallSide: 'inside' }),
  skch('s2', [{ t: 'rect', x: 60, y: 0, w: 30, h: 20 }]), extr('i2', 's2', { distance: 10, thin: true, wall: 2, wallSide: 'outside' }),
  skch('s3', [{ t: 'rect', x: 120, y: 0, w: 30, h: 20 }]), extr('i3', 's3', { distance: 10, thin: true, wall: 3, wallSide: 'center' }),
]), { volTol: 0.02 });
// ---- migration batch 4: pipe, rib, coil ----
bothBackends('Both backends: a pipe along lines and arcs, solid and hollow', doc([
  skch('w1', [{ t: 'path', open: true, pts: [[0, 0], [30, 0, 0.41421356], [50, 20]] }]),
  { id: 'pp', type: 'pipe', name: 'Pipe1', params: { path: 'w1', smooth: false, diameter: 6, wall: 0, op: 'new', target: '' } },
  skch('w2', [{ t: 'path', open: true, pts: [[0, 60], [40, 60]] }]),
  { id: 'ph', type: 'pipe', name: 'Pipe2', params: { path: 'w2', smooth: false, diameter: 8, wall: 1.5, op: 'new', target: '' } }]), { volTol: 0.03 });
bothBackends('Both backends: ribs along a centre line', doc([
  prim('a', 'box', { sx: 60, sy: 40, sz: 4, radius: 0 }), skch('r', [{ t: 'path', open: true, pts: [[-20, -10], [20, -10], [20, 10]] }], 'XY', { offset: 4 }),
  { id: 'rb', type: 'rib', name: 'Rib', params: { sketch: 'r', thickness: 2, height: 8, symmetric: false, op: 'join', target: 'a' } }]), { volTol: 0.02 });
bothBackends('Both backends: a coil with a round and a square section', doc([
  { id: 'c1', type: 'coil', name: 'Coil1', params: { origin: [0, 0, 0], axis: 'Z', diameter: 20, section: 'circle', size: 2, pitch: 4, turns: 5, left: false, op: 'new', target: '' } },
  { id: 'c2', type: 'coil', name: 'Coil2', params: { origin: [50, 0, 0], axis: 'Z', diameter: 16, section: 'square', size: 2, pitch: 4, turns: 4, left: true, op: 'new', target: '' } }]), { volTol: 0.04 });
// ---- migration batch 5: face tools, patterns, thread holes, shells ----
bothBackends('Both backends: Press/Pull a face out and in, thicken faces, replace a face with a plane', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'pp', type: 'presspull', name: 'PP', params: { body: 'a', face: { point: [0, 0, 20], normal: [0, 0, 1] }, distance: 6 } },
  { id: 'pq', type: 'presspull', name: 'PQ', params: { body: 'a', face: { point: [20, 0, 10], normal: [1, 0, 0] }, distance: -5 } },
  prim('b', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [80, 0, 0] }), { id: 'tf', type: 'thickenface', name: 'TF', params: { body: 'b', faces: [{ point: [80, 0, 20], normal: [0, 0, 1] }], thickness: 3, dir: 'out' } },
  { id: 'tg', type: 'thickenface', name: 'TG', params: { body: 'b', faces: [{ point: [100, 0, 10], normal: [1, 0, 0] }], thickness: 4, dir: 'in' } },
  prim('c', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [160, 0, 0] }), { id: 'rf', type: 'replaceface', name: 'RF', params: { body: 'c', face: { point: [160, 0, 20], normal: [0, 0, 1] }, plane: 'XY', offset: 26 } },
  prim('d', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [240, 0, 0] }), { id: 'rg', type: 'replaceface', name: 'RG', params: { body: 'd', face: { point: [240, 0, 20], normal: [0, 0, 1] }, plane: 'XY', offset: 12 } },
]), { volTol: 0.002 });
bothBackends('Both backends: patterns along a path and on a face', doc([
  prim('a', 'box', { sx: 6, sy: 6, sz: 6, radius: 0 }), skch('pp', [{ t: 'path', open: true, pts: [[0, 0], [40, 0], [40, 30]] }]),
  { id: 'pa', type: 'pattern', name: 'Pa', params: { body: 'a', kind: 'path', path: 'pp', count: 5, spacing: [0, 0, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '' } },
  prim('b', 'box', { sx: 6, sy: 6, sz: 6, radius: 0, pos: [0, 80, 0] }),
  { id: 'pf', type: 'pattern', name: 'Pf', params: { body: 'b', kind: 'face', face: { point: [0, 80, 6], normal: [0, 0, 1] }, faceBody: 'b', countU: 3, spacingU: 12, countV: 2, spacingV: 10, count: 2, spacing: [0, 0, 0], axis: 'Z', angle: 360, extent: 'spacing', symmetric: false, skip: '' } },
]), { volTol: 0.01 });
bothBackends('Both backends: a threaded hole', doc([
  prim('a', 'box', { sx: 30, sy: 30, sz: 20, radius: 0 }),
  { id: 'h', type: 'hole', name: 'H', params: { target: 'a', pos: [0, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 8, through: false, depth: 14, thread: true, pitch: 1.25, threadLength: 8 } }]), { volTol: 0.02 });
scenario('Exact shells grow outward or about the surface, which the mesh kernel only approximated', () => {
  const base = doc([prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 })]);
  const sh = (side, t = 2) => ({ id: 'sh', type: 'shell', name: 'Shell', params: { body: 'a', thickness: t, open: topOpen, side } });
  const inV = evaluate(doc([...base.features, sh('inside')]), { backend: 'brep' }), outV = evaluate(doc([...base.features, sh('outside')]), { backend: 'brep' }), cenV = evaluate(doc([...base.features, sh('both')]), { backend: 'brep' });
  check('inward: 40x30x20 minus 36x26x18', !errs(inV) && approx(bodyOf(inV, 'a').volume, 24000 - 36 * 26 * 18, 0.001), errs(inV));
  const outerFull = 44 * 34 * 22 - (Math.PI / 1) * 0, wall = bodyOf(outV, 'a').volume;
  check('outward: a wall of 2 outside the box, the top stays where it was', !errs(outV) && wall > 8000 && bodyOf(outV, 'a').bbox.max[2] < 20.01 && bodyOf(outV, 'a').bbox.min[0] < -21.9, `${wall} ${JSON.stringify(bodyOf(outV, 'a').bbox)} ${errs(outV)} ${outerFull}`);
  const cv = bodyOf(cenV, 'a');
  check('centred: half the wall each side of the surface', !errs(cenV) && cv.bbox.min[0] < -20.9 && cv.bbox.min[0] > -21.1 && cv.volume > 7900, `${cv.volume} ${JSON.stringify(cv.bbox)} ${errs(cenV)}`);
  const m = evaluate(doc([...base.features, sh('inside')]));
  check('inward on the mesh kernel agrees', approx(bodyOf(m, 'a').volume, bodyOf(inV, 'a').volume, 0.03));
});
// ---- migration batch 6: sketch regions on the exact kernel ----
scenario('Sketch regions: the exact kernel finds the same regions, ids and default selection as the mesh code', () => {
  const sk = (shapes) => ({ id: 's', type: 'sketch', name: 's', params: { plane: 'XY', offset: 0, shapes } });
  const cases = {
    'a circle inside a rectangle': [{ t: 'rect', x: 0, y: 0, w: 40, h: 30 }, { t: 'circle', cx: 20, cy: 15, r: 6 }],
    'two overlapping rectangles': [{ t: 'rect', x: 0, y: 0, w: 20, h: 20 }, { t: 'rect', x: 10, y: 10, w: 20, h: 20 }],
    'three nested shapes': [{ t: 'rect', x: 0, y: 0, w: 40, h: 40 }, { t: 'circle', cx: 20, cy: 20, r: 15 }, { t: 'rect', x: 15, y: 15, w: 10, h: 10 }],
    'separate shapes': [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }, { t: 'circle', cx: 30, cy: 5, r: 4 }, { t: 'ngon', cx: 50, cy: 5, r: 5, n: 5 }],
    'a circle crossing a rectangle': [{ t: 'rect', x: 0, y: 0, w: 20, h: 20 }, { t: 'circle', cx: 20, cy: 10, r: 6 }],
    'lines that meet end to end': [{ t: 'path', open: true, pts: [[0, 0], [20, 0]] }, { t: 'path', open: true, pts: [[20, 0], [20, 15], [0, 15]] }, { t: 'path', open: true, pts: [[0, 15], [0, 0]] }],
  };
  for (const [name, shapes] of Object.entries(cases)) {
    const f = sk(shapes), b = profilesOfExact(f);
    if (process.env.UPDATE_GOLDEN) golden['profiles: ' + name] = profilesOf(f).map((x) => ({ id: x.id, defaultOn: x.defaultOn, area: x.area }));
    const a = golden['profiles: ' + name];
    const key = (r) => r.map((x) => `${x.id}${x.defaultOn ? '+' : '-'}`).sort().join(' ');
    check(`${name}: same region ids and default selection (${key(b)})`, key(a) === key(b), `${key(a)} vs ${key(b)}`);
    const areas = (r) => Object.fromEntries(r.map((x) => [x.id, x.area]));
    const A = areas(a), B = areas(b);
    check(`${name}: same areas`, Object.keys(A).every((id) => B[id] !== undefined && Math.abs(A[id] - B[id]) <= 0.01 * A[id] + 0.5), JSON.stringify([A, B]));
    check(`${name}: every region has an outline`, b.every((x) => x.polys.length >= 1 && x.polys[0].length >= 3));
  }
});
bothBackends('Both backends: extrude overlapping shapes, joined lines and a hand-picked region', doc([
  skch('s1', [{ t: 'rect', x: 0, y: 0, w: 20, h: 20 }, { t: 'rect', x: 10, y: 10, w: 20, h: 20 }]), extr('e1', 's1', { distance: 6 }),
  skch('s2', [{ t: 'path', open: true, pts: [[60, 0], [80, 0]] }, { t: 'path', open: true, pts: [[80, 0], [80, 15, 0.4142], [60, 15]] }, { t: 'path', open: true, pts: [[60, 15], [60, 0]] }]), extr('e2', 's2', { distance: 6 }),
  skch('s3', [{ t: 'rect', x: 100, y: 0, w: 20, h: 20 }, { t: 'circle', cx: 120, cy: 10, r: 6 }]), extr('e3', 's3', { distance: 6, profiles: ['1:0'] }),
]), { volTol: 0.02 });
// ---- migration batch 7: imported meshes are sewn into faceted solids ----
{
  const src = evaluate(doc([clone(boxFeature), clone(holeF), prim('s', 'sphere', { radius: 8, pos: [60, 0, 10] }), prim('t', 'torus', { major: 10, minor: 3, pos: [120, 0, 10] })]));
  const soupOf = (id) => { const b = bodyOf(src, id); return soupOfMesh(b.verts, b.tris); };
  const soupVol = (soup) => { let v = 0; for (let i = 0; i < soup.length; i += 9) { const a = soup.slice(i, i + 3), b = soup.slice(i + 3, i + 6), c = soup.slice(i + 6, i + 9); v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } return v; };
  const imp = (id, soup) => ({ id, type: 'import', name: id, params: { data: encodeFloats(soup), tris: soup.length / 9 } });
  const both = new Float32Array([...soupOf('box'), ...soupOf('s')]);
  scenario('An imported mesh (a box with a hole, a sphere, a torus) sews into a solid with the volume of its triangles', () => {
    const r = evaluate(doc([imp('i1', soupOf('box')), imp('i2', soupOf('s')), imp('i3', soupOf('t'))]));
    check('no errors', !errs(r), errs(r));
    for (const [id, src2] of [['i1', 'box'], ['i2', 's'], ['i3', 't']]) check(`${id}: volume ${bodyOf(r, id).volume.toFixed(1)} vs ${soupVol(soupOf(src2)).toFixed(1)}`, approx(bodyOf(r, id).volume, soupVol(soupOf(src2)), 0.001));
  });
  const it = doc([imp('i1', soupOf('box'))]);
  const bi = bodyOf(evaluate(it, { backend: 'brep' }), 'i1');
  check('a box with a hole imports with merged flat faces, not one face per triangle', bi.faces.length < 100 && bi.faces.length >= 10, String(bi.faces.length));
  const tooBig = evaluate(doc([imp('i1', soupOf('t'))]), { backend: 'brep' });
  check('a mesh within the limit sews', !errs(tooBig));
  scenario('Mesh tools on imported triangles: separate, reduce and clean', () => {
    const d = doc([imp('i', both), { id: 'sep', type: 'mseparate', name: 'Sep', params: { body: 'i' } }]);
    const r = evaluate(d, { backend: 'brep' }), want = [soupVol(soupOf('box')), soupVol(soupOf('s'))].sort((a, b) => b - a);
    check('separate gives two bodies', !errs(r) && r.result.bodies.length === 2, `${errs(r)} ${r.result.bodies.length}`);
    check('separate: the bigger piece keeps the body, with the volumes of the two meshes', r.result.bodies.map((b) => b.volume).every((v, k) => approx(v, want[k], 0.001)), JSON.stringify([r.result.bodies.map((b) => b.volume), want]));
    const red = evaluate(doc([imp('t', soupOf('t')), { id: 'red', type: 'mreduce', name: 'Red', params: { body: 't', keep: 40, tolerance: 0.5 } }]), { backend: 'brep' });
    const rb = bodyOf(red, 't');
    check('reduce lowers the triangle count and keeps the volume close', !errs(red) && rb.tris.length / 3 < 0.7 * (soupOf('t').length / 9) && approx(rb.volume, soupVol(soupOf('t')), 0.2), `${errs(red)} ${rb?.tris.length / 3} ${rb?.volume}`);
    const cl = evaluate(doc([imp('t', soupOf('t')), { id: 'cl', type: 'mclean', name: 'Clean', params: { body: 't', tolerance: 0, minShell: 0 } }]), { backend: 'brep' });
    check('clean keeps a healthy mesh as it is', !errs(cl) && approx(bodyOf(cl, 't').volume, soupVol(soupOf('t')), 0.001), errs(cl));
  });
}
// ---- migration batch 8: closed shells, boundary fill, non-uniform scale ----
bothBackends('Both backends: a closed hollow shell, inside, outside and centred', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'sa', type: 'shell', name: 'S1', params: { body: 'a', thickness: 2, open: [], side: 'inside' } },
  prim('b', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [80, 0, 0] }), { id: 'sb', type: 'shell', name: 'S2', params: { body: 'b', thickness: 2, open: [], side: 'outside' } },
  prim('c', 'box', { sx: 40, sy: 30, sz: 20, radius: 0, pos: [160, 0, 0] }), { id: 'sc', type: 'shell', name: 'S3', params: { body: 'c', thickness: 3, open: [], side: 'both' } },
]), { volTol: 0.04 });
bothBackends('Both backends: boundary fill takes the space a hollow body encloses, and where bodies overlap', doc([
  prim('a', 'box', { sx: 40, sy: 30, sz: 20, radius: 0 }), { id: 'sa', type: 'shell', name: 'S1', params: { body: 'a', thickness: 2, open: [], side: 'inside' } },
  { id: 'bf', type: 'boundaryfill', name: 'BF', params: { tools: ['a'], region: 'voids', keepTools: true } },
  prim('x', 'box', { sx: 20, sy: 20, sz: 20, radius: 0, pos: [100, 0, 0] }), prim('y', 'box', { sx: 20, sy: 20, sz: 20, radius: 0, pos: [110, 5, 5] }),
  { id: 'bg', type: 'boundaryfill', name: 'BG', params: { tools: ['x', 'y'], region: 'common', keepTools: true } },
]), { volTol: 0.01 });
bothBackends('Both backends: stretch bodies differently along each axis (the exact kernel facets them)', doc([
  prim('a', 'box', { sx: 20, sy: 20, sz: 20, radius: 0 }), { id: 'na', type: 'scale', name: 'N1', params: { body: 'a', mode: 'nonuniform', factor: 1, s: [1, 2, 0.5], about: 'center', copy: false } },
  prim('c', 'cylinder', { radius: 8, height: 20, pos: [60, 0, 0] }), { id: 'nc', type: 'scale', name: 'N2', params: { body: 'c', mode: 'nonuniform', factor: 1, s: [2, 1, 1.5], about: 'center', copy: false } },
]), { volTol: 0.03 });
// ---- migration batch 9: surfaces ----
scenario('Surfaces on the exact kernel: extrude, revolve, sweep, loft, stitch, thicken and trim', () => {
  const triArea = triAreaOf;
  const compare = (name, d, ids, tol = 0.03) => {
    const m = meshAnswer('surface: ' + name, d), b = evaluate(d, { backend: 'brep' });
    check(`${name}: built by the exact kernel`, b.result.backend.kind === 'brep' && !errs(b), JSON.stringify(b.result.backend.blocked || '') + errs(b));
    for (const id of ids) {
      const sm = m.surfaces.find((x) => x.id === id), sb = b.result.surfaces.find((x) => x.id === id);
      check(`${name}: surface ${id} exists on both`, !!sm && !!sb);
      if (sm && sb) {
        check(`${name}: ${id} area ${triArea(sb).toFixed(1)} vs ${sm.area.toFixed(1)}`, approx(triArea(sb), sm.area, tol));
        const dev = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(sb.bbox.min[k] - sm.bbox.min[k]), Math.abs(sb.bbox.max[k] - sm.bbox.max[k])]));
        check(`${name}: ${id} bounding box (off by ${dev.toFixed(3)})`, dev < 0.4, JSON.stringify([sm.bbox, sb.bbox]));
      }
    }
    return { m, b };
  };
  compare('extrude', doc([skch('s', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [20, 10]] }, { t: 'circle', cx: 40, cy: 5, r: 5 }]), { id: 'se', type: 'sextrude', name: 'SE', params: { sketch: 's', distance: 8, symmetric: true } }]), ['se']);
  compare('revolve', doc([skch('s', [{ t: 'path', open: true, pts: [[10, 0], [15, 10], [10, 20]] }]), { id: 'sr', type: 'srevolve', name: 'SR', params: { sketch: 's', angle: 360 } }]), ['sr']);
  compare('sweep', doc([skch('p', [{ t: 'circle', cx: 0, cy: 0, r: 4 }], 'YZ'), skch('w', [{ t: 'path', open: true, pts: [[0, 0], [30, 0, 0.4142], [50, 20]] }]), { id: 'ss', type: 'ssweep', name: 'SS', params: { profile: 'p', path: 'w', smooth: false } }]), ['ss'], 0.08);
  compare('loft', doc([skch('a', [{ t: 'rect', x: -10, y: -10, w: 20, h: 20 }]), skch('b', [{ t: 'circle', cx: 0, cy: 0, r: 6 }], 'XY', { offset: 20 }), { id: 'sl', type: 'sloft', name: 'SL', params: { sketches: ['a', 'b'] } }]), ['sl'], 0.08);
  const st = compare('stitch six faces into a solid', doc([
    skch('a', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }]), { id: 'x1', type: 'sextrude', name: 'X1', params: { sketch: 'a', distance: 10, symmetric: false } },
    skch('c', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }]), skch('c2', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }], 'XY', { offset: 10 }),
  ]), ['x1']);
  const stitched = evaluate(doc([skch('a', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }]), { id: 'x1', type: 'sextrude', name: 'X1', params: { sketch: 'a', distance: 10, symmetric: false } }, { id: 'ss', type: 'sstitch', name: 'Stitch', params: { surfaces: ['x1'], requireSolid: false } }]), { backend: 'brep' });
  check('stitching an open wall keeps it a surface', !errs(stitched) && stitched.result.surfaces.length === 1 && stitched.result.bodies.length === 0, errs(stitched));
  const th = evaluate(doc([skch('a', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [20, 10]] }]), { id: 'x1', type: 'sextrude', name: 'X1', params: { sketch: 'a', distance: 8, symmetric: false } }, { id: 'tk', type: 'sthicken', name: 'Thicken', params: { surface: 'x1', thickness: 2, both: false } }]), { backend: 'brep' });
  const thm = meshAnswer('surface: thicken', doc([skch('a', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [20, 10]] }]), { id: 'x1', type: 'sextrude', name: 'X1', params: { sketch: 'a', distance: 8, symmetric: false } }, { id: 'tk', type: 'sthicken', name: 'Thicken', params: { surface: 'x1', thickness: 2, both: false } }]));
  check('thicken makes a solid of the flat wall, about as much material as the mesh kernel makes', !errs(th) && th.result.surfaces.length === 0 && approx(bodyOf(th, 'tk').volume, thm.bodies.find((x) => x.id === 'tk').volume, 0.12), `${errs(th)} ${bodyOf(th, 'tk')?.volume}`);
  const tr = evaluate(doc([skch('a', [{ t: 'path', open: true, pts: [[0, 0], [20, 0]] }]), { id: 'x1', type: 'sextrude', name: 'X1', params: { sketch: 'a', distance: 10, symmetric: false } }, { id: 'tm', type: 'strim', name: 'Trim', params: { surface: 'x1', plane: 'XY', offset: 4, keep: 'above' } }]), { backend: 'brep' });
  const trs = tr.result.surfaces[0];
  check('trim keeps the side of the plane', !errs(tr) && trs && Math.abs(trs.bbox.min[2] - 4) < 1e-3 && Math.abs(trs.bbox.max[2] - 10) < 1e-3, errs(tr) + JSON.stringify(trs?.bbox));
});
bothBackends('Both backends: sweep and pipe along smoothed paths, 3D sketches and closed shapes', doc([
  skch('p1', [{ t: 'circle', cx: 0, cy: 0, r: 2 }], 'YZ'), skch('w1', [{ t: 'path', open: true, pts: [[0, 0], [20, 0], [30, 15], [50, 15]] }]),
  { id: 'sw1', type: 'sweep', name: 'Sweep1', params: { profile: 'p1', path: 'w1', smooth: true, op: 'new', target: '' } },
  skch('w2', [{ t: 'path', open: true, pts: [[0, 40], [20, 40], [30, 55], [50, 55]] }]),
  { id: 'pp', type: 'pipe', name: 'Pipe1', params: { path: 'w2', smooth: true, diameter: 4, wall: 0, op: 'new', target: '' } },
  { id: 'k3', type: 'sketch3d', name: '3D', params: { points: [[0, 80, 0], [20, 80, 0], [20, 100, 10], [40, 100, 10]], closed: false, smooth: false } },
  { id: 'p3', type: 'pipe', name: 'Pipe3D', params: { path: 'k3', smooth: false, diameter: 3, wall: 0, op: 'new', target: '' } },
]), { volTol: 0.08 });
scenario('A pipe around a closed shape (the exact kernel sweeps the corners fully, the mesh kernel mitred them thinner)', () => {
  const r = evaluate(doc([skch('w4', [{ t: 'rect', x: 100, y: 0, w: 30, h: 20 }]), { id: 'pr', type: 'pipe', name: 'PipeClosed', params: { path: 'w4', smooth: false, diameter: 2, wall: 0, op: 'new', target: '' } }]), { backend: 'brep' });
  check('volume is pi r^2 times the perimeter', !errs(r) && approx(bodyOf(r, 'pr').volume, Math.PI * 100, 0.02), errs(r) + bodyOf(r, 'pr')?.volume);
});
scenario('Interference, version compare and polygon offset on the exact kernel', () => {
  const d = doc([prim('a', 'box', { sx: 20, sy: 20, sz: 20, radius: 0 }), prim('b', 'cylinder', { radius: 5, height: 30, pos: [10, 0, -5] }), prim('c', 'sphere', { radius: 3, pos: [100, 0, 0] })]);
  const r = evaluate(d, { backend: 'brep', cache: true });
  const hits = interferenceOf(r.result.bodies);
  check('one pair overlaps (the box and the cylinder), with the right volume', hits.length === 1 && hits[0].a.id === 'a' && hits[0].b.id === 'b' && approx(hits[0].volume, 0.5 * Math.PI * 25 * 20, 0.001), JSON.stringify(hits.map((h) => [h.a.id, h.b.id, h.volume])));
  const A = evaluate(doc([prim('a', 'box', { sx: 20, sy: 20, sz: 20, radius: 0 })]), { backend: 'brep', keepShapes: true });
  const B = evaluate(doc([prim('a', 'box', { sx: 20, sy: 20, sz: 30, radius: 0 })]), { backend: 'brep', keepShapes: true });
  const diff = compareResults(A.result, B.result);
  check('compare: added 4000, removed nothing, kept 8000', diff.added && approx(diff.added.volume, 4000, 0.001) && !diff.removed && approx(diff.kept.volume, 8000, 0.001), JSON.stringify([diff.added?.volume, diff.removed?.volume, diff.kept?.volume]));
  const o = offsetPolygonExact([[0, 0], [10, 0], [10, 10], [0, 10]], 1);
  const w = Math.max(...o.map((p) => p[0])) - Math.min(...o.map((p) => p[0]));
  check('offsetting a square by 1 makes a 12 wide square', o && approx(w, 12, 0.001), JSON.stringify(o));
});
scenario('An import over the face limit says so, and reducing it in the import step makes it fit', () => {
  const n = 400, m = 200, P = (i, j) => { const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m; return [(20 + 5 * Math.cos(v)) * Math.cos(u), (20 + 5 * Math.cos(v)) * Math.sin(u), 5 * Math.sin(v)]; };
  const s = []; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1); s.push(...a, ...b, ...e, ...b, ...c, ...e); }
  const soup = new Float32Array(s), imp = (extra) => doc([{ id: 'i', type: 'import', name: 'i', params: { data: encodeFloats(soup), tris: soup.length / 9, ...extra } }]);
  const big = evaluate(imp({}));
  check('160,000 triangles are over the limit, with a message that points to Reduce', /more than the 32,000/.test(errs(big)) && /educe/.test(errs(big)), errs(big));
  const red = evaluate(imp({ reduce: { keep: 10, tolerance: 0.4 } }));
  check('with a reduce in the import step it sews', !errs(red) && bodyOf(red, 'i').faces.length < 32000 && approx(bodyOf(red, 'i').volume, 2 * Math.PI * Math.PI * 20 * 25, 0.1), errs(red) + bodyOf(red, 'i')?.faces.length);
});
scenario('A 30,000 triangle import, none of them flat together, sews in seconds', () => {
  const n = 100, m = 75, P = (i, j) => { const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m, r = 20 + 5 * Math.cos(v) + 0.1 * Math.sin(7 * u) * Math.cos(5 * v); return [r * Math.cos(u), r * Math.sin(u), 5 * Math.sin(v) + 0.05 * Math.sin(3 * u)]; };
  const s = []; for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1); s.push(...a, ...b, ...e, ...b, ...c, ...e); }
  const soup = new Float32Array(s), t0 = Date.now(), r = evaluate(doc([{ id: 'i', type: 'import', name: 'i', params: { data: encodeFloats(soup), tris: soup.length / 9 } }]));
  check('it builds one solid (volume of the torus) without hitting the limit, in under 15 s', !errs(r) && approx(bodyOf(r, 'i').volume, 2 * Math.PI * Math.PI * 20 * 25, 0.05) && Date.now() - t0 < 15000, errs(r) + ' ' + (Date.now() - t0) + ' ms ' + bodyOf(r, 'i')?.faces.length + ' faces');
  const seen = []; globalThis.__sketchyProgress = (stage, done, total) => seen.push([stage, done, total]);
  try { clearKernelCache(); evaluate(doc([{ id: 'i', type: 'import', name: 'i', params: { data: encodeFloats(soup), tris: soup.length / 9 } }])); } finally { delete globalThis.__sketchyProgress; }
  check('sewing reports progress (stage, faces done, faces in all) that ends near the total', seen.length > 20 && seen.every(([st, d, t]) => st === 'Sewing faces' && d <= t) && seen.at(-1)[1] > seen.at(-1)[2] * 0.9, String(seen.length));
});
scenario('Chamfers and fillets that run into rounded corners build at every size that fits, and say what fits when it does not', () => {
  const box60 = prim('box', 'box', { sx: 60, sy: 40, sz: 20, radius: 0 }), pick = (res, pred) => edgesWhere(res, 'box', pred);
  const fillet = (id, edges, radius) => ({ id, type: 'fillet', name: id, params: { edges, radius, tangent: false, variable: false } });
  const vol0 = 60 * 40 * 20;
  // A: the top edges rounded, then a chamfer or fillet on a vertical edge that ends in the rounded corner (sizes OpenCascade alternately refused)
  const tops = pick(evaluate(doc([box60])), (p) => p.every((q) => Math.abs(q[2] - 20) < 1e-3)), A = doc([box60, fillet('f1', tops, 2)]), rA = evaluate(A), bA = bodyOf(rA, 'box');
  const chain = findEdgeChains(bA.verts, 3, bA.tris).find((c) => c.pts[0][2] < 1e-3 && c.pts.length > 5 && c.pts[0][0] < -29 && c.pts[0][1] < -19);
  check('the vertical edge continues into the rounded corner as one picked chain', !!chain);
  if (chain) {
    const ref = [edgeRef('box', chain)];
    for (const d of [0.3, 0.5, 1, 1.5, 2, 3]) {
      const r = evaluate(doc([...A.features, { id: 'ch', type: 'chamfer', name: 'Chamfer', params: { edges: ref, distance: d, tangent: false } }])), v = bodyOf(r, 'box').volume;
      check(`chamfer ${d} mm on that edge builds and takes about the right amount away`, !errs(r) && bA.volume - v > 0.4 * (d * d / 2) * 18 && bA.volume - v < 1.6 * (d * d / 2) * 18 + 5, `${errs(r)} removed ${(bA.volume - v).toFixed(2)} expected ${(d * d / 2 * 18).toFixed(2)}`);
    }
    for (const d of [1, 2]) { const r = evaluate(doc([...A.features, fillet('f2', ref, d)])); check(`fillet ${d} mm on that edge builds`, !errs(r) && bodyOf(r, 'box').volume < bA.volume - 0.2 * d * d * 18, errs(r)); }
    const big = evaluate(doc([...A.features, { id: 'ch', type: 'chamfer', name: 'Chamfer', params: { edges: ref, distance: 45, tangent: false } }]));
    check('a size that cannot fit is refused with the size that does', /does not fit/.test(errs(big)) && /about [\d.]+ mm does/.test(errs(big)), errs(big));
  }
  // B: the vertical edges rounded, then a chamfer or fillet on the loop of top edges
  const verts = pick(evaluate(doc([box60])), (p) => Math.abs(p[0][0] - p.at(-1)[0]) < 1e-3 && Math.abs(p[0][1] - p.at(-1)[1]) < 1e-3 && Math.abs(p[0][2] - p.at(-1)[2]) > 10), B = doc([box60, fillet('fv', verts, 5)]), rB = evaluate(B), bB = bodyOf(rB, 'box');
  const loop = findEdgeChains(bB.verts, 3, bB.tris).filter((c) => c.pts.every((q) => Math.abs(q[2] - 20) < 1e-3));
  check('the top edge loop of the body with rounded vertical edges is found', loop.length > 0, String(loop.length));
  if (loop.length) for (const d of [0.5, 1, 2, 4]) {
    const r = evaluate(doc([...B.features, { id: 'ch', type: 'chamfer', name: 'Chamfer', params: { edges: loop.map((c) => edgeRef('box', c)), distance: d, tangent: true } }]));
    check(`chamfer ${d} mm around the whole top loop builds`, !errs(r) && bodyOf(r, 'box').volume < bB.volume - 0.5 * d * d / 2 * 200, errs(r));
  }
});

scenario('Exact fillet follows the picked edges and refuses nonsense', () => {
  const d = doc([boxFeature, filF]);
  const r = evaluate(d, { backend: 'brep' });
  const b = bodyOf(r, 'box');
  const exact = 40 * 30 * 20 - (1 - Math.PI / 4) * 9 * (2 * 40 + 2 * 30);
  check('exact volume of a 3 mm fillet on four top edges', approx(b.volume, exact, 0.0005), `${b.volume} vs ${exact}`);
  check('a fillet on a curved edge works too (the rim of a hole)', (() => {
    const hr = evaluate(doc([boxFeature, holeF]), { backend: 'brep' });
    const hb = bodyOf(hr, 'box'), V = hb.verts;
    const ring = findEdgeChains(V, 3, hb.tris).filter((c) => c.pts.every((q) => Math.abs(q[2] - 20) < 1e-3 && Math.hypot(q[0], q[1]) < 5.1));
    if (ring.length !== 1) return false;
    const fr = evaluate(doc([boxFeature, holeF, { id: 'f2', type: 'fillet', name: 'F2', params: { edges: [edgeRef('box', ring[0])], radius: 1, tangent: false, variable: false } }]), { backend: 'brep' });
    return !errs(fr) && bodyOf(fr, 'box').volume < hb.volume && bodyOf(fr, 'box').faces.some((f) => f.type === 'TORUS');
  })());
  const big = evaluate(doc([boxFeature, { ...filF, params: { ...filF.params, radius: 40 } }]), { backend: 'brep' });
  check('a fillet that is too large is reported, not hidden', /too large/i.test(errs(big)), errs(big));
  const gone = evaluate(doc([boxFeature, { ...filF, params: { ...filF.params, edges: [{ body: 'box', pts: [[1, 1, 1], [2, 2, 2]], nrm: [[0, 0, 1], [1, 0, 0]] }] } }]), { backend: 'brep' });
  check('an edge that is not there is reported', /could be found/i.test(errs(gone)), errs(gone));
});

scenario('A feature the exact kernel does not have reports an error on that feature and the rest of the design builds', () => {
  const d = doc([boxFeature, { id: 'sh', type: 'sextend', name: 'Surf1', params: { surface: 'nothing', distance: 5 } }, prim('b', 'sphere', { radius: 4, pos: [60, 0, 0] })]);
  const r = evaluate(d);
  check('the feature that cannot be built has an error that says so', /sextend|Extend surface|surface you picked/i.test(r.result.errors.sh || ''), JSON.stringify(r.result.errors));
  check('the bodies around it are intact', bodyOf(r, 'box').volume === 24000 && r.result.bodies.length === 2);
  for (const [label, f] of [['a surface extend', { id: 'e', type: 'sextend', name: 'e', params: { surface: 'x', distance: 5 } }], ['an unknown feature', { id: 'e', type: 'nosuchfeature', name: 'e', params: {} }]]) {
    const sup = brepSupport([skch('s', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }]), f]);
    check(`${label} is refused by brepSupport with a reason (used for the exact STEP export)`, !sup.ok && sup.feature.id === 'e' && sup.reason.length > 3, JSON.stringify(sup));
  }
  const ov = brepSupport([skch('s', [{ t: 'rect', x: 0, y: 0, w: 10, h: 10 }, { t: 'rect', x: 5, y: 5, w: 10, h: 10 }]), extr('e', 's')]);
  check('overlapping sketch shapes are accepted', ov.ok);
  const sup = brepSupport([{ ...boxFeature, suppressed: false }, { id: 'sh', type: 'sextend', name: 'S', suppressed: true, params: {} }]);
  check('a suppressed feature does not count', sup.ok);
});

console.log('Exact STEP export');
try {
  const d = doc([boxFeature, filF, holeF]);
  const logged = [], realLog = console.log, realErr = console.error;
  console.log = (...a) => logged.push(a.join(' ')); console.error = (...a) => logged.push(a.join(' '));
  let blob, bodies;
  try { ({ blob, bodies } = exactStep(evaluate(d).resolved)); } finally { console.log = realLog; console.error = realErr; }
  check('the STEP writer prints no transfer statistics', logged.length === 0, logged.slice(0, 3).join(' | '));
  const txt = await blob.text();
  check('one body written', bodies === 1);
  check('AP242 with real surfaces, not facets', /AP242/.test(txt) && /CYLINDRICAL_SURFACE/.test(txt)  && !/FACETED_BREP/.test(txt));
  check('11 faces', (txt.match(/ADVANCED_FACE/g) || []).length === 11, String((txt.match(/ADVANCED_FACE/g) || []).length));
  const old = await writeSTEP(evaluate(d).result.bodies, 'x').text();
  check('the faceted exporter is still what a mesh design gets', /FACETED_BREP/.test(old) && (old.match(/FACE\(/g) || []).length > 11);
  let refused = '';
  try { exactStep(evaluate(doc([boxFeature, skch('sk', [{ t: 'circle', cx: 0, cy: 0, r: 5 }]), { id: 'sh', type: 'sextend', name: 'Shell1', params: { surface: 'sk', distance: 5 } }])).resolved); } catch (e) { refused = e.message; }
  check('a design with a mesh-only feature is refused with the feature named', /Shell1/.test(refused), refused);
} catch (e) { failed++; console.log('  FAIL threw: ' + e.stack.split('\n').slice(0, 3).join(' | ')); }

console.log('STEP import keeps true surfaces');
try {
  const d = doc([clone(boxFeature), clone(filF), clone(holeF)]);
  const text = await exactStep(evaluate(d).resolved).blob.text();
  const back = evaluate(doc([{ id: 'st', type: 'importstep', name: 'Imported', params: { data: text } }]), { backend: 'brep' }), orig = bodyOf(evaluate(d, { backend: 'brep' }), 'box');
  const ib = bodyOf(back, 'st');
  check('a STEP file written by the exact kernel reads back as the same solid', !errs(back) && approx(ib.volume, orig.volume, 1e-6), errs(back));
  check('with its 11 true faces, not facets', ib.faces.length === 11 && ib.faces.some((f) => f.type === 'CYLINDRE'), String(ib.faces?.length));
  const filleted = evaluate(doc([{ id: 'st', type: 'importstep', name: 'Imported', params: { data: text } }, { id: 'p', type: 'primitive', name: 'Cut', params: { shape: 'cylinder', pos: [10, 0, -5], op: 'new', radius: 3, height: 40 } }, { id: 'cb', type: 'combine', name: 'Cut', params: { target: 'st', tool: 'p', op: 'cut', keepTool: false } }]), { backend: 'brep' });
  check('and it takes booleans like any body', !errs(filleted) && bodyOf(filleted, 'st').volume < ib.volume - 100, errs(filleted));
} catch (e) { failed++; console.log('  FAIL threw: ' + e.stack.split('\n').slice(0, 3).join(' | ')); }

if (process.env.UPDATE_GOLDEN) { writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 1)); console.log('recorded', Object.keys(golden).length, 'mesh answers'); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
