// Driving dimensions: set one named dimension of a sketch shape, and resolve shape.ex expressions
// (e.g. { w: "width/2", d: "hole + 0.2 mm" }) against the user parameters.
import { evalExpr } from './params.js';
import { arcOf, bulgeFromRadius } from './sketchgeo.js';
import { applyConstraints } from './sketchcons.js';

/** Dimension ids per shape type (match the labels shown in the sketch). */
export const DIM_IDS = {
  rect: ['w', 'h'], rrect: ['w', 'h', 'r'], circle: ['d'], ngon: ['r'], slot: ['len', 'w'], ellipse: ['a', 'b'],
};

/** Returns a copy of `sh` with dimension `id` set to `v` (positive number), or `sh` when it can't apply. */
export function setDim(sh, id, v) {
  if (!(v > 0)) return sh;
  switch (sh.t) {
    case 'rect': return id === 'w' ? { ...sh, w: v } : id === 'h' ? { ...sh, h: v } : sh;
    case 'rrect':
      if (id === 'w') return { ...sh, w: v, r: Math.min(sh.r, v / 2) };
      if (id === 'h') return { ...sh, h: v, r: Math.min(sh.r, v / 2) };
      if (id === 'r') return { ...sh, r: Math.min(v, sh.w / 2, sh.h / 2) };
      return sh;
    case 'circle': return id === 'd' ? { ...sh, r: v / 2 } : sh;
    case 'ngon': return id === 'r' ? { ...sh, r: v } : sh;
    case 'ellipse': return id === 'a' ? { ...sh, rx: v } : id === 'b' ? { ...sh, ry: v } : sh;
    case 'slot': {
      if (id === 'w') return { ...sh, w: v };
      if (id === 'len') {
        const L = Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1), k = L > 1e-9 ? v / L : 1;
        return { ...sh, x2: sh.x1 + (sh.x2 - sh.x1) * k, y2: sh.y1 + (sh.y2 - sh.y1) * k };
      }
      return sh;
    }
    case 'path': {
      const m = /^s(\d+)$/.exec(id);
      if (!m) return sh;
      const i = +m[1], n = sh.pts.length, a = sh.pts[i], j = (i + 1) % n, b = sh.pts[j];
      if (!a || !b) return sh;
      const bulge = a[2] || 0, chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (bulge) {
        const nb = bulgeFromRadius(chord, v, Math.sign(bulge));
        return nb ? { ...sh, pts: sh.pts.map((p, q) => (q === i ? [p[0], p[1], nb] : p)) } : sh;
      }
      const k = chord > 1e-9 ? v / chord : 1;
      const np = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      return { ...sh, pts: sh.pts.map((p, q) => (q === j ? (p[2] ? [...np, p[2]] : np) : p)) };
    }
    default: return sh;
  }
}

/** Current value of a dimension (for display). */
export function getDim(sh, id) {
  switch (sh.t) {
    case 'rect': case 'rrect': return id === 'w' ? sh.w : id === 'h' ? sh.h : sh.r;
    case 'circle': return sh.r * 2;
    case 'ngon': return sh.r;
    case 'ellipse': return id === 'a' ? sh.rx : sh.ry;
    case 'slot': return id === 'w' ? sh.w : Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1);
    case 'path': {
      const i = +id.slice(1), a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length];
      if (!a || !b) return 0;
      return a[2] ? arcOf(a, b, a[2]).r : Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    default: return 0;
  }
}

/**
 * Apply every shape's `ex` expressions. Returns {params, error}; `params` keeps identity when nothing changes
 * so caches keyed on it stay valid.
 */
export function resolveSketch(f, scope) {
  if (f.type !== 'sketch' || (!f.params.shapes.some((s) => s.ex) && !f.params.cons?.length)) return { params: f.params };
  let error = null;
  const shapes = f.params.shapes.map((sh) => {
    if (!sh.ex) return sh;
    let out = sh;
    for (const [id, text] of Object.entries(sh.ex)) {
      try { out = setDim(out, id, evalExpr(text, scope)); }
      catch (e) { error ||= `${id}: ${e.message}`; }
    }
    return out;
  });
  return { params: { ...f.params, shapes: applyConstraints(shapes, f.params.cons) }, error: error && `Sketch dimension ${error}` };
}
