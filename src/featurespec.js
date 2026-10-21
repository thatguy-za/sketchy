// What the mesh kernel (kernel.js) and the exact kernel (backend-brep.js) both need to decide about a feature before they build
// anything, written once so the two cannot drift apart: how far and in which direction an extrude goes, where a revolve's axis is,
// how the picked edges of a fillet or chamfer are reported, and how a new solid is added to, cut from or intersected with the bodies
// (Join / Cut / Intersect / New body / Automatic). Nothing here touches a solid directly; the kernels hand in the few operations
// they need (see makeApplyOp).
import { planeFrame } from './kernel.js';
import { sub, dot } from './solids.js';

export const BIGDIST = 5000;

/**
 * The slabs an Extrude fills, as [z0, z1] ranges along the sketch normal (z = 0 is the sketch plane), for the plain case (no taper,
 * twist or end scale). `bodyBox(id)` gives the bounds of a body, for "to object". Throws the user-facing reason when it cannot.
 */
export function extrudeRanges(p, sk, bodyBox) {
  const fr = planeFrame(sk.params);
  let dist = p.distance || 0;
  const dirSign = p.extent && p.extent !== 'distance' ? (p.flip ? -1 : 1) : dist < 0 ? -1 : 1;
  if (p.extent === 'all') dist = dirSign * BIGDIST;
  else if (p.extent === 'object') {
    const bb = bodyBox(p.toBody), ds = [];
    for (const cx of [bb.min[0], bb.max[0]]) for (const cy of [bb.min[1], bb.max[1]]) for (const cz of [bb.min[2], bb.max[2]]) ds.push(dirSign * dot(sub([cx, cy, cz], fr.o), fr.n));
    const far = Math.max(...ds), near = Math.min(...ds);
    if (far <= 1e-6) throw new Error('The object is behind the profile — flip the direction');
    dist = dirSign * (near <= 1e-6 || p.op === 'cut' ? far : near);
  }
  const d = Math.abs(dist) || 1e-3;
  const mode = p.direction || (p.symmetric ? 'symmetric' : 'one'); // one side, both sides equally, or two sides with their own distance
  const off = p.start === 'offset' && p.startOffset ? p.startOffset : 0; // begin the extrusion off the profile plane
  let ranges;
  if (mode === 'symmetric') ranges = [[-d / 2, d / 2]];
  else if (mode === 'two') {
    const d2 = p.extent2 === 'all' ? BIGDIST : Math.abs(p.distance2 ?? 0);
    if (!(d2 > 0)) throw new Error('Side 2 needs a distance');
    ranges = [[Math.min(0, dirSign * d), Math.max(0, dirSign * d)], [Math.min(0, -dirSign * d2), Math.max(0, -dirSign * d2)]];
  } else ranges = [dist < 0 ? [-d, 0] : [0, d]];
  return { ranges: ranges.map(([a, b]) => [a + off, b + off]), mode, d, dist, dirSign, off };
}

/** The revolve axis in sketch coordinates: a point on it (o2) and its direction in degrees (th). Throws the user-facing reason when it cannot be found. */
export function revolveAxis(p, sk, features) {
  let o2 = [0, 0], th = 90; // the sketch's Y axis by default
  if (p.axis === 'x') th = 0;
  else if (p.axis && !['x', 'y', 'centerline'].includes(p.axis)) { // a construction axis: its direction in the sketch plane
    const ax = features.find((x) => x.id === p.axis && x.type === 'axis');
    if (!ax || ax.params.error) throw new Error('The axis you picked no longer exists or could not be built');
    const fr = planeFrame(sk.params), dd = ax.params.dir, rel = sub(ax.params.origin, fr.o);
    const dir2 = [dot(dd, fr.x), dot(dd, fr.y)];
    if (Math.hypot(...dir2) < 1e-6) throw new Error('That axis points straight out of the sketch plane, so it cannot be a revolve axis.');
    o2 = [dot(rel, fr.x), dot(rel, fr.y)];
    th = (Math.atan2(dir2[1], dir2[0]) * 180) / Math.PI;
  } else if (p.axis === 'centerline') {
    const cl = (sk.params.shapes || []).find((x) => x.lt === 'centerline' && x.t === 'path' && x.pts?.length >= 2);
    if (!cl) throw new Error('This sketch has no centerline. Draw a line and set its line type to Centerline, or choose another axis.');
    o2 = [cl.pts[0][0], cl.pts[0][1]];
    th = (Math.atan2(cl.pts[1][1] - cl.pts[0][1], cl.pts[1][0] - cl.pts[0][0]) * 180) / Math.PI;
  }
  return { o2, th };
}
/** Full or partial, and by how much (degrees). */
export function revolveSweep(p) {
  const partial = (p.extent || (p.angle >= 360 ? 'full' : 'partial')) === 'partial';
  return { partial, ang: partial ? Math.min(Math.max(p.angle || 0, 1e-3), 360) : 360, mode: p.direction || 'one' };
}

/** What a Fillet or Chamfer asks for, checked: the size and the picked edges grouped by body. Throws the user-facing reason. */
export function edgeFeatureSpec(f) {
  const p = f.params, size0 = f.type === 'fillet' ? p.radius : p.distance;
  if (!p.edges?.length) throw new Error('Select at least one edge in the viewport');
  if (!(size0 > 0)) throw new Error('Size must be positive');
  const byBody = new Map();
  for (const e of p.edges) byBody.set(e.body, [...(byBody.get(e.body) || []), e]);
  return { size0, byBody, tangent: !!p.tangent };
}
/** After the edges were looked up: throws when none of them was found, otherwise returns the warning (or undefined) for the picked edges that were not. */
export function lostEdgesOutcome(lostIdx, total) {
  if (!lostIdx?.length) return undefined;
  const n = lostIdx.length;
  if (n === total) throw new Error(`None of the ${total} picked edge${total > 1 ? 's' : ''} could be found any more, because an earlier feature changed the shape. Pick the edges again.`);
  return [{ text: `${n} of ${total} picked edges could not be found after an earlier change, so they were skipped.`, action: 'repick' }];
}

/**
 * The part of Extrude, Revolve, Sweep, Loft and friends that is the same on every kernel: what happens to the bodies when a new
 * solid arrives. `c` gives the state (live bodies, notes, warnings, preview) and `ops` the few operations on a solid:
 *   get(b) set(b, solid)                       read and replace a body's solid
 *   isEmpty(s) volume(s) bbox(s)
 *   intersectVolume(a, b)                      volume of what a and b share
 *   union(a, b) subtract(a, b) intersect(a, b) new solids (the kernel frees what it must)
 *   previewMesh(s)                             { verts, tris } for the dialog's preview
 */
export function makeApplyOp(c) {
  const { live, notes, warnings, ops, opts, addBody, getBody, state } = c;
  const names = (list) => list.map((b) => `"${b.name}"`).join(', ');
  const overlaps = (a, b, pad = 1e-3) => a.min.every((v, k) => v <= b.max[k] + pad && a.max[k] >= b.min[k] - pad);
  return (f, solid, op, target) => {
    const previewing = opts.previewId && opts.previewId === f.id;
    if (previewing) state.preview = { op, ...ops.previewMesh(solid) };
    if (op === 'auto') {
      let best = null, bv = 0;
      for (const b of live.values()) { const v = ops.intersectVolume(ops.get(b), solid); if (v > bv) { bv = v; best = b; } }
      if (best && bv > 1e-6 * Math.max(ops.volume(solid), 1e-9)) {
        if (previewing) state.preview.op = 'cut';
        ops.set(best, ops.subtract(ops.get(best), solid)); notes[f.id] = { op: 'cut', bodies: [best.id], text: `Automatic: cuts from ${names([best])}` };
        if (ops.isEmpty(ops.get(best))) live.delete(best.id);
        return;
      }
      const sb = ops.bbox(solid);
      const touch = [...live.values()].find((b) => overlaps(ops.bbox(ops.get(b)), sb));
      if (previewing) state.preview.op = 'join';
      if (touch) { ops.set(touch, ops.union(ops.get(touch), solid)); notes[f.id] = { op: 'join', bodies: [touch.id], text: `Automatic: joins ${names([touch])}` }; }
      else { addBody(f.id, solid, f.name); notes[f.id] = { op: 'new', bodies: [], text: 'Automatic: makes a new body (it does not touch anything)' }; }
      return;
    }
    const picked = (f.params?.targets || []).filter((id) => live.has(id)); // objects to cut: several bodies chosen in the dialog
    if (op === 'cut') {
      const ids = picked.length ? picked : !target || target === 'all' ? [...live.keys()] : [target];
      const hit = [];
      for (const id of ids) {
        const b = getBody(id), before = ops.volume(ops.get(b));
        ops.set(b, ops.subtract(ops.get(b), solid));
        if (Math.abs(before - (ops.isEmpty(ops.get(b)) ? 0 : ops.volume(ops.get(b)))) > 1e-9 * Math.max(before, 1)) hit.push(b);
        if (ops.isEmpty(ops.get(b))) live.delete(id);
      }
      const all = ids.map((id) => live.get(id) || { name: 'a removed body' });
      notes[f.id] = { op: 'cut', bodies: hit.map((b) => b.id), text: hit.length ? `Cuts from ${names(hit)}` : `Cuts from ${!target || target === 'all' ? 'all bodies' : names(all)}` };
      if (!hit.length) warnings[f.id] = [{ text: 'The cut does not touch any body, so nothing was removed. Move or extend it so it overlaps the body.' }];
    } else if (op === 'intersect' && picked.length > 1) {
      for (const id of picked) { const b = getBody(id); ops.set(b, ops.intersect(ops.get(b), solid)); }
      notes[f.id] = { op, bodies: picked, text: `Intersects ${names(picked.map((id) => live.get(id)))}` };
    } else if (op === 'join' || op === 'intersect') {
      const b = (target && live.get(target)) || (picked.length === 1 && live.get(picked[0])) || [...live.values()][0];
      if (!b) { addBody(f.id, solid, f.name); notes[f.id] = { op: 'new', bodies: [], text: 'No body to join, so this makes a new body' }; }
      else {
        ops.set(b, op === 'join' ? ops.union(ops.get(b), solid) : ops.intersect(ops.get(b), solid));
        notes[f.id] = { op, bodies: [b.id], text: `${op === 'join' ? 'Joins' : 'Intersects'} ${names([b])}${target && live.get(target) ? '' : ' (the first body, since none was chosen)'}` };
      }
    } else { addBody(f.id, solid, f.name); notes[f.id] = { op: 'new', bodies: [], text: 'Makes a new body' }; }
  };
}
