// Finding a stored B-rep face again after an edit. A face is stored as { brepFace: key, point, normal, curved? } where the key is
// "TYPE@cx,cy,cz/area" (see backend-brep.js). Same geometry gives the same key. When an edit changed the face's area or position the
// key no longer matches; the face is then the one of the same surface type (and, for a plane, the same normal) whose centre is
// nearest the old one, provided that is clearly the best candidate. Returns an index into `faces`, or -1 (the caller then falls back
// to matching by point and normal on the mesh). Pure data, so the viewport and the exact kernel share it.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((c) => c / l); };

export function matchBrepFace(faces, ref) {
  if (!ref?.brepFace || !faces?.length) return -1;
  const exact = faces.findIndex((f) => f.key === ref.brepFace);
  if (exact >= 0) return exact;
  const m = /^([^@]+)@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\//.exec(ref.brepFace);
  if (!m) return -1;
  const type = m[1], c0 = [+m[2], +m[3], +m[4]];
  let cand = faces.map((f, k) => ({ f, k })).filter((x) => x.f.type === type && x.f.centroid);
  if (type === 'PLANE' && ref.normal) { const n = unit(ref.normal); cand = cand.filter((x) => x.f.normal && dot(x.f.normal, n) > 0.999); }
  if (!cand.length) return -1;
  const d = (x) => Math.hypot(x.f.centroid[0] - c0[0], x.f.centroid[1] - c0[1], x.f.centroid[2] - c0[2]);
  cand.sort((a, b) => d(a) - d(b));
  if (cand.length === 1 || d(cand[0]) < 0.6 * d(cand[1])) return cand[0].k;
  return -1;
}
