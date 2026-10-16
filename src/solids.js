// Pure geometry helpers for lofts, sweeps, helical solids and frames. No manifold dependency:
// they return indexed triangle meshes ({verts, tris}) that the kernel turns into manifolds.
import { ShapeUtils, Vector2 } from 'three';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => { const l = len(a); return l < 1e-12 ? [0, 0, 0] : scl(a, 1 / l); };
const centroid = (r) => scl(r.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / r.length);

/** Newell normal of a 3D polygon (length ~ 2*area). */
export function newell(r) {
  let n = [0, 0, 0];
  for (let i = 0; i < r.length; i++) n = add(n, cross(r[i], r[(i + 1) % r.length]));
  return n;
}

/** Column-major 4x4 placing local coords onto origin `o` with local +Z along `axis`. */
export function axisFrame(o, axis) {
  const z = unit(axis);
  const ref = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = unit(cross(ref, z)), y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
}

// ---- ring utilities ----
export function resample(poly, N) {
  const P = [...poly, poly[0]];
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
  const total = cum[cum.length - 1] || 1;
  const out = [];
  let k = 0;
  for (let i = 0; i < N; i++) {
    const d = (i / N) * total;
    while (k < P.length - 2 && cum[k + 1] < d) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    const u = (d - cum[k]) / seg;
    out.push(add(P[k], scl(sub(P[k + 1], P[k]), u)));
  }
  return out;
}
function alignTo(prev, cur) {
  const N = cur.length;
  let best = null;
  for (const ring of [cur, [...cur].reverse()]) {
    for (let s = 0; s < N; s++) {
      let d = 0;
      for (let i = 0; i < N; i += Math.max(1, N >> 5)) d += len(sub(prev[i], ring[(i + s) % N]));
      if (!best || d < best.d) best = { d, s, ring };
    }
  }
  return Array.from({ length: N }, (_, i) => best.ring[(i + best.s) % N]);
}
export function loftRings(polys) {
  const N = Math.max(48, ...polys.map((p) => p.length));
  const rs = polys.map((p) => resample(p, N));
  for (let i = 1; i < rs.length; i++) rs[i] = alignTo(rs[i - 1], rs[i]);
  return rs;
}

/** Chaikin corner cutting on an open polyline (ends are kept). */
export function smoothPath(pts, iterations = 3) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      q.push(add(scl(p[i], 0.75), scl(p[i + 1], 0.25)), add(scl(p[i], 0.25), scl(p[i + 1], 0.75)));
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

function rotFromTo(a, b) {
  const v = cross(a, b), c = dot(a, b);
  if (c < -0.999999) { // 180°: any perpendicular axis
    const ax = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return [[2 * ax[0] * ax[0] - 1, 2 * ax[0] * ax[1], 2 * ax[0] * ax[2]], [2 * ax[1] * ax[0], 2 * ax[1] * ax[1] - 1, 2 * ax[1] * ax[2]], [2 * ax[2] * ax[0], 2 * ax[2] * ax[1], 2 * ax[2] * ax[2] - 1]];
  }
  const k = 1 / (1 + c);
  return [
    [c + v[0] * v[0] * k, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1]],
    [v[1] * v[0] * k + v[2], c + v[1] * v[1] * k, v[1] * v[2] * k - v[0]],
    [v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], c + v[2] * v[2] * k],
  ];
}
const mulv = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
const mulm = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));

/** Rings of `profile` (3D polygon placed at path[0]) carried along the path by parallel transport. */
export function sweepRings(profile, path, closed) {
  const n = path.length;
  const miter = [];
  const T = path.map((_, i) => {
    const prev = closed ? path[(i - 1 + n) % n] : path[Math.max(0, i - 1)];
    const next = closed ? path[(i + 1) % n] : path[Math.min(n - 1, i + 1)];
    const a = i > 0 || closed ? unit(sub(path[i], prev)) : [0, 0, 0];
    const b = i < n - 1 || closed ? unit(sub(next, path[i])) : [0, 0, 0];
    const d = unit(add(a, b));
    // stretch the section along the bend direction so mitred corners keep their full width
    const c = len(a) && len(b) ? dot(a, b) : 1;
    const half = Math.sqrt(Math.max((1 + c) / 2, 0.05));
    miter.push(c < 0.9999 ? { w: unit(sub(b, a)), s: 1 / half } : null);
    return len(d) < 1e-9 ? (len(b) ? b : a) : d;
  });
  const rel = profile.map((p) => sub(p, path[0]));
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const rings = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) R = mulm(rotFromTo(T[i - 1], T[i]), R);
    const mi = miter[i];
    rings.push(rel.map((r) => {
      let q = mulv(R, r);
      if (mi) q = add(q, scl(mi.w, (mi.s - 1) * dot(q, mi.w)));
      return add(path[i], q);
    }));
  }
  return rings;
}

/** Rings of a 2D (radius, z) profile revolved along a helix about +Z. */
export function helixRings(profile, { turns, pitch, perTurn = 48, left = false }) {
  const steps = Math.max(2, Math.ceil(turns * perTurn));
  const rings = [];
  for (let i = 0; i <= steps; i++) {
    const th = (i / perTurn) * Math.PI * 2 * (left ? -1 : 1);
    const dz = (i / perTurn) * pitch;
    rings.push(profile.map(([r, z]) => [r * Math.cos(th), r * Math.sin(th), z + dz]));
  }
  return rings;
}

/** Turn rings into a closed solid mesh (side strips + planar end caps unless `closed`). */
export function ringMesh(ringsIn, closed = false) {
  let rings = ringsIn;
  const R = rings.length, m = rings[0].length;
  const nr = newell(rings[0]);
  const dir0 = sub(centroid(rings[1]), centroid(rings[0]));
  if (dot(nr, dir0) < 0) rings = rings.map((r) => [...r].reverse());
  const verts = rings.flat(2);
  const tris = [];
  const segs = closed ? R : R - 1;
  for (let k = 0; k < segs; k++) {
    const a = k * m, b = ((k + 1) % R) * m;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      tris.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  if (!closed) {
    const cap = (ring, base, want) => {
      const nrm = unit(newell(ring));
      const u = unit(sub(ring[1], ring[0]));
      const ux = unit(sub(u, scl(nrm, dot(u, nrm)))), uy = cross(nrm, ux);
      const c0 = ring[0];
      const pts2 = ring.map((p) => { const d = sub(p, c0); return new Vector2(dot(d, ux), dot(d, uy)); });
      const idx = ShapeUtils.triangulateShape(pts2, []);
      for (const [a, b, c] of idx) {
        const n = cross(sub(ring[b], ring[a]), sub(ring[c], ring[a]));
        if (dot(n, want) >= 0) tris.push(base + a, base + b, base + c); else tris.push(base + a, base + c, base + b);
      }
    };
    cap(rings[0], 0, scl(sub(centroid(rings[1]), centroid(rings[0])), -1));
    cap(rings[R - 1], (R - 1) * m, sub(centroid(rings[R - 1]), centroid(rings[R - 2])));
  }
  return { verts, tris };
}

/**
 * Open surface through a list of rings (each a polyline of 3D points, all the same length), without end caps.
 * ringClosed: each ring wraps around (a closed profile); loopClosed: the last ring joins the first (a closed sweep / full revolve).
 * Winding is left as built; surfaces are drawn double-sided and re-oriented when stitched.
 */
export function surfaceMesh(rings, ringClosed = true, loopClosed = false) {
  const R = rings.length, m = rings[0].length;
  const verts = rings.flat(2), tris = [];
  const segs = loopClosed ? R : R - 1, around = ringClosed ? m : m - 1;
  for (let k = 0; k < segs; k++) {
    const a = k * m, b = ((k + 1) % R) * m;
    for (let i = 0; i < around; i++) {
      const j = (i + 1) % m;
      tris.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  return { verts, tris };
}
