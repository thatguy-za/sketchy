// Section analysis cut planes, shared by the app's viewport and the software renderer behind render_view.
// A cut is { o: [x, y, z], n: [x, y, z] }: a point on the plane and the unit normal of the side that is cut away.

export const MAX_CUTS = 6;
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
const num3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(+x)) ? v.map(Number) : null;

/** The six cuts of a box (centre and half sizes, in mm): everything outside it is cut away. */
export function boxCuts(center, half) {
  const c = num3(center), h = num3(half);
  if (!c || !h || h.some((x) => !(x > 0))) return [];
  const out = [];
  for (let k = 0; k < 3; k++) for (const s of [1, -1]) { const n = [0, 0, 0]; n[k] = s; const o = c.slice(); o[k] += s * h[k]; out.push({ o, n }); }
  return out;
}

/**
 * Cuts from a request: { axis, offset, flip } (the render_view form: keeps the larger coordinate, flip keeps the smaller), { origin, normal, offset?, flip }
 * (the side `normal` points to is cut away; offset moves the plane along the normal; flip reverses the side), { box: { center, half } }, or an array of these (six cuts at most).
 * Throws a message that names what is wrong.
 */
export function cutsFromSpec(spec) {
  if (spec == null) return [];
  if (Array.isArray(spec)) { const all = spec.flatMap((s) => cutsFromSpec(s)); if (all.length > MAX_CUTS) throw new Error(`At most ${MAX_CUTS} section planes`); return all; }
  if (typeof spec !== 'object') throw new Error('A section is an object');
  if (spec.box) { const c = boxCuts(spec.box.center, spec.box.half); if (!c.length) throw new Error('A section box needs a centre [x, y, z] and positive half sizes [x, y, z]'); return c; }
  if (spec.axis !== undefined) {
    const a = 'xyz'.indexOf(String(spec.axis).toLowerCase());
    if (a < 0) throw new Error('Section axis must be x, y or z');
    const n = [0, 0, 0]; n[a] = spec.flip ? 1 : -1;
    const o = [0, 0, 0]; o[a] = +spec.offset || 0;
    return [{ o, n }];
  }
  const o = num3(spec.origin), n0 = num3(spec.normal) && unit(num3(spec.normal));
  if (!o || !n0) throw new Error('A section plane needs an origin [x, y, z] and a non-zero normal [x, y, z], or an axis and offset');
  const off = +spec.offset || 0; // along the normal: a plane through a face, moved into the part
  const o2 = o.map((v, k) => v + n0[k] * off);
  return [{ o: o2, n: spec.flip ? n0.map((v) => -v) : n0 }];
}

/** Whether a point stays (is not on the cut-away side of any cut). */
export const keepsPoint = (cuts, p, eps = 1e-9) => cuts.every((c) => c.n[0] * (p[0] - c.o[0]) + c.n[1] * (p[1] - c.o[1]) + c.n[2] * (p[2] - c.o[2]) <= eps);
