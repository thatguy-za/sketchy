// Asking a built model questions: which faces and edges does it have, where, how big, how far apart. Used by the MCP tools
// so an assistant can pick faces and edges by describing them ("the top face", "the vertical edges") instead of by coordinates.
// Everything here works on the bodies a rebuild returns ({ id, name, verts, tris, bbox }), in mm.
import { planarFace, curvedFace, findEdgeChains, edgeRef, norm as unit } from './edges.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const r3 = (v) => v.map((c) => +c.toFixed(3));
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** '+z', '-x', 'up', 'down', 'front', ... or a vector, as a unit vector (or null). */
export function directionOf(d) {
  if (Array.isArray(d) && d.length === 3 && d.every(Number.isFinite) && len(d) > 0) return unit(d);
  const s = String(d || '').toLowerCase().trim();
  const NAMED = { up: [0, 0, 1], top: [0, 0, 1], down: [0, 0, -1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
  if (NAMED[s]) return NAMED[s];
  const m = /^([+-]?)([xyz])$/.exec(s);
  return m ? scl(AXES[m[2]], m[1] === '-' ? -1 : 1) : null;
}

const vtx = (b, t, k) => [b.verts[b.tris[t * 3 + k] * 3], b.verts[b.tris[t * 3 + k] * 3 + 1], b.verts[b.tris[t * 3 + k] * 3 + 2]];
const triArea = (b, t) => len(cross(sub(vtx(b, t, 1), vtx(b, t, 0)), sub(vtx(b, t, 2), vtx(b, t, 0)))) / 2;
const triCentre = (b, t) => scl(add(add(vtx(b, t, 0), vtx(b, t, 1)), vtx(b, t, 2)), 1 / 3);

/** Every face of a body: flat faces and curved faces, each with a ref you can pass to a feature that takes a face. */
export function listFaces(body) {
  const T = body.tris.length / 3, seen = new Uint8Array(T), out = [];
  for (let t = 0; t < T; t++) {
    if (seen[t]) continue;
    const f = planarFace(body.verts, body.tris, t) || curvedFace(body.verts, body.tris, t);
    if (!f) { seen[t] = 1; continue; }
    for (const q of f.tris) seen[q] = 1;
    let area = 0, c = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const q of f.tris) {
      const a = triArea(body, q), ct = triCentre(body, q);
      area += a; c = add(c, scl(ct, a));
      for (let k = 0; k < 3; k++) { const v = vtx(body, q, k); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); } }
    }
    c = scl(c, 1 / (area || 1));
    const curved = !!f.curved;
    // a flat face: any point on its plane will do, and its centroid is the steadiest choice; a curved face keeps its canonical point
    const point = curved ? f.point : r3(c), normal = r3(f.normal);
    out.push({ kind: curved ? 'curved' : 'planar', ref: { body: body.id, point, normal, ...(curved ? { curved: true } : {}) }, normal, area: +area.toFixed(3), centroid: r3(c), bbox_min: r3(lo), bbox_max: r3(hi), triangles: f.tris.length });
  }
  return out;
}

/**
 * Faces of a body filtered by a description. filter: { type: 'planar'|'curved', normal: '+z'|'up'|[x,y,z], angle_tol (degrees, default 10),
 * at: { axis: 'x'|'y'|'z', value, tol }, near: { point, radius }, min_area, largest: n, limit }.
 */
export function findFaces(body, filter = {}) {
  let faces = listFaces(body);
  const f = filter || {};
  if (f.type === 'planar' || f.type === 'curved') faces = faces.filter((x) => x.kind === f.type);
  if (f.normal !== undefined) {
    const want = directionOf(f.normal); if (!want) throw new Error(`filter.normal "${JSON.stringify(f.normal)}" is not a direction. Use "+z", "-x", "up", "down", "front", "back", "left", "right" or [x, y, z].`);
    const tol = Math.cos(((f.angle_tol ?? 10) * Math.PI) / 180);
    faces = faces.filter((x) => x.kind === 'planar' && dot(x.normal, want) >= tol);
  }
  if (f.at) {
    const ax = 'xyz'.indexOf(String(f.at.axis).toLowerCase()); if (ax < 0 || !Number.isFinite(f.at.value)) throw new Error('filter.at needs axis ("x", "y" or "z") and a numeric value.');
    const tol = f.at.tol ?? 0.05;
    faces = faces.filter((x) => (x.kind === 'planar' ? Math.abs(x.centroid[ax] - f.at.value) <= tol : x.bbox_min[ax] - tol <= f.at.value && f.at.value <= x.bbox_max[ax] + tol));
  }
  if (f.near) {
    if (!Array.isArray(f.near.point) || f.near.point.length !== 3) throw new Error('filter.near needs a point [x, y, z] and optionally a radius.');
    const rad = f.near.radius ?? 5;
    faces = faces.filter((x) => len(sub(x.centroid, f.near.point)) <= rad + len(sub(x.bbox_max, x.bbox_min)) / 2);
    faces.sort((a, b) => len(sub(a.centroid, f.near.point)) - len(sub(b.centroid, f.near.point)));
  }
  if (f.min_area) faces = faces.filter((x) => x.area >= f.min_area);
  if (f.largest) faces = [...faces].sort((a, b) => b.area - a.area).slice(0, f.largest);
  return faces.slice(0, Math.min(f.limit ?? 100, 200));
}

/** Edges of a body (the sharp ones: where faces meet at an angle), each with a ref for fillet / chamfer. */
export function listEdges(body) {
  const chains = findEdgeChains(body.verts, 3, body.tris);
  return chains.map((ch, i) => {
    const P = ch.pts, first = P[0], last = P[P.length - 1];
    let length = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k++) { if (k) length += len(sub(P[k], P[k - 1])); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[k][a]); hi[a] = Math.max(hi[a], P[k][a]); } }
    if (ch.closed) length += len(sub(first, last));
    const straight = !ch.closed && P.every((p) => len(cross(sub(p, first), sub(last, first))) < 1e-3 * Math.max(1, len(sub(last, first))));
    const mid = P[Math.floor(P.length / 2)];
    let kind = straight ? 'line' : ch.closed ? 'loop' : 'curve';
    let radius;
    if (!straight && P.length >= 6) { // a circle or an arc: every point the same distance from the middle of the points
      const c = scl(P.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / P.length), d = P.map((p) => len(sub(p, c))), mean = d.reduce((s, v) => s + v, 0) / d.length;
      if (mean > 1e-6 && d.every((v) => Math.abs(v - mean) < 0.03 * mean)) { kind = ch.closed ? 'circle' : 'arc'; radius = +mean.toFixed(3); }
    }
    return { kind, ref: edgeRef(body.id, ch), length: +length.toFixed(3), ...(straight ? { direction: r3(unit(sub(last, first))) } : {}), ...(radius ? { radius } : {}), midpoint: r3(mid), bbox_min: r3(lo), bbox_max: r3(hi), _i: i };
  });
}

/**
 * Edges filtered by a description. filter: { kind: 'line'|'circle'|'arc'|'curve'|'loop', direction: 'z'|'+z'|[x,y,z] (lines, either way round),
 * angle_tol, length_min, length_max, radius, at: { axis, value, tol } (on the midpoint), near: { point, radius }, on_face: <face ref>, limit }.
 */
export function findEdges(body, filter = {}) {
  let edges = listEdges(body);
  const f = filter || {};
  if (f.kind) edges = edges.filter((e) => e.kind === f.kind);
  if (f.direction !== undefined) {
    const want = directionOf(f.direction); if (!want) throw new Error(`filter.direction "${JSON.stringify(f.direction)}" is not a direction. Use "x", "y", "z", "+z", "up" or [x, y, z].`);
    const tol = Math.cos(((f.angle_tol ?? 5) * Math.PI) / 180);
    edges = edges.filter((e) => e.direction && Math.abs(dot(e.direction, want)) >= tol);
  }
  if (f.length_min !== undefined) edges = edges.filter((e) => e.length >= f.length_min - 1e-6);
  if (f.length_max !== undefined) edges = edges.filter((e) => e.length <= f.length_max + 1e-6);
  if (f.radius !== undefined) edges = edges.filter((e) => e.radius !== undefined && Math.abs(e.radius - f.radius) <= Math.max(0.05, 0.02 * f.radius));
  if (f.at) {
    const ax = 'xyz'.indexOf(String(f.at.axis).toLowerCase()); if (ax < 0 || !Number.isFinite(f.at.value)) throw new Error('filter.at needs axis ("x", "y" or "z") and a numeric value.');
    const tol = f.at.tol ?? 0.05;
    edges = edges.filter((e) => e.bbox_min[ax] - tol <= f.at.value && f.at.value <= e.bbox_max[ax] + tol); // the edge reaches that position
  }
  if (f.near) {
    if (!Array.isArray(f.near.point) || f.near.point.length !== 3) throw new Error('filter.near needs a point [x, y, z] and optionally a radius.');
    const rad = f.near.radius ?? 5;
    edges = edges.filter((e) => len(sub(e.midpoint, f.near.point)) <= rad + e.length / 2);
    edges.sort((a, b) => len(sub(a.midpoint, f.near.point)) - len(sub(b.midpoint, f.near.point)));
  }
  if (f.on_face) {
    const fr = f.on_face, n = unit(fr.normal || [0, 0, 1]), p0 = fr.point;
    if (!p0 || p0.length !== 3) throw new Error('filter.on_face must be a face ref from find_faces ({ point, normal }).');
    edges = edges.filter((e) => e.ref.pts.every((p) => Math.abs(dot(sub(p, p0), n)) < 0.05));
  }
  return edges.slice(0, Math.min(f.limit ?? 100, 300)).map(({ _i, ...e }) => e);
}

/** Volume, area, centre of mass and mass of a body (density in g/cm3). */
export function massProps(body, density = 1.24) {
  let vol = 0, c = [0, 0, 0], area = 0;
  const T = body.tris.length / 3;
  for (let t = 0; t < T; t++) {
    const a = vtx(body, t, 0), b = vtx(body, t, 1), cc = vtx(body, t, 2), v = dot(a, cross(b, cc)) / 6;
    vol += v; c = add(c, scl(add(add(a, b), cc), v / 4)); area += triArea(body, t);
  }
  const centre = Math.abs(vol) > 1e-9 ? scl(c, 1 / vol) : [0, 0, 0];
  return { volume_mm3: +vol.toFixed(3), surface_area_mm2: +area.toFixed(3), center_of_mass: r3(centre), mass_g: +((vol / 1000) * density).toFixed(2), density_g_cm3: density };
}

/** Distance and relationship between two things. Each is { point } or { face: { body, point, normal } } (from find_faces) or { body }. */
export function measure(bodies, a, b) {
  const faceOf = (x) => x?.face ? { n: unit(x.face.normal), p: x.face.point } : null;
  const pointOf = (x) => {
    if (x?.point) return x.point;
    if (x?.face) return x.face.point;
    if (x?.body) { const bd = bodies.find((q) => q.id === x.body); if (!bd) throw new Error(`No body "${x.body}". Call inspect_design for body ids.`); return bd.bbox.min.map((v, k) => (v + bd.bbox.max[k]) / 2); }
    throw new Error('Each thing to measure needs a "point", a "face" (from find_faces) or a "body".');
  };
  const fa = faceOf(a), fb = faceOf(b);
  if (fa && fb) {
    const d = dot(fa.n, fb.n);
    if (Math.abs(d) > 0.99999) return { relation: 'parallel faces', distance_mm: +Math.abs(dot(sub(fb.p, fa.p), fa.n)).toFixed(4) };
    return { relation: 'faces at an angle', angle_degrees: +((Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI).toFixed(3) };
  }
  const pa = pointOf(a), pb = pointOf(b), dv = sub(pb, pa);
  const out = { relation: 'points', distance_mm: +len(dv).toFixed(4), delta: r3(dv) };
  if (fa || fb) { const f = fa || fb, p = fa ? pb : pa, q = fa ? fa.p : fb.p; out.relation = 'point to face plane'; out.distance_mm = +Math.abs(dot(sub(p, q), f.n)).toFixed(4); delete out.delta; }
  return out;
}
