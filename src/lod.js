// A rough copy of a mesh for use while the camera moves. Orbiting a model with hundreds of thousands of triangles redraws all of
// them every frame, which is what makes it stutter. Vertex clustering is quick and good enough for a few moments of motion:
// the vertices in each cell of a coarse grid merge into one, and triangles that collapse are dropped. The full mesh comes back
// as soon as the camera stops.

/** @returns { verts: Float32Array, tris: Uint32Array } with roughly (cells)^2 * a few triangles, whatever the input size */
export function clusterMesh(verts, tris, cells = 110) {
  const nv = verts.length / 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const size = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-6), cell = size / cells;
  const cid = new Int32Array(nv), ids = new Map(), sum = [], cnt = [];
  for (let i = 0; i < nv; i++) {
    const ix = Math.floor((verts[i * 3] - x0) / cell), iy = Math.floor((verts[i * 3 + 1] - y0) / cell), iz = Math.floor((verts[i * 3 + 2] - z0) / cell);
    const key = (ix * 4096 + iy) * 4096 + iz;
    let c = ids.get(key);
    if (c === undefined) { c = sum.length / 3; ids.set(key, c); sum.push(0, 0, 0); cnt.push(0); }
    cid[i] = c; sum[c * 3] += verts[i * 3]; sum[c * 3 + 1] += verts[i * 3 + 1]; sum[c * 3 + 2] += verts[i * 3 + 2]; cnt[c]++;
  }
  const out = new Float32Array(sum.length);
  for (let c = 0; c < cnt.length; c++) { out[c * 3] = sum[c * 3] / cnt[c]; out[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; out[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; }
  const keep = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = cid[tris[i]], b = cid[tris[i + 1]], c = cid[tris[i + 2]];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  return { verts: out, tris: Uint32Array.from(keep) };
}
