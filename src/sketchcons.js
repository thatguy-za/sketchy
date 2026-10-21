// Geometric sketch constraints. A constraint adjusts the *first* referenced item to satisfy a relation with
// the second, and every constraint is re-applied whenever the sketch is resolved (so parameter changes and
// edits keep relations intact). Constraints: horizontal, vertical, coincident, concentric, equal, parallel,
// perpendicular.
//   refs: { s: shapeIndex, k?: pointKey, seg?: segmentIndex }
import { setDim, getDim } from './sketchdims.js';
import { arcOf } from './sketchgeo.js';
import { solveSketch } from './sketchsolve.js';

const D2R = Math.PI / 180;
export const CON_GLYPH = { horizontal: 'H', vertical: 'V', coincident: '●', concentric: '◎', equal: '=', parallel: '∥', perpendicular: '⟂', collinear: '═', midpoint: '△', tangent: '⌒', symmetry: '⇋', fix: '⚓' };
export const CON_LABEL = { horizontal: 'Horizontal', vertical: 'Vertical', coincident: 'Coincident', concentric: 'Concentric', equal: 'Equal', parallel: 'Parallel', perpendicular: 'Perpendicular', collinear: 'Collinear', midpoint: 'Midpoint', tangent: 'Tangent', symmetry: 'Symmetry', fix: 'Fix' };

/** Named points of a shape: [{k, p:[x,y]}]. */
export function keyPoints(sh) {
  switch (sh.t) {
    case 'rect': case 'rrect': {
      const { x, y, w, h } = sh;
      return [{ k: 'c0', p: [x, y] }, { k: 'c1', p: [x + w, y] }, { k: 'c2', p: [x + w, y + h] }, { k: 'c3', p: [x, y + h] }, { k: 'ctr', p: [x + w / 2, y + h / 2] }];
    }
    case 'circle': case 'ngon': case 'ellipse': return [{ k: 'c', p: [sh.cx, sh.cy] }];
    case 'slot': return [{ k: 'a', p: [sh.x1, sh.y1] }, { k: 'b', p: [sh.x2, sh.y2] }];
    case 'point': return [{ k: 'p', p: [sh.x, sh.y] }];
    case 'path': return sh.pts.map((p, i) => ({ k: 'p' + i, p: [p[0], p[1]] }));
    default: return [];
  }
}
export const pointOf = (sh, k) => keyPoints(sh).find((q) => q.k === k)?.p || null;

/** Move a named point of a shape to uv (resizing rectangles through the dragged corner). */
export function movePoint(sh, k, [u, v]) {
  switch (sh.t) {
    case 'circle': case 'ngon': case 'ellipse': return k === 'c' ? { ...sh, cx: u, cy: v } : sh;
    case 'slot': return k === 'a' ? { ...sh, x1: u, y1: v } : k === 'b' ? { ...sh, x2: u, y2: v } : sh;
    case 'point': return k === 'p' ? { ...sh, x: u, y: v } : sh;
    case 'path': { const i = +k.slice(1); return { ...sh, pts: sh.pts.map((p, q) => (q === i ? (p[2] ? [u, v, p[2]] : [u, v]) : p)) }; }
    case 'rect': case 'rrect': {
      if (k === 'ctr') return { ...sh, x: u - sh.w / 2, y: v - sh.h / 2 };
      let x0 = sh.x, y0 = sh.y, x1 = sh.x + sh.w, y1 = sh.y + sh.h;
      if (k === 'c0') { x0 = u; y0 = v; } else if (k === 'c1') { x1 = u; y0 = v; } else if (k === 'c2') { x1 = u; y1 = v; } else if (k === 'c3') { x0 = u; y1 = v; } else return sh;
      const nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0);
      if (nw < 1e-3 || nh < 1e-3) return sh;
      return { ...sh, x: Math.min(x0, x1), y: Math.min(y0, y1), w: nw, h: nh, ...(sh.t === 'rrect' ? { r: Math.min(sh.r, nw / 2, nh / 2) } : {}) };
    }
    default: return sh;
  }
}

/** [a, b] endpoints of segment `seg` of a path (null for non-paths). */
export function segOf(sh, seg) {
  if (sh?.t !== 'path') return null;
  const a = sh.pts[seg], b = sh.pts[(seg + 1) % sh.pts.length];
  return a && b ? [a, b] : null;
}

function rotateSegTo(sh, seg, angle) {
  const [a, b] = segOf(sh, seg);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const j = (seg + 1) % sh.pts.length;
  const np = [a[0] + len * Math.cos(angle), a[1] + len * Math.sin(angle)];
  return { ...sh, pts: sh.pts.map((p, q) => (q === j ? (p[2] ? [...np, p[2]] : np) : p)) };
}

function applyOne(shapes, c) {
  const A = shapes[c.a?.s];
  if (!A) return;
  const set = (i, v) => { shapes[i] = v; };
  switch (c.t) {
    case 'horizontal': case 'vertical': {
      const sg = segOf(A, c.a.seg);
      if (!sg || sg[0][2]) return;
      const j = (c.a.seg + 1) % A.pts.length;
      const np = c.t === 'horizontal' ? [sg[1][0], sg[0][1]] : [sg[0][0], sg[1][1]];
      set(c.a.s, { ...A, pts: A.pts.map((p, q) => (q === j ? (p[2] ? [...np, p[2]] : np) : p)) });
      return;
    }
    case 'coincident': case 'concentric': {
      const B = shapes[c.b?.s];
      if (!B) return;
      const kb = c.t === 'concentric' ? (['circle', 'ngon', 'ellipse'].includes(B.t) ? 'c' : 'ctr') : c.b.k;
      const ka = c.t === 'concentric' ? (['circle', 'ngon', 'ellipse'].includes(A.t) ? 'c' : 'ctr') : c.a.k;
      const target = pointOf(B, kb);
      if (target) set(c.a.s, movePoint(A, ka, target));
      return;
    }
    case 'equal': {
      const B = shapes[c.b?.s];
      if (!B) return;
      if (A.t === 'path' && B.t === 'path') {
        const idA = 's' + c.a.seg, idB = 's' + c.b.seg;
        const sa = segOf(A, c.a.seg), sb = segOf(B, c.b.seg);
        if (!sa || !sb || !!sa[0][2] !== !!sb[0][2]) return; // line↔line or arc↔arc only
        set(c.a.s, setDim(A, idA, getDim(B, idB)));
      } else if (A.t === 'circle' && B.t === 'circle') set(c.a.s, { ...A, r: B.r });
      else if (A.t === 'ngon' && B.t === 'ngon') set(c.a.s, { ...A, r: B.r });
      return;
    }
    case 'parallel': case 'perpendicular': {
      const B = shapes[c.b?.s];
      const sa = segOf(A, c.a.seg), sb = segOf(B, c.b.seg);
      if (!sa || !sb || sa[0][2] || sb[0][2]) return;
      const ang = Math.atan2(sb[1][1] - sb[0][1], sb[1][0] - sb[0][0]);
      const cur = Math.atan2(sa[1][1] - sa[0][1], sa[1][0] - sa[0][0]);
      const base = c.t === 'perpendicular' ? ang + Math.PI / 2 : ang;
      set(c.a.s, rotateSegTo(A, c.a.seg, Math.cos(cur - base) >= 0 ? base : base + Math.PI)); // keep orientation
      return;
    }
    case 'collinear': { // the first segment lies on the line through the second
      const B = shapes[c.b?.s];
      const sa = segOf(A, c.a.seg), sb = segOf(B, c.b?.seg);
      if (!sa || !sb || sa[0][2] || sb[0][2]) return;
      const dx = sb[1][0] - sb[0][0], dy = sb[1][1] - sb[0][1], L2 = dx * dx + dy * dy;
      if (L2 < 1e-18) return;
      const proj = (p) => { const t = ((p[0] - sb[0][0]) * dx + (p[1] - sb[0][1]) * dy) / L2; return [sb[0][0] + dx * t, sb[0][1] + dy * t]; };
      const j = (c.a.seg + 1) % A.pts.length;
      set(c.a.s, { ...A, pts: A.pts.map((p, q) => (q === c.a.seg || q === j ? (p[2] ? [...proj(p), p[2]] : proj(p)) : p)) });
      return;
    }
    case 'midpoint': { // a point sits at the middle of a segment
      const B = shapes[c.b?.s], sb = segOf(B, c.b?.seg);
      if (!sb || sb[0][2] || !c.a.k) return;
      set(c.a.s, movePoint(A, c.a.k, [(sb[0][0] + sb[1][0]) / 2, (sb[0][1] + sb[1][1]) / 2]));
      return;
    }
    case 'symmetry': { // the first point mirrors the second across a line segment
      const B = shapes[c.b?.s], C = shapes[c.c?.s], sc = segOf(C, c.c?.seg), pb = B && pointOf(B, c.b.k);
      if (!sc || sc[0][2] || !pb || !c.a.k) return;
      const dx = sc[1][0] - sc[0][0], dy = sc[1][1] - sc[0][1], L2 = dx * dx + dy * dy;
      if (L2 < 1e-18) return;
      const t = ((pb[0] - sc[0][0]) * dx + (pb[1] - sc[0][1]) * dy) / L2, fx = sc[0][0] + dx * t, fy = sc[0][1] + dy * t;
      set(c.a.s, movePoint(A, c.a.k, [2 * fx - pb[0], 2 * fy - pb[1]]));
      return;
    }
    case 'tangent': {
      const B = shapes[c.b?.s];
      if (!B) return;
      const circ = (sh, seg) => { // a circle, or an arc segment of a path: { c, r }
        if (sh.t === 'circle') return { c: [sh.cx, sh.cy], r: sh.r };
        if (sh.t === 'path' && seg != null) { const sg = segOf(sh, seg); if (sg && sg[0][2]) { const a = arcOf(sg[0], sg[1], sg[0][2]); return { c: a.c, r: a.r }; } }
        return null;
      };
      const lineOf = (sh, seg) => { const sg = sh.t === 'path' && seg != null ? segOf(sh, seg) : null; return sg && !sg[0][2] ? sg : null; };
      const la = lineOf(A, c.a.seg), lb = lineOf(B, c.b.seg), ca = circ(A, c.a.seg), cb = circ(B, c.b.seg);
      if (la && cb) { // a line meets a circle: keep its first end and turn it until it just touches
        const P = la[0], dx = cb.c[0] - P[0], dy = cb.c[1] - P[1], d = Math.hypot(dx, dy);
        if (d <= cb.r + 1e-9) return;
        const base = Math.atan2(dy, dx), off = Math.asin(cb.r / d), cur = Math.atan2(la[1][1] - P[1], la[1][0] - P[0]);
        const want = [base + off, base - off].reduce((m, a) => (Math.abs(Math.atan2(Math.sin(a - cur), Math.cos(a - cur))) < Math.abs(Math.atan2(Math.sin(m - cur), Math.cos(m - cur))) ? a : m));
        set(c.a.s, rotateSegTo(A, c.a.seg, want));
      } else if (ca && ca.r && lb && A.t === 'circle') { // a circle meets a line: slide it sideways
        const dx = lb[1][0] - lb[0][0], dy = lb[1][1] - lb[0][1], L = Math.hypot(dx, dy);
        if (L < 1e-12) return;
        const nx = -dy / L, ny = dx / L, dist = (ca.c[0] - lb[0][0]) * nx + (ca.c[1] - lb[0][1]) * ny, side = dist >= 0 ? 1 : -1, move = side * ca.r - dist;
        set(c.a.s, { ...A, cx: A.cx + nx * move, cy: A.cy + ny * move });
      } else if (A.t === 'circle' && cb) { // two circles touch: slide the first along the line between the centres
        const dx = A.cx - cb.c[0], dy = A.cy - cb.c[1], d = Math.hypot(dx, dy) || 1e-9;
        const ext = cb.r + A.r, inn = Math.abs(cb.r - A.r), want = d >= (ext + inn) / 2 ? ext : inn;
        set(c.a.s, { ...A, cx: cb.c[0] + (dx / d) * want, cy: cb.c[1] + (dy / d) * want });
      }
      return;
    }
    default:
  }
}

/** The older method: apply constraints one after another, three passes. Used when the solver cannot (a very big sketch) or does no better. Input untouched. */
export function applySequential(shapes, cons) {
  if (!cons?.length) return shapes;
  const out = [...shapes];
  for (let pass = 0; pass < 3; pass++) {
    for (const c of cons) if (c.t !== 'fix') { try { applyOne(out, c); } catch { /* skip broken */ } }
    for (const c of cons) { // fixed geometry goes back to where it was fixed: it wins over every other relation
      if (c.t !== 'fix' || !out[c.a?.s]) continue;
      if (c.snap) out[c.a.s] = c.snap;
      else if (c.pos && c.a.k) out[c.a.s] = movePoint(out[c.a.s], c.a.k, c.pos);
    }
  }
  return out;
}

/** Satisfy all the constraints together with the solver (src/sketchsolve.js). Returns new shapes; the input is untouched. */
export function applyConstraints(shapes, cons) {
  if (!cons?.length) return shapes;
  const out = [...solveSketch(shapes, cons).shapes];
  for (const c of cons) { // fixed geometry is exactly where it was fixed: it wins over every other relation
    if (c.t !== 'fix' || !out[c.a?.s]) continue;
    if (c.snap) out[c.a.s] = c.snap;
    else if (c.pos && c.a.k) out[c.a.s] = movePoint(out[c.a.s], c.a.k, c.pos);
  }
  return out;
}

/** Where to draw a constraint's badge: [u, v] in sketch coordinates. */
export function conAnchor(shapes, c) {
  const A = shapes[c.a?.s];
  if (!A) return null;
  if (c.a.seg != null) { const sg = segOf(A, c.a.seg); return sg ? [(sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2] : null; }
  if (c.a.k) return pointOf(A, c.a.k);
  const kp = keyPoints(A)[A.t === 'rect' || A.t === 'rrect' ? 4 : 0];
  return kp?.p || null;
}

/**
 * How firmly a sketch is pinned down, counted per shape: a rectangle has two sizes (width, height), a circle one (diameter), a
 * line segment a length and a direction. A size counts as locked when a parameter expression drives it or an Equal constraint
 * copies it; a direction counts as locked by Horizontal, Vertical, Parallel or Perpendicular. Where the sketch sits is not counted.
 * Returns { total, locked, free: ["Rectangle 1 width", ...], state: 'empty' | 'free' | 'partial' | 'defined' }.
 */
export function definedState(shapes, cons) {
  const heur = definedStateByCounting(shapes, cons);
  if (heur.state === 'empty') return heur;
  let info;
  try { info = solveSketch(shapes, cons || [], { details: true }); } catch { return heur; }
  if (info.method === 'sequential' && !info.free.length && info.rank === 0) return heur; // too big for the solver: count instead
  const free = info.free, total = info.total;
  return { total, locked: Math.max(0, total - free.length), free, dof: info.dof, redundant: info.redundant, state: !free.length ? 'defined' : free.length < total ? 'partial' : 'free' };
}
/** The older way of judging how defined a sketch is, by counting locked sizes and directions. Used for sketches too big for the solver. */
export function definedStateByCounting(shapes, cons) {
  const NAMES = { rect: 'Rectangle', rrect: 'Rounded rectangle', circle: 'Circle', ngon: 'Polygon', slot: 'Slot', ellipse: 'Ellipse', path: 'Path' };
  const DIMS = { rect: [['w', 'width'], ['h', 'height']], rrect: [['w', 'width'], ['h', 'height'], ['r', 'corner radius']], circle: [['d', 'diameter']], ngon: [['r', 'radius']], slot: [['len', 'length'], ['w', 'width']], ellipse: [['a', 'width'], ['b', 'height']] };
  let total = 0, locked = 0;
  const free = [];
  let curShape = -1;
  const count = (ok, label) => { total++; if (ok || fixedShape(curShape)) locked++; else free.push(label); };
  const fixedShape = (s) => (cons || []).some((c) => c.t === 'fix' && c.a?.s === s && c.a.k === undefined);
  const equalTo = (s, seg) => (cons || []).some((c) => c.t === 'equal' && c.a?.s === s && (seg == null || c.a.seg === seg));
  shapes.forEach((sh, s) => {
    curShape = s;
    if (sh.lt || sh.t === 'point') return; // reference geometry has nothing to define
    const nm = `${NAMES[sh.t] || 'Shape'} ${s + 1}`;
    if (sh.t === 'path') {
      const n = sh.pts.length, segs = sh.open ? n - 1 : n;
      for (let i = 0; i < segs; i++) {
        const arc = !!sh.pts[i][2];
        count(!!sh.ex?.['s' + i] || equalTo(s, i), `${nm} ${arc ? 'arc radius' : 'side'} ${i + 1}`);
        if (!arc) count((cons || []).some((c) => c.a?.s === s && c.a.seg === i && ['horizontal', 'vertical', 'parallel', 'perpendicular'].includes(c.t)), `${nm} side ${i + 1} direction`);
      }
    } else for (const [id, label] of DIMS[sh.t] || []) count(!!sh.ex?.[id] || (equalTo(s) && ['d', 'r'].includes(id)), `${nm} ${label}`);
  });
  return { total, locked, free, state: !total ? 'empty' : locked === total ? 'defined' : locked ? 'partial' : 'free' };
}
