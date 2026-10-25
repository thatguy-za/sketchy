// A small geometry service for add-ins: it builds a tree of solids (primitives, transforms, booleans, extrusions) with the same
// mesh kernel the app uses (manifold-3d) and returns plain triangle meshes. An add-in never touches the kernel;
// it describes the shape as JSON and asks for it (sketchy.geometry.build), so an add-in can be pure JavaScript with no 3D library.
//
// Node types (all lengths in mm; matrices are 4 x 4, row-major, applied to column vectors):
//   3D  { t:'cube', size:[x,y,z], center }  { t:'sphere', r, fn }  { t:'cylinder', h, r1, r2, center, fn }  { t:'polyhedron', points, faces }
//       { t:'union'|'difference'|'intersection', c:[...] }  { t:'transform', m, c:[node] }  { t:'hull', c:[...] }  { t:'minkowski', c:[...] }
//       { t:'linear_extrude', h, center, twist, slices, scale:[sx,sy], c:[2D nodes] }  { t:'rotate_extrude', angle, fn, c:[2D nodes] }
//   2D  { t:'square', size:[x,y], center }  { t:'circle', r, fn }  { t:'polygon', points, paths }  { t:'offset', r|delta, chamfer, fn, c:[...] }
//       union / difference / intersection / transform / hull work on 2D nodes too
//
// Round things are made of straight facets, as in OpenSCAD: `fn` sides (or a count worked out from the size when `fn` is 0).

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
 * @param K  the manifold-3d module, loaded and set up
 * @param tree  the root node (or a list of nodes, joined as a union)
 * @returns { verts: Float32Array, tris: Uint32Array, volume } for a 3D result, or null when the tree makes nothing
 */
export function buildTree(K, tree, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const { Manifold, CrossSection, Mesh } = K;
  const live = []; // everything created along the way, freed at the end
  const keep = (o) => { live.push(o); return o; };
  let count = 0;
  const EMPTY3 = { dim: 3, empty: true };
  // OpenSCAD makes round things from n-sided polygons, and models rely on it (a hexagonal nut is a cylinder with $fn=6).
  const seg = (fn, r) => Math.max(3, Math.min(L.segments, Math.round(fn > 0 ? fn : Math.max(5, Math.min(360 / 12, (2 * Math.PI * (r || 1)) / 2)))));

  const polys = (pts, paths) => {
    if (!Array.isArray(pts) || pts.length > L.points || !pts.every((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]))) throw new Error('polygon points must be a list of [x, y]');
    const loops = paths?.length ? paths : [pts.map((_, i) => i)];
    return loops.map((lp) => lp.map((i) => { const p = pts[i]; if (!p) throw new Error('polygon path refers to a point that does not exist'); return [p[0], p[1]]; }));
  };
  const fromTriangles = (verts, tris) => {
    let vol = 0; // signed volume: a script that lists its faces the other way round is turned the right way out
    for (const [a, b, c] of tris) { const p = verts[a], q = verts[b], r = verts[c]; vol += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]); }
    if (vol < 0) tris = tris.map(([a, b, c]) => [a, c, b]);
    const vp = new Float32Array(verts.length * 3), tv = new Uint32Array(tris.length * 3);
    verts.forEach((p, i) => vp.set(p, i * 3));
    tris.forEach((t, i) => tv.set(t, i * 3));
    const mesh = keep(new Mesh({ numProp: 3, vertProperties: vp, triVerts: tv }));
    mesh.merge(); // a polyhedron lists a corner once per face; the solid needs them joined
    const m = keep(Manifold.ofMesh(mesh));
    if (m.status && m.status() !== 'NoError') throw new Error('That shape is not a closed solid (its faces leave gaps or cross each other)');
    return m;
  };
  const union3 = (list) => (list.length === 1 ? list[0] : keep(Manifold.union(list)));
  const union2 = (list) => (list.length === 1 ? list[0] : keep(CrossSection.union(list)));
  const m4 = (m) => { const out = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c]; return out; }; // row-major in, column-major out

  /** Build a node; returns { dim, o } where o is a Manifold (3) or a CrossSection (2). */
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
        return { dim: 3, o: keep(Manifold.cube(s, !!n.center)) };
      }
      case 'sphere': {
        if (!(n.r > 0)) return EMPTY3;
        return { dim: 3, o: keep(Manifold.sphere(n.r, seg(n.fn, n.r))) };
      }
      case 'cylinder': {
        const h = +n.h, r1 = Math.max(+n.r1, 0), r2 = Math.max(n.r2 === undefined ? +n.r1 : +n.r2, 0);
        if (!(h > 0) || (!(r1 > 0) && !(r2 > 0))) return EMPTY3;
        return { dim: 3, o: keep(Manifold.cylinder(h, r1, r2, seg(n.fn, Math.max(r1, r2)), !!n.center)) };
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
        return { dim: 3, o: fromTriangles(P, tri) };
      }
      case 'square': {
        const s = vec(n.size, 2, 'square size');
        if (s.some((v) => v <= 0)) return empty2;
        return { dim: 2, o: keep(CrossSection.square(s, !!n.center)) };
      }
      case 'circle': {
        if (!(n.r > 0)) return empty2;
        return { dim: 2, o: keep(CrossSection.circle(n.r, seg(n.fn, n.r))) };
      }
      case 'polygon': {
        const loops = polys(n.points, n.paths); // OpenSCAD fills the first loop and cuts the others out (even-odd)
        return { dim: 2, o: keep(CrossSection.ofPolygons(loops, 'EvenOdd')) };
      }
      case 'union': case 'difference': case 'intersection': {
        const k = kids();
        if (!k.length) return EMPTY3;
        const dim = k[0].dim, same = k.filter((x) => x.dim === dim);
        if (n.t === 'union') {
          const parts = same.filter((x) => !x.empty).map((x) => x.o);
          if (!parts.length) return { dim, empty: true };
          return { dim, o: dim === 2 ? union2(parts) : union3(parts) };
        }
        if (same[0].empty) return { dim, empty: true };
        let acc = same[0].o;
        for (const x of same.slice(1)) {
          if (n.t === 'difference') { if (x.empty) continue; acc = keep(acc.subtract(x.o)); }
          else { if (x.empty) return { dim, empty: true }; acc = keep(acc.intersect(x.o)); }
        }
        return { dim, o: acc };
      }
      case 'transform': {
        const k = kids().filter((x) => !x.empty);
        if (!k.length) return { dim: dimOf(n), empty: true };
        const m = vec(n.m, 16, 'a transform matrix'), dim = k[0].dim, parts = k.filter((x) => x.dim === dim).map((x) => x.o);
        if (dim === 3) return { dim, o: keep(union3(parts).transform(m4(m))) };
        const a = m[0], b = m[1], c = m[4], d = m[5], tx = m[3], ty = m[7];
        return { dim, o: keep(union2(parts).transform([a, c, 0, b, d, 0, tx, ty, 1])) };
      }
      case 'hull': {
        const k = kids().filter((x) => !x.empty);
        if (!k.length) return { dim: dimOf(n), empty: true };
        const dim = k[0].dim, parts = k.filter((x) => x.dim === dim).map((x) => x.o);
        return { dim, o: keep(dim === 2 ? CrossSection.hull(parts) : Manifold.hull(parts)) };
      }
      case 'minkowski': {
        const k = kids().filter((x) => !x.empty && x.dim === 3);
        if (!k.length) return EMPTY3;
        let acc = k[0].o;
        for (const x of k.slice(1)) acc = keep(acc.minkowskiSum(x.o));
        return { dim: 3, o: acc };
      }
      case 'offset': {
        const k = kids().filter((x) => !x.empty && x.dim === 2);
        if (!k.length) throw new Error('offset needs a 2D shape');
        const d = n.delta !== undefined ? +n.delta : +n.r || 0;
        const join = n.delta !== undefined ? (n.chamfer ? 'Square' : 'Miter') : 'Round';
        return { dim: 2, o: keep(union2(k.map((x) => x.o)).offset(d, join, 2, seg(n.fn, Math.abs(d)))) };
      }
      case 'linear_extrude': {
        const k = kids().filter((x) => x.dim === 2 && !x.empty);
        if (!k.length) throw new Error('linear_extrude needs a 2D shape');
        const h = +n.h;
        if (!(h > 0)) return EMPTY3;
        const tw = +n.twist || 0, sc = n.scale === undefined ? [1, 1] : Array.isArray(n.scale) ? n.scale : [n.scale, n.scale];
        const slices = Math.max(1, Math.min(500, Math.round(+n.slices || (tw ? Math.ceil(Math.abs(tw) / 5) : sc[0] !== 1 || sc[1] !== 1 ? 1 : 0))));
        let m = keep(Manifold.extrude(union2(k.map((x) => x.o)), h, slices, -tw, sc)); // OpenSCAD twists clockwise, manifold counter-clockwise
        if (n.center) m = keep(m.translate([0, 0, -h / 2]));
        return { dim: 3, o: m };
      }
      case 'rotate_extrude': {
        const k = kids().filter((x) => x.dim === 2 && !x.empty);
        if (!k.length) throw new Error('rotate_extrude needs a 2D shape');
        const ang = n.angle === undefined ? 360 : +n.angle;
        const cs = union2(k.map((x) => x.o));
        return { dim: 3, o: keep(Manifold.revolve(cs, seg(n.fn, Math.max(1, cs.bounds().max[0])), ang)) };
      }
      default: throw new Error(`Unknown geometry node "${String(n.t).slice(0, 30)}"`);
    }
  };

  try {
    const root = Array.isArray(tree) ? { t: 'union', c: tree } : tree;
    const r = build(root, 0);
    if (r.dim !== 3 || r.empty) return null;
    const me = r.o.getMesh();
    if (!me.triVerts.length) return null;
    const np = me.numProp, verts = new Float32Array((me.vertProperties.length / np) * 3);
    for (let i = 0, n = verts.length / 3; i < n; i++) { verts[i * 3] = me.vertProperties[i * np]; verts[i * 3 + 1] = me.vertProperties[i * np + 1]; verts[i * 3 + 2] = me.vertProperties[i * np + 2]; }
    return { verts, tris: Uint32Array.from(me.triVerts), volume: r.o.volume() };
  } finally {
    for (const o of live.reverse()) { try { o.delete(); } catch { /* already freed */ } }
  }
}
