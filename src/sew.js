// Imported meshes in the exact kernel. A mesh has no surfaces, so it becomes a *faceted* solid: the triangles are welded, neighbouring
// triangles that lie in one plane are merged into one planar face (with holes where they have them), and the faces are sewn into a
// closed shell. Flat parts of a scan or an STL (boxes, slabs, brackets) come out with a few faces; a curved or organic mesh keeps
// about one face per triangle, which is why there is a limit (MAX_FACES). Above it the import is refused with a message and
// the owner of the model is told to reduce the mesh first (Reduce works on the triangles before they are sewn).
import { flatFaces } from './exporters.js';
import { pieces } from './meshtools.js';

export const MAX_FACES = 12000; // about 10 s to sew; the cost grows faster than the number of faces

/** Weld a triangle soup (9 floats per triangle) into indexed vertices; vertices closer than `tol` become one. Degenerate triangles go. */
export function weldSoup(soup, tol = 1e-4) {
  const key = (x, y, z) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
  const map = new Map(), verts = [], tris = [];
  const id = (x, y, z) => { const k = key(x, y, z); let i = map.get(k); if (i === undefined) { i = verts.length / 3; map.set(k, i); verts.push(x, y, z); } return i; };
  for (let t = 0; t < soup.length; t += 9) {
    const a = id(soup[t], soup[t + 1], soup[t + 2]), b = id(soup[t + 3], soup[t + 4], soup[t + 5]), c = id(soup[t + 6], soup[t + 7], soup[t + 8]);
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris) };
}

/**
 * Sew indexed triangles into a faceted solid, or, when the mesh has several separate pieces, into a compound of one solid per piece.
 * `R` is replicad. Throws a plain-language reason when it cannot.
 */
export function sewMesh(R, verts, tris, opts = {}) {
  const parts = pieces(tris, verts.length / 3);
  if (parts.length < 2) return sewPiece(R, verts, tris, opts);
  const results = parts.map((tl) => { const t = new Uint32Array(tl.length * 3); tl.forEach((ti, n) => { t[n * 3] = tris[ti * 3]; t[n * 3 + 1] = tris[ti * 3 + 1]; t[n * 3 + 2] = tris[ti * 3 + 2]; }); return sewPiece(R, verts, t, opts); });
  const track = opts.track || ((o) => o);
  return { solid: track(R.makeCompound(results.map((r) => r.solid))), faces: results.reduce((a, r) => a + r.faces, 0), volume: results.reduce((a, r) => a + r.volume, 0), skipped: results.reduce((a, r) => a + r.skipped, 0) };
}

function sewPiece(R, verts, tris, { maxFaces = MAX_FACES, track = (o) => o } = {}) {
  const merged = flatFaces(verts, tris);
  if (merged.length > maxFaces) throw new Error(`This mesh has ${merged.length.toLocaleString()} flat faces once neighbouring triangles are merged, more than the ${maxFaces.toLocaleString()} the exact kernel will sew into a solid. Reduce the triangle count first: import it again and choose "Import and reduce" in the Large model dialog, or use Reduce on the mesh.`);
  try { return sewFaces(R, verts, merged, track); }
  catch (e) { // some merged outlines do not sew (a face's edge meets two shorter edges of its neighbour): sew the triangles one by one instead
    if (tris.length / 3 > maxFaces * 2) throw e;
    const single = []; for (let t = 0; t < tris.length; t += 3) single.push({ loops: [[tris[t], tris[t + 1], tris[t + 2]]] });
    return sewFaces(R, verts, single, track);
  }
}
/**
 * The faces become one shell whose faces share their edges: a vertex is made once per mesh vertex and an edge once per pair of them (used
 * reversed by the face on its other side), so nothing has to be sewn afterwards. Sewing by search (weldShellsAndFaces) cost as much
 * as making the faces; this takes about a third of the time of both. A face OpenCascade will not accept as flat is cut into triangles.
 */
function sewFaces(R, verts, faces, track) {
  const oc = R.getOC(), nV = verts.length / 3, vs = new Array(nV), edges = new Map(), garbage = [];
  const own = (o) => { garbage.push(o); return o; };
  const vtx = (i) => vs[i] || (vs[i] = own(new oc.BRepBuilderAPI_MakeVertex(own(new oc.gp_Pnt(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2])))).Vertex());
  const edge = (a, b) => { // the edge between two vertices, in the direction a to b
    const lo = a < b ? a : b, hi = a < b ? b : a, key = lo * nV + hi;
    let e = edges.get(key);
    if (!e) { e = own(new oc.BRepBuilderAPI_MakeEdge(vtx(lo), vtx(hi))).Edge(); edges.set(key, e); }
    return a < b ? e : oc.TopoDS.Edge(e.Reversed());
  };
  const wireOf = (lp) => { const mw = own(new oc.BRepBuilderAPI_MakeWire()); for (let k = 0; k < lp.length; k++) mw.Add(edge(lp[k], lp[(k + 1) % lp.length])); return mw.Wire(); };
  const builder = own(new oc.TopoDS_Builder()), shell = new oc.TopoDS_Shell();
  builder.MakeShell(shell);
  let skipped = 0, made = 0;
  const add = (face) => { builder.Add(shell, face); made++; };
  try {
    for (const fc of faces) {
      const [outer, ...holes] = fc.loops;
      if (outer.length < 3) continue;
      try {
        const mf = own(new oc.BRepBuilderAPI_MakeFace(wireOf(outer), true));
        if (!mf.IsDone()) throw new Error('not flat');
        for (const h of holes) mf.Add(wireOf(h));
        add(mf.Face());
      } catch {
        if (holes.length) { skipped++; continue; }
        try { for (let k = 1; k + 1 < outer.length; k++) { const mf = own(new oc.BRepBuilderAPI_MakeFace(wireOf([outer[0], outer[k], outer[k + 1]]), true)); if (mf.IsDone()) add(mf.Face()); else skipped++; } }
        catch { skipped++; } // a degenerate sliver: the neighbours close the gap
      }
    }
    if (!made) throw new Error('The mesh has no usable triangles.');
    const welded = track(R.cast(shell));
    garbage.push(shell);
    let solid = track(R.makeSolid([welded]));
    let v = R.measureVolume(solid);
    if (v < 0) { // faces pointing inwards: turn the shell inside out
      solid = track(R.makeSolid([track(welded.flipOrientation?.() ?? welded)]));
      v = R.measureVolume(solid);
    }
    if (!(Math.abs(v) > 1e-9)) throw new Error('The mesh is not a closed solid (it has holes or loose pieces). Use Clean Mesh to weld and fill it before sewing.');
    return { solid, faces: faces.length, volume: v, skipped };
  } finally { for (const o of garbage) { try { o.delete(); } catch { /* already freed */ } } }
}
