// Parametric kernel: replays the feature timeline on top of manifold-3d (WASM).
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { findEdgeChains, matchChain, planarFace } from './edges.js';
import { ringMesh, loftRings, sweepRings, helixRings, smoothPath, axisFrame, sub, add, scl, dot, len, unit } from './solids.js';

let K;
export async function initKernel() {
  K = await Module({ locateFile: () => wasmUrl });
  K.setup();
  return K;
}

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
  if (s.t === 'path') return s.pts;
  return [];
}

function shapeToCS(s, t) {
  if (s.open) return null;
  let poly = shapeToPolygon(s);
  if (poly.length < 3) return null;
  if (polyArea(poly) < 0) poly = [...poly].reverse();
  return t(K.CrossSection.ofPolygons([poly]));
}

export function sketchSection(f, t) {
  const parts = f.params.shapes
    .map((s) => shapeToCS(s, t))
    .filter((c) => c && c.area() > 1e-9)
    .sort((a, b) => b.area() - a.area());
  let acc = null;
  for (const cs of parts) {
    if (!acc) { acc = cs; continue; }
    const inter = t(acc.intersect(cs));
    const contained = Math.abs(inter.area() - cs.area()) < 1e-6 * Math.max(1, cs.area());
    acc = t(contained ? acc.subtract(cs) : acc.add(cs));
  }
  return acc;
}

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

// Place a solid built in sketch-local coordinates (z = sketch normal) onto the sketch plane.
function toPlane(m, params, t) {
  const { o, x, y, n } = planeFrame(params);
  return t(m.transform([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1]));
}

// ---------- fillet / chamfer ----------
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vscl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Cross-section ring (3D polygon) of the material to remove (convex edge) / add (concave edge).
function edgeRing(E, fr, kind, size, arcSteps) {
  const { n1, n2, u1, u2 } = fr;
  const convex = vdot(n1, u2) < 0;
  const alpha = Math.acos(Math.max(-1, Math.min(1, vdot(u1, u2))));
  const t = kind === 'fillet' ? size / Math.tan(alpha / 2) : size;
  const T1 = vadd(E, vscl(u1, t)), T2 = vadd(E, vscl(u2, t));
  const sg = convex ? 1 : -1;
  const delta = Math.max(0.05 * size, 0.01);
  const A1 = vadd(T1, vscl(n1, sg * delta)), A2 = vadd(T2, vscl(n2, sg * delta));
  const X = vadd(E, vscl(vadd(n1, n2), sg * delta));
  const ring = [T1];
  if (kind === 'fillet') {
    const b = v3norm(vadd(u1, u2));
    const C = vadd(E, vscl(b, size / Math.sin(alpha / 2)));
    const v1 = vsub(T1, C), v2 = vsub(T2, C);
    const D = Math.PI - alpha, sD = Math.sin(D);
    for (let j = 1; j < arcSteps; j++) {
      const s = j / arcSteps;
      const w = sD < 1e-3 ? [1 - s, s] : [Math.sin((1 - s) * D) / sD, Math.sin(s * D) / sD];
      ring.push(vadd(C, vadd(vscl(v1, w[0]), vscl(v2, w[1]))));
    }
  }
  ring.push(T2, A2, X, A1);
  return { ring, fan: ring.length - 2, convex };
}

function manifoldFromIndexed(verts, tris, t) {
  const build = (tv) => new K.Manifold(new K.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tv) }));
  let m = t(build(tris));
  if (m.volume() < 0) {
    const fl = tris.slice();
    for (let i = 0; i < fl.length; i += 3) [fl[i + 1], fl[i + 2]] = [fl[i + 2], fl[i + 1]];
    m = t(build(fl));
  }
  return m;
}

// Loft the edge profile along an edge chain -> { m, convex }.
function edgeCutter(ch, kind, size, t) {
  const steps = kind === 'fillet' ? 12 : 0;
  const delta = Math.max(0.05 * size, 0.01);
  let pts = ch.pts, frames = ch.frames;
  if (!ch.closed) {
    const d0 = v3norm(vsub(pts[1], pts[0])), dn = v3norm(vsub(pts[pts.length - 1], pts[pts.length - 2]));
    pts = [vsub(pts[0], vscl(d0, delta)), ...pts, vadd(pts[pts.length - 1], vscl(dn, delta))];
    frames = [frames[0], ...frames, frames[frames.length - 1]];
  }
  const convex = vdot(frames[0].n1, frames[0].u2) < 0;
  const rings = pts.map((p, i) => edgeRing(p, frames[i], kind, size, steps).ring);
  const m = rings[0].length, fan = m - 2;
  const verts = rings.flat(2);
  const tris = [];
  const R = rings.length;
  const segs = ch.closed ? R : R - 1;
  for (let k = 0; k < segs; k++) {
    const a = k * m, b = ((k + 1) % R) * m;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      tris.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  if (!ch.closed) {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      if (i === fan || j === fan) continue;
      tris.push((R - 1) * m + fan, (R - 1) * m + i, (R - 1) * m + j); // end cap
      tris.push(fan, j, i); // start cap
    }
  }
  return { m: manifoldFromIndexed(verts, tris, t), convex };
}

// ---------- STL mesh helpers ----------
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

function manifoldFromSoup(soup, t) {
  const map = new Map();
  const verts = [];
  const tris = [];
  const q = (x) => Math.round(x * 1e4);
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${q(soup[i])},${q(soup[i + 1])},${q(soup[i + 2])}`;
    let idx = map.get(key);
    if (idx === undefined) { idx = verts.length / 3; map.set(key, idx); verts.push(soup[i], soup[i + 1], soup[i + 2]); }
    tris.push(idx);
  }
  const build = (tv) => new K.Manifold(new K.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tv) }));
  let m = t(build(tris));
  if (m.volume() < 0) {
    const flipped = tris.slice();
    for (let i = 0; i < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]];
    m = t(build(flipped));
  }
  return m;
}

// ---------- build ----------
function makePrimitive(p, t) {
  const [px, py, pz] = p.pos;
  let m;
  switch (p.shape) {
    case 'box':
      if (p.radius > 0) {
        const r = Math.min(p.radius, p.sx / 2, p.sy / 2, p.sz / 2);
        const pts = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
          pts.push(t(K.Manifold.sphere(r, 24).translate([sx * (p.sx / 2 - r), sy * (p.sy / 2 - r), sz * (p.sz / 2 - r)])));
        m = t(K.Manifold.hull(pts)).translate([0, 0, p.sz / 2]);
      } else m = K.Manifold.cube([p.sx, p.sy, p.sz], false).translate([-p.sx / 2, -p.sy / 2, 0]);
      break;
    case 'cylinder': m = K.Manifold.cylinder(p.height, p.radius, p.radius, SEG, false); break;
    case 'cone': m = K.Manifold.cylinder(p.height, p.radius, Math.max(p.radius2, 1e-4), SEG, false); break;
    case 'sphere': m = K.Manifold.sphere(p.radius, SEG); break;
    case 'torus': m = t(K.CrossSection.circle(p.minor, 32).translate([p.major, 0])).revolve(SEG, 360); break;
    default: throw new Error('unknown primitive');
  }
  return t(t(m).translate([px, py, pz]));
}


// ---------- advanced solids ----------
const BIGDIST = 5000;
const rotM = (M) => [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
/** Inverse of a rigid column-major 4x4 frame (orthonormal basis + translation). */
function invFrame(M) {
  const [x, y, z, o] = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]], [M[12], M[13], M[14]]];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, o), -dot(y, o), -dot(z, o), 1];
}
void rotM;

function solidFromRings(rings, closed, t) {
  const { verts, tris } = ringMesh(rings, closed);
  let m;
  try { m = manifoldFromIndexed(verts, tris, t); } catch { throw new Error('Could not build a valid solid (self-intersecting, or too sharply bent/twisted)'); }
  if (m.isEmpty()) throw new Error('Could not build a valid solid (self-intersecting, or too sharply bent/twisted)');
  return m;
}

/** Largest outline of a sketch as a 3D polygon on the sketch plane. */
function sketchOutline3D(sk, t) {
  const cs = sketchSection(sk, t);
  if (!cs) throw new Error(`${sk.name} has no closed profile`);
  const polys = cs.toPolygons();
  const area = (pl) => Math.abs(polyArea(pl));
  const pl = polys.reduce((a, b) => (area(b) > area(a) ? b : a));
  const { o, x, y } = planeFrame(sk.params);
  return pl.map(([u, v]) => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v]);
}
function sketchPath3D(sk) {
  const sh = sk.params.shapes.find((s) => s.t === 'path' && s.open) || sk.params.shapes.find((s) => s.t === 'path' || s.t === 'circle' || s.t === 'rect' || s.t === 'ngon');
  if (!sh) throw new Error(`${sk.name} has no path (draw a Path or any shape)`);
  const closed = !sh.open;
  const pts2 = shapeToPolygon(sh);
  const { o, x, y } = planeFrame(sk.params);
  return { closed, pts: pts2.map(([u, v]) => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v]) };
}

/** Helical groove tool for threads, built about +Z from z=0 to z=length. */
function threadGroove(p, t) {
  const { radius: Rs, pitch, length, depth, internal, left } = p;
  if (!(pitch > 0) || !(length > 0) || !(depth > 0)) throw new Error('Pitch, length and depth must be positive');
  const ov = Math.max(depth * 0.3, 0.05), wt = pitch / 16;
  const wOpen = Math.min(depth * Math.tan(Math.PI / 6) + wt, pitch * 0.48);
  const slope = (wOpen - wt) / depth;
  const profile = internal
    ? [[Rs - ov, -(wOpen + slope * ov)], [Rs + depth, -wt], [Rs + depth, wt], [Rs - ov, wOpen + slope * ov]]
    : [[Rs + ov, -(wOpen + slope * ov)], [Rs - depth, -wt], [Rs - depth, wt], [Rs + ov, wOpen + slope * ov]];
  const rings = helixRings(profile, { turns: length / pitch, pitch, left });
  return solidFromRings(rings, false, t);
}

function holeTool(p, t) {
  const d = p.diameter, depth = p.through ? BIGDIST : p.depth;
  if (!(d > 0) || !(depth > 0)) throw new Error('Diameter and depth must be positive');
  const e = 0.2;
  const cyl = (r, h, z) => t(t(K.Manifold.cylinder(h, r, r, SEG, false)).translate([0, 0, z]));
  let parts = [cyl(d / 2, depth + e, -e)];
  if (p.kind === 'counterbore') {
    if (!(p.cbDia > d)) throw new Error('Counterbore diameter must exceed the hole diameter');
    parts.push(cyl(p.cbDia / 2, p.cbDepth + e, -e));
  } else if (p.kind === 'countersink') {
    if (!(p.cskDia > d)) throw new Error('Countersink diameter must exceed the hole diameter');
    const h = (p.cskDia - d) / 2 / Math.tan((p.cskAngle * Math.PI) / 360);
    parts.push(t(K.Manifold.cylinder(h, p.cskDia / 2, d / 2, SEG, false)), cyl(p.cskDia / 2, e, -e));
  }
  let tool = parts.length > 1 ? t(K.Manifold.union(parts)) : parts[0];
  if (p.thread) {
    const g = threadGroove({ radius: d / 2, pitch: p.pitch, length: Math.min(p.threadLength, depth), depth: p.pitch * 0.6134, internal: true, left: false }, t);
    tool = t(tool.add(g));
  }
  return tool;
}

/** Find the triangle of a mesh that lies on the stored planar face {point, normal}. */
function findFaceTri(verts, tris, point, normal) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < tris.length / 3; i++) {
    const a = [verts[tris[i * 3] * 3], verts[tris[i * 3] * 3 + 1], verts[tris[i * 3] * 3 + 2]];
    const b = [verts[tris[i * 3 + 1] * 3], verts[tris[i * 3 + 1] * 3 + 1], verts[tris[i * 3 + 1] * 3 + 2]];
    const c = [verts[tris[i * 3 + 2] * 3], verts[tris[i * 3 + 2] * 3 + 1], verts[tris[i * 3 + 2] * 3 + 2]];
    const n = unit(vcross3(sub(b, a), sub(c, a)));
    if (dot(n, normal) < 0.999) continue;
    if (Math.abs(dot(sub(point, a), normal)) > 0.02) continue;
    const ctr = scl(add(add(a, b), c), 1 / 3);
    const d = len(sub(ctr, point));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
const vcross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const axisVec = (a) => ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[a] || [0, 0, 1]);
const rotAbout = (m, o, euler, t) => t(t(t(m.translate(o.map((c) => -c))).rotate(euler)).translate(o));

export function bboxOf(m) {
  const b = m.boundingBox();
  return { min: b.min, max: b.max };
}

/**
 * Replay features[0..count). Returns { bodies, errors, snaps, sketchUsed }.
 * bodies: [{id,name,verts,tris,volume,area,bbox}]; snaps[i] = bodies alive before feature i.
 */
export function rebuild(features, count, opts = {}) {
  const garbage = [];
  const t = (o) => { garbage.push(o); return o; };
  const live = new Map(); // id -> {id,name,m}
  const errors = {};
  const snaps = [];
  const sketchUsed = new Set();
  let captured = null;
  let counter = 0;
  const snap = () => [...live.values()].map((b) => ({ id: b.id, name: b.name, bbox: bboxOf(b.m) }));
  const addBody = (id, m, name) => live.set(id, { id, name: name || `Body${++counter}`, m });
  const getBody = (id) => {
    const b = live.get(id);
    if (!b) throw new Error('Referenced body no longer exists');
    return b;
  };
  const sketches = {};
  const solidFromSketch = (f, forRevolve) => {
    const sk = sketches[f.params.sketch];
    if (!sk) throw new Error('Sketch not found');
    sketchUsed.add(sk.id);
    const cs = sketchSection(sk, t);
    if (!cs) throw new Error('Sketch has no closed profile');
    return { cs, sk };
  };
  const overlaps = (a, b, pad = 1e-3) => a.min.every((v, k) => v <= b.max[k] + pad && a.max[k] >= b.min[k] - pad);
  const applyOp = (f, solid, op, target) => {
    if (op === 'auto') {
      let best = null, bv = 0;
      for (const b of live.values()) { const v = t(b.m.intersect(solid)).volume(); if (v > bv) { bv = v; best = b; } }
      if (best && bv > 1e-6 * Math.max(solid.volume(), 1e-9)) { best.m = t(best.m.subtract(solid)); if (best.m.isEmpty()) live.delete(best.id); return; }
      const sb = bboxOf(solid);
      const touch = [...live.values()].find((b) => overlaps(bboxOf(b.m), sb));
      if (touch) touch.m = t(touch.m.add(solid)); else addBody(f.id, solid, f.name);
      return;
    }
    if (op === 'cut') {
      const ids = !target || target === 'all' ? [...live.keys()] : [target];
      for (const id of ids) {
        const b = getBody(id);
        b.m = t(b.m.subtract(solid));
        if (b.m.isEmpty()) live.delete(id);
      }
    } else if (op === 'join' || op === 'intersect') {
      const b = (target && live.get(target)) || [...live.values()][0];
      if (!b) addBody(f.id, solid, f.name);
      else b.m = t(op === 'join' ? b.m.add(solid) : b.m.intersect(solid));
    } else addBody(f.id, solid, f.name);
  };

  for (let i = 0; i < Math.min(count, features.length); i++) {
    const f = features[i];
    snaps.push(snap());
    if (opts.capture === i) captured = [...live.values()].map((b) => { const me = b.m.getMesh(); return { id: b.id, name: b.name, verts: new Float32Array(me.vertProperties.filter((_, k) => k % me.numProp < 3)), tris: new Uint32Array(me.triVerts) }; });
    if (f.suppressed) continue;
    try {
      const p = f.params;
      switch (f.type) {
        case 'primitive': addBody(f.id, makePrimitive(p, t), f.name); break;
        case 'sketch': sketches[f.id] = f; break;
        case 'extrude': {
          const { cs, sk } = solidFromSketch(f);
          const fr = planeFrame(sk.params);
          let dist = p.distance || 0;
          const dirSign = p.extent && p.extent !== 'distance' ? (p.flip ? -1 : 1) : dist < 0 ? -1 : 1;
          if (p.extent === 'all') dist = dirSign * BIGDIST;
          else if (p.extent === 'object') {
            const ob = getBody(p.toBody);
            const bb = bboxOf(ob.m);
            const ds = [];
            for (const cx of [bb.min[0], bb.max[0]]) for (const cy of [bb.min[1], bb.max[1]]) for (const cz of [bb.min[2], bb.max[2]]) ds.push(dirSign * dot(sub([cx, cy, cz], fr.o), fr.n));
            const far = Math.max(...ds), near = Math.min(...ds);
            if (far <= 1e-6) throw new Error('The object is behind the profile — flip the direction');
            dist = dirSign * (near <= 1e-6 || p.op === 'cut' ? far : near);
          }
          const d = Math.abs(dist) || 1e-3;
          let m;
          if (p.taper) {
            if (p.symmetric) throw new Error('Taper cannot be combined with Symmetric');
            const polys = cs.toPolygons();
            if (polys.length !== 1) throw new Error('Taper needs a single closed profile without holes');
            const off = t(cs.offset(-d * Math.tan((p.taper * Math.PI) / 180), 'Miter'));
            const polys2 = off.toPolygons();
            if (polys2.length !== 1) throw new Error('Taper angle too large for this profile');
            const lift = (pl, z) => pl.map(([u, v]) => [u, v, z]);
            const rings = loftRings([lift(polys[0], 0), lift(polys2[0], dirSign * d)]);
            m = solidFromRings(rings, false, t);
          } else {
            m = p.twist || p.scaleTop !== 1
              ? t(cs.extrude(d, p.twist ? 32 : 1, p.twist || 0, p.scaleTop ?? 1))
              : t(cs.extrude(d));
            if (p.symmetric) m = t(m.translate([0, 0, -d / 2]));
            else if (dist < 0) m = t(m.translate([0, 0, -d]));
          }
          if (p.taper) { /* rings already carry the sign */ }
          applyOp(f, toPlane(m, sk.params, t), p.op, p.target);
          break;
        }
        case 'revolve': {
          const { cs, sk } = solidFromSketch(f);
          const full = p.angle >= 360;
          let m = t(cs.revolve(SEG, p.angle));
          m = t(m.rotate([-90, 0, 0])); // axis (local Y of sketch)
          void full;
          applyOp(f, toPlane(m, sk.params, t), p.op, p.target);
          break;
        }
        case 'move': {
          const b = getBody(p.body);
          const bb = bboxOf(b.m);
          const c = bb.min.map((v, k) => (v + bb.max[k]) / 2);
          let m = t(b.m.translate(c.map((v) => -v)));
          m = t(m.scale(p.s));
          m = t(m.rotate(p.r));
          m = t(m.translate(c.map((v, k) => v + p.t[k])));
          if (p.copy) addBody(f.id, m, f.name); else b.m = m;
          break;
        }
        case 'combine': {
          const a = getBody(p.target), b = getBody(p.tool);
          if (a === b) throw new Error('Target and tool must differ');
          a.m = t(p.op === 'join' ? a.m.add(b.m) : p.op === 'cut' ? a.m.subtract(b.m) : a.m.intersect(b.m));
          if (!p.keepTool) live.delete(p.tool);
          break;
        }
        case 'mirror': {
          const b = getBody(p.body);
          const n = PLANES[p.plane].n;
          let m = t(b.m.translate(n.map((c) => -c * p.offset)));
          m = t(m.mirror(n));
          m = t(m.translate(n.map((c) => c * p.offset)));
          if (p.join) b.m = t(b.m.add(m)); else addBody(f.id, m, f.name);
          break;
        }
        case 'pattern': {
          const b = getBody(p.body);
          let acc = b.m;
          for (let k = 1; k < p.count; k++) {
            let m;
            if (p.kind === 'linear') m = t(b.m.translate(p.spacing.map((v) => v * k)));
            else {
              const r = [0, 0, 0];
              r['XYZ'.indexOf(p.axis)] = (p.angle / (p.angle >= 360 ? p.count : Math.max(1, p.count - 1))) * k;
              m = t(b.m.rotate(r));
            }
            acc = t(acc.add(m));
          }
          b.m = acc;
          break;
        }
        case 'fillet':
        case 'chamfer': {
          const size = f.type === 'fillet' ? p.radius : p.distance;
          if (!p.edges?.length) throw new Error('Select at least one edge in the viewport');
          if (!(size > 0)) throw new Error('Size must be positive');
          const byBody = new Map();
          for (const e of p.edges) byBody.set(e.body, [...(byBody.get(e.body) || []), e]);
          for (const [bid, edges] of byBody) {
            const b = getBody(bid);
            const me = b.m.getMesh();
            const chains = findEdgeChains(me.vertProperties, me.numProp, me.triVerts);
            for (const e of edges) {
              const ch = matchChain(chains, e.pts);
              if (!ch) throw new Error('An edge no longer exists — reselect the edges');
              const cut = edgeCutter(ch, f.type, size, t);
              if (cut.m.isEmpty()) throw new Error('Size too large for this edge');
              b.m = t(cut.convex ? b.m.subtract(cut.m) : b.m.add(cut.m));
            }
          }
          break;
        }
        case 'sweep': {
          const prof = sketches[p.profile], path = sketches[p.path];
          if (!prof || !path) throw new Error('Choose a profile sketch and a path sketch');
          sketchUsed.add(prof.id); sketchUsed.add(path.id);
          const outline = sketchOutline3D(prof, t);
          let { pts, closed } = sketchPath3D(path);
          if (p.smooth && !closed) pts = smoothPath(pts, 3);
          if (pts.length < 2) throw new Error('Path needs at least two points');
          const rings = sweepRings(outline, pts, closed);
          applyOp(f, solidFromRings(rings, closed, t), p.op, p.target);
          break;
        }
        case 'loft': {
          const sks = (p.sketches || []).map((id) => sketches[id]).filter(Boolean);
          if (sks.length < 2) throw new Error('Choose at least two profile sketches');
          sks.forEach((k) => sketchUsed.add(k.id));
          const rings = loftRings(sks.map((k) => sketchOutline3D(k, t)));
          applyOp(f, solidFromRings(rings, false, t), p.op, p.target);
          break;
        }
        case 'coil': {
          const R = p.diameter / 2, h = p.size / 2;
          if (!(R > h) || !(h > 0) || !(p.pitch > 0) || !(p.turns > 0)) throw new Error('Check diameter, section size, pitch and turns');
          const prof = p.section === 'square'
            ? [[R - h, -h], [R + h, -h], [R + h, h], [R - h, h]]
            : Array.from({ length: 16 }, (_, i) => [R + h * Math.cos((i / 16) * Math.PI * 2), h * Math.sin((i / 16) * Math.PI * 2)]);
          const m = solidFromRings(helixRings(prof, { turns: p.turns, pitch: p.pitch, left: p.left }), false, t);
          applyOp(f, t(m.transform(axisFrame(p.origin, axisVec(p.axis)))), p.op, p.target);
          break;
        }
        case 'thread': {
          const b = getBody(p.target);
          const g = threadGroove(p, t);
          b.m = t(b.m.subtract(t(g.transform(axisFrame(p.origin, axisVec(p.axis))))));
          break;
        }
        case 'rib': {
          const sk = sketches[p.sketch];
          if (!sk) throw new Error('Sketch not found');
          sketchUsed.add(sk.id);
          const pieces = [];
          for (const s2 of sk.params.shapes) {
            if (s2.t !== 'path' || !s2.open) continue;
            for (let i = 0; i < s2.pts.length - 1; i++) {
              const [a, b2] = [s2.pts[i], s2.pts[i + 1]];
              const dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy);
              if (L < 1e-9) continue;
              const ux = dx / L, uy = dy / L, hw = p.thickness / 2;
              const A = [a[0] - ux * hw, a[1] - uy * hw], B = [b2[0] + ux * hw, b2[1] + uy * hw];
              pieces.push([[A[0] - uy * hw, A[1] + ux * hw], [B[0] - uy * hw, B[1] + ux * hw], [B[0] + uy * hw, B[1] - ux * hw], [A[0] + uy * hw, A[1] - ux * hw]]);
            }
          }
          if (!pieces.length) throw new Error('Draw an open Path in the sketch (the rib centre-line)');
          const cs = t(K.CrossSection.union(pieces.map((pl) => t(K.CrossSection.ofPolygons([polyArea(pl) < 0 ? [...pl].reverse() : pl])))));
          const h = Math.abs(p.height) || 1e-3;
          let m = t(cs.extrude(h));
          if (p.symmetric) m = t(m.translate([0, 0, -h / 2]));
          else if (p.height < 0) m = t(m.translate([0, 0, -h]));
          applyOp(f, toPlane(m, sk.params, t), p.op, p.target);
          break;
        }
        case 'hole': {
          const tool = holeTool(p, t);
          const dir = unit(p.dir);
          const placed = t(tool.transform(axisFrame(p.pos, scl(dir, -1))));
          applyOp(f, placed, 'cut', p.target);
          break;
        }
        case 'shell': {
          const b = getBody(p.body);
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          const inner = t(b.m.minkowskiDifference(t(K.Manifold.sphere(p.thickness, 12))));
          if (inner.isEmpty()) throw new Error('Wall thickness is too large for this body');
          let cavity = inner;
          for (const o of p.open || []) {
            const M = axisFrame(o.point, o.normal), inv = invFrame(M);
            const cs = t(t(inner.transform(inv)).project());
            const prism = t(t(cs.extrude(p.thickness + 2 + 0.2)).translate([0, 0, -p.thickness - 0.2]));
            cavity = t(cavity.add(t(prism.transform(M))));
          }
          b.m = t(b.m.subtract(cavity));
          break;
        }
        case 'split': {
          const b = getBody(p.body);
          let first, second;
          if (p.by === 'body') {
            const tool = getBody(p.tool);
            if (tool === b) throw new Error('Tool must be a different body');
            [second, first] = b.m.split(tool.m); // [inside, outside]
            t(first); t(second);
            if (!p.keepTool) live.delete(p.tool);
          } else {
            const n = PLANES[p.plane].n;
            [first, second] = b.m.splitByPlane(n, p.offset + 0);
            t(first); t(second);
          }
          const keep = p.keep || 'both';
          const pieces = p.by === 'body' ? [first, second] : [first, second];
          if (keep === 'both') {
            if (!pieces[0].isEmpty()) b.m = pieces[0]; else live.delete(b.id);
            if (!pieces[1].isEmpty()) addBody(f.id, pieces[1], f.name);
          } else {
            const pick = keep === 'above' || keep === 'outside' ? pieces[0] : pieces[1];
            if (pick.isEmpty()) live.delete(b.id); else b.m = pick;
          }
          break;
        }
        case 'scale': {
          const b = getBody(p.body);
          const bb = bboxOf(b.m);
          const c = p.about === 'origin' ? [0, 0, 0] : bb.min.map((v, k) => (v + bb.max[k]) / 2);
          const s3 = p.mode === 'nonuniform' ? p.s : [p.factor, p.factor, p.factor];
          if (!s3.every((v) => v > 0)) throw new Error('Scale factors must be positive');
          let m = t(b.m.translate(c.map((v) => -v)));
          m = t(m.scale(s3));
          m = t(m.translate(c));
          if (p.copy) addBody(f.id, m, f.name); else b.m = m;
          break;
        }
        case 'presspull': {
          if (!p.face) throw new Error('Click a flat face in the viewport');
          const b = getBody(p.body);
          const me = b.m.getMesh();
          const verts = me.numProp === 3 ? me.vertProperties : me.vertProperties.filter((_, k) => k % me.numProp < 3);
          const tri = findFaceTri(verts, me.triVerts, p.face.point, p.face.normal);
          if (tri < 0) throw new Error('The picked face no longer exists — pick it again');
          const face = planarFace(verts, me.triVerts, tri);
          if (!face) throw new Error('Press/Pull works on flat faces only');
          if (!p.distance) break;
          const M = axisFrame(face.point, face.normal), inv = invFrame(M);
          const loc = (vi) => { const P = [verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]]; return [inv[0] * P[0] + inv[4] * P[1] + inv[8] * P[2] + inv[12], inv[1] * P[0] + inv[5] * P[1] + inv[9] * P[2] + inv[13]]; };
          const polys = face.tris.map((ti) => {
            const pl = [loc(me.triVerts[ti * 3]), loc(me.triVerts[ti * 3 + 1]), loc(me.triVerts[ti * 3 + 2])];
            return t(K.CrossSection.ofPolygons([polyArea(pl) < 0 ? pl.reverse() : pl]));
          });
          const cs = t(K.CrossSection.union(polys));
          const d = Math.abs(p.distance);
          let m = t(cs.extrude(d));
          if (p.distance < 0) { m = t(m.translate([0, 0, -d])); b.m = t(b.m.subtract(t(m.transform(M)))); }
          else b.m = t(b.m.add(t(m.transform(M))));
          break;
        }
        case 'joint': {
          const A = getBody(p.bodyA), B = getBody(p.bodyB);
          if (A === B) throw new Error('Choose two different bodies');
          const o = p.pointB, ax = 'XYZ'.indexOf(p.axis), av = axisVec(p.axis);
          let m = t(A.m.translate(sub(o, p.pointA)));
          const eul = (deg) => { const r = [0, 0, 0]; r[ax] = deg; return r; };
          const slide = (v) => av.map((c) => c * v);
          switch (p.jtype) {
            case 'revolute': m = rotAbout(m, o, eul(p.value), t); break;
            case 'slider': m = t(m.translate(slide(p.value))); break;
            case 'cylindrical': m = rotAbout(m, o, eul(p.value), t); m = t(m.translate(slide(p.value2))); break;
            case 'planar': {
              const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
              const tr = [0, 0, 0]; tr[a1] = p.value; tr[a2] = p.value2;
              m = rotAbout(m, o, eul(p.value3 || 0), t); m = t(m.translate(tr));
              break;
            }
            case 'ball': m = rotAbout(m, o, p.rot, t); break;
            default: if (p.flip) { const r = [0, 0, 0]; r[(ax + 1) % 3] = 180; m = rotAbout(m, o, r, t); }
          }
          A.m = m;
          break;
        }
        case 'remove': getBody(p.body); live.delete(p.body); break;
        case 'import': {
          const soup = decodeMesh(p);
          addBody(f.id, manifoldFromSoup(soup, t), f.name);
          break;
        }
        default: throw new Error('Unknown feature ' + f.type);
      }
    } catch (e) {
      errors[f.id] = (e && e.message) || String(e);
    }
  }

  const bodies = [...live.values()].map((b) => {
    const mesh = b.m.getMesh();
    return {
      id: b.id, name: b.name,
      verts: new Float32Array(mesh.vertProperties.filter((_, i) => i % mesh.numProp < 3)),
      tris: new Uint32Array(mesh.triVerts),
      volume: b.m.volume(), area: b.m.surfaceArea(), bbox: bboxOf(b.m),
    };
  });
  garbage.forEach((o) => { try { o.delete(); } catch { /* shared handle */ } });
  return { bodies, errors, snaps, sketchUsed, captured };
}
