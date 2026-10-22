// Mesh tools that work on triangles before a mesh is sewn into a solid (see sew.js): reduce the triangle count, and split a mesh into
// its connected pieces. Clean Mesh is repairSoup in meshrepair.js. Each takes and returns plain triangle data.

/** Soup (9 floats per triangle) of an indexed mesh. */
export function soupOfMesh(verts, tris) {
  const s = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) for (let k = 0; k < 3; k++) s[i * 3 + k] = verts[tris[i] * 3 + k];
  return s;
}

/**
 * Fewer triangles by edge collapse with quadric error (Garland and Heckbert): the cheapest edge, the one whose removal moves the surface
 * least, collapses first, until the mesh is at or below `keepPercent` of its triangles or the next collapse would move the surface more
 * than `maxDeviation`. A collapse that would flip a triangle or pinch the mesh into a non-manifold edge is not done.
 * Returns { verts, tris, from, to }.
 */
const progress = (stage, done, total) => { try { globalThis.__sketchyProgress?.(stage, done, total); } catch { /* nobody is listening */ } };
export function reduceMesh(verts0, tris0, { keepPercent = 50, maxDeviation = 0.2 } = {}) {
  const nv = verts0.length / 3, from = tris0.length / 3, target = Math.max(8, Math.round((from * keepPercent) / 100));
  const V = Float64Array.from(verts0), T = Uint32Array.from(tris0), alive = new Uint8Array(from).fill(1);
  const Q = new Float64Array(nv * 10); // symmetric 4x4 quadric per vertex: a b c d e f g h i j
  const vt = Array.from({ length: nv }, () => new Set()); // triangles at each vertex
  const addQ = (v, a, b, c, d, w) => { const q = Q, o = v * 10; q[o] += w * a * a; q[o + 1] += w * a * b; q[o + 2] += w * a * c; q[o + 3] += w * a * d; q[o + 4] += w * b * b; q[o + 5] += w * b * c; q[o + 6] += w * b * d; q[o + 7] += w * c * c; q[o + 8] += w * c * d; q[o + 9] += w * d * d; };
  const triPlane = (t) => { const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2], ux = V[b * 3] - V[a * 3], uy = V[b * 3 + 1] - V[a * 3 + 1], uz = V[b * 3 + 2] - V[a * 3 + 2], wx = V[c * 3] - V[a * 3], wy = V[c * 3 + 1] - V[a * 3 + 1], wz = V[c * 3 + 2] - V[a * 3 + 2]; let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz); if (l < 1e-18) return null; nx /= l; ny /= l; nz /= l; return { n: [nx, ny, nz], d: -(nx * V[a * 3] + ny * V[a * 3 + 1] + nz * V[a * 3 + 2]), area: l / 2 }; };
  for (let t = 0; t < from; t++) {
    for (let k = 0; k < 3; k++) vt[T[t * 3 + k]].add(t);
    const pl = triPlane(t);
    if (pl) for (let k = 0; k < 3; k++) addQ(T[t * 3 + k], pl.n[0], pl.n[1], pl.n[2], pl.d, 1);
  }
  const errAt = (q, o, x, y, z) => q[o] * x * x + 2 * q[o + 1] * x * y + 2 * q[o + 2] * x * z + 2 * q[o + 3] * x + q[o + 4] * y * y + 2 * q[o + 5] * y * z + 2 * q[o + 6] * y + q[o + 7] * z * z + 2 * q[o + 8] * z + q[o + 9];
  const sum = new Float64Array(10);
  const cost = (u, v) => { for (let k = 0; k < 10; k++) sum[k] = Q[u * 10 + k] + Q[v * 10 + k]; let best = null; for (const c of [[V[u * 3], V[u * 3 + 1], V[u * 3 + 2]], [V[v * 3], V[v * 3 + 1], V[v * 3 + 2]], [(V[u * 3] + V[v * 3]) / 2, (V[u * 3 + 1] + V[v * 3 + 1]) / 2, (V[u * 3 + 2] + V[v * 3 + 2]) / 2]]) { const e = errAt(sum, 0, c[0], c[1], c[2]); if (!best || e < best.e) best = { e, p: c }; } return best; };
  // a binary min-heap of candidate edges; an entry is stale when either end changed since it was pushed
  const ver = new Int32Array(nv), heap = [];
  const less = (a, b) => a.e < b.e;
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  const seen = new Set();
  const edgeOf = (u, v) => { const a = Math.min(u, v), b = Math.max(u, v), key = a * nv + b; if (seen.has(key)) return; seen.add(key); const c = cost(a, b); push({ e: c.e, u: a, v: b, p: c.p, vu: ver[a], vv: ver[b] }); };
  for (let t = 0; t < from; t++) for (let k = 0; k < 3; k++) edgeOf(T[t * 3 + k], T[t * 3 + (k + 1) % 3]);
  const nbrs = (v) => { const s = new Set(); for (const t of vt[v]) for (let k = 0; k < 3; k++) if (T[t * 3 + k] !== v) s.add(T[t * 3 + k]); return s; };
  let count = from;
  const maxErr = maxDeviation * maxDeviation;
  let spin = 0;
  while (count > target && heap.length) {
    if (++spin % 500 === 0) progress('Reducing triangles', from - count, from - target);
    const it = pop();
    if (ver[it.u] !== it.vu || ver[it.v] !== it.vv) continue;
    if (it.e > maxErr) break;
    const { u, v, p } = it, shared = [...vt[u]].filter((t) => vt[v].has(t));
    if (!shared.length || shared.length > 2) continue;
    // link condition: the only vertices u and v both touch are the ones opposite the shared triangles
    const nu = nbrs(u), nvv = nbrs(v), opp = new Set(); let ok = true;
    for (const t of shared) for (let k = 0; k < 3; k++) { const w = T[t * 3 + k]; if (w !== u && w !== v) opp.add(w); }
    for (const w of nu) if (nvv.has(w) && !opp.has(w)) { ok = false; break; }
    if (!ok) continue;
    // no triangle around u or v may flip (or collapse to a sliver) when the collapsed vertex moves to p
    for (const end of [u, v]) for (const t of vt[end]) {
      if (shared.includes(t)) continue;
      const o = []; for (let k = 0; k < 3; k++) { const w = T[t * 3 + k]; o.push(w === u || w === v ? p : [V[w * 3], V[w * 3 + 1], V[w * 3 + 2]]); }
      const before = triPlane(t); if (!before) continue;
      const ux = o[1][0] - o[0][0], uy = o[1][1] - o[0][1], uz = o[1][2] - o[0][2], wx = o[2][0] - o[0][0], wy = o[2][1] - o[0][1], wz = o[2][2] - o[0][2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
      if (l < 1e-12 || (nx * before.n[0] + ny * before.n[1] + nz * before.n[2]) / l < 0.2) { ok = false; break; }
    }
    if (!ok) continue;
    // collapse v into u at p
    V[u * 3] = p[0]; V[u * 3 + 1] = p[1]; V[u * 3 + 2] = p[2];
    for (let k = 0; k < 10; k++) Q[u * 10 + k] += Q[v * 10 + k];
    for (const t of shared) { alive[t] = 0; count--; for (let k = 0; k < 3; k++) vt[T[t * 3 + k]].delete(t); }
    for (const t of [...vt[v]]) { for (let k = 0; k < 3; k++) if (T[t * 3 + k] === v) T[t * 3 + k] = u; vt[v].delete(t); vt[u].add(t); }
    ver[u]++; ver[v]++;
    for (const w of nbrs(u)) { seen.delete(Math.min(u, w) * nv + Math.max(u, w)); edgeOf(u, w); }
  }
  const keep = [];
  for (let t = 0; t < from; t++) if (alive[t]) keep.push(T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
  // drop unused vertices
  const remap = new Int32Array(nv).fill(-1), out = [];
  const tris = keep.map((i) => { if (remap[i] < 0) { remap[i] = out.length / 3; out.push(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]); } return remap[i]; });
  return { verts: Float32Array.from(out), tris: Uint32Array.from(tris), from, to: tris.length / 3 };
}

/** The connected pieces of an indexed mesh (triangles that share a vertex), as lists of triangle indices, largest first. */
export function pieces(tris, nverts) {
  const parent = new Int32Array(nverts).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < tris.length; i += 3) { const a = find(tris[i]), b = find(tris[i + 1]), c = find(tris[i + 2]); parent[b] = a; parent[find(c)] = a; }
  const groups = new Map();
  for (let i = 0; i < tris.length; i += 3) { const r = find(tris[i]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i / 3); }
  return [...groups.values()].sort((x, y) => y.length - x.length);
}
