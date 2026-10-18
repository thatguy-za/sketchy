// Zero-thickness walls ("skins"): two faces lying exactly on top of each other with opposite directions, so the solid between them
// has no thickness. They look like a floor or a wall on screen but hold no material, and a slicer drops them. Sketchy hides them in
// the viewport so what you see is what prints.
//
// A face is a skin when another face lies in the same plane, faces the opposite way, and covers the point at its centre.

const Q = 1000; // planes within 0.001 mm of each other count as the same plane

/** Indices of the triangles that belong to a zero-thickness wall, as a Set (empty for a healthy body). */
export function findSkins(verts, tris) {
  const n = tris.length / 3, out = new Set();
  if (!n || n > 400000) return out;
  const buckets = new Map(), info = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = tris[i * 3] * 3, b = tris[i * 3 + 1] * 3, c = tris[i * 3 + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const wx = verts[c] - verts[a], wy = verts[c + 1] - verts[a + 1], wz = verts[c + 2] - verts[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    const d = nx * verts[a] + ny * verts[a + 1] + nz * verts[a + 2];
    const q = [Math.round(nx * Q), Math.round(ny * Q), Math.round(nz * Q), Math.round(d * Q)];
    info[i] = { a, b, c, n: [nx, ny, nz], q };
    const key = q.join(',');
    (buckets.get(key) || buckets.set(key, []).get(key)).push(i);
  }
  for (const [, list] of buckets) {
    const q = info[list[0]].q;
    const twins = [];
    for (let dd = -1; dd <= 1; dd++) { const t = buckets.get([-q[0], -q[1], -q[2], -q[3] + dd].join(',')); if (t) twins.push(...t); }
    if (!twins.length) continue;
    const nrm = info[list[0]].n, ax = Math.abs(nrm[0]) > Math.abs(nrm[1]) && Math.abs(nrm[0]) > Math.abs(nrm[2]) ? 0 : Math.abs(nrm[1]) > Math.abs(nrm[2]) ? 1 : 2;
    const u = (ax + 1) % 3, v = (ax + 2) % 3; // project onto the two other axes
    const tri2 = (t) => [verts[t.a + u], verts[t.a + v], verts[t.b + u], verts[t.b + v], verts[t.c + u], verts[t.c + v]];
    const twin2 = twins.map((j) => tri2(info[j]));
    for (const i of list) {
      const t = info[i], cx = (verts[t.a + u] + verts[t.b + u] + verts[t.c + u]) / 3, cy = (verts[t.a + v] + verts[t.b + v] + verts[t.c + v]) / 3;
      for (const p of twin2) {
        const den = (p[3] - p[5]) * (p[0] - p[4]) + (p[4] - p[2]) * (p[1] - p[5]);
        if (Math.abs(den) < 1e-12) continue;
        const l1 = ((p[3] - p[5]) * (cx - p[4]) + (p[4] - p[2]) * (cy - p[5])) / den, l2 = ((p[5] - p[1]) * (cx - p[4]) + (p[0] - p[4]) * (cy - p[5])) / den;
        if (l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6) { out.add(i); break; }
      }
    }
  }
  return out;
}

/** A copy of a body without its zero-thickness walls, or the body itself when it has none. skinned = how many triangles were left out. */
export function withoutSkins(body) {
  const skins = findSkins(body.verts, body.tris);
  if (!skins.size) return body;
  const keep = [];
  for (let i = 0; i < body.tris.length / 3; i++) if (!skins.has(i)) keep.push(body.tris[i * 3], body.tris[i * 3 + 1], body.tris[i * 3 + 2]);
  return { ...body, tris: Uint32Array.from(keep), skinned: skins.size };
}
