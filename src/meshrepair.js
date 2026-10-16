// Triangle-soup repair so imperfect STL files become watertight solids:
//   weld vertices -> drop degenerate/duplicate triangles -> prune non-manifold edges ->
//   make orientation consistent (and outward) -> fill holes.
import { ShapeUtils, Vector2 } from 'three';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * @param {Float32Array} soup  9 floats per triangle
 * @returns {{verts: Float32Array, tris: Uint32Array, soup: Float32Array, report: object}}
 */
export function repairSoup(soup) {
  const report = { triangles: soup.length / 9, welded: 0, degenerate: 0, duplicates: 0, nonManifold: 0, flipped: 0, holes: 0, holeTriangles: 0, skippedHoles: 0 };
  // ---- bounds + tolerance
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], soup[i + k]); hi[k] = Math.max(hi[k], soup[i + k]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = Math.max(diag * 1e-6, 1e-5);

  // ---- weld
  const map = new Map(), pos = [];
  let tris = [];
  const vid = (x, y, z) => {
    const key = `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    let id = map.get(key);
    if (id === undefined) { id = pos.length; map.set(key, id); pos.push([x, y, z]); } else report.welded++;
    return id;
  };
  for (let i = 0; i < soup.length; i += 9) tris.push([vid(soup[i], soup[i + 1], soup[i + 2]), vid(soup[i + 3], soup[i + 4], soup[i + 5]), vid(soup[i + 6], soup[i + 7], soup[i + 8])]);

  // ---- degenerate + duplicate triangles
  const seen = new Set();
  tris = tris.filter(([a, b, c]) => {
    if (a === b || b === c || a === c) { report.degenerate++; return false; }
    const n = cross(sub(pos[b], pos[a]), sub(pos[c], pos[a]));
    if (Math.hypot(...n) < tol * tol) { report.degenerate++; return false; }
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) { report.duplicates++; return false; }
    seen.add(key);
    return true;
  });

  // ---- prune edges shared by more than two triangles (keep the first two)
  const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  let edgeTris = new Map();
  const rebuildEdges = () => {
    edgeTris = new Map();
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = ekey(t[k], t[(k + 1) % 3]); (edgeTris.get(key) || edgeTris.set(key, []).get(key)).push(i); } });
  };
  rebuildEdges();
  const drop = new Set();
  for (const list of edgeTris.values()) if (list.length > 2) for (const i of list.slice(2)) drop.add(i);
  if (drop.size) { report.nonManifold = drop.size; tris = tris.filter((_, i) => !drop.has(i)); rebuildEdges(); }

  // ---- consistent orientation per connected component
  const comp = new Array(tris.length).fill(-1);
  const hasDir = (t, a, b) => { for (let k = 0; k < 3; k++) if (t[k] === a && t[(k + 1) % 3] === b) return true; return false; };
  let nc = 0;
  for (let s = 0; s < tris.length; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = nc;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop(), t = tris[i];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        for (const j of edgeTris.get(ekey(a, b)) || []) {
          if (j === i || comp[j] >= 0) continue;
          if (hasDir(tris[j], a, b)) { tris[j] = [tris[j][0], tris[j][2], tris[j][1]]; report.flipped++; } // same direction -> flip neighbour
          comp[j] = nc; stack.push(j);
        }
      }
    }
    nc++;
  }
  // outward: flip components with negative volume
  const vol = new Array(nc).fill(0);
  tris.forEach((t, i) => { const [a, b, c] = t.map((x) => pos[x]); vol[comp[i]] += dot(a, cross(b, c)) / 6; });
  tris = tris.map((t, i) => (vol[comp[i]] < 0 ? [t[0], t[2], t[1]] : t));
  report.flipped += vol.reduce((n, v, c) => n + (v < 0 ? comp.filter((x) => x === c).length : 0), 0);

  // ---- fill holes: boundary half-edges (those without an opposite) form loops
  const half = new Set(tris.flatMap((t) => [0, 1, 2].map((k) => `${t[k]}>${t[(k + 1) % 3]}`)));
  const outgoing = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3];
    if (!half.has(`${b}>${a}`)) (outgoing.get(a) || outgoing.set(a, []).get(a)).push(b);
  }
  const used = new Set();
  for (const [start, nexts] of outgoing) {
    for (const first of [...nexts]) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let a = start, b = first, ok = false;
      for (let guard = 0; guard < 100000; guard++) {
        used.add(`${a}>${b}`);
        if (b === start) { ok = true; break; }
        loop.push(b);
        const cand = (outgoing.get(b) || []).find((n) => !used.has(`${b}>${n}`));
        if (cand === undefined) break;
        a = b; b = cand;
      }
      if (!ok || loop.length < 3) { report.skippedHoles++; continue; }
      if (loop.length > 5000) { report.skippedHoles++; continue; }
      // fill with triangles whose edges run opposite to the boundary: use the loop reversed
      const poly = [...loop].reverse();
      let nrm = [0, 0, 0];
      for (let i = 0; i < poly.length; i++) { const c = cross(pos[poly[i]], pos[poly[(i + 1) % poly.length]]); nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]]; }
      const nl = Math.hypot(...nrm);
      let filled = [];
      if (nl > 1e-12) {
        const n = nrm.map((x) => x / nl);
        const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const ux = (() => { const u = cross(ref, n); const l = Math.hypot(...u); return u.map((x) => x / l); })(), uy = cross(n, ux);
        const pts2 = poly.map((i) => new Vector2(dot(pos[i], ux), dot(pos[i], uy)));
        try { filled = ShapeUtils.triangulateShape(pts2, []).map(([x, y, z]) => [poly[x], poly[y], poly[z]]); } catch { filled = []; }
      }
      if (filled.length < poly.length - 2) { // fallback: fan from the loop's centroid
        const c = pos[poly[0]].map((_, k) => poly.reduce((s, i) => s + pos[i][k], 0) / poly.length);
        const ci = pos.push(c) - 1;
        filled = poly.map((v, i) => [ci, v, poly[(i + 1) % poly.length]]);
      }
      // orient each new triangle like the polygon normal
      for (const [x, y, z] of filled) {
        const tn = cross(sub(pos[y], pos[x]), sub(pos[z], pos[x]));
        tris.push(nl > 1e-12 && dot(tn, nrm) < 0 ? [x, z, y] : [x, y, z]);
      }
      report.holes++; report.holeTriangles += filled.length;
    }
  }

  const verts = new Float32Array(pos.length * 3);
  pos.forEach((p, i) => verts.set(p, i * 3));
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => idx.set(t, i * 3));
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, k) => out.set(pos[v], i * 9 + k * 3)));
  return { verts, tris: idx, soup: out, report };
}

export function describeRepair(r) {
  const parts = [];
  if (r.holes) parts.push(`filled ${r.holes} hole${r.holes > 1 ? 's' : ''}`);
  if (r.flipped) parts.push(`fixed ${r.flipped} flipped triangle${r.flipped > 1 ? 's' : ''}`);
  if (r.degenerate) parts.push(`removed ${r.degenerate} degenerate`);
  if (r.duplicates) parts.push(`removed ${r.duplicates} duplicate`);
  if (r.nonManifold) parts.push(`removed ${r.nonManifold} non-manifold`);
  return parts.join(', ') || 'welded vertices';
}
