// Pure 2D sketch editing helpers: mirror, trim and spline fitting. Shapes use the sketch format
// ({t:'path', pts:[[x,y,bulge?]], open?}, rect, circle, ...). No DOM, no kernel state.
import { arcOf } from './sketchgeo.js';
import { shapeToPolygon } from './kernel.js';

const TAU = Math.PI * 2;
const EPS = 1e-9;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const wrapPos = (a) => ((a % TAU) + TAU) % TAU;

// ------------------------------------------------------------------ mirror
export function reflectPoint(p, a, b) {
  const d = sub(b, a), l = Math.hypot(d[0], d[1]) || 1e-12, u = [d[0] / l, d[1] / l], v = sub(p, a), k = dot(v, u);
  return [a[0] + 2 * k * u[0] - v[0], a[1] + 2 * k * u[1] - v[1]];
}

/** Mirror one shape across the line a-b. Shapes keep their type where that is exact; otherwise they become a path. */
export function mirrorShape(sh, a, b) {
  const R = (x, y) => reflectPoint([x, y], a, b);
  const theta = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const horiz = Math.abs(b[1] - a[1]) < 1e-9, vert = Math.abs(b[0] - a[0]) < 1e-9;
  const asPath = () => ({ t: 'path', pts: shapeToPolygon(sh).map(([x, y]) => R(x, y)) });
  switch (sh.t) {
    case 'circle': { const [cx, cy] = R(sh.cx, sh.cy); return { ...sh, cx, cy }; }
    case 'ellipse': { const [cx, cy] = R(sh.cx, sh.cy); return { ...sh, cx, cy, rot: 2 * theta - (sh.rot || 0) }; }
    case 'ngon': { const [cx, cy] = R(sh.cx, sh.cy); return { ...sh, cx, cy, rot: 2 * theta - (sh.rot || 0) }; }
    case 'slot': { const [x1, y1] = R(sh.x1, sh.y1), [x2, y2] = R(sh.x2, sh.y2); return { ...sh, x1, y1, x2, y2 }; }
    case 'rect': case 'rrect': {
      if (!horiz && !vert) return asPath();
      const p = R(sh.x, sh.y), q = R(sh.x + sh.w, sh.y + sh.h);
      return { ...sh, x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]) };
    }
    case 'path': return { ...sh, pts: sh.pts.map((q) => { const [x, y] = R(q[0], q[1]); return q[2] ? [x, y, -q[2]] : [x, y]; }) };
    default: return asPath();
  }
}

// ------------------------------------------------------------------ primitives (lines and arcs)
/** A shape as a chain of lines and arcs: {closed, prims:[{k:'L',a,b} | {k:'A',c,r,a0,sw}]}. */
export function primitivesOf(sh) {
  if (sh.t === 'circle') return { closed: true, prims: [{ k: 'A', c: [sh.cx, sh.cy], r: sh.r, a0: 0, sw: TAU }] };
  if (sh.t === 'path') {
    const pts = sh.pts, n = pts.length, closed = !sh.open, segs = closed ? n : n - 1, prims = [];
    for (let i = 0; i < segs; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n], b = p0[2] || 0;
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < EPS) continue;
      if (!b) prims.push({ k: 'L', a: [p0[0], p0[1]], b: [p1[0], p1[1]] });
      else { const ar = arcOf(p0, p1, b); prims.push({ k: 'A', c: ar.c, r: ar.r, a0: ar.a0, sw: ar.sweep }); }
    }
    return { closed, prims };
  }
  const poly = shapeToPolygon(sh);
  return { closed: true, prims: poly.map((p, i) => ({ k: 'L', a: p, b: poly[(i + 1) % poly.length] })) };
}

export const ptAt = (p, t) => (p.k === 'L' ? [p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t] : [p.c[0] + p.r * Math.cos(p.a0 + p.sw * t), p.c[1] + p.r * Math.sin(p.a0 + p.sw * t)]);

/** Parameter (0..1) of the point on primitive p nearest to q. */
export function paramOf(p, q) {
  if (p.k === 'L') { const d = sub(p.b, p.a), l2 = dot(d, d) || 1e-12; return Math.min(1, Math.max(0, dot(sub(q, p.a), d) / l2)); }
  const ang = Math.atan2(q[1] - p.c[1], q[0] - p.c[0]);
  const d = p.sw >= 0 ? wrapPos(ang - p.a0) : wrapPos(p.a0 - ang), len = Math.abs(p.sw);
  if (d <= len) return d / len;
  const toEnd = d - len, toStart = TAU - d; // outside the arc: nearer end
  return toEnd < toStart ? 1 : 0;
}

/** Parameters t on primitive P where it meets primitive Q (0..1, endpoints included). */
export function intersectParams(P, Q) {
  const out = [];
  const onArc = (A, pt) => {
    if (Math.abs(A.sw) >= TAU - 1e-9) return true;
    const ang = Math.atan2(pt[1] - A.c[1], pt[0] - A.c[0]), d = A.sw >= 0 ? wrapPos(ang - A.a0) : wrapPos(A.a0 - ang);
    return d <= Math.abs(A.sw) + 1e-7;
  };
  if (P.k === 'L' && Q.k === 'L') {
    const r = sub(P.b, P.a), s = sub(Q.b, Q.a), den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return out;
    const qp = sub(Q.a, P.a), t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push(Math.min(1, Math.max(0, t)));
  } else if (P.k === 'L' && Q.k === 'A') {
    const d = sub(P.b, P.a), f = sub(P.a, Q.c), a = dot(d, d), b = 2 * dot(f, d), c = dot(f, f) - Q.r * Q.r, disc = b * b - 4 * a * c;
    if (a < 1e-18 || disc < 0) return out;
    const sq = Math.sqrt(disc);
    for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) if (t >= -1e-9 && t <= 1 + 1e-9 && onArc(Q, ptAt(P, t))) out.push(Math.min(1, Math.max(0, t)));
  } else if (P.k === 'A' && Q.k === 'L') {
    const d = sub(Q.b, Q.a), f = sub(Q.a, P.c), a = dot(d, d), b = 2 * dot(f, d), c = dot(f, f) - P.r * P.r, disc = b * b - 4 * a * c;
    if (a < 1e-18 || disc < 0) return out;
    const sq = Math.sqrt(disc);
    for (const u of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) if (u >= -1e-9 && u <= 1 + 1e-9) { const pt = ptAt(Q, Math.min(1, Math.max(0, u))); if (onArc(P, pt)) out.push(paramOf(P, pt)); }
  } else {
    const dx = Q.c[0] - P.c[0], dy = Q.c[1] - P.c[1], d = Math.hypot(dx, dy);
    if (d < 1e-12 || d > P.r + Q.r + 1e-9 || d < Math.abs(P.r - Q.r) - 1e-9) return out;
    const a = (P.r * P.r - Q.r * Q.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, P.r * P.r - a * a));
    const mx = P.c[0] + (a * dx) / d, my = P.c[1] + (a * dy) / d;
    for (const sg of [1, -1]) {
      const pt = [mx + sg * (h * dy) / d, my - sg * (h * dx) / d];
      if (onArc(P, pt) && onArc(Q, pt)) out.push(paramOf(P, pt));
    }
  }
  return out;
}

const subPrim = (p, t0, t1) => (p.k === 'L' ? { k: 'L', a: ptAt(p, t0), b: ptAt(p, t1) } : { k: 'A', c: p.c, r: p.r, a0: p.a0 + p.sw * t0, sw: p.sw * (t1 - t0) });
/** Sample a primitive as a polyline (for previews). */
export const primPoints = (p, n = 32) => (p.k === 'L' ? [p.a, p.b] : Array.from({ length: Math.max(4, Math.ceil((n * Math.abs(p.sw)) / TAU) + 1) }, (_, i, a) => ptAt(p, i / (a.length - 1))));
const primLen = (p) => (p.k === 'L' ? Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) : p.r * Math.abs(p.sw));

/** A chain of connected primitives as an open path shape. */
export function chainToPath(prims) {
  const pts = prims.map((p) => {
    const s = ptAt(p, 0);
    return p.k === 'A' ? [s[0], s[1], Math.tan(p.sw / 4)] : s;
  });
  pts.push(ptAt(prims.at(-1), 1));
  return { t: 'path', open: true, pts };
}

/** The closest primitive to q across all shapes: {si, pi, dist, t}. */
export function nearestPrim(shapes, q) {
  let best = null;
  shapes.forEach((sh, si) => {
    const { prims } = primitivesOf(sh);
    prims.forEach((p, pi) => {
      const t = paramOf(p, q), pt = ptAt(p, t), dist = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (!best || dist < best.dist) best = { si, pi, dist, t };
    });
  });
  return best;
}

/**
 * Trim the curve under q back to its nearest intersections with the other curves.
 * Returns the new shape list and the index of the edited shape, or null when q is not on a curve.
 */
export function trimAt(shapes, q, tol = Infinity) {
  const hit = nearestPrim(shapes, q);
  if (!hit || hit.dist > tol) return null;
  const { si, pi } = hit;
  const sh = shapes[si], { closed, prims } = primitivesOf(sh), P = prims[pi], tq = hit.t;
  // intersections with every other curve (and the shape's own other segments)
  const ts = [];
  shapes.forEach((o, oi) => primitivesOf(o).prims.forEach((Q, qi) => {
    if (oi === si && qi === pi) return;
    for (const t of intersectParams(P, Q)) ts.push(t);
  }));
  const interior = [...new Set(ts.map((t) => +t.toFixed(9)))].filter((t) => t > 1e-7 && t < 1 - 1e-7).sort((a, b) => a - b);
  let removed = [primPoints(P)];
  const replace = (newShapes) => ({ shapes: [...shapes.slice(0, si), ...newShapes, ...shapes.slice(si + 1)], index: si, removed });
  const full = P.k === 'A' && Math.abs(P.sw) >= TAU - 1e-9 && prims.length === 1;
  if (full) { // a whole circle: needs two cuts to leave an arc
    const cuts = interior.concat(ts.filter((t) => t <= 1e-7 || t >= 1 - 1e-7).length ? [0] : []);
    const u = [...new Set(cuts.map((t) => +(t % 1).toFixed(9)))].sort((a, b) => a - b);
    if (u.length < 2) return replace([]);
    let prev = [...u].reverse().find((t) => t <= tq), next = u.find((t) => t >= tq);
    if (prev === undefined) prev = u.at(-1) - 1;
    if (next === undefined) next = u[0] + 1;
    const keep = 1 - (next - prev);
    if (keep < 1e-6) return replace([]);
    removed = [primPoints({ k: 'A', c: P.c, r: P.r, a0: P.a0 + P.sw * prev, sw: P.sw * (next - prev) })];
    return replace([chainToPath([{ k: 'A', c: P.c, r: P.r, a0: P.a0 + P.sw * next, sw: P.sw * keep }])]);
  }
  let prev = 0, next = 1;
  for (const t of interior) { if (t <= tq) prev = t; else { next = t; break; } }
  if (!interior.length) { prev = 0; next = 1; }
  removed = [primPoints(subPrim(P, prev, next))];
  const A = prev > 1e-7 ? subPrim(P, 0, prev) : null, B = next < 1 - 1e-7 ? subPrim(P, next, 1) : null;
  const ok = (arr) => arr.filter((p) => primLen(p) > 1e-9);
  if (!closed) {
    const left = ok([...prims.slice(0, pi), ...(A ? [A] : [])]), right = ok([...(B ? [B] : []), ...prims.slice(pi + 1)]);
    return replace([left, right].filter((c) => c.length).map(chainToPath));
  }
  const chain = ok([...(B ? [B] : []), ...prims.slice(pi + 1), ...prims.slice(0, pi), ...(A ? [A] : [])]);
  return replace(chain.length ? [chainToPath(chain)] : []);
}

// ------------------------------------------------------------------ spline
/** Smooth curve through the points (centripetal Catmull-Rom), sampled as a polyline. */
export function fitSpline(pts, closed = false, per = 14) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p[0], p[1]]);
  if (n === 2) return [pts[0], pts[1]].map((p) => [p[0], p[1]]);
  const P = (i) => (closed ? pts[((i % n) + n) % n] : i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] : i >= n ? [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]] : pts[i]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const tj = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6) ** 0.5;
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 0; k < per; k++) {
      const t = t1 + ((t2 - t1) * k) / per;
      const lerp = (a, b, ta, tb) => [a[0] * ((tb - t) / (tb - ta)) + b[0] * ((t - ta) / (tb - ta)), a[1] * ((tb - t) / (tb - ta)) + b[1] * ((t - ta) / (tb - ta))];
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  if (!closed) out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

// ---------------------------------------------------------------- patterns
const rot2 = (x, y, cx, cy, c, sn) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
/** A copy of a shape moved by (dx, dy). Every shape type keeps its type. */
export function moveShape(sh, dx, dy) {
  switch (sh.t) {
    case 'circle': case 'ellipse': case 'ngon': return { ...sh, cx: sh.cx + dx, cy: sh.cy + dy };
    case 'slot': return { ...sh, x1: sh.x1 + dx, y1: sh.y1 + dy, x2: sh.x2 + dx, y2: sh.y2 + dy };
    case 'rect': case 'rrect': return { ...sh, x: sh.x + dx, y: sh.y + dy };
    case 'path': return { ...sh, pts: sh.pts.map((q) => (q.length > 2 ? [q[0] + dx, q[1] + dy, ...q.slice(2)] : [q[0] + dx, q[1] + dy])) };
    default: return { t: 'path', pts: shapeToPolygon(sh).map(([x, y]) => [x + dx, y + dy]) };
  }
}
/** A copy of a shape turned by `deg` degrees about (cx, cy). Rectangles turned off the axes become paths. */
export function rotateShape(sh, cx, cy, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), R = (x, y) => rot2(x, y, cx, cy, c, sn);
  switch (sh.t) {
    case 'circle': { const [x, y] = R(sh.cx, sh.cy); return { ...sh, cx: x, cy: y }; }
    case 'ellipse': case 'ngon': { const [x, y] = R(sh.cx, sh.cy); return { ...sh, cx: x, cy: y, rot: (sh.rot || 0) + deg }; }
    case 'slot': { const [x1, y1] = R(sh.x1, sh.y1), [x2, y2] = R(sh.x2, sh.y2); return { ...sh, x1, y1, x2, y2 }; }
    case 'path': return { ...sh, pts: sh.pts.map((q) => { const [x, y] = R(q[0], q[1]); return q.length > 2 ? [x, y, ...q.slice(2)] : [x, y]; }) };
    default: return { t: 'path', open: false, pts: shapeToPolygon(sh).map(([x, y]) => R(x, y)) };
  }
}
/**
 * Copies of the given shapes in a grid ({ kind: 'rect', nx, ny, dx, dy }) or around a centre
 * ({ kind: 'circ', n, angle, cx, cy, turn }). The originals are not included.
 */
export function patternShapes(shapes, o) {
  const out = [];
  if (o.kind === 'rect') {
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) { if (!i && !j) continue; for (const sh of shapes) out.push(moveShape(sh, i * o.dx, j * o.dy)); }
  } else {
    const full = Math.abs(o.angle) >= 359.999, step = o.n > 1 ? o.angle / (full ? o.n : o.n - 1) : 0;
    for (let k = 1; k < o.n; k++) for (const sh of shapes) {
      const ang = step * k;
      if (o.turn) out.push(rotateShape(sh, o.cx, o.cy, ang));
      else { // keep each copy's own orientation: just move it round the circle
        const c0 = shapeCentre(sh), [x, y] = rot2(c0[0], c0[1], o.cx, o.cy, Math.cos((ang * Math.PI) / 180), Math.sin((ang * Math.PI) / 180));
        out.push(moveShape(sh, x - c0[0], y - c0[1]));
      }
    }
  }
  return out;
}
export function shapeCentre(sh) {
  const pts = shapeToPolygon(sh);
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [x, y] of pts) { lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
}
