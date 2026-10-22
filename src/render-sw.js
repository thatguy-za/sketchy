// A small software renderer: turns built bodies into a PNG with no GPU and no browser, so an assistant can look at a model.
// Flat-shaded triangles with smooth shading on curved surfaces, a depth buffer, dark outlines on sharp edges, optional
// section cut, highlighted faces or bodies, and a small axis triad. Pure JS plus Node's zlib.
import zlib from 'node:zlib';
import { cutsFromSpec, keepsPoint } from './section.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]; };

/** Named views: the direction the camera sits in, relative to the model (Z is up; the front of a model faces -Y). */
export const VIEWS = {
  iso: [1, -1, 0.8], iso_back: [-1, 1, 0.8], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1],
};

const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0xc3c7cd; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function pngOf(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * @param bodies  [{ id, verts, tris, bbox, color?, opacity? }]  (color is '#rrggbb')
 * @param o  { view: name | { azimuth, elevation }, width, height, perspective, section: { axis, offset, flip } (keeps the side with the larger coordinate; flip keeps the other), or { origin, normal, flip } (cuts away the side the normal points to), or { box: { center, half } }, or an array of those (see section.js), highlight: { bodies: [ids], tris: { bodyId: [triangle indexes] } },
 *             edges: true, background: '#rrggbb', zoom }
 * @returns { png: Buffer, width, height, camera }
 */
export function renderPNG(bodies, o = {}) {
  const cuts = cutsFromSpec(o.section);
  const W = Math.max(64, Math.min(1600, Math.round(o.width || 800))), H = Math.max(64, Math.min(1600, Math.round(o.height || 600)));
  const SS = W * H > 700000 ? 1 : 2, w = W * SS, h = H * SS;
  const bg = hex(o.background || '#f4f5f7');
  // bounds of everything
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.bbox.min[k]); hi[k] = Math.max(hi[k], b.bbox.max[k]); }
  if (!bodies.length) { lo = [-10, -10, -10]; hi = [10, 10, 10]; }
  const ctr = lo.map((v, k) => (v + hi[k]) / 2), diag = Math.max(1e-3, len(sub(hi, lo)));
  // camera
  let dir;
  if (typeof o.view === 'object' && o.view) { const az = ((o.view.azimuth ?? 35) * Math.PI) / 180, el = ((o.view.elevation ?? 25) * Math.PI) / 180; dir = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)]; }
  else if (!o.view && cuts.length) { const n = cuts[0].n; dir = [0.25, -0.2, 0.3].map((v, k) => v + 1.4 * n[k] * (Math.abs(n[k]) > 0.9 ? 1 : 0.7)); } // by default look at the cut face (the cut faces away from the half that is kept)
  else dir = VIEWS[o.view || 'iso'] || VIEWS.iso;
  dir = unit(dir);
  const up0 = Math.abs(dir[2]) > 0.98 ? [0, 1, 0] : [0, 0, 1];
  const right = unit(cross(up0, dir)), up = cross(dir, right); // camera looks along -dir
  const persp = !!o.perspective, dist = diag * 2.2, eye = [ctr[0] + dir[0] * dist, ctr[1] + dir[1] * dist, ctr[2] + dir[2] * dist];
  const zoom = Math.max(0.2, Math.min(8, o.zoom || 1));
  const scale = (Math.min(w, h) / (diag * 1.15)) * zoom; // pixels per mm for ortho; for perspective see f below
  const f = scale * dist;
  const proj = (p) => {
    const q = sub(p, persp ? eye : ctr), x = dot(q, right), y = dot(q, up), depth = persp ? -dot(q, dir) : -dot(q, dir) + dist; // depth grows away from the camera
    const s = persp ? f / Math.max(1e-6, depth) : scale;
    return [w / 2 + x * s, h / 2 - y * s, depth];
  };
  const clipPlane = cuts.length > 0;
  const keep = (p) => keepsPoint(cuts, p); // the side that stays

  const rgb = new Float32Array(w * h * 3), zb = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  const light = unit([0.4, -0.55, 0.75]), fill = unit([-0.6, 0.3, 0.3]);
  const hlBodies = new Set(o.highlight?.bodies || []);
  const drawEdges = o.edges !== false;
  const edgeSegs = [];

  for (const b of bodies) {
    const T = b.tris.length / 3, V = b.verts;
    const P = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
    const tn = new Array(T);
    for (let t = 0; t < T; t++) tn[t] = unit(cross(sub(P(b.tris[t * 3 + 1]), P(b.tris[t * 3])), sub(P(b.tris[t * 3 + 2]), P(b.tris[t * 3]))));
    // smooth shading: average with neighbouring triangles that turn by less than 35 degrees (welded by position)
    const key = (p) => `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)},${Math.round(p[2] * 500)}`;
    const at = new Map();
    for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) { const kk = key(P(b.tris[t * 3 + k])); (at.get(kk) || at.set(kk, []).get(kk)).push(t); }
    const COS = Math.cos((35 * Math.PI) / 180);
    const vn = (t, k) => { let s = [0, 0, 0]; for (const q of at.get(key(P(b.tris[t * 3 + k])))) if (dot(tn[q], tn[t]) > COS) s = [s[0] + tn[q][0], s[1] + tn[q][1], s[2] + tn[q][2]]; return unit(s); };
    // sharp edges: shared by two triangles that turn by more than 20 degrees, or by only one
    if (drawEdges && T < 250000) {
      const em = new Map();
      for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
        const a = key(P(b.tris[t * 3 + k])), c = key(P(b.tris[t * 3 + (k + 1) % 3])), ek = a < c ? a + '|' + c : c + '|' + a;
        const e = em.get(ek); if (e) e.n.push(t); else em.set(ek, { n: [t], a: P(b.tris[t * 3 + k]), b: P(b.tris[t * 3 + (k + 1) % 3]) });
      }
      for (const e of em.values()) if (e.n.length === 1 || dot(tn[e.n[0]], tn[e.n[1]]) < Math.cos((20 * Math.PI) / 180)) if (keep(e.a) && keep(e.b)) edgeSegs.push([e.a, e.b]);
    }
    const base = hex(b.color), hlTris = new Set(o.highlight?.tris?.[b.id] || []), body_hl = hlBodies.has(b.id);
    for (let t = 0; t < T; t++) {
      const A = P(b.tris[t * 3]), B = P(b.tris[t * 3 + 1]), C = P(b.tris[t * 3 + 2]);
      if (clipPlane && !(keep(A) || keep(B) || keep(C))) continue; // wholly on the cut-away side; triangles across the cut are trimmed per pixel below
      const pa = proj(A), pb = proj(B), pc = proj(C);
      if (persp && (pa[2] < 1e-3 || pb[2] < 1e-3 || pc[2] < 1e-3)) continue;
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
      if (Math.abs(area) < 1e-9) continue;
      const facing = dot(tn[t], persp ? sub(eye, A) : dir) > 0; // front of the triangle toward the camera?
      const n0 = vn(t, 0), n1 = vn(t, 1), n2 = vn(t, 2);
      const x0 = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0]))), x1 = Math.min(w - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1]))), y1 = Math.min(h - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      const tint = body_hl || hlTris.has(t) ? [224, 69, 58] : null;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((pb[0] - px) * (pc[1] - py) - (pc[0] - px) * (pb[1] - py)) / area, w1 = ((pc[0] - px) * (pa[1] - py) - (pa[0] - px) * (pc[1] - py)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2], zi = y * w + x;
        if (z >= zb[zi]) continue;
        if (clipPlane && !keepsPoint(cuts, [w0 * A[0] + w1 * B[0] + w2 * C[0], w0 * A[1] + w1 * B[1] + w2 * C[1], w0 * A[2] + w1 * B[2] + w2 * C[2]])) continue; // the cut-away side
        zb[zi] = z;
        let r, g, bl;
        if (!facing && clipPlane) { r = 214; g = 96; bl = 64; } // the inside of a cut: shown in orange so the cut reads clearly
        else {
          let n = [w0 * n0[0] + w1 * n1[0] + w2 * n2[0], w0 * n0[1] + w1 * n1[1] + w2 * n2[1], w0 * n0[2] + w1 * n1[2] + w2 * n2[2]];
          n = unit(n); if (!facing) n = [-n[0], -n[1], -n[2]];
          const view = persp ? unit(sub(eye, [0, 0, 0])) : dir; void view;
          const sh = 0.28 + 0.62 * Math.max(0, dot(n, light)) + 0.25 * Math.max(0, dot(n, fill)) + 0.18 * Math.max(0, dot(n, dir));
          const k = Math.min(1.15, sh);
          const c = tint ? [tint[0] * 0.55 + base[0] * 0.45, tint[1] * 0.55 + base[1] * 0.45, tint[2] * 0.55 + base[2] * 0.45] : base;
          r = c[0] * k; g = c[1] * k; bl = c[2] * k;
        }
        rgb[zi * 3] = r; rgb[zi * 3 + 1] = g; rgb[zi * 3 + 2] = bl;
      }
    }
  }
  // outlines
  const line = (p, q, col, bias) => {
    let [x0, y0, z0] = p; const [x1, y1, z1] = q;
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    if (n > 8 * Math.max(w, h)) return;
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t), z = z0 + (z1 - z0) * t;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const zi = y * w + x;
      if (bias !== null && z > zb[zi] + bias) continue;
      rgb[zi * 3] = col[0]; rgb[zi * 3 + 1] = col[1]; rgb[zi * 3 + 2] = col[2];
    }
  };
  const bias = diag * 0.004 * (persp ? 1 : 1);
  for (const [a, b] of edgeSegs) line(proj(a), proj(b), [38, 44, 52], bias);
  // axis triad in the lower-left corner
  const tri = (v, col) => { const o0 = [64 * SS, h - 64 * SS], s = 38 * SS, x = dot(v, right), y = dot(v, up); line([o0[0], o0[1], 0], [o0[0] + x * s, o0[1] - y * s, 0], col, null); };
  tri([1, 0, 0], [224, 69, 58]); tri([0, 1, 0], [53, 168, 83]); tri([0, 0, 1], [47, 127, 224]);
  // downsample
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0; for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) s += rgb[((y * SS + dy) * w + (x * SS + dx)) * 3 + c];
    out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(s / (SS * SS))));
  }
  return { png: pngOf(W, H, out), width: W, height: H, camera: { direction: dir.map((v) => +v.toFixed(3)), centre: ctr.map((v) => +v.toFixed(2)), perspective: persp } };
}
