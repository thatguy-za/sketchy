// What a beginner needs to know before printing: the printer settings that matter (nozzle, layer height, fit tolerance, material),
// plain-language findings from the print checks, and the best way up to lay a part on the bed. Pure functions; main.js draws them.
import { overhangs } from './printcheck.js';
import { materialById, DEFAULT_DENSITY } from './materials.js';

export const DEFAULT_PROFILE = { nozzle: 0.4, layer: 0.2, tol: 0.2, material: 'pla' };
export const NOZZLES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
export const FITS = [['tight', 'Tight', 0.1, 'Parts press together'], ['normal', 'Normal', 0.2, 'Parts slide together'], ['loose', 'Loose', 0.3, 'Parts move freely']];

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
/** A profile with every field present and inside a sensible range. */
export function cleanProfile(p = {}) {
  return {
    nozzle: clamp(p.nozzle, 0.1, 2, DEFAULT_PROFILE.nozzle),
    layer: clamp(p.layer, 0.04, 1.2, DEFAULT_PROFILE.layer),
    tol: clamp(p.tol, 0, 1, DEFAULT_PROFILE.tol),
    material: materialById(p.material)?.group === 'Printing' ? p.material : DEFAULT_PROFILE.material,
  };
}

// The profile lives in the design as three ordinary parameters, so an expression like "6 mm + 2 * tol" works in any field.
const PARAM_DEFS = [
  ['nozzle', 'Nozzle diameter of the printer'],
  ['layer', 'Layer height'],
  ['tol', 'Fit tolerance: the gap to leave on each side where parts meet'],
];
/** The parameters list with nozzle, layer and tol set from the profile (other parameters are kept as they are). */
export function withProfileParams(params, profile) {
  const p = cleanProfile(profile), out = (params || []).map((x) => ({ ...x }));
  for (const [name, comment] of PARAM_DEFS) {
    const expr = `${+p[name].toFixed(3)} mm`, at = out.findIndex((x) => x.name === name);
    if (at >= 0) out[at] = { ...out[at], expr }; else out.push({ name, expr, unit: 'length', comment });
  }
  return out;
}
/** The profile a design's parameters describe (missing ones fall back to the defaults), or null when it has none of them. */
export function profileOfParams(params) {
  const get = (n) => { const x = (params || []).find((q) => q.name === n); const v = x && parseFloat(String(x.expr)); return Number.isFinite(v) ? v : undefined; };
  const n = get('nozzle'), l = get('layer'), t = get('tol');
  return n === undefined && l === undefined && t === undefined ? null : cleanProfile({ nozzle: n, layer: l, tol: t });
}

/** The thinnest wall that prints reliably: three perimeters. */
export const minWallFor = (p) => +(3 * cleanProfile(p).nozzle).toFixed(2);
/** The smallest hole worth printing: smaller than about two nozzle widths closes up. */
export const minHoleFor = (p) => +(2 * cleanProfile(p).nozzle).toFixed(2);

/** Rough weight of a part: solid, and with a typical 15% infill and two perimeters. Both are estimates, not a slice. */
export function weightEstimate(volumeMm3, areaMm2, profile) {
  const p = cleanProfile(profile), d = (materialById(p.material)?.density ?? DEFAULT_DENSITY) / 1000; // g per mm³
  const shell = Math.min(volumeMm3, areaMm2 * p.nozzle * 2);
  const solid = volumeMm3 * d, typical = (shell + (volumeMm3 - shell) * 0.15) * d;
  const filamentM = (typical / d) / (Math.PI * 0.875 * 0.875) / 1000; // 1.75 mm filament
  return { solid, typical, filamentM };
}

// ---------------------------------------------------------------- lying flat
const ROTATIONS = [
  { r: [0, 0, 0], name: 'the way it is now' },
  { r: [90, 0, 0], name: 'tipped over 90° about X' }, { r: [-90, 0, 0], name: 'tipped over −90° about X' }, { r: [180, 0, 0], name: 'upside down' },
  { r: [0, 90, 0], name: 'tipped over 90° about Y' }, { r: [0, -90, 0], name: 'tipped over −90° about Y' },
];
const rotMatrix = ([rx, ry, rz]) => { // the order the Move feature uses: X, then Y, then Z
  const c = (d) => Math.cos((d * Math.PI) / 180), s = (d) => Math.sin((d * Math.PI) / 180);
  const X = [[1, 0, 0], [0, c(rx), -s(rx)], [0, s(rx), c(rx)]], Y = [[c(ry), 0, s(ry)], [0, 1, 0], [-s(ry), 0, c(ry)]], Z = [[c(rz), -s(rz), 0], [s(rz), c(rz), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  return mul(Z, mul(Y, X));
};
/** The body turned about the middle of its box by `rot` degrees, then dropped so its lowest point touches z = 0. */
export function turned(body, rot) {
  const { min, max } = body.bbox, c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2), M = rotMatrix(rot), V = new Float32Array(body.verts.length);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < V.length; i += 3) {
    const q = [body.verts[i] - c[0], body.verts[i + 1] - c[1], body.verts[i + 2] - c[2]];
    for (let k = 0; k < 3; k++) V[i + k] = M[k][0] * q[0] + M[k][1] * q[1] + M[k][2] * q[2] + c[k];
    lo = Math.min(lo, V[i + 2]); hi = Math.max(hi, V[i + 2]);
  }
  for (let i = 2; i < V.length; i += 3) V[i] -= lo;
  return { verts: V, tris: body.tris, height: hi - lo, lift: -lo };
}
/** The Move feature's rotation and translation that stand a body on the plate turned by `rot`. */
export const placement = (body, rot) => ({ r: rot, t: [0, 0, +turned(body, rot).lift.toFixed(4)] });
/**
 * Try the six ways of standing the bodies on an edge or face and rank them by how much would need supports. Returns the list
 * best first: { r, name, overhang (fraction of the surface), supportVolume, height }. Use placement() for the Move feature that does it.
 */
export function orientations(bodies, angle = 45) {
  const out = ROTATIONS.map((o) => {
    let area = 0, total = 0, vol = 0, height = 0;
    for (const b of bodies) {
      const t = turned(b, o.r), ov = overhangs([{ verts: t.verts, tris: t.tris }], angle, 0);
      area += ov.area; total += ov.total; vol += ov.supportVolume; height = Math.max(height, t.height);
    }
    return { ...o, overhang: total ? area / total : 0, supportVolume: vol, height };
  });
  const cur = out[0];
  // a turn must beat the way it lies now by a clear margin, or the part stays as it is
  out.sort((a, b) => (a.supportVolume + a.height * 1e-3) - (b.supportVolume + b.height * 1e-3));
  const best = out[0];
  return { current: cur, best: best === cur || best.supportVolume > cur.supportVolume * 0.8 - 1 ? cur : best, all: out };
}

// ---------------------------------------------------------------- plain-language findings
/**
 * Findings as { level: 'ok'|'warn'|'bad', title, detail, fix? }. `fit` is bedFit()'s result, `over` is overhangs()'s, `wall` is
 * wallThickness()'s (or null when it has not been run), `turn` is orientations()'s.
 */
export function findings({ fit, over, wall, turn, profile, bedName, count, fmtLen }) {
  const p = cleanProfile(profile), list = [], f = fmtLen || ((v) => `${+v.toFixed(2)} mm`);
  if (!count) return [{ level: 'warn', title: 'Nothing to check yet', detail: 'Make a part first, then come back.' }];
  if (fit.fitsAll) list.push({ level: 'ok', title: `Fits your ${bedName}`, detail: count > 1 ? `All ${count} parts fit on one plate.` : 'The part fits on the bed.' });
  else if (fit.tooBig.length) list.push({ level: 'bad', title: `Too big for your ${bedName}`, detail: `${fit.tooBig.map((t) => `${t.name} is ${t.why}`).join('; ')}. Make it smaller (Scale), or split it into pieces (Split body) and glue them.`, fix: { id: 'scale', label: 'Scale it down' } });
  else list.push({ level: 'warn', title: `Needs ${fit.plates} print runs`, detail: 'Each part fits the bed, but not all at once. Print them one plate at a time.' });
  const needs = over.fraction > 0.15 && over.supportVolume > 0;
  if (!needs) list.push({ level: 'ok', title: 'Prints without supports', detail: over.area ? `${(over.fraction * 100).toFixed(0)}% of the surface slopes steeply, which most printers manage.` : 'Nothing hangs out in the air.' });
  else if (turn && turn.best !== turn.current) list.push({ level: 'warn', title: 'Needs supports as it lies', detail: `${(over.fraction * 100).toFixed(0)}% of the surface hangs in the air. The best other way up is ${turn.best.name}, where it drops to ${(turn.best.overhang * 100).toFixed(0)}%.`, fix: { id: 'lay-flat', label: 'Lay it that way' } });
  else list.push({ level: 'warn', title: 'Needs supports', detail: `${(over.fraction * 100).toFixed(0)}% of the surface hangs in the air and no other way up is better. Turn supports on in your slicer, or reshape the overhangs with a chamfer or fillet (a 45° slope prints without support).` });
  if (wall) {
    const min = minWallFor(p);
    if (wall.min === Infinity) list.push({ level: 'ok', title: 'Walls', detail: 'No walls found to measure.' });
    else if (wall.thin.length / Math.max(1, wall.samples.length) >= TIP_SHARE) list.push({ level: wall.min < p.nozzle ? 'bad' : 'warn', title: 'Some walls are too thin', detail: `The thinnest is ${f(wall.min)}. With a ${p.nozzle} mm nozzle aim for at least ${f(min)}. They are marked in red.` });
    else if (wall.thin.length) list.push({ level: 'ok', title: 'Walls are thick enough', detail: `Only a few sharp tips are thinner (down to ${f(wall.min)}, marked in red). That is normal where two surfaces meet at an angle.` });
    else list.push({ level: 'ok', title: 'Walls are thick enough', detail: `The thinnest is ${f(wall.min)}, above the ${f(min)} that a ${p.nozzle} mm nozzle needs.` });
  }
  return list;
}
/** Below this share of thin sample points the thin spots are tips and sharp edges, not walls. */
const TIP_SHARE = 0.01;
export const verdict = (list) => (list.some((x) => x.level === 'bad') ? 'bad' : list.some((x) => x.level === 'warn') ? 'warn' : 'ok');
