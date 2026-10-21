// The wedge that a fillet or chamfer removes (or, on a concave edge, adds), built from the two faces along a chain of sharp mesh edges: the
// section is lofted along the chain as triangles. The exact kernel uses it when OpenCascade's own fillet or chamfer cannot be built (an edge that
// runs into a rounded corner, for instance); the result is a faceted solid cut from or fused to the body. Pure geometry, no kernel.
const v3norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((c) => c / l); };
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vscl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

function edgeRing(E, fr, kind, sizeIn, arcSteps, opts = {}) {
  const { n1, n2, u1, u2 } = fr;
  const convex = vdot(n1, u2) < 0;
  const alpha = Math.acos(Math.max(-1, Math.min(1, vdot(u1, u2))));
  let size = sizeIn;
  if (kind === 'fillet' && opts.chord) size = opts.chord / (2 * Math.cos(alpha / 2)); // the straight distance between the two tangent points, so the radius follows the angle of the edge
  let t1 = kind === 'fillet' ? size / Math.tan(alpha / 2) : size, t2 = t1;
  if (kind === 'chamfer' && opts.chamfer) { // two distances, or one distance and an angle from the first face
    const o = opts.chamfer;
    let a = size, b = o.mode === 'angle' ? (size * Math.sin(o.angle)) / Math.sin(alpha + o.angle) : o.d2;
    if (!(b > 0) || !Number.isFinite(b)) b = a;
    if (o.flip) [a, b] = [b, a];
    t1 = a; t2 = b;
  }
  const t = Math.max(t1, t2);
  const T1 = vadd(E, vscl(u1, t1)), T2 = vadd(E, vscl(u2, t2));
  const sg = convex ? 1 : -1;
  const delta = Math.max(0.05 * Math.max(size, t), opts.minDelta ?? 0.01);
  const A1 = vadd(T1, vscl(n1, sg * delta)), A2 = vadd(T2, vscl(n2, sg * delta));
  const X = vadd(E, vscl(vadd(n1, n2), sg * delta));
  const ring = [T1];
  if (kind === 'fillet') {
    const b = v3norm(vadd(u1, u2));
    const C = vadd(E, vscl(b, size / Math.sin(alpha / 2)));
    const v1 = vsub(T1, C), v2 = vsub(T2, C);
    const D = Math.PI - alpha, sD = Math.sin(D);
    for (let j = 1; j < arcSteps; j++) {
      const s = j / arcSteps;
      const w = sD < 1e-3 ? [1 - s, s] : [Math.sin((1 - s) * D) / sD, Math.sin(s * D) / sD];
      ring.push(vadd(C, vadd(vscl(v1, w[0]), vscl(v2, w[1]))));
    }
  }
  ring.push(T2, A2, X, A1);
  return { ring, fan: ring.length - 2, convex };
}

export function edgeCutter(ch, kind, sizeIn, opts = {}) {
  const steps = kind === 'fillet' ? 12 : 0;
  const varying = typeof sizeIn === 'object' && !ch.closed;
  const r0 = varying ? sizeIn.r0 : typeof sizeIn === 'object' ? sizeIn.r0 : sizeIn, r1 = varying ? sizeIn.r1 : r0;
  const size = Math.max(r0, r1);
  const delta = Math.max(0.05 * size, opts.minDelta ?? 0.01);
  let pts = ch.pts, frames = ch.frames;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(...vsub(pts[i], pts[i - 1])));
  let sizes = cum.map((c) => r0 + (r1 - r0) * (cum.at(-1) ? c / cum.at(-1) : 0));
  if (!ch.closed) {
    sizes = [sizes[0], ...sizes, sizes.at(-1)];
    const d0 = v3norm(vsub(pts[1], pts[0])), dn = v3norm(vsub(pts[pts.length - 1], pts[pts.length - 2]));
    pts = [vsub(pts[0], vscl(d0, delta)), ...pts, vadd(pts[pts.length - 1], vscl(dn, delta))];
    frames = [frames[0], ...frames, frames[frames.length - 1]];
  }
  const convex = vdot(frames[0].n1, frames[0].u2) < 0;
  const rings = pts.map((p, i) => edgeRing(p, frames[i], kind, sizes[i], steps, opts).ring);
  const m = rings[0].length, fan = m - 2;
  const verts = rings.flat(2);
  const tris = [];
  const R = rings.length;
  const segs = ch.closed ? R : R - 1;
  for (let k = 0; k < segs; k++) {
    const a = k * m, b = ((k + 1) % R) * m;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      tris.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  if (!ch.closed) {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      if (i === fan || j === fan) continue;
      tris.push((R - 1) * m + fan, (R - 1) * m + i, (R - 1) * m + j); // end cap
      tris.push(fan, j, i); // start cap
    }
  }
  return { verts: Float32Array.from(verts), tris: Uint32Array.from(tris), convex };
}
