// A small geometry service for add-ins: it builds a tree of solids (primitives, transforms, booleans, extrusions) with the same
// exact kernel the app uses (OpenCascade through replicad) and returns plain triangle meshes. An add-in never touches the kernel;
// it describes the shape as JSON and asks for it (sketchy.geometry.build), so an add-in can be pure JavaScript with no 3D library.
//
// Node types (all lengths in mm; matrices are 4 x 4, row-major, applied to column vectors):
//   3D  { t:'cube', size:[x,y,z], center }  { t:'sphere', r, fn }  { t:'cylinder', h, r1, r2, center, fn }  { t:'polyhedron', points, faces }
//       { t:'union'|'difference'|'intersection', c:[...] }  { t:'transform', m, c:[node] }  { t:'hull', c:[...] }  { t:'minkowski', c:[...] }
//       { t:'linear_extrude', h, center, twist, slices, scale:[sx,sy], c:[2D nodes] }  { t:'rotate_extrude', angle, fn, c:[2D nodes] }
//   2D  { t:'square', size:[x,y], center }  { t:'circle', r, fn }  { t:'polygon', points, paths }  { t:'offset', r|delta, chamfer, fn, c:[...] }
//       union / difference / intersection / transform / hull work on 2D nodes too
//
// Spheres, cylinders and circles are exact surfaces ($fn does not facet them). Hulls, polyhedra, minkowski sums and transforms that
// stretch (non-uniform scale, shear) are built from triangles and come out as faceted solids: OpenCascade has no exact form for them.
import { sewMesh, weldSoup } from './sew.js';
import { hull2D, hull3D } from './hull.js';
import { outlinesOf, areaOf } from './sketch-brep.js';
import { shapeMesh } from './backend-brep.js';

export const LIMITS = { nodes: 20000, depth: 60, points: 400000, faces: 400000, segments: 720 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (v, n, what) => { if (!Array.isArray(v) || v.length !== n || !v.every(isNum)) throw new Error(`${what} must be a list of ${n} numbers`); return v; };

/** Is this node 2D? (A transform, boolean or hull takes the dimension of its first child.) */
export function dimOf(n) {
  if (['square', 'circle', 'polygon', 'offset'].includes(n.t)) return 2;
  if (['union', 'difference', 'intersection', 'hull', 'transform'].includes(n.t)) return n.c?.length ? dimOf(n.c[0]) : 3;
  return 3;
}

/**
 * @param R  replicad (the exact kernel), loaded
 * @param tree  the root node (or a list of nodes, joined as a union)
 * @returns { verts: Float32Array, tris: Uint32Array, volume } for a 3D result, or null when the tree makes nothing
 */
export function buildTree(R, tree, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const live = []; // everything created along the way, freed at the end
  const keep = (o) => { live.push(o); return o; };
  let count = 0;
  const EMPTY3 = { dim: 3, empty: true };
  // OpenSCAD makes round things from n-sided polygons, and models rely on it (a hexagonal nut is a cylinder with $fn=6). Up to
  // FACET_MAX sides we build the polygon; above that the surface is smooth for every practical purpose and becomes exact.
  const FACET_MAX = 128, SPHERE_FACET_MAX = 24;
  const seg = (fn, r) => Math.max(3, Math.min(L.segments, Math.round(fn > 0 ? fn : Math.max(5, Math.min(360 / 12, (2 * Math.PI * (r || 1)) / 2)))));
  const ring = (r, z, k) => Array.from({ length: k }, (_, j) => [r * Math.cos((2 * Math.PI * j) / k), r * Math.sin((2 * Math.PI * j) / k), z]);

  const polys = (pts, paths) => {
    if (!Array.isArray(pts) || pts.length > L.points || !pts.every((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]))) throw new Error('polygon points must be a list of [x, y]');
    const loops = paths?.length ? paths : [pts.map((_, i) => i)];
    return loops.map((lp) => lp.map((i) => { const p = pts[i]; if (!p) throw new Error('polygon path refers to a point that does not exist'); return [p[0], p[1]]; }));
  };
  const polygonDrawing = (pl) => { let pen = R.draw(pl[0]); for (let i = 1; i < pl.length; i++) pen = pen.lineTo(pl[i]); return keep(pen.close()); };
  const area2 = (d) => areaOf(R, d, keep);
  const dunion = (list) => list.reduce((a, b) => keep(a.fuse(b)));
  const ddiff = (a, b) => (area2(keep(a.intersect(b))) > 1e-9 ? keep(a.cut(b)) : a); // cutting what lies in a hole of the shape returns the shape and the cutter together
  const dintersect = (a, b) => keep(a.intersect(b));

  const tidy = (s) => { try { return s.simplify(); } catch { return s; } };
  const fuse3 = (a, b) => keep(tidy(keep(a.fuse(b))));
  const cut3 = (a, b) => keep(tidy(keep(a.cut(b))));
  const int3 = (a, b) => keep(tidy(keep(a.intersect(b))));
  const solidFromTriangles = (verts, tris) => { // faceted: merge coplanar triangles into faces and sew
    const soup = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => t.forEach((v, k) => { soup[i * 9 + k * 3] = verts[v][0]; soup[i * 9 + k * 3 + 1] = verts[v][1]; soup[i * 9 + k * 3 + 2] = verts[v][2]; }));
    const w = weldSoup(soup);
    return sewMesh(R, w.verts, w.tris, { track: keep, maxFaces: 100000 }).solid;
  };
  const pointsOf = (shape) => { const me = shapeMesh(shape), out = []; for (let i = 0; i < me.verts.length; i += 3) out.push([me.verts[i], me.verts[i + 1], me.verts[i + 2]]); return out; };
  const revolveProfile = (pts) => { // a polygon of [radius, z] revolved about Z
    let pen = R.draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return keep(keep(keep(pen.close()).sketchOnPlane(keep(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])))).revolve([0, 0, 1], { origin: [0, 0, 0] }));
  };
  const trsf = (shape, m) => { // rotation, uniform scale and translation (the rows of m)
    const oc = R.getOC(), t = new oc.gp_Trsf();
    t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
    const x = new oc.BRepBuilderAPI_Transform(shape.wrapped, t, true);
    const out = keep(R.cast(x.Shape())); x.delete(); t.delete();
    return out;
  };
  const similarity = (m) => { // a rotation (maybe mirrored) times one scale factor: the only transforms that keep surfaces exact
    const cols = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]], n = cols.map((c) => Math.hypot(...c)), s = n[0];
    if (!(s > 1e-12) || n.some((v) => Math.abs(v - s) > 1e-9 * Math.max(1, s))) return null;
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (Math.abs(dt(cols[0], cols[1])) > 1e-9 * s * s || Math.abs(dt(cols[0], cols[2])) > 1e-9 * s * s || Math.abs(dt(cols[1], cols[2])) > 1e-9 * s * s) return null;
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    return { s, mirrored: det < 0 };
  };

  /** Build a node; returns { dim, o } where o is a shape (3) or a drawing (2). */
  const build = (n, depth) => {
    if (!n || typeof n !== 'object') throw new Error('Bad geometry node');
    if (++count > L.nodes) throw new Error(`That is more than ${L.nodes} shapes; simplify it`);
    if (depth > L.depth) throw new Error('Shapes are nested too deeply');
    const kids = () => (n.c || []).map((c) => build(c, depth + 1));
    const empty2 = { dim: 2, empty: true };
    switch (n.t) {
      case 'cube': {
        const s = vec(n.size, 3, 'cube size');
        if (s.some((v) => v <= 0)) return EMPTY3;
        const o = n.center ? s.map((v) => -v / 2) : [0, 0, 0];
        return { dim: 3, o: keep(R.makeBox(o, o.map((v, k) => v + s[k]))) };
      }
      case 'sphere': {
        if (!(n.r > 0)) return EMPTY3;
        const k = seg(n.fn, n.r);
        if (k > SPHERE_FACET_MAX) return { dim: 3, o: keep(R.makeSphere(n.r)) };
        const rings = Math.floor((k + 1) / 2), pts = [];
        for (let i = 0; i < rings; i++) { const phi = (Math.PI * (i + 0.5)) / rings; pts.push(...ring(n.r * Math.sin(phi), n.r * Math.cos(phi), k)); }
        const h = hull3D(pts);
        return { dim: 3, o: solidFromTriangles(h.verts, h.tris) };
      }
      case 'cylinder': {
        const h = +n.h, r1 = Math.max(+n.r1, 0), r2 = Math.max(n.r2 === undefined ? +n.r1 : +n.r2, 0);
        if (!(h > 0) || (!(r1 > 0) && !(r2 > 0))) return EMPTY3;
        const k = seg(n.fn, Math.max(r1, r2));
        let o;
        if (k <= FACET_MAX) { const hh = hull3D([...(r1 > 0 ? ring(r1, 0, k) : [[0, 0, 0]]), ...(r2 > 0 ? ring(r2, h, k) : [[0, 0, h]])]); o = solidFromTriangles(hh.verts, hh.tris); }
        else o = revolveProfile([[0, 0], ...(r1 > 0 ? [[r1, 0]] : []), ...(r2 > 0 ? [[r2, h]] : []), [0, h]]);
        if (n.center) o = keep(o.translate([0, 0, -h / 2]));
        return { dim: 3, o };
      }
      case 'polyhedron': {
        const P = n.points, F = n.faces;
        if (!Array.isArray(P) || !Array.isArray(F) || P.length > L.points || F.length > L.faces) throw new Error('polyhedron is too big or malformed');
        P.forEach((p) => vec(p, 3, 'polyhedron point'));
        const tri = [];
        for (const f of F) { // OpenSCAD lists faces clockwise seen from outside; triangulate each as a fan and flip to counter-clockwise
          if (!Array.isArray(f) || f.length < 3) continue;
          for (let k = 1; k < f.length - 1; k++) tri.push([f[0], f[k + 1], f[k]]);
        }
        if (tri.some((t) => t.some((i) => !Number.isInteger(i) || i < 0 || i >= P.length))) throw new Error('polyhedron face refers to a point that does not exist');
        return { dim: 3, o: solidFromTriangles(P, tri) };
      }
      case 'square': {
        const s = vec(n.size, 2, 'square size');
        if (s.some((v) => v <= 0)) return empty2;
        const x = n.center ? -s[0] / 2 : 0, y = n.center ? -s[1] / 2 : 0;
        return { dim: 2, o: polygonDrawing([[x, y], [x + s[0], y], [x + s[0], y + s[1]], [x, y + s[1]]]) };
      }
      case 'circle': {
        if (!(n.r > 0)) return empty2;
        const k = seg(n.fn, n.r);
        return { dim: 2, o: k <= FACET_MAX ? polygonDrawing(ring(n.r, 0, k).map((p) => [p[0], p[1]])) : keep(R.drawCircle(n.r)) };
      }
      case 'polygon': {
        const loops = polys(n.points, n.paths); // OpenSCAD fills the first loop and cuts the others out (even-odd)
        let d = polygonDrawing(loops[0]);
        for (const lp of loops.slice(1)) d = ddiff(d, polygonDrawing(lp));
        return { dim: 2, o: d };
      }
      case 'union': case 'difference': case 'intersection': {
        const k = kids();
        const live0 = k.filter((x) => x && !x.empty);
        if (!k.length) return EMPTY3;
        const dim = k[0].dim, same = k.filter((x) => x.dim === dim);
        if (n.t === 'union') {
          const parts = same.filter((x) => !x.empty).map((x) => x.o);
          if (!parts.length) return { dim, empty: true };
          return { dim, o: parts.length === 1 ? parts[0] : dim === 2 ? dunion(parts) : parts.reduce((a, b) => fuse3(a, b)) };
        }
        if (same[0].empty) return { dim, empty: true };
        let acc = same[0].o;
        for (const x of same.slice(1)) {
          if (n.t === 'difference') { if (x.empty) continue; acc = dim === 2 ? ddiff(acc, x.o) : cut3(acc, x.o); }
          else { if (x.empty) return { dim, empty: true }; acc = dim === 2 ? dintersect(acc, x.o) : int3(acc, x.o); }
        }
        void live0;
        return { dim, o: acc };
      }
      case 'transform': {
        const k = kids().filter((x) => !x.empty);
        if (!k.length) return { dim: dimOf(n), empty: true };
        const m = vec(n.m, 16, 'a transform matrix'), dim = k[0].dim, parts = k.filter((x) => x.dim === dim).map((x) => x.o);
        const one = parts.length === 1 ? parts[0] : dim === 2 ? dunion(parts) : parts.reduce((a, b) => fuse3(a, b));
        if (dim === 3) {
          const sim = similarity(m);
          if (sim) { // exact: mirror first when the matrix turns space inside out, then the proper rotation, scale and shift
            let sh = one, mm = m;
            if (sim.mirrored) { sh = keep(sh.clone().mirror('YZ', [0, 0, 0])); mm = [-m[0], m[1], m[2], m[3], -m[4], m[5], m[6], m[7], -m[8], m[9], m[10], m[11]]; }
            return { dim, o: trsf(sh, mm) };
          }
          const me = shapeMesh(one), V = [];
          for (let i = 0; i < me.verts.length; i += 3) { const x = me.verts[i], y = me.verts[i + 1], z = me.verts[i + 2]; V.push([m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]); }
          const T = []; for (let i = 0; i < me.tris.length; i += 3) T.push([me.tris[i], me.tris[i + 1], me.tris[i + 2]]);
          const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
          return { dim, o: solidFromTriangles(V, det < 0 ? T.map(([a, b, c]) => [a, c, b]) : T) };
        }
        // 2D: a rotation with one scale (and maybe a mirror) stays exact, anything else goes through the outline points
        const a = m[0], b = m[1], c = m[4], d = m[5], tx = m[3], ty = m[7], det = a * d - b * c, s = Math.sqrt(Math.abs(det));
        const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
        if (s > 1e-12 && Math.abs(sx - s) < 1e-9 * Math.max(1, s) && Math.abs(sy - s) < 1e-9 * Math.max(1, s) && Math.abs(a * b + c * d) < 1e-9 * s * s) {
          let o = one;
          if (det < 0) { o = keep(o.mirror([1, 0], [0, 0], 'plane')); } // flip y about the x axis, then turn and scale
          const ang = (Math.atan2(det < 0 ? -c : c, det < 0 ? a : a) * 180) / Math.PI;
          o = keep(o.scale(s, [0, 0])); o = keep(o.rotate(det < 0 ? (Math.atan2(c, a) * 180) / Math.PI : ang, [0, 0])); o = keep(o.translate(tx, ty));
          return { dim, o };
        }
        const sk = keep(one.sketchOnPlane('XY')), loops = [];
        for (const piece of sk.sketches || [sk]) outlinesOf(R, keep(piece.face()), keep).forEach((pl, i) => loops.push({ pl: pl.map(([x, y]) => [a * x + b * y + tx, c * x + d * y + ty]), hole: i > 0 }));
        let res = null;
        for (const lp of loops.filter((q) => !q.hole)) res = res ? dunion([res, polygonDrawing(lp.pl)]) : polygonDrawing(lp.pl);
        for (const lp of loops.filter((q) => q.hole)) res = ddiff(res, polygonDrawing(lp.pl));
        return { dim, o: res };
      }
      case 'hull': {
        const k = kids().filter((x) => !x.empty);
        if (!k.length) return { dim: dimOf(n), empty: true };
        const dim = k[0].dim;
        if (dim === 2) {
          const pts = [];
          for (const x of k) { const sk = keep(x.o.sketchOnPlane('XY')); for (const piece of sk.sketches || [sk]) outlinesOf(R, keep(piece.face()), keep)[0].forEach((p) => pts.push(p)); }
          const h = hull2D(pts);
          return h.length >= 3 ? { dim, o: polygonDrawing(h) } : { dim, empty: true };
        }
        const pts = k.flatMap((x) => pointsOf(x.o)), h = hull3D(pts);
        return h ? { dim, o: solidFromTriangles(h.verts, h.tris) } : EMPTY3;
      }
      case 'minkowski': {
        const k = kids().filter((x) => !x.empty);
        if (k.length < 1) return EMPTY3;
        let acc = k[0].o;
        for (let i = 1; i < k.length; i++) {
          const A = acc, B = k[i].o, pa = pointsOf(A), pb = pointsOf(B), sum = (pp) => pp.flatMap((p) => pb.map((q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]]));
          const hb = hull3D(pb), ha = hull3D(pa);
          if (!hb) throw new Error('minkowski needs a solid second shape');
          const volOf = (h) => { let v = 0; for (const [x, y, z] of h.tris) { const a = h.verts[x], b = h.verts[y], c = h.verts[z]; v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } return v; };
          if (Math.abs(volOf(hb) - shapeMesh(B).volume) > 0.02 * Math.abs(volOf(hb))) throw new Error('minkowski needs a convex second shape');
          if (ha && Math.abs(volOf(ha) - shapeMesh(A).volume) <= 0.02 * Math.abs(volOf(ha))) { // both convex: the hull of every sum of two points
            const h = hull3D(sum(pa)); acc = solidFromTriangles(h.verts, h.tris);
          } else { // the shape itself plus the sweep of the second shape over its surface, triangle by triangle
            const me = shapeMesh(A);
            if (me.tris.length / 3 > 2000) throw new Error('minkowski of a complex shape is too big; simplify it');
            const parts = [A];
            for (let t = 0; t < me.tris.length; t += 3) {
              const tri = [0, 1, 2].map((q) => [me.verts[me.tris[t + q] * 3], me.verts[me.tris[t + q] * 3 + 1], me.verts[me.tris[t + q] * 3 + 2]]);
              const h = hull3D(tri.flatMap((p) => pb.map((q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]])));
              if (h) parts.push(solidFromTriangles(h.verts, h.tris));
            }
            acc = parts.reduce((a, b) => fuse3(a, b));
          }
        }
        return { dim: 3, o: acc };
      }
      case 'offset': {
        const k = kids().filter((x) => !x.empty); if (!k.length) throw new Error('offset needs a 2D shape');
        const cs = k.length === 1 ? k[0].o : dunion(k.map((x) => x.o));
        const d = n.delta !== undefined ? +n.delta : +n.r || 0, join = n.delta !== undefined ? (n.chamfer ? 'bevel' : 'miter') : 'round';
        return { dim: 2, o: keep(cs.offset(d, { lineJoinType: join })) };
      }
      case 'linear_extrude': {
        const k = kids().filter((x) => x.dim === 2 && !x.empty); if (!k.length) throw new Error('linear_extrude needs a 2D shape');
        const cs = k.length === 1 ? k[0].o : dunion(k.map((x) => x.o));
        const h = +n.h; if (!(h > 0)) return EMPTY3;
        const tw = +n.twist || 0, sc = n.scale === undefined ? [1, 1] : Array.isArray(n.scale) ? n.scale : [n.scale, n.scale];
        let m;
        if (sc[0] === sc[1]) {
          const sk = keep(cs.sketchOnPlane('XY')), pieces = (sk.sketches || [sk]).map((p) => keep(p.extrude(h, tw || sc[0] !== 1 ? { twistAngle: -tw, extrusionProfile: { profile: 'linear', endFactor: sc[0] } } : {})));
          m = pieces.length === 1 ? pieces[0] : pieces.reduce((a, b) => fuse3(a, b));
        } else { // stretched differently in x and y: a ruled loft between the shape and its stretched copy
          if (tw) throw new Error('linear_extrude cannot combine a twist with different x and y scales');
          const top = keep(keep(cs.stretch(sc[0], [1, 0], [0, 0])).stretch(sc[1], [0, 1], [0, 0]));
          const a = keep(cs.sketchOnPlane('XY')), b = keep(top.sketchOnPlane('XY', h));
          m = keep((a.sketches ? a.sketches[0] : a).loftWith(b.sketches ? b.sketches[0] : b, { ruled: true }));
        }
        if (n.center) m = keep(m.translate([0, 0, -h / 2]));
        return { dim: 3, o: m };
      }
      case 'rotate_extrude': {
        const k = kids().filter((x) => x.dim === 2 && !x.empty); if (!k.length) throw new Error('rotate_extrude needs a 2D shape');
        const cs = k.length === 1 ? k[0].o : dunion(k.map((x) => x.o));
        const sk = keep(cs.sketchOnPlane(keep(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])))), ang = n.angle === undefined ? 360 : n.angle;
        const pieces = (sk.sketches || [sk]).map((p) => keep(p.revolve([0, 0, 1], { origin: [0, 0, 0], ...(ang < 360 ? { angle: ang } : {}) })));
        return { dim: 3, o: pieces.length === 1 ? pieces[0] : pieces.reduce((a, b) => fuse3(a, b)) };
      }
      default: throw new Error(`Unknown geometry node "${String(n.t).slice(0, 30)}"`);
    }
  };

  try {
    const root = Array.isArray(tree) ? { t: 'union', c: tree } : tree;
    const r = build(root, 0);
    if (r.dim !== 3 || r.empty) return null;
    const me = shapeMesh(r.o);
    if (!me.tris.length) return null;
    return { verts: Float32Array.from(me.verts), tris: Uint32Array.from(me.tris), volume: me.volume };
  } finally {
    for (const o of live.reverse()) { try { o.delete(); } catch { /* already freed */ } }
  }
}
