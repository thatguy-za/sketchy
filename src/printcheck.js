// Print checks on kernel bodies ({ id, name, verts: Float32Array, tris: Uint32Array, bbox }): does it fit the bed, where does it
// overhang (needs supports), and how thin are the walls. Everything assumes the model sits on the build plate as it is, Z up.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- bed fit
/**
 * Fit every body on the bed: each one on its own (either way round in the plate plane), and all of them together on as few
 * plates as a simple shelf packing needs. Returns { size, fitsEach, fitsAll, tooBig: [names], plates, layout, usage }.
 */
export function bedFit(bodies, bed, gap = 4) {
  const [bx, by, bz] = bed;
  const items = bodies.map((b) => ({ id: b.id, name: b.name, w: b.bbox.max[0] - b.bbox.min[0], d: b.bbox.max[1] - b.bbox.min[1], h: b.bbox.max[2] - b.bbox.min[2], min: b.bbox.min }));
  const fits = (it) => it.h <= bz + 1e-6 && ((it.w <= bx && it.d <= by) || (it.d <= bx && it.w <= by));
  const tooBig = items.filter((it) => !fits(it)).map((it) => ({ name: it.name, size: [it.w, it.d, it.h], why: it.h > bz ? 'too tall' : 'too wide for the plate' }));
  const placeable = items.filter(fits).sort((a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d));
  const plates = [];
  const place = (it) => {
    for (const rot of [false, true]) {
      const w = rot ? it.d : it.w, d = rot ? it.w : it.d;
      if (w > bx || d > by) continue;
      for (const pl of plates) { // shelves: rows filled left to right
        for (const row of pl.rows) {
          if (row.x + w <= bx && d <= row.h) { pl.items.push({ id: it.id, name: it.name, x: row.x, y: row.y, w, d, rot }); row.x += w + gap; return true; }
        }
        const y = pl.rows.length ? pl.rows[pl.rows.length - 1].y + pl.rows[pl.rows.length - 1].h + gap : 0;
        if (y + d <= by) { pl.rows.push({ y, h: d, x: w + gap }); pl.items.push({ id: it.id, name: it.name, x: 0, y, w, d, rot }); return true; }
      }
    }
    return false;
  };
  for (const it of placeable) if (!place(it)) { plates.push({ rows: [], items: [] }); place(it); }
  const area = placeable.reduce((s, it) => s + it.w * it.d, 0);
  return { size: bed, fitsEach: tooBig.length === 0, tooBig, plates: plates.length, fitsAll: tooBig.length === 0 && plates.length <= 1, layout: plates.map((p) => p.items), usage: plates.length ? area / (plates.length * bx * by) : 0 };
}

// ---------------------------------------------------------------- overhangs
/**
 * Faces that face down more steeply than `angle` degrees from vertical need supports (a vertical wall is 0°, a flat ceiling is
 * 90°). Faces lying on the plate are fine. Returns { area, total, fraction, worst, supportVolume, soup } where soup holds the
 * triangles to highlight (9 numbers each) and `grade` marks how bad each one is (0 = near the limit, 1 = flat ceiling).
 */
export function overhangs(bodies, angle = 45, plateZ = 0) {
  const lim = Math.sin((angle * Math.PI) / 180);
  let area = 0, total = 0, worst = 0, vol = 0;
  const soup = [], grade = [];
  for (const b of bodies) {
    const v = b.verts, t = b.tris;
    for (let i = 0; i < t.length; i += 3) {
      const a = [v[t[i] * 3], v[t[i] * 3 + 1], v[t[i] * 3 + 2]], c = [v[t[i + 1] * 3], v[t[i + 1] * 3 + 1], v[t[i + 1] * 3 + 2]], d = [v[t[i + 2] * 3], v[t[i + 2] * 3 + 1], v[t[i + 2] * 3 + 2]];
      const n = cross(sub(c, a), sub(d, a)), l = Math.hypot(...n);
      if (l < 1e-12) continue;
      const ar = l / 2; total += ar;
      const nz = n[2] / l;
      if (nz >= -lim) continue; // not steep enough
      if (Math.max(a[2], c[2], d[2]) <= plateZ + 0.05) continue; // lying on the plate
      area += ar;
      const deg = (Math.asin(Math.min(1, -nz)) * 180) / Math.PI;
      worst = Math.max(worst, deg);
      vol += ar * Math.max(0, (a[2] + c[2] + d[2]) / 3 - plateZ); // a column of support down to the plate
      soup.push(...a, ...c, ...d); grade.push(Math.min(1, (deg - angle) / Math.max(90 - angle, 1)));
    }
  }
  return { area, total, fraction: total ? area / total : 0, worst, supportVolume: vol, soup: Float32Array.from(soup), grade };
}

// ---------------------------------------------------------------- wall thickness
/**
 * Thickness at sample points on the surface: from each point, look straight into the material (against the face normal) and
 * measure the distance to the far side. Works through the triangles of one body in small slices so the page stays responsive.
 * onProgress(0..1) is called as it goes; resolves { samples: [{p:[x,y,z], t}], min, thin: [...] }.
 */
export function wallThickness(bodies, { minWall = 1.2, maxSamples = 1600, onProgress = () => {}, cancel = { stop: false } } = {}) {
  return new Promise((resolve) => {
    // gather triangles per body (the far side must be the same body)
    const jobs = bodies.map((b) => {
      const v = b.verts, t = b.tris, n = t.length / 3;
      const P = new Float64Array(n * 9), N = new Float64Array(n * 3), C = new Float64Array(n * 3), A = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) P[i * 9 + k * 3 + j] = v[t[i * 3 + k] * 3 + j];
        const a = [P[i * 9], P[i * 9 + 1], P[i * 9 + 2]], c = [P[i * 9 + 3], P[i * 9 + 4], P[i * 9 + 5]], d = [P[i * 9 + 6], P[i * 9 + 7], P[i * 9 + 8]];
        const nn = cross(sub(c, a), sub(d, a)), l = Math.hypot(...nn) || 1;
        N.set([nn[0] / l, nn[1] / l, nn[2] / l], i * 3); A[i] = l / 2;
        C.set([(a[0] + c[0] + d[0]) / 3, (a[1] + c[1] + d[1]) / 3, (a[2] + c[2] + d[2]) / 3], i * 3);
      }
      return { n, P, N, C, A };
    });
    const totalTris = jobs.reduce((s, j) => s + j.n, 0) || 1;
    const out = [], work = [];
    for (const j of jobs) {
      const want = Math.max(1, Math.round((maxSamples * j.n) / totalTris));
      // sample triangles in proportion to their area so big flat faces are not over-represented
      const cum = new Float64Array(j.n); let s = 0; for (let i = 0; i < j.n; i++) { s += j.A[i]; cum[i] = s; }
      for (let k = 0; k < want; k++) {
        const r = ((k + 0.5) / want) * s; let lo = 0, hi = j.n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
        work.push([j, lo]);
      }
    }
    let at = 0;
    const step = () => {
      const t0 = performance.now();
      while (at < work.length && performance.now() - t0 < 14) {
        if (cancel.stop) return resolve(null);
        const [j, i] = work[at++];
        const o = [j.C[i * 3], j.C[i * 3 + 1], j.C[i * 3 + 2]], dir = [-j.N[i * 3], -j.N[i * 3 + 1], -j.N[i * 3 + 2]];
        let best = Infinity;
        for (let q = 0; q < j.n; q++) {
          if (q === i) continue;
          const nd = j.N[q * 3] * dir[0] + j.N[q * 3 + 1] * dir[1] + j.N[q * 3 + 2] * dir[2];
          if (nd <= 1e-9) continue; // the far side of the wall faces the same way we look
          // Moller-Trumbore
          const b = q * 9, e1x = j.P[b + 3] - j.P[b], e1y = j.P[b + 4] - j.P[b + 1], e1z = j.P[b + 5] - j.P[b + 2], e2x = j.P[b + 6] - j.P[b], e2y = j.P[b + 7] - j.P[b + 1], e2z = j.P[b + 8] - j.P[b + 2];
          const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det, tx = o[0] - j.P[b], ty = o[1] - j.P[b + 1], tz = o[2] - j.P[b + 2];
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const w = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
          if (w < 0 || u + w > 1) continue;
          const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (dist > 1e-6 && dist < best) best = dist;
        }
        if (best < Infinity) out.push({ p: o, t: best });
      }
      onProgress(at / work.length);
      if (at < work.length) setTimeout(step, 0);
      else {
        const min = out.length ? Math.min(...out.map((s) => s.t)) : Infinity;
        resolve({ samples: out, min, thin: out.filter((s) => s.t < minWall), total: work.length });
      }
    };
    step();
  });
}
