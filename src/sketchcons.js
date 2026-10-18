// Geometric sketch constraints. A constraint adjusts the *first* referenced item to satisfy a relation with
// the second, and every constraint is re-applied whenever the sketch is resolved (so parameter changes and
// edits keep relations intact). Constraints: horizontal, vertical, coincident, concentric, equal, parallel,
// perpendicular.
//   refs: { s: shapeIndex, k?: pointKey, seg?: segmentIndex }
import { setDim, getDim } from './sketchdims.js';

const D2R = Math.PI / 180;
export const CON_GLYPH = { horizontal: 'H', vertical: 'V', coincident: '●', concentric: '◎', equal: '=', parallel: '∥', perpendicular: '⟂' };
export const CON_LABEL = { horizontal: 'Horizontal', vertical: 'Vertical', coincident: 'Coincident', concentric: 'Concentric', equal: 'Equal', parallel: 'Parallel', perpendicular: 'Perpendicular' };

/** Named points of a shape: [{k, p:[x,y]}]. */
export function keyPoints(sh) {
  switch (sh.t) {
    case 'rect': case 'rrect': {
      const { x, y, w, h } = sh;
      return [{ k: 'c0', p: [x, y] }, { k: 'c1', p: [x + w, y] }, { k: 'c2', p: [x + w, y + h] }, { k: 'c3', p: [x, y + h] }, { k: 'ctr', p: [x + w / 2, y + h / 2] }];
    }
    case 'circle': case 'ngon': case 'ellipse': return [{ k: 'c', p: [sh.cx, sh.cy] }];
    case 'slot': return [{ k: 'a', p: [sh.x1, sh.y1] }, { k: 'b', p: [sh.x2, sh.y2] }];
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
    default:
  }
}

/** Apply constraints in order, repeating so chains settle. Returns new shapes (input untouched). */
export function applyConstraints(shapes, cons) {
  if (!cons?.length) return shapes;
  const out = [...shapes];
  for (let pass = 0; pass < 3; pass++) for (const c of cons) { try { applyOne(out, c); } catch { /* skip broken */ } }
  return out;
}

/** Where to draw a constraint's badge: [u, v] in sketch coordinates. */
export function conAnchor(shapes, c) {
  const A = shapes[c.a?.s];
  if (!A) return null;
  if (c.a.seg != null) { const sg = segOf(A, c.a.seg); return sg ? [(sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2] : null; }
  if (c.t === 'coincident') return pointOf(A, c.a.k);
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
  const NAMES = { rect: 'Rectangle', rrect: 'Rounded rectangle', circle: 'Circle', ngon: 'Polygon', slot: 'Slot', ellipse: 'Ellipse', path: 'Path' };
  const DIMS = { rect: [['w', 'width'], ['h', 'height']], rrect: [['w', 'width'], ['h', 'height'], ['r', 'corner radius']], circle: [['d', 'diameter']], ngon: [['r', 'radius']], slot: [['len', 'length'], ['w', 'width']], ellipse: [['a', 'width'], ['b', 'height']] };
  let total = 0, locked = 0;
  const free = [];
  const count = (ok, label) => { total++; if (ok) locked++; else free.push(label); };
  const equalTo = (s, seg) => (cons || []).some((c) => c.t === 'equal' && c.a?.s === s && (seg == null || c.a.seg === seg));
  shapes.forEach((sh, s) => {
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
