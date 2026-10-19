// A bounding-volume hierarchy for ray picking on big meshes. three.js tests every triangle of a mesh for each ray; with a
// few hundred thousand triangles that makes every mouse move (hover highlights, snapping, edge occlusion) slow. This tree
// lets a ray skip whole regions. It is built once per mesh, the first time the mesh is picked.

const LEAF = 8;

/** @param verts Float32Array xyz  @param tris Uint32Array 3 indices per triangle */
export function buildBVH(verts, tris) {
  const n = tris.length / 3;
  const cen = new Float32Array(n * 3), lo = new Float32Array(n * 3), hi = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const a = verts[tris[i * 3] * 3 + k], b = verts[tris[i * 3 + 1] * 3 + k], c = verts[tris[i * 3 + 2] * 3 + k];
      lo[i * 3 + k] = Math.min(a, b, c); hi[i * 3 + k] = Math.max(a, b, c); cen[i * 3 + k] = (a + b + c) / 3;
    }
  }
  const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
  const maxNodes = Math.max(1, Math.ceil((2 * n) / LEAF) * 2 + 2);
  const box = new Float32Array(maxNodes * 6), left = new Int32Array(maxNodes).fill(-1), right = new Int32Array(maxNodes).fill(-1), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes);
  let nodes = 0;
  const build = (s, e) => { // an explicit stack: a deep mesh must not overflow the call stack
    const root = nodes++;
    const stack = [[root, s, e]];
    while (stack.length) {
      const [id, a, b] = stack.pop();
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = a; i < b; i++) {
        const t = order[i] * 3;
        if (lo[t] < x0) x0 = lo[t]; if (lo[t + 1] < y0) y0 = lo[t + 1]; if (lo[t + 2] < z0) z0 = lo[t + 2];
        if (hi[t] > x1) x1 = hi[t]; if (hi[t + 1] > y1) y1 = hi[t + 1]; if (hi[t + 2] > z1) z1 = hi[t + 2];
        if (cen[t] < cx0) cx0 = cen[t]; if (cen[t + 1] < cy0) cy0 = cen[t + 1]; if (cen[t + 2] < cz0) cz0 = cen[t + 2];
        if (cen[t] > cx1) cx1 = cen[t]; if (cen[t + 1] > cy1) cy1 = cen[t + 1]; if (cen[t + 2] > cz1) cz1 = cen[t + 2];
      }
      box.set([x0, y0, z0, x1, y1, z1], id * 6);
      if (b - a <= LEAF) { start[id] = a; count[id] = b - a; continue; }
      const dx = cx1 - cx0, dy = cy1 - cy0, dz = cz1 - cz0, ax = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
      if ((ax === 0 ? dx : ax === 1 ? dy : dz) < 1e-12) { start[id] = a; count[id] = b - a; continue; } // all centres coincide
      const mid = (a + b) >> 1;
      select(order, cen, ax, a, b - 1, mid); // median split: the middle triangle by centre along the longest axis
      const l = nodes++, r = nodes++;
      left[id] = l; right[id] = r;
      stack.push([l, a, mid], [r, mid, b]);
    }
    return root;
  };
  build(0, n);
  return { verts, tris, order, box, left, right, start, count };
}

/** Quickselect: arrange order[a..b] so the element at k is where it would be if sorted by centre along axis. */
function select(order, cen, axis, a, b, k) {
  while (b > a) {
    const pivot = cen[order[(a + b) >> 1] * 3 + axis];
    let i = a, j = b;
    while (i <= j) {
      while (cen[order[i] * 3 + axis] < pivot) i++;
      while (cen[order[j] * 3 + axis] > pivot) j--;
      if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
    }
    if (k <= j) b = j; else if (k >= i) a = i; else return;
  }
}

const hitBox = (box, o, ox, oy, oz, ix, iy, iz, tmax) => {
  let t0 = 0, t1 = tmax;
  let a = (box[o] - ox) * ix, b = (box[o + 3] - ox) * ix; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return false;
  a = (box[o + 1] - oy) * iy; b = (box[o + 4] - oy) * iy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return false;
  a = (box[o + 2] - oz) * iz; b = (box[o + 5] - oz) * iz; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b;
  return t0 <= t1;
};

/**
 * The nearest triangle a ray hits, as { t, tri } or null. `backfaces`: also count triangles seen from behind.
 * Triangles are tested like three.js tests them, so the answers match the slower built-in picking.
 */
export function raycastBVH(bvh, ox, oy, oz, dx, dy, dz, tmax = Infinity, backfaces = false) {
  const { verts, tris, order, box, left, right, start, count } = bvh;
  const ix = dx === 0 ? 1e30 : 1 / dx, iy = dy === 0 ? 1e30 : 1 / dy, iz = dz === 0 ? 1e30 : 1 / dz;
  let best = tmax, hit = -1;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    if (!hitBox(box, id * 6, ox, oy, oz, ix, iy, iz, best)) continue;
    if (left[id] < 0) {
      for (let i = start[id], e = i + count[id]; i < e; i++) {
        const tri = order[i], p = tri * 3, a = tris[p] * 3, b = tris[p + 1] * 3, c = tris[p + 2] * 3;
        const e1x = verts[b] - verts[a], e1y = verts[b + 1] - verts[a + 1], e1z = verts[b + 2] - verts[a + 2];
        const e2x = verts[c] - verts[a], e2y = verts[c + 1] - verts[a + 1], e2z = verts[c + 2] - verts[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0 || (!backfaces && det < 0)) continue; // det < 0: the face is seen from behind (counter-clockwise faces point at the viewer when det > 0)
        const inv = 1 / det, tx = ox - verts[a], ty = oy - verts[a + 1], tz = oz - verts[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-9 && t < best) { best = t; hit = tri; }
      }
    } else {
      // visit the nearer child second so it is popped first
      const l = left[id], r = right[id];
      const lc = (box[l * 6 + 0] + box[l * 6 + 3]) * (dx > 0 ? 1 : -1) + (box[l * 6 + 1] + box[l * 6 + 4]) * (dy > 0 ? 1 : -1) + (box[l * 6 + 2] + box[l * 6 + 5]) * (dz > 0 ? 1 : -1);
      const rc = (box[r * 6 + 0] + box[r * 6 + 3]) * (dx > 0 ? 1 : -1) + (box[r * 6 + 1] + box[r * 6 + 4]) * (dy > 0 ? 1 : -1) + (box[r * 6 + 2] + box[r * 6 + 5]) * (dz > 0 ? 1 : -1);
      if (lc < rc) stack.push(r, l); else stack.push(l, r);
    }
  }
  return hit < 0 ? null : { t: best, tri: hit };
}
