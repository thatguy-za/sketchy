// Convex hulls on plain point lists, for the OpenSCAD add-in's hull() and minkowski() (src/csg-service.js).

/** 2D: the hull of [x, y] points as a counter-clockwise polygon (Andrew's monotone chain). */
export function hull2D(points) {
  const P = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 1e-12) lo.pop(); lo.push(p); }
  for (const p of [...P].reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 1e-12) up.pop(); up.push(p); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

/**
 * 3D: the hull of [x, y, z] points as triangles, outward facing and counter-clockwise: { verts: [[x,y,z]..], tris: [[a,b,c]..] }.
 * Incremental construction; fine for a few thousand points. Returns null when the points are flat or fewer than four.
 */
export function hull3D(points, eps = 1e-9) {
  const P = [...new Map(points.map((p) => [`${p[0]},${p[1]},${p[2]}`, p])).values()];
  if (P.length < 4) return null;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // a first tetrahedron that is not flat
  let i0 = 0, i1 = -1, i2 = -1, i3 = -1, best = 0;
  for (let i = 1; i < P.length; i++) { const d = Math.hypot(...sub(P[i], P[i0])); if (d > best) { best = d; i1 = i; } }
  if (i1 < 0 || best < eps) return null;
  best = 0;
  for (let i = 0; i < P.length; i++) { if (i === i0 || i === i1) continue; const d = Math.hypot(...cr(sub(P[i1], P[i0]), sub(P[i], P[i0]))); if (d > best) { best = d; i2 = i; } }
  if (i2 < 0 || best < eps) return null;
  const n0 = cr(sub(P[i1], P[i0]), sub(P[i2], P[i0]));
  best = 0;
  for (let i = 0; i < P.length; i++) { if (i === i0 || i === i1 || i === i2) continue; const d = Math.abs(dt(n0, sub(P[i], P[i0]))); if (d > best) { best = d; i3 = i; } }
  if (i3 < 0 || best < eps) return null;
  const ctr = [0, 1, 2, 3].map((k) => [i0, i1, i2, i3][k]).reduce((a, i) => [a[0] + P[i][0] / 4, a[1] + P[i][1] / 4, a[2] + P[i][2] / 4], [0, 0, 0]);
  let faces = [];
  const addFace = (a, b, c) => { const n = cr(sub(P[b], P[a]), sub(P[c], P[a])); if (dt(n, sub(ctr, P[a])) > 0) [b, c] = [c, b]; const m = cr(sub(P[b], P[a]), sub(P[c], P[a])), l = Math.hypot(...m) || 1; faces.push({ a, b, c, n: [m[0] / l, m[1] / l, m[2] / l], d: 0 }); faces.at(-1).d = dt(faces.at(-1).n, P[a]); };
  addFace(i0, i1, i2); addFace(i0, i1, i3); addFace(i0, i2, i3); addFace(i1, i2, i3);
  const used = new Set([i0, i1, i2, i3]);
  for (let p = 0; p < P.length; p++) {
    if (used.has(p)) continue;
    const vis = faces.filter((f) => dt(f.n, P[p]) - f.d > eps);
    if (!vis.length) continue; // inside
    const edges = new Map();
    for (const f of vis) for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) { const k = `${v}>${u}`; if (edges.has(k)) edges.delete(k); else edges.set(`${u}>${v}`, [u, v]); }
    const visSet = new Set(vis);
    faces = faces.filter((f) => !visSet.has(f));
    for (const [u, v] of edges.values()) addFace(u, v, p);
  }
  const ids = new Map(), verts = [], tris = faces.map((f) => [f.a, f.b, f.c].map((i) => { if (!ids.has(i)) { ids.set(i, verts.length); verts.push(P[i]); } return ids.get(i); }));
  return { verts, tris };
}
