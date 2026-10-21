// A real sketch constraint solver. Every shape is a handful of numbers (a rectangle: x, y, width, height; a path: each point's x and
// y), every constraint is a few equations that must come out as zero, and the solver finds the numbers that satisfy all of them at
// once while moving things as little as it can (damped Gauss-Newton / Levenberg-Marquardt, with numerical derivatives).
// That handles what applying constraints one after another cannot: chains and loops (a rectangle drawn as four lines made
// parallel, perpendicular and equal), constraints that fight each other, and it can tell how many degrees of freedom are left.
import { arcOf } from './sketchgeo.js';
import { keyPoints, segOf, applySequential } from './sketchcons.js';
import { getDim } from './sketchdims.js';

const MAX_VARS = 360;       // above this the sequential method is used (the dense linear algebra here is O(n^3))
const PIN = 1e3;            // weight of "this stays where it is" equations (Fix, and sizes driven by a parameter)

// ---------------------------------------------------------------- shapes as numbers
const LAYOUT = {
  rect: { f: ['x', 'y', 'w', 'h'], names: ['x position', 'y position', 'width', 'height'] },
  rrect: { f: ['x', 'y', 'w', 'h'], names: ['x position', 'y position', 'width', 'height'] },
  circle: { f: ['cx', 'cy', 'r'], names: ['centre x', 'centre y', 'radius'] },
  ngon: { f: ['cx', 'cy', 'r'], names: ['centre x', 'centre y', 'radius'] },
  ellipse: { f: ['cx', 'cy', 'rx', 'ry'], names: ['centre x', 'centre y', 'width', 'height'] },
  slot: { f: ['x1', 'y1', 'x2', 'y2', 'w'], names: ['start x', 'start y', 'end x', 'end y', 'width'] },
  point: { f: ['x', 'y'], names: ['x position', 'y position'] },
};
export const NAMES = { rect: 'Rectangle', rrect: 'Rounded rectangle', circle: 'Circle', ngon: 'Polygon', slot: 'Slot', ellipse: 'Ellipse', path: 'Path', point: 'Point' };

function toVec(sh) {
  if (sh.t === 'path') return sh.pts.flatMap((p) => [p[0], p[1]]);
  const L = LAYOUT[sh.t];
  return L ? L.f.map((k) => sh[k]) : [];
}
function fromVec(sh, v, o = 0) {
  if (sh.t === 'path') return { ...sh, pts: sh.pts.map((p, i) => (p[2] ? [v[o + i * 2], v[o + i * 2 + 1], p[2]] : [v[o + i * 2], v[o + i * 2 + 1]])) };
  const L = LAYOUT[sh.t];
  if (!L) return sh;
  const out = { ...sh };
  L.f.forEach((k, i) => { out[k] = v[o + i]; });
  return out;
}
const varNames = (sh, s) => {
  const nm = `${NAMES[sh.t] || 'Shape'} ${s + 1}`;
  if (sh.t === 'path') return sh.pts.flatMap((_, i) => [`${nm} point ${i + 1} x`, `${nm} point ${i + 1} y`]);
  return (LAYOUT[sh.t]?.names || []).map((n) => `${nm} ${n}`);
};

// ---------------------------------------------------------------- equations
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const crs = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const EPS = 1e-9;
const ptOf = (shapes, r) => { const sh = shapes[r?.s]; return sh ? keyPoints(sh).find((q) => q.k === r.k)?.p || null : null; };
const centreOf = (sh) => (['circle', 'ngon', 'ellipse'].includes(sh.t) ? [sh.cx, sh.cy] : keyPoints(sh).find((q) => q.k === 'ctr')?.p || null);
const circOf = (sh, seg) => {
  if (sh?.t === 'circle') return { c: [sh.cx, sh.cy], r: sh.r };
  if (sh?.t === 'path' && seg != null) { const sg = segOf(sh, seg); if (sg && sg[0][2]) { const a = arcOf(sg[0], sg[1], sg[0][2]); return { c: a.c, r: a.r }; } }
  return null;
};
const lineOf = (sh, seg) => { const sg = sh?.t === 'path' && seg != null ? segOf(sh, seg) : null; return sg && !sg[0][2] ? sg : null; };
const unitDir = (sg) => { const d = sub(sg[1], sg[0]), l = len(d) || EPS; return [d[0] / l, d[1] / l]; };

/** The equations of one constraint, as numbers that are zero when it holds. `ini` carries choices made from the starting layout. */
function equations(c, shapes, ini, out) {
  const A = shapes[c.a?.s], B = shapes[c.b?.s], C = shapes[c.c?.s];
  if (!A) return;
  switch (c.t) {
    case 'horizontal': case 'vertical': {
      const sg = lineOf(A, c.a.seg); if (!sg) return;
      out.push(c.t === 'horizontal' ? sg[1][1] - sg[0][1] : sg[1][0] - sg[0][0]); return;
    }
    case 'coincident': {
      const p = ptOf(shapes, c.a), q = ptOf(shapes, c.b); if (!p || !q) return;
      out.push(p[0] - q[0], p[1] - q[1]); return;
    }
    case 'concentric': {
      if (!B) return; const p = centreOf(A), q = centreOf(B); if (!p || !q) return;
      out.push(p[0] - q[0], p[1] - q[1]); return;
    }
    case 'equal': {
      if (!B) return;
      if (A.t === 'path' && B.t === 'path') {
        const sa = segOf(A, c.a.seg), sb = segOf(B, c.b.seg); if (!sa || !sb || !!sa[0][2] !== !!sb[0][2]) return;
        out.push(sa[0][2] ? arcOf(sa[0], sa[1], sa[0][2]).r - arcOf(sb[0], sb[1], sb[0][2]).r : len(sub(sa[1], sa[0])) - len(sub(sb[1], sb[0])));
      } else if ((A.t === 'circle' && B.t === 'circle') || (A.t === 'ngon' && B.t === 'ngon')) out.push(A.r - B.r);
      return;
    }
    case 'parallel': case 'perpendicular': {
      if (!B) return; const sa = lineOf(A, c.a.seg), sb = lineOf(B, c.b.seg); if (!sa || !sb) return;
      const da = unitDir(sa), db = unitDir(sb);
      out.push(c.t === 'parallel' ? crs(da, db) : dot(da, db)); return;
    }
    case 'collinear': {
      if (!B) return; const sa = lineOf(A, c.a.seg), sb = lineOf(B, c.b.seg); if (!sa || !sb) return;
      const da = unitDir(sa), db = unitDir(sb);
      out.push(crs(da, db), crs(db, sub(sa[0], sb[0]))); return;
    }
    case 'midpoint': {
      if (!B) return; const p = ptOf(shapes, c.a), sb = lineOf(B, c.b.seg); if (!p || !sb) return;
      out.push(p[0] - (sb[0][0] + sb[1][0]) / 2, p[1] - (sb[0][1] + sb[1][1]) / 2); return;
    }
    case 'symmetry': {
      if (!B || !C) return; const p = ptOf(shapes, c.a), q = ptOf(shapes, c.b), sc = lineOf(C, c.c.seg); if (!p || !q || !sc) return;
      const d = unitDir(sc), mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      out.push(crs(d, sub(mid, sc[0])), dot(d, sub(q, p))); return; // the middle lies on the line, and the pair is square to it
    }
    case 'tangent': {
      if (!B) return;
      const la = lineOf(A, c.a.seg), lb = lineOf(B, c.b.seg), ca = circOf(A, c.a.seg), cb = circOf(B, c.b.seg), side = ini.tangent?.get(c);
      const dist = (l, ce) => crs(unitDir(l), sub(ce, l[0]));
      if (la && cb) out.push((side ?? Math.sign(dist(la, cb.c)) ?? 1) * dist(la, cb.c) - cb.r);
      else if (ca && lb) out.push((side ?? Math.sign(dist(lb, ca.c)) ?? 1) * dist(lb, ca.c) - ca.r);
      else if (ca && cb) { const d = len(sub(ca.c, cb.c)); out.push(d - (side === 'inner' ? Math.abs(ca.r - cb.r) : ca.r + cb.r)); }
      return;
    }
    default:
  }
}
/** Choices a tangent constraint makes from where the shapes start: which side of the line, outside or inside the circle. */
function tangentSides(shapes, cons) {
  const m = new Map();
  for (const c of cons) {
    if (c.t !== 'tangent') continue;
    const A = shapes[c.a?.s], B = shapes[c.b?.s]; if (!A || !B) continue;
    const la = lineOf(A, c.a.seg), lb = lineOf(B, c.b.seg), ca = circOf(A, c.a.seg), cb = circOf(B, c.b.seg);
    const dist = (l, ce) => crs(unitDir(l), sub(ce, l[0]));
    if (la && cb) m.set(c, dist(la, cb.c) >= 0 ? 1 : -1);
    else if (ca && lb) m.set(c, dist(lb, ca.c) >= 0 ? 1 : -1);
    else if (ca && cb) { const d = len(sub(ca.c, cb.c)); m.set(c, d >= (ca.r + cb.r + Math.abs(ca.r - cb.r)) / 2 ? 'outer' : 'inner'); }
  }
  return m;
}

// ---------------------------------------------------------------- linear algebra (small and dense)
/** Solve A x = b in place by Gaussian elimination with partial pivoting; false if singular. */
function gauss(A, b, n) {
  for (let i = 0; i < n; i++) {
    let p = i, best = Math.abs(A[i * n + i]);
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > best) { best = Math.abs(A[r * n + i]); p = r; }
    if (best < 1e-300) return false;
    if (p !== i) { for (let k = 0; k < n; k++) { const t = A[i * n + k]; A[i * n + k] = A[p * n + k]; A[p * n + k] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    const d = A[i * n + i];
    for (let r = i + 1; r < n; r++) {
      const f = A[r * n + i] / d; if (!f) continue;
      for (let k = i; k < n; k++) A[r * n + k] -= f * A[i * n + k];
      b[r] -= f * b[i];
    }
  }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= A[i * n + k] * b[k]; b[i] = s / A[i * n + i]; }
  return true;
}
/** Reduced row echelon form of an m x n matrix (copied); returns { R, pivots }. */
function rref(J, m, n, tol) {
  const R = Float64Array.from(J), pivots = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let p = row, best = Math.abs(R[row * n + col]);
    for (let r = row + 1; r < m; r++) if (Math.abs(R[r * n + col]) > best) { best = Math.abs(R[r * n + col]); p = r; }
    if (best < tol) continue;
    if (p !== row) for (let k = 0; k < n; k++) { const t = R[row * n + k]; R[row * n + k] = R[p * n + k]; R[p * n + k] = t; }
    const d = R[row * n + col];
    for (let k = 0; k < n; k++) R[row * n + k] /= d;
    for (let r = 0; r < m; r++) { if (r === row) continue; const f = R[r * n + col]; if (!f) continue; for (let k = 0; k < n; k++) R[r * n + k] -= f * R[row * n + k]; }
    pivots.push(col); row++;
  }
  return { R, pivots };
}

// ---------------------------------------------------------------- what should move
const SIZE_FIELDS = new Set(['w', 'h', 'r', 'rx', 'ry']);
/** Which variables are sizes (they should keep their value when they can) and, for the damping, how reluctant each is to move. */
function weightsFor(shapes, offs, n, cons) {
  const size = new Uint8Array(n), dw = new Float64Array(n).fill(1), heavy = new Float64Array(n).fill(1);
  const moving = new Set(), refOnly = new Set();
  for (const c of cons) { if (c.a) moving.add(c.a.s); }
  for (const c of cons) for (const r of ['b', 'c']) if (c[r] && !moving.has(c[r].s)) refOnly.add(c[r].s); // a shape that is only ever the thing to match stays put
  shapes.forEach((sh, i) => {
    const L = LAYOUT[sh.t];
    if (L) L.f.forEach((k, j) => { if (SIZE_FIELDS.has(k)) size[offs[i] + j] = 1; });
    if (refOnly.has(i)) for (let j = 0; j < toVec(sh).length; j++) { dw[offs[i] + j] = 25; heavy[offs[i] + j] = 1e10; }
  });
  for (const c of cons) { // turning a line about its first end: the end named by the constraint is the one that stays
    if (!['tangent', 'parallel', 'perpendicular', 'horizontal', 'vertical'].includes(c.t)) continue;
    const sh = shapes[c.a?.s];
    if (sh?.t === 'path' && c.a.seg != null) { const k = offs[c.a.s] + c.a.seg * 2; dw[k] = Math.max(dw[k], 12); dw[k + 1] = Math.max(dw[k + 1], 12); heavy[k] = Math.max(heavy[k], 1e10); heavy[k + 1] = Math.max(heavy[k + 1], 1e10); }
  }
  return { size, dw, heavy };
}

// ---------------------------------------------------------------- the solver
/**
 * Solve a sketch's constraints. Returns { shapes, ok, residual, vars, rank, dof, free: [names], redundant, method }.
 * ok: every equation is met. method: 'solver', or 'sequential' when the sketch is too big for the solver or it did no better.
 */
export function solveSketch(shapes, cons, { details = false } = {}) {
  const live = (cons || []).filter((c) => c && c.t && shapes[c.a?.s]);
  const offs = []; let n = 0;
  shapes.forEach((sh) => { offs.push(n); n += toVec(sh).length; });
  const x0 = Float64Array.from(shapes.flatMap(toVec));
  const fallback = () => ({ shapes: applySequential(shapes, cons), ok: true, residual: 0, vars: n, rank: 0, dof: n, free: [], redundant: 0, method: 'sequential' });
  if (!n || n > MAX_VARS) return fallback();
  const ini = { tangent: tangentSides(shapes, live) };
  const build = (x) => shapes.map((sh, i) => fromVec(sh, x, offs[i]));

  // pins: Fix (a whole shape, or one point of it) and every size driven by a parameter expression
  const pinSpecs = [];
  for (const c of live) if (c.t === 'fix') {
    const s = c.a.s, sh = shapes[s];
    if (c.a.k && c.pos) pinSpecs.push({ kind: 'point', s, k: c.a.k, to: c.pos });
    else if (c.a.k) pinSpecs.push({ kind: 'point', s, k: c.a.k, to: ptOf(shapes, c.a) });
    else pinSpecs.push({ kind: 'vec', s, to: c.snap ? toVec(c.snap) : toVec(sh) });
  }
  shapes.forEach((sh, s) => { if (sh.ex) for (const id of Object.keys(sh.ex)) { const target = getDim(sh, id); if (target > 0) pinSpecs.push({ kind: 'dim', s, id, to: target }); } });

  const hard = (x, out) => { // the equations that must be zero (no pins)
    const S = build(x);
    for (const c of live) if (c.t !== 'fix') { try { equations(c, S, ini, out); } catch { /* a broken constraint adds nothing */ } }
    return S;
  };
  const pins = (x, S, out) => {
    for (const p of pinSpecs) {
      const sh = S[p.s];
      if (p.kind === 'vec') toVec(sh).forEach((v, i) => out.push((v - (p.to[i] ?? v)) * PIN));
      else if (p.kind === 'point') { const q = keyPoints(sh).find((k) => k.k === p.k)?.p; if (q && p.to) out.push((q[0] - p.to[0]) * PIN, (q[1] - p.to[1]) * PIN); }
      else out.push((getDim(sh, p.id) - p.to) * PIN);
    }
  };
  const { size, dw, heavy } = weightsFor(shapes, offs, n, live);
  const lens0 = shapes.map((sh) => (sh.t === 'path' ? sh.pts.map((_, i) => { const a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length]; return sh.open && i === sh.pts.length - 1 ? 0 : (a[2] ? arcOf(a, b, a[2]).r : Math.hypot(b[0] - a[0], b[1] - a[1])); }) : sh.t === 'slot' ? [Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1)] : []));
  const keepEq = (x, S, out) => { // sizes and segment lengths stay as they were, as far as the constraints allow
    for (let j = 0; j < n; j++) if (size[j]) out.push(x[j] - x0[j]);
    S.forEach((sh, i) => {
      if (sh.t === 'path') sh.pts.forEach((a, k) => { if (sh.open && k === sh.pts.length - 1) return; const b = sh.pts[(k + 1) % sh.pts.length]; out.push((a[2] ? arcOf(a, b, a[2]).r : Math.hypot(b[0] - a[0], b[1] - a[1])) - lens0[i][k]); });
      else if (sh.t === 'slot') out.push(Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1) - lens0[i][0]);
    });
  };
  let keepOn = true;
  const all = (x) => { const r = []; const S = hard(x, r); pins(x, S, r); if (keepOn) keepEq(x, S, r); return r; };
  const cost = (r) => { let s = 0; for (const v of r) s += v * v; return s; };
  const jac = (x, r0) => { // central differences: accurate enough that a symmetric problem stays symmetric
    const m = r0.length, J = new Float64Array(m * n);
    for (let j = 0; j < n; j++) {
      const h = 1e-5 * Math.max(1, Math.abs(x[j])), xp = Float64Array.from(x), xm = Float64Array.from(x); xp[j] += h; xm[j] -= h;
      const rp = all(xp), rm = all(xm);
      if (rp.length !== m || rm.length !== m) continue;
      for (let i = 0; i < m; i++) J[i * n + j] = (rp[i] - rm[i]) / (2 * h);
    }
    return J;
  };

  let x = Float64Array.from(x0), r, lambda = 1e-6;
  let sc = Float64Array.from(heavy, (w) => 1 / Math.sqrt(w));
  const lm = () => {
    r = all(x); lambda = 1e-6;
    if (!r.length) return;
    for (let it = 0; it < 80 && cost(r) > 1e-30; it++) {
      const J = jac(x, r), m = r.length;
      const H = new Float64Array(n * n), g = new Float64Array(n);
      for (let i = 0; i < m; i++) for (let a = 0; a < n; a++) { const ja = J[i * n + a]; if (!ja) continue; g[a] += ja * r[i]; for (let b = a; b < n; b++) H[a * n + b] += ja * J[i * n + b]; }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) H[a * n + b] = H[b * n + a];
      for (let a = 0; a < n; a++) { g[a] *= sc[a]; for (let b = 0; b < n; b++) H[a * n + b] *= sc[a] * sc[b]; } // work in scaled variables: a heavy variable needs a big change in its scaled value to move at all
      let improved = false;
      for (let tries = 0; tries < 12 && !improved; tries++) {
        const A = Float64Array.from(H), step = new Float64Array(n);
        for (let a = 0; a < n; a++) { A[a * n + a] += lambda; step[a] = -g[a]; } // the last term decides which way to go where the equations leave a choice
        if (!gauss(A, step, n)) { lambda *= 10; continue; }
        const xn = Float64Array.from(x); for (let a = 0; a < n; a++) xn[a] += step[a] * sc[a];
        const rn = all(xn);
        if (cost(rn) < cost(r)) { x = xn; r = rn; lambda = Math.max(1e-12, lambda / 4); improved = true; } else lambda *= 6;
      }
      if (!improved) break;
    }
  };
  const hardErr = () => { const hr = []; const Sx = hard(x, hr); const pr = []; pins(x, Sx, pr); return Math.max(hr.reduce((m, v) => Math.max(m, Math.abs(v)), 0), pr.reduce((m, v) => Math.max(m, Math.abs(v / PIN)), 0)); };
  // First try with the shapes you are matching to (and the end of a line you are turning) held where they are and sizes kept; if the
  // constraints cannot all be met that way, let those move a little, and finally let sizes give way too.
  const x00 = Float64Array.from(x);
  const attempts = [[heavy, true], [dw, true], [dw, false]];
  for (const [w, keep] of attempts) {
    x = Float64Array.from(x00); sc = Float64Array.from(w, (v) => 1 / Math.sqrt(v)); keepOn = keep;
    lm();
    if (hardErr() <= 1e-6) break;
  }
  keepOn = false;
  const S = build(x), hardR = []; hard(x, hardR);
  const residual = hardR.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const pinR = []; pins(x, S, pinR);
  const pinned = pinR.reduce((m, v) => Math.max(m, Math.abs(v / PIN)), 0);
  const ok = residual < 1e-6 && pinned < 1e-6;
  let result = { shapes: S.map((sh, i) => (shapes[i].t === 'rrect' ? { ...sh, r: Math.min(shapes[i].r, sh.w / 2, sh.h / 2) } : sh)), ok, residual, method: 'solver' };
  if (!ok) { // conflicting constraints: keep whichever of the two methods leaves the smaller error
    const seq = applySequential(shapes, cons), xs = Float64Array.from(seq.flatMap(toVec)), rs = []; hard(xs, rs);
    const resSeq = rs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (resSeq < residual) result = { shapes: seq, ok: resSeq < 1e-6, residual: resSeq, method: 'sequential' };
  }
  // how many degrees of freedom remain: the rank of the equations' derivatives, with the sketch's position and the first point pinned
  let info = { vars: n, rank: 0, dof: n, free: [], redundant: 0 };
  if (details) {
    const xr = Float64Array.from(result.shapes.flatMap(toVec)), rr = []; const Sx = hard(xr, rr); pins(xr, Sx, rr);
    const m = rr.length;
    const J0 = m ? jac(xr, rr) : new Float64Array(0);
    const J = new Float64Array((m + 2) * n); J.set(J0);
    const first = shapes.findIndex((sh) => !sh.lt && toVec(sh).length >= 2);
    if (first >= 0) { J[m * n + offs[first]] = 1; J[(m + 1) * n + offs[first] + 1] = 1; } // the position of the sketch is not something to define
    // Work out which numbers are free parameters. Columns are taken positions first and sizes last, so what is reported as free
    // tends to be the sizes (the width you have not set) rather than where something sits.
    const order = [...Array(n).keys()].sort((p, q) => size[p] - size[q] || p - q);
    const Jp = new Float64Array((m + 2) * n);
    for (let i = 0; i < m + 2; i++) for (let c = 0; c < n; c++) Jp[i * n + c] = J[i * n + order[c]];
    const { pivots } = rref(Jp, m + 2, n, 1e-7 * J0.reduce((mx, v) => Math.max(mx, Math.abs(v)), 1));
    const piv = new Set(pivots), free = [...Array(n).keys()].filter((c) => !piv.has(c)).map((c) => order[c]);
    const names = shapes.flatMap((sh, s) => (sh.lt || sh.t === 'point' ? Array(toVec(sh).length).fill(null) : varNames(sh, s)));
    info = { vars: n, total: names.filter(Boolean).length, rank: pivots.length, dof: n - pivots.length, free: free.map((j) => names[j]).filter(Boolean), redundant: Math.max(0, m - (pivots.length - (first >= 0 ? 2 : 0))) };
  }
  return { ...result, ...info };
}
