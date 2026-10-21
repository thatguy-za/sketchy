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
function sewFaces(R, verts, faces, track) {
  const P = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const built = [];
  let skipped = 0;
  for (const fc of faces) {
    const [outer, ...holes] = fc.loops;
    if (outer.length < 3) continue;
    try {
      if (!holes.length) {
        const pts = outer.map(P); // (collinear points stay: the face next to this one has its own vertex there, and the two edges must match to be sewn)
        try { built.push(track(R.makePolygon(pts))); }
        catch { for (let k = 1; k + 1 < pts.length; k++) built.push(track(R.makePolygon([pts[0], pts[k], pts[k + 1]]))); } // nearly flat but not flat enough for one face: split it
      } else {
        const wire = (lp) => track(R.assembleWire(lp.map((v, k) => track(R.makeLine(P(v), P(lp[(k + 1) % lp.length]))))));
        built.push(track(R.makeFace(wire(outer), holes.map(wire))));
      }
    } catch { skipped++; /* a degenerate sliver: the neighbours close the gap when sewn */ }
  }
  if (!built.length) throw new Error('The mesh has no usable triangles.');
  const shell = track(R.weldShellsAndFaces(built));
  let solid = track(R.makeSolid([shell]));
  let v = R.measureVolume(solid);
  if (v < 0) { // faces pointing inwards: turn the shell inside out
    solid = track(R.makeSolid([track(shell.flipOrientation?.() ?? shell)]));
    v = R.measureVolume(solid);
  }
  if (!(Math.abs(v) > 1e-9)) throw new Error('The mesh is not a closed solid (it has holes or loose pieces). Use Clean Mesh to weld and fill it before sewing.');
  return { solid, faces: faces.length, volume: v, skipped };
}
