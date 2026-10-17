// Parametric kernel: replays the feature timeline on top of manifold-3d (WASM).
import Module from 'manifold-3d';
import { findEdgeChains, matchChain, planarFace } from './edges.js';
import { pathPolygon, openLoops } from './sketchgeo.js';
import { repairSoup } from './meshrepair.js';
import { ringMesh, surfaceMesh, loftRings, sweepRings, helixRings, smoothPath, axisFrame, sub, add, scl, dot, len, unit, cross } from './solids.js';

let K;
/** Browser: pass { locateFile } pointing at the bundled wasm. Node (the MCP server): no options needed. */
export async function initKernel(opts = {}) {
  K = await Module(opts);
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

function shapeToCS(s, t) {
  if (s.open) return null;
  let poly = shapeToPolygon(s);
  if (poly.length < 3) return null;
  if (polyArea(poly) < 0) poly = [...poly].reverse();
  return t(K.CrossSection.ofPolygons([poly]));
}

/**
 * Split a sketch into closed regions ("profiles"), as in most CAD tools: every closed area bounded by the sketch
 * shapes is its own selectable region. Returns [{id, cs, sig, defaultOn}].
 * Default selection: nested shapes alternate (a circle inside a rectangle is a hole), partial overlaps all count.
 */
function profileCells(f, t) {
  const items = [];
  f.params.shapes.forEach((s, i) => { if (s.open) return; const cs = shapeToCS(s, t); if (cs && cs.area() > 1e-9) items.push({ i, cs, area: cs.area() }); });
  // closed loops formed by open lines/arcs that meet end to end are profiles too
  openLoops(f.params.shapes).forEach((poly, k) => {
    const a = poly.reduce((acc, [x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return acc + (x1 * y2 - x2 * y1); }, 0);
    const cs = t(K.CrossSection.ofPolygons([a < 0 ? [...poly].reverse() : poly]));
    if (cs.area() > 1e-9) items.push({ i: 1000 + k, cs, area: cs.area() });
  });
  const eps = (a) => Math.max(1e-7, 1e-7 * a);
  let cells = [];
  for (const { i, cs } of items) {
    const next = [];
    let remaining = cs;
    for (const c of cells) {
      const inter = t(c.cs.intersect(cs));
      if (inter.area() > eps(cs.area())) next.push({ sig: [...c.sig, i], cs: inter });
      const diff = t(c.cs.subtract(cs));
      if (diff.area() > eps(c.cs.area())) next.push({ sig: c.sig, cs: diff });
      remaining = t(remaining.subtract(c.cs));
    }
    if (remaining.area() > eps(cs.area())) next.push({ sig: [i], cs: remaining });
    cells = next;
  }
  const byIdx = new Map(items.map((x) => [x.i, x]));
  const nested = (sig) => {
    const sh = sig.map((i) => byIdx.get(i)).sort((a, b) => b.area - a.area);
    for (let k = 1; k < sh.length; k++) {
      const inter = t(sh[k].cs.intersect(sh[k - 1].cs));
      if (Math.abs(inter.area() - sh[k].area) > 1e-6 * sh[k].area) return false;
    }
    return true;
  };
  const out = [];
  for (const c of cells) {
    const parts = c.cs.decompose().map((p) => t(p)).filter((p) => p.area() > eps(c.cs.area()));
    const defaultOn = c.sig.length < 2 || !nested(c.sig) || c.sig.length % 2 === 1;
    parts.map((p) => ({ p, b: p.bounds() })).sort((a, b) => a.b.min[0] - b.b.min[0] || a.b.min[1] - b.b.min[1])
      .forEach(({ p }, k) => out.push({ id: `${c.sig.join('.')}:${k}`, cs: p, sig: c.sig, defaultOn }));
  }
  return out;
}

/** Union of the chosen profile regions (ids = explicit selection, null = defaults). */
export function profileSection(f, ids, t) {
  const cells = profileCells(f, t);
  const chosen = Array.isArray(ids) && ids.length ? cells.filter((c) => ids.includes(c.id)) : cells.filter((c) => c.defaultOn);
  if (!chosen.length) return null;
  return chosen.length === 1 ? chosen[0].cs : t(K.CrossSection.union(chosen.map((c) => c.cs)));
}
export const sketchSection = (f, t) => profileSection(f, null, t);

/** Offset a closed polygon by d (outward positive). Returns the largest resulting polygon or null. */
export function offsetPolygon(poly, d) {
  const garbage = [];
  const t = (o) => { garbage.push(o); return o; };
  try {
    const a = poly.reduce((acc, [x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return acc + (x1 * y2 - x2 * y1); }, 0);
    const cs = t(K.CrossSection.ofPolygons([a < 0 ? [...poly].reverse() : poly]));
    const polys = t(cs.offset(d, 'Miter', 2)).toPolygons();
    const area = (pl) => Math.abs(pl.reduce((acc, [x1, y1], i) => { const [x2, y2] = pl[(i + 1) % pl.length]; return acc + (x1 * y2 - x2 * y1); }, 0));
    return polys.length ? polys.reduce((m, q) => (area(q) > area(m) ? q : m)) : null;
  } catch { return null; } finally { garbage.forEach((o) => { try { o.delete(); } catch { /* shared */ } }); }
}

/** Plain-data profile regions for the UI: [{id, defaultOn, area, polys: [[[x,y]..]..]}]. */
export function profilesOf(f) {
  const garbage = [];
  const t = (o) => { garbage.push(o); return o; };
  try {
    return profileCells(f, t).map((c) => ({ id: c.id, defaultOn: c.defaultOn, area: c.cs.area(), polys: c.cs.toPolygons() }));
  } finally { garbage.forEach((o) => { try { o.delete(); } catch { /* shared */ } }); }
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
/**
 * Chains connected end to end with `ch` (an edge loop): follows a shared end point as long as exactly two chains meet there
 * and the turn is under maxTurnDeg. Edge picking already follows smooth curves; this carries on across sharper corners.
 */
function connectedChains(chains, ch, maxTurnDeg = 100) {
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

/** size: a number, or {r0, r1} to vary linearly along the chain (open chains only). */
function edgeCutter(ch, kind, sizeIn, t) {
  const steps = kind === 'fillet' ? 12 : 0;
  const varying = typeof sizeIn === 'object' && !ch.closed;
  const r0 = varying ? sizeIn.r0 : typeof sizeIn === 'object' ? sizeIn.r0 : sizeIn, r1 = varying ? sizeIn.r1 : r0;
  const size = Math.max(r0, r1);
  const delta = Math.max(0.05 * size, 0.01);
  let pts = ch.pts, frames = ch.frames;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(...vsub(pts[i], pts[i - 1])));
  let sizes = cum.map((c) => r0 + (r1 - r0) * (cum.at(-1) ? c / cum.at(-1) : 0));
  if (!ch.closed) {
    sizes = [sizes[0], ...sizes, sizes.at(-1)];
    const d0 = v3norm(vsub(pts[1], pts[0])), dn = v3norm(vsub(pts[pts.length - 1], pts[pts.length - 2]));
    pts = [vsub(pts[0], vscl(d0, delta)), ...pts, vadd(pts[pts.length - 1], vscl(dn, delta))];
    frames = [frames[0], ...frames, frames[frames.length - 1]];
  }
  const convex = vdot(frames[0].n1, frames[0].u2) < 0;
  const rings = pts.map((p, i) => edgeRing(p, frames[i], kind, sizes[i], steps).ring);
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
  if (sk.type === 'sketch3d') { // a 3D sketch is a polyline through points in space
    const pts = (sk.params.points || []).map((q) => [+q[0] || 0, +q[1] || 0, +q[2] || 0]);
    if (pts.length < 2) throw new Error(`${sk.name} needs at least two points`);
    const closed = !!sk.params.closed && pts.length > 2;
    return { closed, pts: sk.params.smooth && !closed ? smoothPath(pts, 3) : pts };
  }
  const sh = sk.params.shapes.find((s) => s.t === 'path' && s.open) || sk.params.shapes.find((s) => s.t === 'path' || s.t === 'circle' || s.t === 'rect' || s.t === 'ngon');
  if (!sh) throw new Error(`${sk.name} has no path (draw a Path or any shape)`);
  const closed = !sh.open;
  const pts2 = shapeToPolygon(sh);
  const { o, x, y } = planeFrame(sk.params);
  return { closed, pts: pts2.map(([u, v]) => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v]) };
}

/** Every shape of a sketch as a 3D polyline: [{pts, closed}] (open paths and closed shapes alike). */
function sketchCurves3D(sk) {
  const { o, x, y } = planeFrame(sk.params);
  const out = sk.params.shapes.map((sh) => ({ closed: !sh.open, pts: shapeToPolygon(sh).map(([u, v]) => [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v]) })).filter((c) => c.pts.length >= 2);
  if (!out.length) throw new Error(`${sk.name} has no shapes (draw a path, rectangle, circle...)`);
  return out;
}
/** Merge several indexed meshes into one. */
function joinMeshes(list) {
  const verts = [], tris = [];
  for (const m of list) { const base = verts.length / 3; verts.push(...m.verts.flat ? m.verts.flat() : m.verts); for (const i of m.tris) tris.push(i + base); }
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris) };
}
/** Weld surface meshes together and, if they enclose a volume, turn them into a solid. */
function stitchSurfaces(list, t) {
  const j = joinMeshes(list), soup = new Float32Array(j.tris.length * 3);
  for (let i = 0; i < j.tris.length; i++) for (let k = 0; k < 3; k++) soup[i * 3 + k] = j.verts[j.tris[i] * 3 + k];
  const r = repairSoup(soup, { fillHoles: false });
  let solid = null;
  if (r.report.openEdges === 0) { try { solid = manifoldFromIndexed(r.verts, Array.from(r.tris), t); if (solid.isEmpty()) solid = null; } catch { solid = null; } }
  return { surface: { verts: r.verts, tris: r.tris }, openEdges: r.report.openEdges, solid };
}
/** Give an open surface thickness by offsetting along smoothed vertex normals; the open boundary is closed with side walls. */
function thickenSurface(surf, thickness, both, t) {
  const soup = new Float32Array(surf.tris.length * 3);
  for (let i = 0; i < surf.tris.length; i++) for (let k = 0; k < 3; k++) soup[i * 3 + k] = surf.verts[surf.tris[i] * 3 + k];
  const r = repairSoup(soup, { fillHoles: false });
  const V = r.verts, T = r.tris, nv = V.length / 3, N = new Float64Array(nv * 3);
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i], b = T[i + 1], c = T[i + 2];
    const e1 = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]], e2 = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
    const n = cross(e1, e2); // area weighted
    for (const v of [a, b, c]) { N[v * 3] += n[0]; N[v * 3 + 1] += n[1]; N[v * 3 + 2] += n[2]; }
  }
  for (let v = 0; v < nv; v++) { const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1; N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l; }
  const lo = both ? -thickness / 2 : 0, hi = both ? thickness / 2 : thickness;
  const P = new Float32Array(nv * 6); // first nv: bottom, next nv: top
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) { P[v * 3 + k] = V[v * 3 + k] + N[v * 3 + k] * lo; P[(nv + v) * 3 + k] = V[v * 3 + k] + N[v * 3 + k] * hi; }
  const tri = [];
  for (let i = 0; i < T.length; i += 3) { tri.push(nv + T[i], nv + T[i + 1], nv + T[i + 2]); tri.push(T[i], T[i + 2], T[i + 1]); } // top as built, bottom reversed
  const half = new Set(); for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) half.add(`${T[i + k]}>${T[i + (k + 1) % 3]}`);
  for (const h of half) { const [a, b] = h.split('>').map(Number); if (!half.has(`${b}>${a}`)) tri.push(a, b, nv + b, a, nv + b, nv + a); } // boundary walls
  let m;
  try { m = manifoldFromIndexed(P, tri, t); } catch { throw new Error('Could not thicken this surface (it folds over itself at this thickness)'); }
  if (m.isEmpty()) throw new Error('Could not thicken this surface (it folds over itself at this thickness)');
  return m;
}

/** Outline loops (3D points) of a region of triangles, from the edges used by exactly one triangle of the region. */
function faceLoops(V, T, triList) {
  const key = (i) => `${Math.round(V[i * 3] * 1e3)},${Math.round(V[i * 3 + 1] * 1e3)},${Math.round(V[i * 3 + 2] * 1e3)}`;
  const ids = new Map(), pos = [];
  const vid = (i) => { const k = key(i); let id = ids.get(k); if (id === undefined) { id = pos.length; ids.set(k, id); pos.push([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]); } return id; };
  const dir = new Set();
  for (const ti of triList) { const a = vid(T[ti * 3]), b = vid(T[ti * 3 + 1]), c = vid(T[ti * 3 + 2]); dir.add(`${a}>${b}`); dir.add(`${b}>${c}`); dir.add(`${c}>${a}`); }
  const next = new Map();
  for (const e of dir) { const [a, b] = e.split('>').map(Number); if (!dir.has(`${b}>${a}`)) (next.get(a) || next.set(a, []).get(a)).push(b); }
  const loops = [], used = new Set();
  for (const [start, outs] of next) for (const first of outs) {
    if (used.has(`${start}>${first}`)) continue;
    const lp = [start]; let a = start, b = first;
    for (let guard = 0; guard < 100000; guard++) {
      used.add(`${a}>${b}`);
      if (b === start) { loops.push(lp.map((i) => pos[i])); break; }
      lp.push(b);
      const nx = (next.get(b) || []).find((n) => !used.has(`${b}>${n}`));
      if (nx === undefined) break;
      a = b; b = nx;
    }
  }
  return loops;
}


function meshV3(m) {
  const me = m.getMesh(), np = me.numProp, n = me.vertProperties.length / np, V = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { V[i * 3] = me.vertProperties[i * np]; V[i * 3 + 1] = me.vertProperties[i * np + 1]; V[i * 3 + 2] = me.vertProperties[i * np + 2]; }
  return { V, T: me.triVerts };
}
/** Outline of a flat face as a cross-section in the face frame (outer loop CCW, holes CW). */
function faceOutlineCS(V, T, pf, X, Y, t) {
  const o = pf.point;
  const loops = faceLoops(V, T, pf.tris).map((lp) => lp.map((q) => { const d = sub(q, o); return [dot(d, X), dot(d, Y)]; }));
  if (!loops.length) throw new Error('Could not read the outline of a picked face');
  const area = (pl) => pl.reduce((a2, [x1, y1], i) => { const [x2, y2] = pl[(i + 1) % pl.length]; return a2 + (x1 * y2 - x2 * y1); }, 0) / 2;
  const polys = loops.sort((a2, b2) => Math.abs(area(b2)) - Math.abs(area(a2)));
  return t(K.CrossSection.ofPolygons(polys.map((pl, i) => (i === 0 ? (area(pl) < 0 ? pl.reverse() : pl) : (area(pl) > 0 ? pl.reverse() : pl)))));
}
/** Keep the part of an open surface on the side where dot(n,x) >= off; triangles that cross the plane are cut. */
function clipSurface(sf, n, off) {
  const P = (i) => [sf.verts[i * 3], sf.verts[i * 3 + 1], sf.verts[i * 3 + 2]];
  const outV = [], outT = [];
  const push = (q) => { outV.push(q[0], q[1], q[2]); return outV.length / 3 - 1; };
  for (let i = 0; i < sf.tris.length; i += 3) {
    const pts = [P(sf.tris[i]), P(sf.tris[i + 1]), P(sf.tris[i + 2])], d = pts.map((q) => dot(n, q) - off), poly = [];
    for (let k = 0; k < 3; k++) {
      const a = pts[k], b = pts[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
      if (da >= 0) poly.push(a);
      if ((da >= 0) !== (db >= 0)) { const s = da / (da - db); poly.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]); }
    }
    if (poly.length < 3) continue;
    const ids = poly.map(push);
    for (let k = 1; k < ids.length - 1; k++) outT.push(ids[0], ids[k], ids[k + 1]);
  }
  const r = repairSoup(Float32Array.from(outT.flatMap((i) => [outV[i * 3], outV[i * 3 + 1], outV[i * 3 + 2]])), { fillHoles: false });
  return { verts: r.verts, tris: r.tris };
}
/** Grow an open surface outward from every open edge by a straight tangent strip. */
function extendSurface(sf, dist) {
  const soup = new Float32Array(sf.tris.length * 3);
  for (let i = 0; i < sf.tris.length; i++) for (let k = 0; k < 3; k++) soup[i * 3 + k] = sf.verts[sf.tris[i] * 3 + k];
  const r = repairSoup(soup, { fillHoles: false }), V = r.verts, T = r.tris, nv = V.length / 3;
  const P = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  const used = new Map(); // directed edge -> opposite vertex
  for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) used.set(`${T[i + k]}>${T[i + (k + 1) % 3]}`, T[i + (k + 2) % 3]);
  const dirSum = new Map(), cnt = new Map(), edges = [];
  for (const [e, opp] of used) {
    const [a, b] = e.split('>').map(Number);
    if (used.has(`${b}>${a}`)) continue;
    edges.push([a, b]);
    const ab = unit(sub(P(b), P(a))), mid = scl(add(P(a), P(b)), 0.5), away = sub(mid, P(opp));
    const out = unit(sub(away, scl(ab, dot(away, ab)))); // in the surface, perpendicular to the edge, pointing away from the surface
    for (const v of [a, b]) { dirSum.set(v, add(dirSum.get(v) || [0, 0, 0], out)); cnt.set(v, (cnt.get(v) || 0) + 1); }
  }
  if (!edges.length) return null;
  const verts = Array.from(V), tris = Array.from(T), ext = new Map();
  for (const [v, d] of dirSum) {
    const u = unit(d), q = add(P(v), scl(u, dist / Math.max(0.5, Math.hypot(...d) / cnt.get(v)))); // corners are pushed out further so the strip keeps its width
    ext.set(v, verts.length / 3); verts.push(q[0], q[1], q[2]);
  }
  for (const [a, b] of edges) tris.push(a, b, ext.get(b), a, ext.get(b), ext.get(a));
  return { verts: Float32Array.from(verts), tris: Uint32Array.from(tris) };
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
export function findFaceTri(verts, tris, point, normal) {
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

/** Pairwise overlap volumes (mm³) between result bodies. */
export function interference(bodies) {
  const ms = bodies.map((b) => { try { return new K.Manifold(new K.Mesh({ numProp: 3, vertProperties: b.verts, triVerts: b.tris })); } catch { return null; } });
  const out = [];
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    if (!ms[i] || !ms[j]) continue;
    const x = K.Manifold.intersection(ms[i], ms[j]);
    const v = x.isEmpty() ? 0 : x.volume();
    x.delete();
    if (v > 1e-6) out.push({ a: bodies[i], b: bodies[j], volume: v });
  }
  ms.forEach((m) => m && m.delete());
  return out;
}
export function bboxOf(m) {
  const b = m.boundingBox();
  return { min: b.min, max: b.max };
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
  const frames = {};
  const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  return features.map((f) => {
    if (f.type === 'plane') {
      const base = frames[f.params.base] ? { plane: 'custom', ...frames[f.params.base], offset: 0 } : { plane: f.params.base || 'XY', offset: 0 };
      const fr = planeFrame(base), d = +f.params.offset || 0;
      const geo = { origin: fr.o.map((c, k) => c + fr.n[k] * d), normal: fr.n, xdir: fr.x };
      frames[f.id] = geo;
      return { ...f, params: { ...f.params, ...geo } };
    }
    if (f.type === 'sketch' && f.params.planeRef && frames[f.params.planeRef]) {
      const g = frames[f.params.planeRef];
      if (f.params.plane === 'custom' && same(f.params.origin, g.origin) && same(f.params.normal, g.normal) && same(f.params.xdir, g.xdir)) return f;
      return { ...f, params: { ...f.params, plane: 'custom', ...g } };
    }
    return f;
  });
}

export function rebuild(features, count, opts = {}) {
  features = resolvePlanes(features);
  const garbage = [];
  const t = (o) => { garbage.push(o); return o; };
  const live = new Map(); // id -> {id,name,m}
  const errors = {};
  const snaps = [];
  const sketchUsed = new Set();
  let captured = null;
  let preview = null;
  let curF = null;
  let counter = 0;
  const snap = () => [...live.values()].map((b) => ({ id: b.id, name: b.name, bbox: bboxOf(b.m) }));
  const addBody = (id, m, name) => live.set(id, { id, name: name || `Body${++counter}`, m });
  const getBody = (id) => {
    const b = live.get(id);
    if (!b) throw new Error('Referenced body no longer exists');
    return b;
  };
  const planeGeo = (ref) => {
    const q = features.find((x) => x.id === ref && x.type === 'plane');
    if (q) return { origin: q.params.origin, normal: q.params.normal };
    const fr = planeFrame({ plane: ref });
    return { origin: fr.o, normal: fr.n };
  };
  const sketches = {};
  const surfaces = new Map(); // id -> {id, name, verts, tris}: open surface bodies (not solids)
  const surfSnaps = [];
  let surfCount = 0;
  const addSurface = (id, mesh, name) => surfaces.set(id, { id, name: name || `Surface${++surfCount}`, verts: Float32Array.from(mesh.verts), tris: Uint32Array.from(mesh.tris) });
  const getSurface = (id) => { const sf = surfaces.get(id); if (!sf) throw new Error('A surface you picked no longer exists'); return sf; };
  const solidFromSketch = (f, forRevolve) => {
    const sk = sketches[f.params.sketch];
    if (!sk) throw new Error('Sketch not found');
    sketchUsed.add(sk.id);
    const cs = profileSection(sk, f.params.profiles, t);
    if (!cs) throw new Error(f.params.profiles?.length ? 'The selected profiles no longer exist — pick them again' : 'Sketch has no closed profile');
    return { cs, sk };
  };
  const overlaps = (a, b, pad = 1e-3) => a.min.every((v, k) => v <= b.max[k] + pad && a.max[k] >= b.min[k] - pad);
  const applyOp = (f, solid, op, target) => {
    if (opts.previewId && opts.previewId === f.id) {
      const me = solid.getMesh();
      preview = { op, verts: new Float32Array(me.vertProperties.filter((_, k) => k % me.numProp < 3)), tris: new Uint32Array(me.triVerts) };
    }
    if (op === 'auto') {
      let best = null, bv = 0;
      for (const b of live.values()) { const v = t(b.m.intersect(solid)).volume(); if (v > bv) { bv = v; best = b; } }
      if (best && bv > 1e-6 * Math.max(solid.volume(), 1e-9)) { if (preview && curF === f) preview.op = 'cut'; best.m = t(best.m.subtract(solid)); if (best.m.isEmpty()) live.delete(best.id); return; }
      const sb = bboxOf(solid);
      const touch = [...live.values()].find((b) => overlaps(bboxOf(b.m), sb));
      if (preview && curF === f) preview.op = 'join';
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
    const f0 = features[i];
    // Emboss is an extrude in disguise: raise = join outward along the sketch normal, engrave = cut into the part
    const eng = f0.type === 'emboss' && f0.params.mode === 'engrave';
    const f = f0.type === 'emboss'
      ? { ...f0, type: 'extrude', params: { sketch: f0.params.sketch, profiles: f0.params.profiles, extent: 'distance', distance: (eng ? -1 : 1) * Math.abs(f0.params.depth || 0), flip: false, symmetric: false, op: eng ? 'cut' : 'join', target: f0.params.target || '', toBody: '', taper: 0, twist: 0, scaleTop: 1 } }
      : f0;
    curF = f;
    snaps.push(snap());
    surfSnaps.push([...surfaces.values()].map((q) => ({ id: q.id, name: q.name })));
    if (opts.capture === i) captured = [...live.values()].map((b) => { const me = b.m.getMesh(); return { id: b.id, name: b.name, verts: new Float32Array(me.vertProperties.filter((_, k) => k % me.numProp < 3)), tris: new Uint32Array(me.triVerts) }; });
    if (f.suppressed) continue;
    try {
      const p = f.params;
      switch (f.type) {
        case 'primitive': addBody(f.id, makePrimitive(p, t), f.name); break;
        case 'sketch': sketches[f.id] = f; break;
        case 'sketch3d': sketches[f.id] = f; break; // used as a path by Sweep, Pipe and Pattern
        case 'plane': break; // construction geometry only (see resolvePlanes)
        case 'extrude': {
          let { cs, sk } = solidFromSketch(f);
          if (p.thin) { // thin extrude: only a wall of the given thickness around each profile outline
            const w = p.wall ?? 1;
            if (!(w > 0)) throw new Error('Wall thickness must be positive');
            if (p.taper) throw new Error('Taper cannot be combined with Thin extrude');
            const side = p.wallSide || 'inside', grow = side === 'inside' ? 0 : side === 'outside' ? w : w / 2, shrink = side === 'inside' ? w : side === 'outside' ? 0 : w / 2;
            const outer = grow ? t(cs.offset(grow, 'Miter', 2)) : cs, inner = shrink ? t(cs.offset(-shrink, 'Miter', 2)) : cs;
            cs = t(outer.subtract(inner));
            if (cs.isEmpty() || cs.area() < 1e-9) throw new Error('Wall is too thick for this profile');
          }
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
          if (p.kind === 'path') {
            const sk = sketches[p.path];
            if (!sk) throw new Error('Choose a path sketch');
            sketchUsed.add(sk.id);
            const { pts, closed } = sketchPath3D(sk);
            const P = closed ? [...pts, pts[0]] : pts;
            const seg = [0];
            for (let i = 1; i < P.length; i++) seg.push(seg[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
            const total = seg[seg.length - 1];
            if (!(total > 0)) throw new Error('Path has no length');
            const at = (d) => { let i = 1; while (i < seg.length - 1 && seg[i] < d) i++; const u = (d - seg[i - 1]) / ((seg[i] - seg[i - 1]) || 1); return P[i - 1].map((v, k) => v + (P[i][k] - v) * u); };
            const start = at(0), n = Math.max(2, p.count | 0);
            for (let k = 1; k < n; k++) {
              const q = at((total * k) / (closed ? n : n - 1));
              acc = t(acc.add(t(b.m.translate([q[0] - start[0], q[1] - start[1], q[2] - start[2]]))));
            }
            b.m = acc;
            break;
          }
          if (p.kind === 'face') {
            if (!p.face) throw new Error('Click a flat face to pattern across');
            const bb = getBody(p.faceBody || p.body);
            const me = bb.m.getMesh();
            const verts = me.numProp === 3 ? me.vertProperties : me.vertProperties.filter((_, k) => k % me.numProp < 3);
            const tri = findFaceTri(verts, me.triVerts, p.face.point, p.face.normal);
            if (tri < 0) throw new Error('The picked face no longer exists — pick it again');
            const M = axisFrame(p.face.point, p.face.normal);
            const U = [M[0], M[1], M[2]], V = [M[4], M[5], M[6]];
            for (let i = 0; i < Math.max(1, p.countU | 0); i++) for (let j = 0; j < Math.max(1, p.countV | 0); j++) {
              if (!i && !j) continue;
              const d = [0, 1, 2].map((k) => U[k] * p.spacingU * i + V[k] * p.spacingV * j);
              acc = t(acc.add(t(b.m.translate(d))));
            }
            b.m = acc;
            break;
          }
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
          const size0 = f.type === 'fillet' ? p.radius : p.distance;
          if (!p.edges?.length) throw new Error('Select at least one edge in the viewport');
          if (!(size0 > 0)) throw new Error('Size must be positive');
          const size = f.type === 'fillet' && p.variable ? (() => { if (!(p.radiusEnd > 0)) throw new Error('End radius must be positive'); return p.reverse ? { r0: p.radiusEnd, r1: p.radius } : { r0: p.radius, r1: p.radiusEnd }; })() : size0;
          const byBody = new Map();
          for (const e of p.edges) byBody.set(e.body, [...(byBody.get(e.body) || []), e]);
          for (const [bid, edges] of byBody) {
            const b = getBody(bid);
            const me = b.m.getMesh();
            const chains = findEdgeChains(me.vertProperties, me.numProp, me.triVerts);
            const todo = [];
            for (const e of edges) {
              const ch = matchChain(chains, e.pts);
              if (!ch) throw new Error('An edge no longer exists — reselect the edges');
              for (const c of p.tangent ? connectedChains(chains, ch) : [ch]) if (!todo.includes(c)) todo.push(c);
            }
            for (const ch of todo) {
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
        case 'sextrude': {
          const sk = sketches[p.sketch];
          if (!sk) throw new Error('Choose a sketch');
          sketchUsed.add(sk.id);
          const { n } = planeFrame(sk.params), d = p.distance || 0;
          if (!d) throw new Error('Enter a distance');
          const parts = sketchCurves3D(sk).map((c) => {
            const off = p.symmetric ? -d / 2 : 0;
            const r0 = c.pts.map((q) => add(q, scl(n, off))), r1 = r0.map((q) => add(q, scl(n, d)));
            return surfaceMesh([r0, r1], c.closed, false);
          });
          addSurface(f.id, joinMeshes(parts), f.name);
          break;
        }
        case 'srevolve': {
          const sk = sketches[p.sketch];
          if (!sk) throw new Error('Choose a sketch');
          sketchUsed.add(sk.id);
          const fr = planeFrame(sk.params), ang = Math.min(360, Math.max(1, p.angle ?? 360)), full = ang >= 360;
          const SEGS = Math.max(8, Math.ceil(ang / 7.5)), R = full ? SEGS : SEGS + 1;
          const parts = sk.params.shapes.map((sh) => ({ closed: !sh.open, uv: shapeToPolygon(sh) })).filter((c) => c.uv.length >= 2).map((c) => {
            const rings = [];
            for (let k = 0; k < R; k++) {
              const th = (k / SEGS) * ang * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
              rings.push(c.uv.map(([u, v]) => add(add(fr.o, scl(fr.x, u * cs)), add(scl(fr.n, u * sn), scl(fr.y, v)))));
            }
            return surfaceMesh(rings, c.closed, full);
          });
          if (!parts.length) throw new Error('The sketch has no shapes to revolve');
          addSurface(f.id, joinMeshes(parts), f.name);
          break;
        }
        case 'ssweep': {
          const prof = sketches[p.profile], path = sketches[p.path];
          if (!prof || !path) throw new Error('Choose a profile sketch and a path sketch');
          sketchUsed.add(prof.id); sketchUsed.add(path.id);
          let { pts, closed } = sketchPath3D(path);
          if (p.smooth && !closed) pts = smoothPath(pts, 3);
          if (pts.length < 2) throw new Error('Path needs at least two points');
          const parts = sketchCurves3D(prof).map((c) => surfaceMesh(sweepRings(c.pts, pts, closed), c.closed, closed));
          addSurface(f.id, joinMeshes(parts), f.name);
          break;
        }
        case 'sloft': {
          const sks = (p.sketches || []).map((id) => sketches[id]).filter(Boolean);
          if (sks.length < 2) throw new Error('Choose at least two profile sketches');
          sks.forEach((k) => sketchUsed.add(k.id));
          addSurface(f.id, surfaceMesh(loftRings(sks.map((k) => sketchOutline3D(k, t))), true, false), f.name);
          break;
        }
        case 'pipe': {
          const path = sketches[p.path];
          if (!path) throw new Error('Choose a path sketch');
          sketchUsed.add(path.id);
          if (!(p.diameter > 0)) throw new Error('Diameter must be positive');
          let { pts, closed } = sketchPath3D(path);
          if (p.smooth && !closed) pts = smoothPath(pts, 3);
          if (pts.length < 2) throw new Error('Path needs at least two points');
          const t0 = unit(sub(pts[1], pts[0])), ref = Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
          const ux = unit(cross(ref, t0)), uy = cross(t0, ux);
          const circle = (r) => Array.from({ length: 32 }, (_, i) => { const a = (i / 32) * 2 * Math.PI; return add(pts[0], add(scl(ux, r * Math.cos(a)), scl(uy, r * Math.sin(a)))); });
          let m = solidFromRings(sweepRings(circle(p.diameter / 2), pts, closed), closed, t);
          if (p.wall > 0) {
            if (p.wall * 2 >= p.diameter) throw new Error('Wall thickness is too large for this diameter');
            m = t(m.subtract(solidFromRings(sweepRings(circle(p.diameter / 2 - p.wall), pts, closed), closed, t)));
          }
          applyOp(f, m, p.op || 'new', p.target);
          break;
        }
        case 'sstitch': {
          const ids = (p.surfaces || []).filter((id) => surfaces.has(id));
          if (ids.length < 1) throw new Error('Pick at least one surface');
          const res = stitchSurfaces(ids.map((id) => surfaces.get(id)), t);
          for (const id of ids) surfaces.delete(id);
          if (res.solid) addBody(f.id, res.solid, f.name);
          else if (p.requireSolid) { throw new Error(`The surfaces are not a closed shell yet (${res.openEdges} open edge segments)`); }
          else addSurface(f.id, res.surface, f.name);
          break;
        }
        case 'sthicken': {
          const sf = getSurface(p.surface);
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          const m = thickenSurface(sf, p.thickness, p.both, t);
          surfaces.delete(sf.id);
          addBody(f.id, m, f.name);
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
          const side = p.side || 'inside';
          const sph = (r) => t(K.Manifold.sphere(r, 12));
          let inner, outer = b.m;
          if (side === 'inside') inner = t(b.m.minkowskiDifference(sph(p.thickness)));
          else if (side === 'outside') { inner = b.m; outer = t(b.m.minkowskiSum(sph(p.thickness))); }
          else { inner = t(b.m.minkowskiDifference(sph(p.thickness / 2))); outer = t(b.m.minkowskiSum(sph(p.thickness / 2))); }
          if (inner.isEmpty()) throw new Error('Wall thickness is too large for this body');
          let cavity = inner;
          for (const o of p.open || []) {
            const M = axisFrame(o.point, o.normal), inv = invFrame(M);
            const cs = t(t(inner.transform(inv)).project());
            const prism = t(t(cs.extrude(p.thickness + 2 + 0.2)).translate([0, 0, -p.thickness - 0.2]));
            cavity = t(cavity.add(t(prism.transform(M))));
          }
          b.m = t(outer.subtract(cavity));
          break;
        }
        case 'draft': {
          // Exact draft of flat faces: each face is tilted about the neutral plane by cutting away (inward) or adding (outward)
          // the wedge between the face and its tilted plane, limited to the face's own outline.
          const b = getBody(p.body);
          if (!p.faces?.length) throw new Error('Pick the faces to draft');
          const ang = ((p.angle || 0) * Math.PI) / 180;
          if (Math.abs(ang) < 1e-9) throw new Error('Enter a draft angle');
          if (Math.abs(ang) >= Math.PI / 4) throw new Error('Draft angle must be under 45 degrees');
          const u = ({ '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] })[p.dir || '+Z'];
          const me = b.m.getMesh(), np = me.numProp, V = new Float32Array((me.vertProperties.length / np) * 3), T = me.triVerts;
          for (let i = 0; i < V.length / 3; i++) { V[i * 3] = me.vertProperties[i * np]; V[i * 3 + 1] = me.vertProperties[i * np + 1]; V[i * 3 + 2] = me.vertProperties[i * np + 2]; }
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < V.length / 3; i++) { const h = V[i * 3] * u[0] + V[i * 3 + 1] * u[1] + V[i * 3 + 2] * u[2]; lo = Math.min(lo, h); hi = Math.max(hi, h); }
          const end = p.neutral === 'end', h0 = end ? hi : lo, hsign = end ? -1 : 1, tn = Math.tan(ang);
          const bb = bboxOf(b.m), D = 2 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 10;
          let m = b.m;
          for (const fc of p.faces) { // re-read the current mesh each time so a neighbour's wedge extends this face's outline (fills corners when drafting outward)
            const cm = m.getMesh(), cnp = cm.numProp, CV = new Float32Array((cm.vertProperties.length / cnp) * 3), CT = cm.triVerts;
            for (let i = 0; i < CV.length / 3; i++) { CV[i * 3] = cm.vertProperties[i * cnp]; CV[i * 3 + 1] = cm.vertProperties[i * cnp + 1]; CV[i * 3 + 2] = cm.vertProperties[i * cnp + 2]; }
            const tri = findFaceTri(CV, CT, fc.point, fc.normal);
            const pf = tri < 0 ? null : planarFace(CV, CT, tri);
            if (!pf) throw new Error('One of the picked faces is not a flat face of this body any more');
            if (Math.abs(dot(pf.normal, u)) > 0.9) throw new Error('A picked face is parallel to the neutral plane; pick the side faces');
            const M = axisFrame(pf.point, pf.normal), inv = invFrame(M);
            const X = [M[0], M[1], M[2]], Y = [M[4], M[5], M[6]], o = pf.point;
            const loops = faceLoops(CV, CT, pf.tris).map((lp) => lp.map((q) => { const d = sub(q, o); return [dot(d, X), dot(d, Y)]; }));
            if (!loops.length) throw new Error('Could not read the outline of a picked face');
            const area = (pl) => pl.reduce((a2, [x1, y1], i) => { const [x2, y2] = pl[(i + 1) % pl.length]; return a2 + (x1 * y2 - x2 * y1); }, 0) / 2;
            const polys = loops.map((pl) => pl.slice()).sort((a2, b2) => Math.abs(area(b2)) - Math.abs(area(a2)));
            const cs = t(K.CrossSection.ofPolygons(polys.map((pl, i) => (i === 0 ? (area(pl) < 0 ? pl.reverse() : pl) : (area(pl) > 0 ? pl.reverse() : pl)))));
            const g = [-tn * hsign * dot(u, X), -tn * hsign * dot(u, Y)], f0 = -tn * hsign * (dot(u, o) - h0);
            const nl = Math.hypot(g[0], g[1], 1), N = [-g[0] / nl, -g[1] / nl, 1 / nl], off = f0 / nl; // unit normal, matching offset
            const up = t(cs.extrude(D)), down = t(t(cs.extrude(D)).translate([0, 0, -D]));
            const wedgeIn = t(down.trimByPlane(N, off)), wedgeOut = t(up.trimByPlane([-N[0], -N[1], -N[2]], -off));
            if (wedgeIn.volume() > 1e-9) m = t(m.subtract(t(wedgeIn.transform(M))));
            if (wedgeOut.volume() > 1e-9) m = t(m.add(t(wedgeOut.transform(M))));
          }
          b.m = m;
          break;
        }
        case 'mreduce': {
          // Fewer triangles: simplify within a deviation limit, searching for the smallest tolerance that reaches the target
          const b = getBody(p.body);
          const orig = b.m.numTri(), target = Math.max(8, Math.round((orig * (p.keep ?? 50)) / 100));
          const maxDev = Math.max(0.001, p.tolerance ?? 0.2);
          let best = t(b.m.simplify(maxDev));
          if (best.numTri() <= target) {
            let lo = 0, hi = maxDev;
            for (let i = 0; i < 8; i++) {
              const mid = (lo + hi) / 2, r = t(b.m.simplify(mid));
              if (r.numTri() <= target) { hi = mid; best = r; } else lo = mid;
            }
          }
          if (best.isEmpty()) throw new Error('Reducing removed the whole body; lower the deviation');
          b.m = best;
          break;
        }
        case 'mclean': {
          // clean a mesh body: weld nearly coincident vertices and drop stray fragments, then rebuild the solid
          const b = getBody(p.body);
          const me = b.m.getMesh(), np = me.numProp, soup = new Float32Array(me.triVerts.length * 3);
          for (let i = 0; i < me.triVerts.length; i++) for (let k = 0; k < 3; k++) soup[i * 3 + k] = me.vertProperties[me.triVerts[i] * np + k];
          const fixed = repairSoup(soup, { tolerance: Math.max(0, +p.tolerance || 0), minShell: Math.max(0, +p.minShell || 0) });
          const m2 = manifoldFromSoup(fixed.soup, t);
          if (m2.isEmpty()) throw new Error('Cleaning left nothing: lower the piece size limit');
          b.m = m2;
          break;
        }
        case 'mseparate': {
          const b = getBody(p.body);
          const parts = b.m.decompose().map((x) => t(x)).sort((a, c) => c.volume() - a.volume());
          if (parts.length < 2) throw new Error('This body is one connected piece, so there is nothing to separate');
          b.m = parts[0];
          parts.slice(1).forEach((pm, k) => addBody(`${f.id}~${k + 2}`, pm, `${b.name} ${k + 2}`));
          break;
        }
        case 'thickenface': {
          // Give flat faces thickness: a slab grown outward (joined to the body) or inward (cut out of it)
          const b = getBody(p.body);
          if (!p.faces?.length) throw new Error('Pick the faces to thicken');
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          let m = b.m;
          for (const fc of p.faces) {
            const { V, T } = meshV3(m);
            const tri = findFaceTri(V, T, fc.point, fc.normal);
            const pf = tri < 0 ? null : planarFace(V, T, tri);
            if (!pf) throw new Error('One of the picked faces is not a flat face of this body any more');
            const tris = [];
            for (const ti of pf.tris) tris.push(T[ti * 3], T[ti * 3 + 1], T[ti * 3 + 2]);
            let slab = thickenSurface({ verts: V, tris: Uint32Array.from(tris) }, p.thickness, false, t);
            if (p.dir === 'in') slab = t(slab.translate(pf.normal.map((c) => -c * p.thickness))); // the slab is built outward; sink it into the body to cut
            m = t(p.dir === 'in' ? m.subtract(slab) : m.add(slab));
            if (m.isEmpty()) throw new Error('Thickening removed the whole body');
          }
          b.m = m;
          break;
        }
        case 'replaceface': {
          // Move a flat face onto a plane: grow the body up to the plane, or trim it back to the plane
          const b = getBody(p.body);
          if (!p.face) throw new Error('Pick the flat face to replace');
          const g = planeGeo(p.plane || 'XY');
          const nt0 = v3norm(g.normal), ot = g.origin.map((c, k) => c + nt0[k] * (p.offset || 0));
          const { V, T } = meshV3(b.m);
          const tri = findFaceTri(V, T, p.face.point, p.face.normal);
          const pf = tri < 0 ? null : planarFace(V, T, tri);
          if (!pf) throw new Error('The picked face is not a flat face of this body any more');
          const M = axisFrame(pf.point, pf.normal), X = [M[0], M[1], M[2]], Y = [M[4], M[5], M[6]], Zn = pf.normal;
          let nl = [dot(nt0, X), dot(nt0, Y), dot(nt0, Zn)], offl = dot(nt0, ot) - dot(nt0, pf.point);
          if (Math.abs(nl[2]) < 0.05) throw new Error('The plane is (nearly) perpendicular to the face; choose a plane that crosses the face direction');
          if (nl[2] < 0) { nl = nl.map((c) => -c); offl = -offl; }
          const cs = faceOutlineCS(V, T, pf, X, Y, t);
          const bb = bboxOf(b.m), D = 2 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 2 * Math.hypot(...ot) + 10;
          const up = t(cs.extrude(D)), down = t(t(cs.extrude(D)).translate([0, 0, -D]));
          const grow = t(up.trimByPlane([-nl[0], -nl[1], -nl[2]], -offl)), cut = t(down.trimByPlane(nl, offl));
          let m = b.m;
          if (cut.volume() > 1e-9) m = t(m.subtract(t(cut.transform(M))));
          if (grow.volume() > 1e-9) m = t(m.add(t(grow.transform(M))));
          if (m.isEmpty()) throw new Error('Replacing the face removed the whole body');
          b.m = m;
          break;
        }
        case 'boundaryfill': {
          // Solid from the empty space enclosed by the tool bodies ('voids'), or from where all of them overlap ('common')
          const ids = (p.tools || []).filter((id) => live.has(id));
          if (ids.length < 1 || (p.region === 'common' && ids.length < 2)) throw new Error(p.region === 'common' ? 'Pick at least two tool bodies' : 'Pick the tool bodies that enclose the space');
          const ms = ids.map((id) => live.get(id).m);
          const results = [];
          if (p.region === 'common') {
            const c = t(ms.slice(1).reduce((a, x) => t(a.intersect(x)), ms[0]));
            if (c.isEmpty()) throw new Error('The tool bodies do not overlap');
            results.push(c);
          } else {
            const all = t(K.Manifold.union(ms));
            const bb = bboxOf(all), pad = 2;
            const box = t(K.Manifold.cube([bb.max[0] - bb.min[0] + 2 * pad, bb.max[1] - bb.min[1] + 2 * pad, bb.max[2] - bb.min[2] + 2 * pad]).translate([bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad]));
            const space = t(box.subtract(all));
            // decompose gives one piece per shell: positive pieces are regions, negative ones are islands (bodies) sitting inside a region
            const pieces = space.decompose().map((x) => t(x)), islands = [];
            for (const piece of pieces) if (piece.volume() < 0) { const { V, T } = meshV3(piece), fl = []; for (let i = 0; i < T.length; i += 3) fl.push(T[i], T[i + 2], T[i + 1]); islands.push({ m: t(manifoldFromIndexed(V, fl, t)), bb: bboxOf(piece) }); }
            for (let piece of pieces) {
              if (!(piece.volume() > 1e-6)) continue;
              const pb = bboxOf(piece);
              if (pb.min[0] <= bb.min[0] - pad + 1e-6 && pb.max[0] >= bb.max[0] + pad - 1e-6) continue; // the outer, unbounded space spans the whole box
              for (const isl of islands) if (overlaps(pb, isl.bb, -1e-6) && isl.bb.min.every((v, k) => v >= pb.min[k] - 1e-6) && isl.bb.max.every((v, k) => v <= pb.max[k] + 1e-6)) piece = t(piece.subtract(isl.m));
              if (piece.volume() > 1e-6) results.push(piece);
            }
            if (!results.length) throw new Error('No enclosed space found between these bodies');
          }
          results.sort((a, c) => c.volume() - a.volume());
          results.forEach((rm, k) => addBody(k ? `${f.id}~${k + 1}` : f.id, rm, k ? `${f.name} ${k + 1}` : f.name));
          if (!p.keepTools) for (const id of ids) live.delete(id);
          break;
        }
        case 'strim': {
          const sf = getSurface(p.surface);
          const g = planeGeo(p.plane || 'XY'), n = v3norm(g.normal), off = dot(n, g.origin) + (p.offset || 0);
          const sgn = p.keep === 'below' ? -1 : 1;
          const res = clipSurface(sf, n.map((c) => c * sgn), off * sgn);
          if (!res.tris.length) throw new Error('Nothing of the surface is left on that side of the plane');
          sf.verts = res.verts; sf.tris = res.tris;
          break;
        }
        case 'sextend': {
          const sf = getSurface(p.surface);
          if (!(p.distance > 0)) throw new Error('Distance must be positive');
          const res = extendSurface(sf, p.distance);
          if (!res) throw new Error('This surface has no open edges to extend');
          sf.verts = res.verts; sf.tris = res.tris;
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
          // a body that belongs to a component drags the rest of its component along
          const comp = opts.bodyComp?.[A.id];
          const group = comp ? [...live.values()].filter((x) => opts.bodyComp[x.id] === comp) : [A];
          if (group.includes(B)) throw new Error('Both bodies are in the same component; choose bodies from different components');
          const eul = (deg) => { const r = [0, 0, 0]; r[ax] = deg; return r; };
          const slide = (v) => av.map((c) => c * v);
          const move = (m0) => {
            let m = t(m0.translate(sub(o, p.pointA)));
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
            return m;
          };
          for (const x of group) x.m = move(x.m);
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
  const surfList = [...surfaces.values()].map((q) => { let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity; for (let i = 0; i < q.verts.length; i += 3) { x0 = Math.min(x0, q.verts[i]); x1 = Math.max(x1, q.verts[i]); y0 = Math.min(y0, q.verts[i + 1]); y1 = Math.max(y1, q.verts[i + 1]); z0 = Math.min(z0, q.verts[i + 2]); z1 = Math.max(z1, q.verts[i + 2]); } return { ...q, surface: true, bbox: { min: [x0, y0, z0], max: [x1, y1, z1] } }; });
  return { bodies, surfaces: surfList, surfSnaps, errors, snaps, sketchUsed, captured, preview };
}
