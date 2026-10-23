// Parametric kernel front: the geometry helpers every part of the app shares (planes, sketch shapes as polygons, sketch paths, face
// lookup on a mesh, the feature-equality test) and the entry points that replay a timeline. Solids are built by the exact kernel
// (OpenCascade through replicad, src/backend-brep.js); this file no longer builds any.
import { pathPolygon } from './sketchgeo.js';
import { smoothPath, sub, add, scl, dot, len, unit, cross } from './solids.js';
import { planarFace } from './edges.js';
import { brepReady, rebuildBrep, clearBrepCache, offsetPolygonExact, profilesOfExact, loadBrep } from './backend-brep.js';

/** Start the kernel: loads OpenCascade (about 23 MB; pass { locateFile } with the bundled .wasm URL in the browser). */
export const initKernel = (opts = {}) => loadBrep(opts);

export const PLANES = {
  XY: { rot: [0, 0, 0], n: [0, 0, 1] },
  XZ: { rot: [90, 0, 0], n: [0, -1, 0] },
  YZ: { rot: [90, 0, 90], n: [1, 0, 0] },
};

const SEG = 64;
// ---------- sketch -> cross-section ----------
function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
export function shapeToPolygon(s) {
  if (s.t === 'rect') return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
  if (s.t === 'ngon' || s.t === 'circle') {
    const n = s.t === 'circle' ? SEG : Math.max(3, Math.round(s.n));
    const rot = ((s.rot || 0) * Math.PI) / 180;
    return Array.from({ length: n }, (_, i) => {
      const a = rot + (i / n) * Math.PI * 2;
      return [s.cx + Math.cos(a) * s.r, s.cy + Math.sin(a) * s.r];
    });
  }
  if (s.t === 'path') return pathPolygon(s.pts, !s.open);
  if (s.t === 'rrect') {
    const r = Math.max(0, Math.min(s.r || 0, s.w / 2, s.h / 2));
    if (r < 1e-6) return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
    const out = [];
    const corners = [[s.x + s.w - r, s.y + r, -90], [s.x + s.w - r, s.y + s.h - r, 0], [s.x + r, s.y + s.h - r, 90], [s.x + r, s.y + r, 180]];
    for (const [cx, cy, a0] of corners) for (let i = 0; i <= 10; i++) { const a = ((a0 + (i / 10) * 90) * Math.PI) / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return out;
  }
  if (s.t === 'slot') {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L = Math.hypot(dx, dy) || 1e-9, r = s.w / 2;
    const ang = Math.atan2(dy, dx), out = [];
    for (let i = 0; i <= 24; i++) { const a = ang - Math.PI / 2 + (i / 24) * Math.PI; out.push([s.x2 + Math.cos(a) * r, s.y2 + Math.sin(a) * r]); }
    for (let i = 0; i <= 24; i++) { const a = ang + Math.PI / 2 + (i / 24) * Math.PI; out.push([s.x1 + Math.cos(a) * r, s.y1 + Math.sin(a) * r]); }
    void L;
    return out;
  }
  if (s.t === 'ellipse') {
    const rot = ((s.rot || 0) * Math.PI) / 180, n = 72;
    return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2, x = Math.cos(a) * s.rx, y = Math.sin(a) * s.ry; return [s.cx + x * Math.cos(rot) - y * Math.sin(rot), s.cy + x * Math.sin(rot) + y * Math.cos(rot)]; });
  }
  return [];
}
const vcross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const BASIS = { XY: [[1, 0, 0], [0, 1, 0]], XZ: [[1, 0, 0], [0, 0, 1]], YZ: [[0, 1, 0], [0, 0, 1]] };
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((c) => c / l); };
/** Sketch plane frame {o,x,y,n} from sketch params: named plane or custom origin/normal/xdir (+ offset along n). */
export function planeFrame(params) {
  let o, x, y, n;
  if (params.plane === 'custom') {
    n = v3norm(params.normal);
    const xd = params.xdir;
    const dn = xd[0] * n[0] + xd[1] * n[1] + xd[2] * n[2];
    x = v3norm(xd.map((c, i) => c - dn * n[i]));
    y = v3cross(n, x);
    o = [...params.origin];
  } else {
    [x, y] = BASIS[params.plane] || BASIS.XY;
    n = v3cross(x, y);
    o = [0, 0, 0];
  }
  const off = params.offset || 0;
  return { o: o.map((c, i) => c + n[i] * off), x, y, n };
}
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vscl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
// Loft the edge profile along an edge chain -> { m, convex }.
/**
 * Chains connected end to end with `ch` (an edge loop): follows a shared end point as long as exactly two chains meet there
 * and the turn is under maxTurnDeg. Edge picking already follows smooth curves; this carries on across sharper corners.
 */
export function connectedChains(chains, ch, maxTurnDeg = 100) {
  const out = [ch], seen = new Set([ch]), cosTol = Math.cos((maxTurnDeg * Math.PI) / 180);
  const ends = (c) => { const n = c.pts.length; return [{ p: c.pts[0], d: v3norm(vsub(c.pts[1], c.pts[0])) }, { p: c.pts[n - 1], d: v3norm(vsub(c.pts[n - 2], c.pts[n - 1])) }]; };
  const near = (a, b) => Math.hypot(...vsub(a, b)) < 1e-3;
  const faces = (c) => [c.frames[0].n1, c.frames[0].n2];
  // the loop runs around one face of the picked edge: the more upward-facing of its two
  const [fa, fb] = faces(ch), loopFace = fb[2] > fa[2] + 1e-6 ? fb : fa;
  const sharesFace = (a, b) => faces(b).some((y) => vdot(loopFace, y) > 0.999);
  for (let k = 0; k < out.length; k++) {
    if (out[k].closed) continue;
    for (const e of ends(out[k])) {
      const cand = chains.filter((c) => c !== out[k] && !c.closed && sharesFace(out[k], c) && ends(c).some((x) => near(x.p, e.p)));
      if (cand.length !== 1) continue; // nothing to follow, or ambiguous
      const d = cand[0];
      if (seen.has(d)) continue;
      for (const f of ends(d)) if (near(e.p, f.p) && vdot(e.d, f.d) < -cosTol) { seen.add(d); out.push(d); break; }
    }
  }
  return out;
}
const meshCache = new WeakMap();
export function decodeMesh(params) {
  if (meshCache.has(params)) return meshCache.get(params);
  const bin = atob(params.data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const v = new Float32Array(u8.buffer);
  meshCache.set(params, v);
  return v;
}
export function encodeFloats(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function sketchPath3D(sk) {
  if (sk.type === 'sketch3d') { // a 3D sketch is a polyline through points in space
    const pts = (sk.params.points || []).map((q) => [+q[0] || 0, +q[1] || 0, +q[2] || 0]);
    if (pts.length < 2) throw new Error(`${sk.name} needs at least two points`);
    const closed = !!sk.params.closed && pts.length > 2;
    return { closed, pts: sk.params.smooth && !closed ? smoothPath(pts, 3) : pts };
  }
  const drawn = sk.params.shapes.filter((s) => !s.lt && s.t !== 'point'); // construction and centerline shapes and points are not geometry to follow
  const sh = drawn.find((s) => s.t === 'path' && s.open) || drawn.find((s) => s.t === 'path' || s.t === 'circle' || s.t === 'rect' || s.t === 'ngon');
  if (!sh) throw new Error(`${sk.name} has no path (draw a Path or any shape)`);
  const closed = !sh.open;
  const pts2 = shapeToPolygon(sh);
  const { o, x, y } = planeFrame(sk.params);
  return { closed, pts: pts2.map(([u, v]) => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v]) };
}
/**
 * Find the triangle of a mesh that lies on the stored planar face {point, normal}. If the face has since moved (an earlier
 * dimension was edited), fall back to the flat face with the same normal whose plane is nearest, provided no other plane
 * is about as near, so later features follow the face instead of failing.
 */
export function findFaceTri(verts, tris, point, normal) {
  let best = -1, bd = Infinity;
  const near = [];
  for (let i = 0; i < tris.length / 3; i++) {
    const a = [verts[tris[i * 3] * 3], verts[tris[i * 3] * 3 + 1], verts[tris[i * 3] * 3 + 2]];
    const b = [verts[tris[i * 3 + 1] * 3], verts[tris[i * 3 + 1] * 3 + 1], verts[tris[i * 3 + 1] * 3 + 2]];
    const c = [verts[tris[i * 3 + 2] * 3], verts[tris[i * 3 + 2] * 3 + 1], verts[tris[i * 3 + 2] * 3 + 2]];
    const n = unit(vcross3(sub(b, a), sub(c, a)));
    if (dot(n, normal) < 0.999) continue;
    const off = dot(sub(a, point), normal), ctr = scl(add(add(a, b), c), 1 / 3);
    const inPlane = len(sub(sub(ctr, point), scl(normal, dot(sub(ctr, point), normal))));
    near.push({ i, off, inPlane });
    if (Math.abs(off) > 0.02) continue;
    const d = len(sub(ctr, point));
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0 || !near.length) return best;
  // the face moved: pick the nearest parallel plane, and only if it is clearly the nearest
  const planes = new Map();
  for (const q of near) {
    const key = Math.round(q.off * 100);
    const e = planes.get(key);
    if (!e || q.inPlane < e.inPlane) planes.set(key, { ...q, key });
  }
  const ranked = [...planes.values()].sort((a, b) => Math.abs(a.off) - Math.abs(b.off));
  if (ranked.length > 1 && Math.abs(ranked[0].off) > 0.7 * Math.abs(ranked[1].off)) return -1;
  return ranked[0].i;
}
/**
 * Replay features[0..count). Returns { bodies, errors, snaps, sketchUsed }.
 * bodies: [{id,name,verts,tris,volume,area,bbox}]; snaps[i] = bodies alive before feature i.
 */
/**
 * Construction planes: a 'plane' feature offsets a base plane (XY/XZ/YZ or an earlier plane feature). Sketches that name one
 * through params.planeRef are re-pointed at its current geometry. Returns copies; the input is not modified.
 * Plane features get origin/normal/xdir filled in so the UI can draw them.
 */
export function resolvePlanes(features) {
  const frames = {}, axes = {};
  const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const V = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], scl: (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
  const frameOf = (ref) => (frames[ref] ? planeFrame({ plane: 'custom', ...frames[ref], offset: 0 }) : planeFrame({ plane: ref || 'XY', offset: 0 }));
  const bad = (f, msg) => ({ ...f, params: { ...f.params, error: msg } });
  /** Rotate point q about the line through a with unit direction d by deg degrees (Rodrigues). */
  const spin = (q, a, d, deg) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t), r = V.sub(q, a), kx = v3cross(d, r); return V.add(a, V.add(V.add(V.scl(r, c), V.scl(kx, sn)), V.scl(d, V.dot(d, r) * (1 - c)))); };
  const turn = (v, d, deg) => V.sub(spin(v, [0, 0, 0], d, deg), [0, 0, 0]);
  return features.map((f) => {
    if (f.type === 'plane') {
      const mode = f.params.mode || 'offset';
      let geo;
      if (mode === 'offset') {
        const fr = frameOf(f.params.base), d = +f.params.offset || 0;
        geo = { origin: fr.o.map((c, k) => c + fr.n[k] * d), normal: fr.n, xdir: fr.x };
      } else if (mode === 'angle') {
        const fr = frameOf(f.params.base), ax = f.params.axis || 'x';
        let a = fr.o, d = fr.x;
        if (ax === 'y') d = fr.y;
        else if (axes[ax]) { a = axes[ax].origin; d = axes[ax].dir; }
        const deg = +f.params.angle || 0;
        geo = { origin: spin(fr.o, a, d, deg), normal: v3norm(turn(fr.n, d, deg)), xdir: v3norm(turn(fr.x, d, deg)) };
      } else if (mode === 'mid') {
        const f1 = frameOf(f.params.base), f2 = frameOf(f.params.base2);
        if (Math.hypot(...v3cross(f1.n, f2.n)) > 1e-6) return bad(f, 'A midplane needs two parallel planes. These two are not parallel.');
        const gap = V.dot(V.sub(f2.o, f1.o), f1.n);
        geo = { origin: V.add(f1.o, V.scl(f1.n, gap / 2)), normal: f1.n, xdir: f1.x };
      } else if (mode === 'three') {
        const [p1, p2, p3] = [f.params.p1, f.params.p2, f.params.p3].map((q) => (Array.isArray(q) ? q.map((v) => +v || 0) : [0, 0, 0]));
        const n = v3cross(V.sub(p2, p1), V.sub(p3, p1));
        if (Math.hypot(...n) < 1e-9) return bad(f, 'Those three points are in a line, so they do not define a plane.');
        geo = { origin: p1, normal: v3norm(n), xdir: v3norm(V.sub(p2, p1)) };
      } else return f;
      frames[f.id] = geo;
      return { ...f, params: { ...f.params, ...geo, error: undefined } };
    }
    if (f.type === 'axis') { // construction axis: a point and a direction
      const mode = f.params.mode || 'twopoints';
      let geo;
      if (mode === 'twopoints') {
        const p1 = (f.params.p1 || [0, 0, 0]).map((v) => +v || 0), p2 = (f.params.p2 || [0, 0, 1]).map((v) => +v || 0), d = V.sub(p2, p1);
        if (Math.hypot(...d) < 1e-9) return bad(f, 'The two points are the same point.');
        geo = { origin: p1, dir: v3norm(d) };
      } else if (mode === 'planes') {
        const f1 = frameOf(f.params.base), f2 = frameOf(f.params.base2), d = v3cross(f1.n, f2.n), L2 = V.dot(d, d);
        if (L2 < 1e-12) return bad(f, 'Those two planes are parallel, so they do not cross in a line.');
        const d1 = V.dot(f1.n, f1.o), d2 = V.dot(f2.n, f2.o);
        const o = V.scl(V.add(V.scl(v3cross(f2.n, d), d1), V.scl(v3cross(d, f1.n), d2)), 1 / L2);
        geo = { origin: o, dir: v3norm(d) };
      } else { // perpendicular to a plane, through a point
        const fr = frameOf(f.params.base);
        geo = { origin: (f.params.pos || [0, 0, 0]).map((v) => +v || 0), dir: fr.n };
      }
      axes[f.id] = geo;
      return { ...f, params: { ...f.params, ...geo, error: undefined } };
    }
    if (f.type === 'sketch' && f.params.planeRef && frames[f.params.planeRef]) {
      const g = frames[f.params.planeRef];
      if (f.params.plane === 'custom' && same(f.params.origin, g.origin) && same(f.params.normal, g.normal) && same(f.params.xdir, g.xdir)) return f;
      return { ...f, params: { ...f.params, plane: 'custom', ...g } };
    }
    return f;
  });
}
/** Same feature, deeply: parameters are plain data, long strings (imported meshes) are compared by value last. */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined); // a key holding undefined is no key: saving to JSON drops it
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!(k in b) || !sameValue(a[k], b[k])) return false;
  return true;
}

/** Regions of a sketch for the UI: [{ id, defaultOn, area, polys }] (exact 2D booleans, see sketch-brep.js). */
export function profilesOf(f) { return profilesOfExact(f); }
/** Offset a closed polygon by d (outward positive). Returns the largest resulting polygon or null. */
export function offsetPolygon(poly, d) { return offsetPolygonExact(poly, d); }
/** Free everything the incremental cache holds (another design was opened, or the page is done with it). */
export function clearKernelCache() { clearBrepCache(); }
export { exportBrepCache, importBrepCache } from './backend-brep.js';

/**
 * Replay features[0..count). Returns { bodies, surfaces, errors, warnings, notes, lost, snaps, sketchUsed, captured, preview, shifted, stats, backend }.
 * bodies: [{id, name, key, verts, tris, faceOf, faces, volume, area, bbox}]; snaps[i] = bodies alive before feature i. A feature the exact
 * kernel cannot build reports an error on that feature; the rest of the design still builds. opts: cache, capture, previewId, bodyComp, keepShapes.
 */
export function rebuild(features, count, opts = {}) {
  if (!brepReady()) throw new Error('The exact kernel is not loaded yet');
  return rebuildBrep(resolvePlanes(features), count, opts);
}
