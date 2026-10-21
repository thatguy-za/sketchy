// Sketch regions ("profiles") on the exact kernel: every closed area bounded by the sketch shapes is its own selectable region, as in
// most CAD tools. This is profileCells() of kernel.js done with exact 2D booleans on OpenCascade drawings instead of polygon clipping,
// so circles and arcs stay circles and arcs. The ids ("0.1:0": the shapes a region lies in, then its number) and the default
// selection (nested shapes alternate: a circle inside a rectangle is a hole; partial overlaps all count) are the same as before.
// Every OpenCascade object made here is passed to `track`, which frees it when the caller is done.
import { shapeToPolygon } from './kernel.js';

const isSolid = (sh) => !sh.lt && sh.t !== 'point';

/** A fit-point spline is stored as the points of its curve (see fitSpline in sketchedit.js). */
export const isSplineShape = (s, pts = s.pts) => !!s.spline && pts.length >= 4 && pts.every((q) => !q[2]);
/**
 * Continue `pen` along the curve through `pts` as smooth cubic pieces, about one per 14 samples (the spacing fitSpline uses), ending at
 * `end`. The tangent at each knot is the direction of the curve there, so the pieces join smoothly and follow the sampled curve closely.
 */
function splineTo(pen, pts, end) {
  const n = pts.length, K = 14, spans = Math.max(1, Math.round((n - 1) / K));
  const knot = (i) => Math.round((i * (n - 1)) / spans);
  const tan = (i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  for (let k = 0; k < spans; k++) {
    const i0 = knot(k), i1 = knot(k + 1), P0 = pts[i0], P1 = k === spans - 1 ? end : pts[i1], t0 = tan(i0), t1 = tan(i1);
    const d = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) / 3;
    pen = pen.cubicBezierCurveTo([P1[0], P1[1]], [P0[0] + t0[0] * d, P0[1] + t0[1] * d], [P1[0] - t1[0] * d, P1[1] - t1[1] * d]);
  }
  return pen;
}

/** Closed shapes drawn from open lines and arcs that meet end to end, as exact drawings. */
export function openLoopDrawings(R, shapes, track) {
  const segs = [];
  for (const s of shapes) {
    if (s.t !== 'path' || !s.open) continue;
    if (isSplineShape(s)) { segs.push({ a: s.pts[0], b: s.pts.at(-1), bulge: 0, curve: s.pts }); continue; } // a fit-point spline is one edge, not its sample segments
    for (let i = 0; i < s.pts.length - 1; i++) segs.push({ a: s.pts[i], b: s.pts[i + 1], bulge: s.pts[i][2] || 0 });
  }
  if (segs.length < 2) return [];
  const key = (p) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
  const adj = new Map();
  segs.forEach((sg, i) => { for (const k of [key(sg.a), key(sg.b)]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  const used = new Set(), out = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used.has(s0)) continue;
    const chain = [{ p0: segs[s0].a, p1: segs[s0].b, b: segs[s0].bulge, curve: segs[s0].curve }], startKey = key(segs[s0].a), idxs = [s0];
    let cur = s0, endKey = key(segs[s0].b), ok = false;
    for (let guard = 0; guard < segs.length + 2; guard++) {
      if (endKey === startKey) { ok = true; break; }
      const nb = adj.get(endKey);
      if (!nb || nb.length !== 2) break;
      const nx = nb[0] === cur ? nb[1] : nb[0];
      if (idxs.includes(nx)) break;
      const sg = segs[nx];
      chain.push(key(sg.a) === endKey ? { p0: sg.a, p1: sg.b, b: sg.bulge, curve: sg.curve } : { p0: sg.b, p1: sg.a, b: -sg.bulge, curve: sg.curve && [...sg.curve].reverse() });
      idxs.push(nx); cur = nx;
      endKey = key(chain.at(-1).p1);
    }
    if (!ok || chain.length < 2) continue;
    idxs.forEach((i) => used.add(i));
    let pen = R.draw([chain[0].p0[0], chain[0].p0[1]]);
    chain.forEach((c, i) => {
      const end = i === chain.length - 1 ? chain[0].p0 : c.p1; // the last segment ends exactly where the first began
      pen = c.curve ? splineTo(pen, c.curve, end) : Math.abs(c.b) > 1e-9 ? pen.bulgeArcTo([end[0], end[1]], c.b) : pen.lineTo([end[0], end[1]]);
    });
    out.push(track(pen.close()));
  }
  return out;
}

const pieces = (d, track) => { const sk = track(d.sketchOnPlane('XY')); return (sk.sketches ? sk.sketches : [sk]).map((s) => track(s)); };
/** Area of a drawing (all its pieces). */
export function areaOf(R, d, track) { try { return pieces(d, track).reduce((t, s) => t + R.measureArea(track(s.face())), 0); } catch { return 0; } }

/**
 * The regions of a sketch: [{ id, sig, defaultOn, face (planar, in the sketch's own x, y), area }]. `shapeDrawing(shape)` turns a closed
 * shape into a drawing. The regions are found by intersecting and cutting thin prisms of the shapes (a 3D boolean), not their flat
 * drawings: the 2D boolean of OpenCascade drawings loses the holes of a shape when it is cut by another one.
 */
export function profileCells(R, sk, shapeDrawing, track) {
  const shapes = sk.params.shapes || [];
  const H = 1, items = [];
  const prism = (d) => track(track(d.sketchOnPlane('XY')).extrude(H));
  const vol = (s) => { try { const v = Math.abs(R.measureVolume(s)); return Number.isFinite(v) ? v : 0; } catch { return 0; } };
  const add = (i, d) => { const area = areaOf(R, d, track); if (area > 1e-9) { const ps = prism(d); items.push({ i, d, area, s: ps, v0: vol(ps) }); } }; // v0: the volume is taken now, later booleans can disturb the solid
  shapes.forEach((s, i) => {
    if (s.open || !isSolid(s)) return;
    if (shapeToPolygon(s).length < 3) return;
    const d = shapeDrawing(s);
    if (d) add(i, track(d));
  });
  openLoopDrawings(R, shapes.filter(isSolid), track).forEach((d, k) => add(1000 + k, d));
  const eps = (a) => Math.max(1e-7, 1e-7 * a);
  let cells = [];
  const solidOf = (f) => { try { return track(f()); } catch { return null; } };
  for (const { i, s: prismS, area, v0 } of items) {
    const next = [], overlapped = [];
    let shared = 0; // the volume this shape shares with the regions found so far (they do not overlap each other)
    for (const c of cells) {
      const inter = solidOf(() => c.s.intersect(prismS)), iv = inter ? vol(inter) : 0;
      if (iv > eps(area)) { next.push({ sig: [...c.sig, i], s: inter, vol: iv }); shared += iv; overlapped.push(c); }
      if (iv <= eps(area)) next.push(c);
      else { const diff = solidOf(() => c.s.cut(prismS)), dv = diff ? vol(diff) : 0; if (dv > eps(c.vol)) next.push({ sig: c.sig, s: diff, vol: dv }); }
    }
    if (v0 - shared > eps(area)) { // part of this shape lies outside every earlier shape: its own region
      let rest = prismS;
      for (const c of overlapped) { const r2 = solidOf(() => rest.cut(c.s)); if (r2) rest = r2; }
      const rv = vol(rest);
      if (rv > eps(area)) next.push({ sig: [i], s: rest, vol: rv });
    }
    cells = next;
  }
  const byIdx = new Map(items.map((x) => [x.i, x]));
  const nested = (sig) => {
    const sh = sig.map((i) => byIdx.get(i)).sort((a, b) => b.area - a.area);
    for (let k = 1; k < sh.length; k++) if (Math.abs(areaOf(R, track(sh[k].d.intersect(sh[k - 1].d)), track) - sh[k].area) > 1e-6 * sh[k].area) return false;
    return true;
  };
  const out = [];
  for (const c of cells) {
    const defaultOn = c.sig.length < 2 || !nested(c.sig) || c.sig.length % 2 === 1;
    const found = [];
    for (const part of c.s.solids) { // one solid per connected region; its top face is the region
      track(part);
      const top = part.faces.map(track).find((f) => { const n = f.normalAt(); return n.z > 0.999 && Math.abs(f.center.z - H) < 1e-6; });
      if (top && R.measureArea(top) > eps(c.vol)) found.push(top);
    }
    found.map((face) => ({ face, lo: face.boundingBox.bounds[0] })).sort((a, b) => a.lo[0] - b.lo[0] || a.lo[1] - b.lo[1])
      .forEach(({ face }, k) => out.push({ id: `${c.sig.join('.')}:${k}`, sig: c.sig, defaultOn, face, area: R.measureArea(face) }));
  }
  return out;
}

/** One region as a drawing again (the outer boundary with its holes cut out), ready to be put on a plane and extruded or revolved. */
export function regionDrawing(R, face, track) {
  // drawFaceOutline draws the outline about its own centre, so move it back to where the face is
  const placed = (f) => {
    const d = track(R.drawFaceOutline(f)), fb = f.boundingBox.bounds, db = d.boundingBox.bounds;
    return track(d.translate((fb[0][0] + fb[1][0]) / 2 - (db[0][0] + db[1][0]) / 2, (fb[0][1] + fb[1][1]) / 2 - (db[0][1] + db[1][1]) / 2));
  };
  let d = placed(track(R.makeFace(track(face.clone().outerWire()))));
  for (const w of face.clone().innerWires()) d = track(d.cut(placed(track(R.makeFace(track(w))))));
  return d;
}

/** The outline of a planar region as polygons for drawing: the outer boundary counter-clockwise, then each hole clockwise. */
export function outlinesOf(R, face, track) {
  const wires = [track(face.clone().outerWire()), ...face.clone().innerWires().map(track)];
  return wires.map((w, wi) => {
    const edges = w.edges.map((e) => { const n = e.geomType === 'LINE' ? 1 : 24, p = []; for (let k = 0; k <= n; k++) { const q = e.pointAt(k / n); p.push([q.x, q.y]); } return p; });
    let cur = edges.shift();
    const ordered = [...cur.slice(0, -1)]; // edges of a wire come in order but each may run against the wire's direction: stitch by the nearest end
    while (edges.length) {
      const end = cur.at(-1);
      let bi = 0, br = false, bd = Infinity;
      edges.forEach((p, i) => { const d0 = Math.hypot(p[0][0] - end[0], p[0][1] - end[1]), d1 = Math.hypot(p.at(-1)[0] - end[0], p.at(-1)[1] - end[1]); if (d0 < bd) { bd = d0; bi = i; br = false; } if (d1 < bd) { bd = d1; bi = i; br = true; } });
      cur = edges.splice(bi, 1)[0];
      if (br) cur = [...cur].reverse();
      ordered.push(...cur.slice(0, -1));
    }
    let a = 0;
    for (let i = 0; i < ordered.length; i++) { const [x1, y1] = ordered[i], [x2, y2] = ordered[(i + 1) % ordered.length]; a += x1 * y2 - x2 * y1; }
    return (wi === 0 ? a < 0 : a > 0) ? ordered.reverse() : ordered;
  });
}
