// Sharp-edge detection on an indexed triangle mesh, chained into polylines with per-vertex
// face frames (used both to pick edges in the viewport and to build fillet/chamfer cutters).
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const norm = (a) => { const l = len(a); return l < 1e-12 ? [0, 0, 0] : scl(a, 1 / l); };

const CREASE = Math.cos((20 * Math.PI) / 180);
const CONTINUE = Math.cos((25 * Math.PI) / 180);
const COLLINEAR = Math.cos((1.5 * Math.PI) / 180);

function avgFrame(f, g) {
  const same = dot(f.u1, g.u1) + dot(f.u2, g.u2) >= dot(f.u1, g.u2) + dot(f.u2, g.u1);
  const [g1, g2] = same ? [[g.n1, g.u1], [g.n2, g.u2]] : [[g.n2, g.u2], [g.n1, g.u1]];
  return {
    n1: norm(add(f.n1, g1[0])), u1: norm(add(f.u1, g1[1])),
    n2: norm(add(f.n2, g2[0])), u2: norm(add(f.u2, g2[1])),
  };
}
function alignTo(f, ref) {
  const same = dot(f.u1, ref.u1) + dot(f.u2, ref.u2) >= dot(f.u1, ref.u2) + dot(f.u2, ref.u1);
  return same ? f : { n1: f.n2, u1: f.u2, n2: f.n1, u2: f.u1 };
}

/** @returns [{closed, pts:[[x,y,z]], frames:[{n1,u1,n2,u2}]}] */
export function findEdgeChains(vp, stride, tris) {
  const weld = new Map(), pos = [], remap = new Uint32Array(vp.length / stride);
  for (let i = 0; i < remap.length; i++) {
    const x = vp[i * stride], y = vp[i * stride + 1], z = vp[i * stride + 2];
    const key = `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
    let id = weld.get(key);
    if (id === undefined) { id = pos.length; weld.set(key, id); pos.push([x, y, z]); }
    remap[i] = id;
  }
  const N = pos.length;
  const tn = [], edgeMap = new Map();
  const T = tris.length / 3;
  for (let t = 0; t < T; t++) {
    const ids = [remap[tris[t * 3]], remap[tris[t * 3 + 1]], remap[tris[t * 3 + 2]]];
    const n = norm(cross(sub(pos[ids[1]], pos[ids[0]]), sub(pos[ids[2]], pos[ids[0]])));
    tn.push(ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2] ? [0, 0, 0] : n);
    for (let k = 0; k < 3; k++) {
      const a = ids[k], b = ids[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * N + b : b * N + a;
      let e = edgeMap.get(key);
      if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), tris: [] }; edgeMap.set(key, e); }
      e.tris.push(t);
    }
  }
  const triIds = (t) => [remap[tris[t * 3]], remap[tris[t * 3 + 1]], remap[tris[t * 3 + 2]]];
  const segs = [];
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue;
    const [ta, tb] = e.tris;
    if (len(tn[ta]) === 0 || len(tn[tb]) === 0 || dot(tn[ta], tn[tb]) > CREASE) continue;
    const d = norm(sub(pos[e.b], pos[e.a]));
    const side = (t) => {
      const c = triIds(t).find((v) => v !== e.a && v !== e.b);
      const w = sub(pos[c], pos[e.a]);
      return norm(sub(w, scl(d, dot(w, d))));
    };
    segs.push({ a: e.a, b: e.b, frame: { n1: tn[ta], u1: side(ta), n2: tn[tb], u2: side(tb) } });
  }
  const adj = new Map();
  segs.forEach((s, i) => { for (const v of [s.a, s.b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); } });
  const visited = new Set();
  const dirAway = (s, from) => norm(sub(pos[s.a === from ? s.b : s.a], pos[from]));

  const walk = (start, firstSeg) => {
    const out = [];
    let cur = start, dir = dirAway(segs[firstSeg], start === segs[firstSeg].a ? segs[firstSeg].b : segs[firstSeg].a);
    // `start` is the vertex we arrived at; dir is the travel direction into it.
    for (;;) {
      let best = -1, bd = CONTINUE;
      for (const si of adj.get(cur) || []) {
        if (visited.has(si)) continue;
        const dd = dot(dirAway(segs[si], cur), dir);
        if (dd > bd) { bd = dd; best = si; }
      }
      if (best < 0) break;
      visited.add(best);
      const s = segs[best];
      const next = s.a === cur ? s.b : s.a;
      out.push({ v: next, seg: best });
      dir = dirAway(s, cur);
      cur = next;
    }
    return out;
  };

  const chains = [];
  for (let si = 0; si < segs.length; si++) {
    if (visited.has(si)) continue;
    visited.add(si);
    const s = segs[si];
    const fwd = walk(s.b, si); // travel a -> b
    let back = [];
    const closed = fwd.length && fwd[fwd.length - 1].v === s.a;
    if (!closed) back = walk(s.a, si); // travel b -> a
    // assemble vertex list V and segment list S (S[i] joins V[i], V[i+1])
    const V = [...back.map((x) => x.v).reverse(), s.a, s.b, ...fwd.map((x) => x.v)];
    const S = [...back.map((x) => x.seg).reverse(), si, ...fwd.map((x) => x.seg)];
    // `back` walk entries go away from s.a, so reversed order is already outer->inner
    let F = S.map((i) => segs[i].frame);
    for (let i = 1; i < F.length; i++) F[i] = alignTo(F[i], F[i - 1]);
    let pts = V.map((v) => pos[v]);
    let frames;
    const n = F.length;
    if (closed) {
      pts = pts.slice(0, -1);
      frames = pts.map((_, i) => avgFrame(F[(i - 1 + n) % n], F[i]));
    } else {
      frames = pts.map((_, i) => (i === 0 ? F[0] : i === n ? F[n - 1] : avgFrame(F[i - 1], F[i])));
    }
    // drop collinear interior vertices
    const keep = pts.map((_, i) => {
      if (!closed && (i === 0 || i === pts.length - 1)) return true;
      const p = pts[(i - 1 + pts.length) % pts.length], c = pts[i], q = pts[(i + 1) % pts.length];
      return dot(norm(sub(c, p)), norm(sub(q, c))) < COLLINEAR;
    });
    const rp = pts.filter((_, i) => keep[i]);
    if (rp.length < 2) continue;
    chains.push({ closed: !!closed, pts: rp, frames: frames.filter((_, i) => keep[i]) });
  }
  return chains;
}

/** Find the chain whose vertices coincide with `pts` (order/direction agnostic). */
export function matchChain(chains, pts, tol = 0.02) {
  for (const ch of chains) {
    if (ch.pts.length !== pts.length) continue;
    const ok = pts.every((p) => ch.pts.some((q) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol && Math.abs(p[2] - q[2]) < tol));
    if (ok) return ch;
  }
  return null;
}

/**
 * Like matchChain, but when the design has been edited since the edge was picked (a box made wider, a face moved) and the
 * stored points no longer lie on any edge, find the edge that is most plausibly the same one: same orientation, nearest, similar
 * length. Returns null when nothing is close enough or two edges are about equally good, so a wrong edge is never picked quietly.
 */
export function matchChainNear(chains, pts, nrm, tol = 0.02) {
  const exact = matchChain(chains, pts, tol);
  if (exact) return exact;
  const sig = (q) => {
    const c = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of q) for (let k = 0; k < 3; k++) { c[k] += p[k] / q.length; lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const ext = hi.map((h, k) => h - lo[k]), big = Math.max(...ext, 1e-9);
    let len = 0; for (let i = 1; i < q.length; i++) len += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1], q[i][2] - q[i - 1][2]);
    return { c, len, flat: ext.map((e) => e < 1e-3 + 0.02 * big), big };
  };
  const want = sig(pts);
  const scored = [];
  for (const ch of chains) {
    const g = sig(ch.pts);
    if (g.flat.some((f, k) => f !== want.flat[k])) continue; // lies in a different direction
    if (nrm && !nrm.every((r) => ch.frames.some((fr) => dot(fr.n1, r) > 0.98 || dot(fr.n2, r) > 0.98))) continue; // not between the same two kinds of face
    const dc = Math.hypot(g.c[0] - want.c[0], g.c[1] - want.c[1], g.c[2] - want.c[2]);
    scored.push({ ch, score: dc + 0.5 * Math.abs(g.len - want.len) });
  }
  scored.sort((a, b) => a.score - b.score);
  if (!scored.length) return null;
  const [best, next] = scored;
  if (next && best.score > 0.7 * next.score) return null; // too close to call
  return best.ch;
}

/** What to store when an edge is picked: its points, plus the normals of the two faces it joins, so the edge can be found again after edits. */
export function edgeRef(body, chain) {
  const fr = chain.frames[Math.floor(chain.frames.length / 2)];
  const r = (v) => v.map((c) => +c.toFixed(3));
  return { body, pts: roundPts(chain.pts), nrm: [r(fr.n1), r(fr.n2)] };
}

export const roundPts = (pts) => pts.map((p) => p.map((v) => +v.toFixed(3)));

// ---------- face regions (flat and curved) ----------
const SMOOTH = Math.cos((30 * Math.PI) / 180); // triangles of one curved face turn by less than this from each neighbour
const topoCache = new WeakMap();
/** Welded vertices, edge to triangle map and triangle normals for a mesh, built once per mesh. */
function meshTopo(verts, tris) {
  const hit = topoCache.get(tris);
  if (hit && hit.nv === verts.length) return hit;
  const weld = new Map(), remap = new Uint32Array(verts.length / 3), pos = [];
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.round(verts[i * 3] * 1e3)},${Math.round(verts[i * 3 + 1] * 1e3)},${Math.round(verts[i * 3 + 2] * 1e3)}`;
    let id = weld.get(key);
    if (id === undefined) { id = pos.length; weld.set(key, id); pos.push([verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]); }
    remap[i] = id;
  }
  const T = tris.length / 3, N = pos.length;
  const ids = (t) => [remap[tris[t * 3]], remap[tris[t * 3 + 1]], remap[tris[t * 3 + 2]]];
  const nrmCache = new Array(T);
  const nrm = (t) => nrmCache[t] || (nrmCache[t] = (() => { const [a, b, c] = ids(t); return norm(cross(sub(pos[b], pos[a]), sub(pos[c], pos[a]))); })());
  const emap = new Map();
  for (let t = 0; t < T; t++) {
    const v = ids(t);
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? a * N + b : b * N + a;
      if (!emap.has(key)) emap.set(key, []);
      emap.get(key).push(t);
    }
  }
  const area = (t) => { const [a, b, c] = ids(t); return len(cross(sub(pos[b], pos[a]), sub(pos[c], pos[a]))) / 2; };
  const topo = { nv: verts.length, pos, N, T, ids, nrm, area, emap, nbrs: (t) => { const v = ids(t), out = []; for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3]; for (const o of emap.get(a < b ? a * N + b : b * N + a)) if (o !== t) out.push(o); } return out; } };
  topoCache.set(tris, topo);
  return topo;
}
/**
 * Flood-fill coplanar triangles around `tri`. Returns {tris, normal, point} or null if the
 * triangle belongs to a curved (non-planar) surface.
 */
export function planarFace(verts, tris, tri) {
  const { pos, ids, nrm, area, nbrs } = meshTopo(verts, tris);
  const n0 = nrm(tri);
  if (len(n0) === 0) return null;
  const p0 = pos[ids(tri)[0]];
  const d0 = dot(n0, p0);
  const region = new Set([tri]);
  const stack = [tri];
  let smoothArea = 0;
  while (stack.length) {
    const t = stack.pop();
    for (const o of nbrs(t)) {
      if (region.has(o)) continue;
      const no = nrm(o);
      if (len(no) === 0) continue;
      const coplanar = dot(no, n0) > 1 - 1e-6 && ids(o).every((i) => Math.abs(dot(n0, pos[i]) - d0) < 2e-3);
      if (coplanar) { region.add(o); stack.push(o); }
      else if (dot(no, n0) > CREASE) smoothArea = Math.max(smoothArea, area(o));
    }
  }
  // A facet of a curved surface is about as big as its smooth neighbours; a flat face blending into a fillet is much bigger.
  let regionArea = 0;
  for (const t of region) regionArea += area(t);
  if (smoothArea > 0 && regionArea <= 3 * smoothArea) return null;
  return { tris: [...region], normal: n0, point: p0 };
}
/**
 * The curved face around `tri`: the triangles reached through smooth joins, leaving out flat faces that blend into it
 * (a fillet stops where the flat face starts). Returns {tris, normal, point, curved: true} or null when `tri` is on a flat face.
 * point and normal come from the same triangle every time (the lowest one), so the face can be recognised again.
 */
export function curvedFace(verts, tris, tri) {
  const topo = meshTopo(verts, tris), { pos, ids, nrm, nbrs } = topo;
  const flat = new Map(); // triangle -> true when it lies on a flat face
  const isFlat = (t) => {
    if (flat.has(t)) return flat.get(t);
    const pf = planarFace(verts, tris, t);
    if (pf) { for (const q of pf.tris) flat.set(q, true); return true; }
    flat.set(t, false); return false;
  };
  if (len(nrm(tri)) === 0 || isFlat(tri)) return null;
  const region = new Set([tri]), stack = [tri];
  while (stack.length) {
    const t = stack.pop(), nt = nrm(t);
    for (const o of nbrs(t)) {
      if (region.has(o)) continue;
      const no = nrm(o);
      if (len(no) === 0 || dot(no, nt) < SMOOTH || isFlat(o)) continue;
      region.add(o); stack.push(o);
    }
  }
  const ctr = (t) => { const [a, b, c] = ids(t); return scl(add(add(pos[a], pos[b]), pos[c]), 1 / 3); };
  let best = tri, bc = ctr(tri);
  for (const t of region) { const c = ctr(t); if (c[2] < bc[2] - 1e-6 || (Math.abs(c[2] - bc[2]) <= 1e-6 && (c[1] < bc[1] - 1e-6 || (Math.abs(c[1] - bc[1]) <= 1e-6 && c[0] < bc[0] - 1e-6)))) { best = t; bc = c; } }
  return { tris: [...region], normal: nrm(best).map((c) => +c.toFixed(6)), point: bc.map((c) => +c.toFixed(4)), curved: true };
}
/** The triangle on a curved face that a stored {point, normal} now refers to (the nearest one that faces the same way), or -1. */
export function findCurvedTri(verts, tris, point, normal) {
  const { pos, ids, nrm, T } = meshTopo(verts, tris);
  let best = -1, bd = Infinity, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pos) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const tol = Math.max(0.5, 0.02 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  for (let t = 0; t < T; t++) {
    if (dot(nrm(t), normal) < 0.7) continue;
    const [a, b, c] = ids(t), q = scl(add(add(pos[a], pos[b]), pos[c]), 1 / 3), d = len(sub(q, point));
    if (d < bd) { bd = d; best = t; }
  }
  return bd <= tol ? best : -1;
}
/** Any face under a triangle: flat ({tris, normal, point}) or curved (same, plus curved: true). */
export function faceOf(verts, tris, tri) { return planarFace(verts, tris, tri) || curvedFace(verts, tris, tri); }
