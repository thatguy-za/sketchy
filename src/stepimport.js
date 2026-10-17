// STEP (ISO 10303-21) import. Reads the geometry of solids and turns every face into triangles:
//   planes, cylinders, cones, spheres and tori (the surfaces most mechanical parts are made of), with line, circle, ellipse and
//   B-spline edges, plus the faceted solids Sketchy itself writes. B-spline *surfaces* (free-form shapes) are not supported: those
//   faces are reported and the gap they leave is closed flat by mesh repair.
// Neighbouring faces share their boundary points exactly, so the result is a watertight mesh.
import { ShapeUtils, Vector2 } from 'three';

// ---------------------------------------------------------------- tokenising
/** Parse the DATA section into Map(id -> { type, args } | { type: 'COMPLEX', parts: {TYPE: args} }). */
function parseEntities(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = text.search(/\bDATA\s*;/i);
  const data = start >= 0 ? text.slice(start + 5) : text;
  const ents = new Map();
  let i = 0;
  const n = data.length;
  while (i < n) {
    const hash = data.indexOf('#', i);
    if (hash < 0) break;
    // find the terminating ';' outside quotes
    let j = hash, q = false, depth = 0;
    for (; j < n; j++) {
      const c = data[j];
      if (c === "'") q = !q;
      else if (!q) { if (c === '(') depth++; else if (c === ')') depth--; else if (c === ';' && depth <= 0) break; }
    }
    const src = data.slice(hash, j);
    i = j + 1;
    const m = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(src);
    if (!m) continue;
    const body = m[2].trim();
    if (body[0] === '(') { // complex entity: ( TYPE(args) TYPE(args) ... )
      const parts = {};
      let p = 1;
      while (p < body.length) {
        const mm = /^\s*([A-Z0-9_]+)\s*\(/i.exec(body.slice(p));
        if (!mm) break;
        const open = p + mm[0].length - 1, close = matchParen(body, open);
        parts[mm[1].toUpperCase()] = parseArgs(body.slice(open + 1, close));
        p = close + 1;
      }
      ents.set(+m[1], { type: 'COMPLEX', parts });
    } else {
      const mm = /^([A-Z0-9_]+)\s*\(/i.exec(body);
      if (!mm) continue;
      const open = mm[0].length - 1;
      ents.set(+m[1], { type: mm[1].toUpperCase(), args: parseArgs(body.slice(open + 1, matchParen(body, open))) });
    }
  }
  return ents;
}
function matchParen(s, open) {
  let d = 0, q = false;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === "'") q = !q;
    else if (!q) { if (c === '(') d++; else if (c === ')') { d--; if (d === 0) return k; } }
  }
  return s.length;
}
/** "a, #3, (1.,2.), .T., 'x', $, *" -> ['a', {ref:3}, [1,2], '.T.', {s:'x'}, null, '*'] */
function parseArgs(s) {
  const out = [];
  let i = 0;
  const skip = () => { while (i < s.length && /\s|,/.test(s[i])) i++; };
  while ((skip(), i < s.length)) {
    const c = s[i];
    if (c === '(') { const close = matchParen(s, i); out.push(parseArgs(s.slice(i + 1, close))); i = close + 1; }
    else if (c === "'") { let j = i + 1; while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1; out.push({ s: s.slice(i + 1, j).replace(/''/g, "'") }); i = j + 1; }
    else if (c === '#') { const m = /^#(\d+)/.exec(s.slice(i)); out.push({ ref: +m[1] }); i += m[0].length; }
    else if (c === '$') { out.push(null); i++; }
    else if (c === '*') { out.push('*'); i++; }
    else {
      let j = i;
      while (j < s.length && !/[,()]/.test(s[j])) j++;
      const tok = s.slice(i, j).trim();
      // typed values like LENGTH_MEASURE(5.) show up as TYPE(…): keep the inner value
      if (s[j] === '(') { const close = matchParen(s, j); const inner = parseArgs(s.slice(j + 1, close)); out.push(inner.length === 1 ? inner[0] : inner); i = close + 1; }
      else { out.push(/^[-+]?[\d.]/.test(tok) && Number.isFinite(+tok) ? +tok : tok); i = j; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- small vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- the model
class Step {
  constructor(text) {
    this.e = parseEntities(text);
    this.notes = new Set();
    this.skipped = 0;
    this.cache = new Map();
    this.scale = this.findScale();
  }
  get(ref) { return ref && ref.ref !== undefined ? this.e.get(ref.ref) : undefined; }
  args(ref, type) { const x = this.get(ref); if (!x) return null; if (x.type === 'COMPLEX') return x.parts[type] || null; return !type || x.type === type ? x.args : null; }
  typeOf(ref) { return this.get(ref)?.type; }
  findScale() {
    for (const x of this.e.values()) {
      const parts = x.type === 'COMPLEX' ? x.parts : null;
      if (parts?.LENGTH_UNIT && parts.SI_UNIT) {
        const pre = String(parts.SI_UNIT[0] ?? '').replace(/\./g, '').toUpperCase();
        return { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6, MICRO: 0.001 }[pre] ?? (pre === '' || pre === '$' ? 1000 : 1);
      }
      if (parts?.LENGTH_UNIT && parts.CONVERSION_BASED_UNIT) return 25.4; // inches
    }
    return 1;
  }
  point(ref) { const a = this.args(ref, 'CARTESIAN_POINT'); return a ? [a[1][0], a[1][1], a[1][2] ?? 0] : null; }
  dir(ref) { const a = this.args(ref, 'DIRECTION'); return a ? unit(a[1]) : null; }
  frame(ref) { // AXIS2_PLACEMENT_3D -> { o, x, y, z }
    const a = this.args(ref, 'AXIS2_PLACEMENT_3D');
    if (!a) return null;
    const o = this.point(a[1]), z = a[2] ? this.dir(a[2]) : [0, 0, 1];
    let x = a[3] ? this.dir(a[3]) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = unit(sub(x, scl(z, dot(x, z))));
    return { o, x, y: cross(z, x), z };
  }

  // ---- edges: sampled once from vertex 1 to vertex 2, so both faces that use an edge get identical points
  edgePoints(edgeRef) {
    const id = edgeRef.ref;
    if (this.cache.has(id)) return this.cache.get(id);
    const a = this.args(edgeRef, 'EDGE_CURVE');
    const v1 = this.point(this.args(a[1], 'VERTEX_POINT')[1]), v2 = this.point(this.args(a[2], 'VERTEX_POINT')[1]);
    const same = a[4] !== '.F.';
    const pts = this.sampleCurve(a[3], v1, v2, same);
    pts[0] = v1; pts[pts.length - 1] = v2; // ends are exactly the vertices
    this.cache.set(id, pts);
    return pts;
  }
  sampleCurve(ref, p1, p2, same) {
    let t = this.typeOf(ref), x = this.get(ref);
    if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE' || t === 'INTERSECTION_CURVE') return this.sampleCurve(x.args[1], p1, p2, same);
    if (t === 'LINE') return [p1, p2];
    if (t === 'CIRCLE' || t === 'ELLIPSE') {
      const f = this.frame(x.args[1]), ra = x.args[2], rb = t === 'ELLIPSE' ? x.args[3] : x.args[2];
      const ang = (p) => { const d = sub(p, f.o); return Math.atan2(dot(d, f.y) / rb, dot(d, f.x) / ra); };
      const a1 = ang(p1), a2 = ang(p2);
      let d = same ? a2 - a1 : a1 - a2;
      d = ((d % TAU) + TAU) % TAU;
      if (d < 1e-9) d = TAU; // same start and end: the full circle
      const steps = Math.max(2, Math.ceil(d / (Math.PI / 45))), pts = [];
      for (let k = 0; k <= steps; k++) {
        const th = same ? a1 + (d * k) / steps : a1 - (d * k) / steps;
        pts.push(add(add(f.o, scl(f.x, ra * Math.cos(th))), scl(f.y, rb * Math.sin(th))));
      }
      return pts;
    }
    const bs = this.bsplineCurve(ref);
    if (bs) return sampleBSpline(bs, p1, p2, same);
    this.notes.add(`an edge of type ${t || 'unknown'} was replaced by a straight line`);
    return [p1, p2];
  }
  bsplineCurve(ref) {
    const x = this.get(ref);
    if (!x) return null;
    const parts = x.type === 'COMPLEX' ? x.parts : { [x.type]: x.args };
    const main = parts.B_SPLINE_CURVE_WITH_KNOTS || (x.type === 'B_SPLINE_CURVE_WITH_KNOTS' ? x.args : null);
    if (!main) return null;
    const base = parts.B_SPLINE_CURVE || main; // [degree, control points, curve form, closed, self-intersect]
    const degree = base[0], cps = base[1].map((r) => this.point(r));
    let knots;
    const km = main.length >= 2 ? main : null; // [mults, knots, spec] (complex) or full arg list (simple)
    const mults = x.type === 'COMPLEX' ? main[0] : main[7], kv = x.type === 'COMPLEX' ? main[1] : main[8];
    knots = []; mults.forEach((m, i) => { for (let k = 0; k < m; k++) knots.push(kv[i]); });
    const w = parts.RATIONAL_B_SPLINE_CURVE ? parts.RATIONAL_B_SPLINE_CURVE[0] : null;
    void km;
    return { degree, cps, knots, w };
  }

  // ---- loops
  loopPoints(loopRef, flip) {
    const l = this.get(loopRef);
    let pts = [];
    if (l?.type === 'POLY_LOOP') pts = l.args[1].map((r) => this.point(r));
    else if (l?.type === 'EDGE_LOOP') {
      for (const oe of l.args[1]) {
        const a = this.args(oe, 'ORIENTED_EDGE');
        let seg = this.edgePoints(a[3]);
        if (a[4] === '.F.') seg = [...seg].reverse();
        pts.push(...(pts.length ? seg.slice(1) : seg));
      }
      if (pts.length > 1 && len(sub(pts[0], pts[pts.length - 1])) < 1e-9) pts.pop();
    } else if (l?.type === 'VERTEX_LOOP') pts = [];
    return flip ? pts.reverse() : pts;
  }
  faceLoops(faceArgs) {
    const loops = [];
    for (const b of faceArgs[1]) {
      const x = this.get(b);
      if (!x) continue;
      const pts = this.loopPoints(x.args[1], x.args[2] === '.F.');
      if (pts.length >= 3) loops.push({ pts, outer: x.type === 'FACE_OUTER_BOUND' });
    }
    return loops;
  }
}

// ---------------------------------------------------------------- B-splines
function bsplineEval(c, u) {
  const { degree: p, cps, knots, w } = c, n = cps.length - 1;
  let k = p;
  while (k < n && u >= knots[k + 1]) k++;
  const dim = 4, d = [];
  for (let j = 0; j <= p; j++) { const i = k - p + j, wt = w ? w[i] : 1; d.push([cps[i][0] * wt, cps[i][1] * wt, cps[i][2] * wt, wt]); }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j, den = knots[i + p - r + 1] - knots[i], al = den ? (u - knots[i]) / den : 0;
      for (let t = 0; t < dim; t++) d[j][t] = (1 - al) * d[j - 1][t] + al * d[j][t];
    }
  }
  const r = d[p];
  return [r[0] / r[3], r[1] / r[3], r[2] / r[3]];
}
function sampleBSpline(c, p1, p2, same) {
  const lo = c.knots[c.degree], hi = c.knots[c.knots.length - 1 - c.degree], N = 400;
  const pts = []; for (let i = 0; i <= N; i++) pts.push(bsplineEval(c, lo + ((hi - lo) * i) / N - (i === N ? 1e-12 : 0)));
  const nearest = (p) => { let b = 0, bd = Infinity; pts.forEach((q, i) => { const d = len(sub(q, p)); if (d < bd) { bd = d; b = i; } }); return b; };
  let i1 = nearest(p1), i2 = nearest(p2);
  const closed = len(sub(p1, p2)) < 1e-9;
  let seg;
  if (closed) seg = same ? pts.slice(i1).concat(pts.slice(1, i1 + 1)) : pts.slice(0, i1 + 1).reverse().concat(pts.slice(i1 + 1).reverse());
  else if (same) seg = i1 <= i2 ? pts.slice(i1, i2 + 1) : pts.slice(i1).concat(pts.slice(1, i2 + 1));
  else seg = i1 >= i2 ? pts.slice(i2, i1 + 1).reverse() : pts.slice(0, i1 + 1).reverse().concat(pts.slice(i2).reverse().slice(1));
  // keep about one point per half degree of turning, at most 120
  const step = Math.max(1, Math.floor(seg.length / 120));
  const out = seg.filter((_, i) => i % step === 0 || i === seg.length - 1);
  return out.length >= 2 ? out : [p1, p2];
}

// ---------------------------------------------------------------- triangulation helpers
const area2 = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function inPoly(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
/** Plain polygon (with holes) triangulation in 2D: returns triples of indices into [outer, ...holes] concatenated. */
function earcut2D(outer, holes) {
  const toV = (l) => l.map((p) => new Vector2(p[0], p[1]));
  return ShapeUtils.triangulateShape(toV(outer), holes.map(toV));
}
/**
 * Delaunay triangulation (Bowyer-Watson) of boundary points plus interior grid points, keeping the triangles inside the
 * region (outer loop minus holes). Falls back to ear clipping when a boundary edge is lost. Points are [x, y] in a space where
 * lengths are roughly real lengths. Returns triples of indices into the point list [outer..., holes..., interior...].
 */
function delaunayRegion(outer, holes, spacing) {
  const pts = [...outer, ...holes.flat()];
  const nb = pts.length;
  // interior points
  const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const loops = [outer, ...holes];
  const distEdge = (p) => { let m = Infinity; for (const l of loops) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); m = Math.min(m, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)); } return m; };
  if (spacing && Number.isFinite(spacing)) {
    let sp = spacing;
    const cols = (x1 - x0) / sp, rows = (y1 - y0) / sp;
    if (cols * rows > 6000) sp *= Math.sqrt((cols * rows) / 6000);
    for (let y = y0 + sp / 2; y < y1; y += sp) for (let x = x0 + sp / 2; x < x1; x += sp) {
      const p = [x + (Math.round((y - y0) / sp) % 2) * sp * 0.25, y];
      if (inPoly(p, outer) && !holes.some((h) => inPoly(p, h)) && distEdge(p) > sp * 0.55) pts.push(p);
    }
  }
  if (pts.length > 5000) return null;
  // Bowyer-Watson
  const big = Math.max(x1 - x0, y1 - y0, 1) * 20, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const P = pts.concat([[cx - big, cy - big], [cx + big, cy - big], [cx, cy + big]]);
  let tris = [[pts.length, pts.length + 1, pts.length + 2]];
  const circ = (t) => {
    const [a, b, c] = t.map((i) => P[i]);
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) || 1e-12;
    const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
    const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
    return [ux, uy, (a[0] - ux) ** 2 + (a[1] - uy) ** 2];
  };
  let cc = [circ(tris[0])];
  for (let i = 0; i < pts.length; i++) {
    const p = P[i], bad = [];
    for (let t = 0; t < tris.length; t++) if ((p[0] - cc[t][0]) ** 2 + (p[1] - cc[t][1]) ** 2 < cc[t][2] * (1 - 1e-12)) bad.push(t);
    const edges = new Map();
    for (const t of bad) for (let k = 0; k < 3; k++) { const a = tris[t][k], b = tris[t][(k + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`; edges.set(key, edges.has(key) ? null : [a, b]); }
    const badSet = new Set(bad);
    const nt = [], nc = [];
    tris.forEach((t, k) => { if (!badSet.has(k)) { nt.push(t); nc.push(cc[k]); } });
    for (const e of edges.values()) if (e) { const t = [e[0], e[1], i]; nt.push(t); nc.push(circ(t)); }
    tris = nt; cc = nc;
  }
  tris = tris.filter((t) => t.every((i) => i < pts.length));
  const keep = tris.filter((t) => { const g = [(P[t[0]][0] + P[t[1]][0] + P[t[2]][0]) / 3, (P[t[0]][1] + P[t[1]][1] + P[t[2]][1]) / 3]; return inPoly(g, outer) && !holes.some((h) => inPoly(g, h)); });
  // every boundary segment must be an edge of the result, otherwise the neighbouring face would not match
  const have = new Set();
  for (const t of keep) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; have.add(a < b ? `${a}_${b}` : `${b}_${a}`); }
  let off = 0;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) { const a = off + i, b = off + ((i + 1) % l.length); if (!have.has(a < b ? `${a}_${b}` : `${b}_${a}`)) return null; }
    off += l.length;
  }
  return { pts, tris: keep };
}

// ---------------------------------------------------------------- surfaces
const wrapTo = (a, ref) => a - TAU * Math.round((a - ref) / TAU);
/** Surface description: param(p) -> [u,v] in a roughly metric space, point(u,v) -> 3D, normal(p) -> outward, spacing. */
function makeSurface(step, ref) {
  const x = step.get(ref);
  if (!x) return null;
  const t = x.type;
  if (t === 'PLANE') { const f = step.frame(x.args[1]); return { kind: 'plane', f }; }
  const f = step.frame(x.args[1]);
  if (!f) return null;
  if (t === 'CYLINDRICAL_SURFACE') {
    const R = x.args[2];
    return { kind: 'cyl', f, R, metric: (th, h) => [th * R, h], param: (p) => { const d = sub(p, f.o); return [Math.atan2(dot(d, f.y), dot(d, f.x)), dot(d, f.z)]; }, point: (th, h) => add(add(f.o, scl(add(scl(f.x, Math.cos(th)), scl(f.y, Math.sin(th))), R)), scl(f.z, h)), normal: (p) => { const d = sub(p, f.o), r = sub(d, scl(f.z, dot(d, f.z))); return unit(r); }, period: [TAU, 0] };
  }
  if (t === 'CONICAL_SURFACE') {
    const R = x.args[2], al = x.args[3], ta = Math.tan(al);
    return { kind: 'cone', f, R, al, metric: (th, h) => [th * Math.max(R + h * ta, 0.05), h / Math.cos(al)], param: (p) => { const d = sub(p, f.o); return [Math.atan2(dot(d, f.y), dot(d, f.x)), dot(d, f.z)]; }, point: (th, h) => add(add(f.o, scl(add(scl(f.x, Math.cos(th)), scl(f.y, Math.sin(th))), R + h * ta)), scl(f.z, h)), normal: (p) => { const d = sub(p, f.o), h = dot(d, f.z), r = unit(sub(d, scl(f.z, h))); return unit(sub(r, scl(f.z, ta))); }, apexH: -R / ta, period: [TAU, 0] };
  }
  if (t === 'SPHERICAL_SURFACE') {
    const R = x.args[2];
    return { kind: 'sph', f, R, param: (p) => { const d = sub(p, f.o); return [Math.atan2(dot(d, f.y), dot(d, f.x)), Math.asin(Math.max(-1, Math.min(1, dot(d, f.z) / R)))]; }, point: (th, ph) => add(f.o, scl(add(add(scl(f.x, Math.cos(ph) * Math.cos(th)), scl(f.y, Math.cos(ph) * Math.sin(th))), scl(f.z, Math.sin(ph))), R)), normal: (p) => unit(sub(p, f.o)), period: [TAU, 0] };
  }
  if (t === 'TOROIDAL_SURFACE') {
    const R = x.args[2], r = x.args[3];
    return { kind: 'tor', f, R, r, param: (p) => { const d = sub(p, f.o), u = Math.atan2(dot(d, f.y), dot(d, f.x)), rad = Math.hypot(dot(d, f.x), dot(d, f.y)) - R; return [u, Math.atan2(dot(d, f.z), rad)]; }, point: (u, v) => { const ring = R + r * Math.cos(v); return add(add(f.o, scl(add(scl(f.x, Math.cos(u)), scl(f.y, Math.sin(u))), ring)), scl(f.z, r * Math.sin(v))); }, normal: (p) => { const d = sub(p, f.o), u = Math.atan2(dot(d, f.y), dot(d, f.x)); const c = add(f.o, scl(add(scl(f.x, Math.cos(u)), scl(f.y, Math.sin(u))), R)); return unit(sub(p, c)); }, period: [TAU, TAU] };
  }
  return null;
}

/** Triangulate one face; returns an array of 9-number triangles (outward-facing) or null when unsupported. */
function triangulateFace(step, faceEnt) {
  const a = faceEnt.args; // ADVANCED_FACE(name, bounds, surface, same_sense)
  const same = a[3] !== '.F.';
  const loops = step.faceLoops(a);
  if (!loops.length) return [];
  const surfEnt = step.get(a[2]);
  const out = [];
  const addTri = (p, q, r, nrm) => { // orient to the outward direction
    const n = cross(sub(q, p), sub(r, p));
    if (len(n) < 1e-14) return;
    const flip = dot(n, nrm) < 0;
    out.push(...(flip ? [...p, ...r, ...q] : [...p, ...q, ...r]));
  };
  const surf = makeSurface(step, a[2]);
  if (!surf) { step.skipped++; return null; }
  // outer loop: marked as such, otherwise the largest
  const sorted = [...loops].sort((x, y) => (y.outer ? 1 : 0) - (x.outer ? 1 : 0));
  if (surf.kind === 'plane') {
    const f = surf.f, nrm = same ? f.z : scl(f.z, -1);
    const to2 = (l) => l.pts.map((p) => { const d = sub(p, f.o); return [dot(d, f.x), dot(d, f.y)]; });
    let outerIdx = sorted.findIndex((l) => l.outer);
    if (outerIdx < 0) outerIdx = sorted.reduce((b, l, i) => (Math.abs(area2(to2(l))) > Math.abs(area2(to2(sorted[b]))) ? i : b), 0);
    const outer = sorted[outerIdx], holes = sorted.filter((_, i) => i !== outerIdx);
    const flat = [outer, ...holes], flatPts = flat.flatMap((l) => l.pts);
    const tri = earcut2D(to2(outer), holes.map(to2));
    for (const [i, j, k] of tri) addTri(flatPts[i], flatPts[j], flatPts[k], nrm);
    return out;
  }
  // curved faces: flatten the face into a 2D chart, triangulate there (Delaunay plus interior points for surfaces that
  // curve in both directions), and map the points back onto the surface
  const outer = sorted[0];
  const uvOf = (l) => { // continuous (unwrapped) parameters along a loop
    let prev = null;
    return l.pts.map((p) => { const q = surf.param(p); if (prev) { q[0] = wrapTo(q[0], prev[0]); if (surf.period[1]) q[1] = wrapTo(q[1], prev[1]); } prev = q; return q; });
  };
  const ouv = uvOf(outer);
  let wind = 0; // how often the outer loop turns around the surface axis (u direction)
  for (let i = 0; i < ouv.length; i++) { const p = ouv[i], q = ouv[(i + 1) % ouv.length]; let d = q[0] - p[0]; d -= TAU * Math.round(d / TAU); wind += d; }
  const around = Math.abs(Math.abs(wind) - TAU) < 0.5;
  const holesUV = sorted.slice(1).map(uvOf);
  const refU = ouv.reduce((s2, p) => s2 + p[0], 0) / ouv.length, refV = ouv.reduce((s2, p) => s2 + p[1], 0) / ouv.length;
  const shifted = holesUV.map((h) => { const cu = h.reduce((s2, p) => s2 + p[0], 0) / h.length, cv = h.reduce((s2, p) => s2 + p[1], 0) / h.length; const du = TAU * Math.round((refU - cu) / TAU), dv = surf.period[1] ? TAU * Math.round((refV - cv) / TAU) : 0; return h.map((p) => [p[0] + du, p[1] + dv]); });
  let chart, unchart, spacing = 0, loopsUV = [ouv, ...shifted], closeThroughApex = false;
  if (surf.kind === 'cyl') {
    chart = (p) => [p[0] * surf.R, p[1]]; unchart = (c) => [c[0] / surf.R, c[1]];
  } else if (surf.kind === 'cone') {
    const k = Math.sin(surf.al), ta = Math.tan(surf.al), slant = (h) => (surf.R + h * ta) / k;
    chart = (p) => { const sl = slant(p[1]), ps = p[0] * k; return [sl * Math.cos(ps), sl * Math.sin(ps)]; };
    unchart = (c) => { const sl = Math.hypot(c[0], c[1]); let ps = Math.atan2(c[1], c[0]); return [ps / k, (sl * k - surf.R) / ta]; };
    if (around) closeThroughApex = true;
  } else if (surf.kind === 'sph' && around) {
    const north = (wind > 0) === same; // interior to the left of the travel direction, seen from outside
    chart = (p) => { const c = north ? Math.PI / 2 - p[1] : p[1] + Math.PI / 2; return [surf.R * c * Math.cos(p[0]), surf.R * c * Math.sin(p[0])]; };
    unchart = (c) => { const col = Math.hypot(c[0], c[1]) / surf.R; return [Math.atan2(c[1], c[0]), north ? Math.PI / 2 - col : col - Math.PI / 2]; };
    spacing = surf.R * 0.1;
  } else {
    const mid = refV, sc = surf.kind === 'sph' ? [surf.R * Math.max(Math.cos(mid), 0.05), surf.R] : [surf.R + surf.r * Math.cos(mid), surf.r];
    chart = (p) => [p[0] * sc[0], p[1] * sc[1]]; unchart = (c) => [c[0] / sc[0], c[1] / sc[1]];
    spacing = (surf.kind === 'sph' ? surf.R : surf.r) * 0.1;
  }
  const ouvClosed = closeThroughApex ? [...ouv, [ouv[0][0] + (wind > 0 ? TAU : -TAU), ouv[0][1]]] : ouv; // a cone's loop ends back at its start one turn later
  let outerC = ouvClosed.map(chart);
  const holesC = shifted.map((h) => h.map(chart));
  if (closeThroughApex) outerC = [...outerC, [0, 0]]; // the surface is only a sector of the flattened cone: its edge runs through the apex
  const dl = delaunayRegion(outerC, holesC, spacing);
  let P3, tris;
  const nBoundary = outerC.length + holesC.reduce((n, h) => n + h.length, 0);
  const mapBack = (c) => { const q = unchart(c); return surf.point(q[0], q[1]); };
  if (dl) { P3 = dl.pts.map((c, i) => (closeThroughApex && i === outerC.length - 1 ? surf.point(0, surf.apexH) : mapBack(c))); tris = dl.tris; }
  else {
    tris = earcut2D(outerC, holesC);
    P3 = [...outerC, ...holesC.flat()].map((c, i) => (closeThroughApex && i === outerC.length - 1 ? surf.point(0, surf.apexH) : mapBack(c)));
    step.notes.add('some curved faces were approximated coarsely');
  }
  void nBoundary; void loopsUV; void surfEnt;
  for (const [i, j, k] of tris) {
    const p = P3[i], q = P3[j], r = P3[k], c = scl(add(add(p, q), r), 1 / 3);
    const n0 = surf.normal(c);
    addTri(p, q, r, same ? n0 : scl(n0, -1));
  }
  return out;
}

// ---------------------------------------------------------------- entry point
/** Read a STEP file into [{ name, soup, notes }] (one entry per solid, or one for all loose faces). */
export function parseSTEP(text) {
  const st = new Step(text);
  const faceCache = new Map();
  const faceTris = (ref) => {
    if (faceCache.has(ref.ref)) return faceCache.get(ref.ref);
    const x = st.get(ref);
    let t = [];
    if (x && (x.type === 'ADVANCED_FACE' || x.type === 'FACE_SURFACE')) t = triangulateFace(st, x) || [];
    else if (x && (x.type === 'FACE')) t = faceFromPolyLoops(st, x);
    faceCache.set(ref.ref, t);
    return t;
  };
  const shellFaces = (shRef) => { const sh = st.get(shRef); if (!sh) return []; const refs = sh.type === 'ORIENTED_CLOSED_SHELL' ? st.args(sh.args[2], 'CLOSED_SHELL')?.[1] || [] : sh.args[1] || []; return sh.type === 'ORIENTED_CLOSED_SHELL' && sh.args[3] === '.F.' ? flipAll(refs.flatMap((r) => faceTris(r))) : refs.flatMap((r) => faceTris(r)); };
  const solids = [];
  for (const [id, x] of st.e) {
    if (x.type === 'MANIFOLD_SOLID_BREP' || x.type === 'FACETED_BREP') solids.push({ id, name: x.args[0]?.s, tris: shellFaces(x.args[1]) });
    else if (x.type === 'BREP_WITH_VOIDS') solids.push({ id, name: x.args[0]?.s, tris: [...shellFaces(x.args[1]), ...x.args[2].flatMap((v) => flipAll(shellFaces(v)))] });
  }
  if (!solids.length) { // no solids: use every face found
    const all = [];
    for (const [id, x] of st.e) if (x.type === 'ADVANCED_FACE' || x.type === 'FACE_SURFACE') all.push(...faceTris({ ref: id }));
    if (all.length) solids.push({ id: 0, name: 'STEP', tris: all });
  }
  const list = solids.filter((s) => s.tris.length).map((s) => ({ name: s.name && s.name !== '' ? s.name : 'STEP', soup: Float32Array.from(s.tris, (v) => v * st.scale), notes: [] }));
  if (!list.length) throw new Error('No solid geometry found in this STEP file');
  const notes = [...st.notes];
  if (st.skipped) notes.unshift(`${st.skipped} face${st.skipped > 1 ? 's' : ''} with free-form (B-spline) surfaces could not be read; the gap is closed flat`);
  list[0].notes = notes;
  return list;
}
const flipAll = (t) => { const o = []; for (let i = 0; i < t.length; i += 9) o.push(t[i], t[i + 1], t[i + 2], t[i + 6], t[i + 7], t[i + 8], t[i + 3], t[i + 4], t[i + 5]); return o; };

/** FACE with POLY_LOOP bounds (the faceted solids Sketchy writes). */
function faceFromPolyLoops(step, x) {
  const loops = step.faceLoops([null, x.args[1]]);
  if (!loops.length) return [];
  const outer = loops.find((l) => l.outer) || loops[0], holes = loops.filter((l) => l !== outer);
  // plane from the outer loop (Newell)
  let n = [0, 0, 0];
  for (let i = 0; i < outer.pts.length; i++) { const p = outer.pts[i], q = outer.pts[(i + 1) % outer.pts.length]; n = add(n, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); }
  n = unit(n);
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], u = unit(cross(ax, n)), v = cross(n, u), o = outer.pts[0];
  const to2 = (l) => l.pts.map((p) => { const d = sub(p, o); return [dot(d, u), dot(d, v)]; });
  const all = [outer, ...holes].flatMap((l) => l.pts), res = [];
  for (const [i, j, k] of earcut2D(to2(outer), holes.map(to2))) {
    const p = all[i], q = all[j], r = all[k], m = cross(sub(q, p), sub(r, p));
    if (len(m) < 1e-14) continue;
    res.push(...(dot(m, n) < 0 ? [...p, ...r, ...q] : [...p, ...q, ...r]));
  }
  return res;
}
