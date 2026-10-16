// 2D sketch geometry helpers. Paths store points as [x, y] or [x, y, bulge]; the bulge belongs to the
// segment that starts at that point (DXF convention: bulge = tan(sweep / 4), positive = counter-clockwise).
export const D2R = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
const STEP = Math.PI / 24; // arc tessellation step

/** Arc described by a segment: {line:true} or {c, r, a0, sweep}. */
export function arcOf(p0, p1, b) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy);
  if (!b || Math.abs(b) < 1e-9 || c < 1e-12) return { line: true, len: c };
  const theta = 4 * Math.atan(b);
  const r = c / (2 * Math.sin(Math.abs(theta) / 2));
  const d = (c / 2) * (1 - b * b) / (2 * b);
  const center = [(p0[0] + p1[0]) / 2 + (-dy / c) * d, (p0[1] + p1[1]) / 2 + (dx / c) * d];
  return { c: center, r, a0: Math.atan2(p0[1] - center[1], p0[0] - center[0]), sweep: theta, len: r * Math.abs(theta) };
}
export const segmentLength = (p0, p1, b) => arcOf(p0, p1, b).len;

/** Points along a segment after p0 (ends with p1). */
export function segmentPoints(p0, p1, b) {
  const a = arcOf(p0, p1, b);
  if (a.line) return [[p1[0], p1[1]]];
  const n = Math.max(2, Math.ceil(Math.abs(a.sweep) / STEP));
  const out = [];
  for (let i = 1; i < n; i++) { const t = a.a0 + (a.sweep * i) / n; out.push([a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]); }
  out.push([p1[0], p1[1]]);
  return out;
}

/** Sampled polygon of a path (lines + arcs). */
export function pathPolygon(pts, closed) {
  if (!pts.length) return [];
  const out = [[pts[0][0], pts[0][1]]];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const seg = segmentPoints(p0, p1, p0[2] || 0);
    if (closed && i === n - 1) seg.pop(); // last point equals the first
    out.push(...seg);
  }
  return out;
}

/** Bulge for the arc p0 -> pm -> p1 (three points on the arc). 0 when collinear. */
export function bulgeFrom3(p0, pm, p1) {
  const ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return 0;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(cy - uy, cx - ux);
  const ccw = (bx - ax) * (cy - by) - (by - ay) * (cx - bx) > 0;
  let sweep = (a1 - a0 + 4 * Math.PI) % (2 * Math.PI);
  if (!ccw) sweep -= 2 * Math.PI;
  return Math.tan(sweep / 4);
}
/** Bulge of the arc leaving p0 along direction t and ending at p1 (tangent arc). */
export function bulgeFromTangent(p0, t, p1) {
  const phi = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), tau = Math.atan2(t[1], t[0]);
  return Math.tan(wrap(phi - tau) / 2);
}
/** Unit tangent at the end of segment p0 -> p1. */
export function endTangent(p0, p1, b) {
  const a = arcOf(p0, p1, b);
  if (a.line) { const l = a.len || 1; return [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l]; }
  const rx = (p1[0] - a.c[0]) / a.r, ry = (p1[1] - a.c[1]) / a.r;
  return b > 0 ? [-ry, rx] : [ry, -rx];
}
export function bulgeFromRadius(chord, R, sign = 1) {
  if (!(R >= chord / 2) || chord < 1e-12) return 0;
  return sign * Math.tan((2 * Math.asin(chord / (2 * R))) / 4);
}

/** Closed loops formed by open path/arc segments that meet end to end (every junction shared by exactly two). */
export function openLoops(shapes) {
  const segs = [];
  for (const s of shapes) {
    if (s.t !== 'path' || !s.open) continue;
    for (let i = 0; i < s.pts.length - 1; i++) segs.push({ a: s.pts[i], b: s.pts[i + 1], bulge: s.pts[i][2] || 0 });
  }
  if (segs.length < 2) return [];
  const key = (p) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
  const adj = new Map();
  segs.forEach((sg, i) => { for (const k of [key(sg.a), key(sg.b)]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  const used = new Set(), loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used.has(s0)) continue;
    const chain = [{ p0: segs[s0].a, p1: segs[s0].b, b: segs[s0].bulge }];
    const startKey = key(segs[s0].a);
    let cur = s0, endKey = key(segs[s0].b), ok = false;
    const idxs = [s0];
    for (let guard = 0; guard < segs.length + 2; guard++) {
      if (endKey === startKey) { ok = true; break; }
      const nb = adj.get(endKey);
      if (!nb || nb.length !== 2) break;
      const nx = nb[0] === cur ? nb[1] : nb[0];
      if (idxs.includes(nx)) break;
      const sg = segs[nx];
      chain.push(key(sg.a) === endKey ? { p0: sg.a, p1: sg.b, b: sg.bulge } : { p0: sg.b, p1: sg.a, b: -sg.bulge });
      idxs.push(nx); cur = nx;
      endKey = key(chain[chain.length - 1].p1);
    }
    if (!ok || chain.length < 2) continue;
    idxs.forEach((i) => used.add(i));
    const poly = [[chain[0].p0[0], chain[0].p0[1]]];
    chain.forEach((c, i) => { const pts = segmentPoints(c.p0, c.p1, c.b); if (i === chain.length - 1) pts.pop(); poly.push(...pts); });
    if (poly.length >= 3) loops.push(poly);
  }
  return loops;
}

/** Round vertex `vi` of a path with an arc of radius r. Returns new pts or null when it doesn't fit. */
export function filletVertex(pts, closed, vi, r) {
  const n = pts.length;
  const pi = closed ? (vi - 1 + n) % n : vi - 1, ni = closed ? (vi + 1) % n : vi + 1;
  if (pi < 0 || ni >= n || !(r > 0)) return null;
  const P = pts[pi], V = pts[vi], N = pts[ni];
  if (P[2] || V[2]) return null; // adjoining segments must be straight lines
  const l1 = Math.hypot(P[0] - V[0], P[1] - V[1]), l2 = Math.hypot(N[0] - V[0], N[1] - V[1]);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const u1 = [(P[0] - V[0]) / l1, (P[1] - V[1]) / l1], u2 = [(N[0] - V[0]) / l2, (N[1] - V[1]) / l2];
  const alpha = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (alpha < 1e-3 || Math.PI - alpha < 1e-3) return null;
  const t = r / Math.tan(alpha / 2);
  if (t >= l1 - 1e-9 || t >= l2 - 1e-9) return null;
  const turn = (V[0] - P[0]) * (N[1] - V[1]) - (V[1] - P[1]) * (N[0] - V[0]);
  const b = Math.sign(turn) * Math.tan((Math.PI - alpha) / 4);
  const T1 = [V[0] + u1[0] * t, V[1] + u1[1] * t, b], T2 = [V[0] + u2[0] * t, V[1] + u2[1] * t];
  const out = [];
  pts.forEach((p, i) => { if (i === vi) out.push(T1, T2); else out.push(p); });
  return out;
}
