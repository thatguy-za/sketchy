// Headless design evaluation, shared by the MCP server (Node) and anything else that needs to replay a design
// without the UI: resolve parameters, run the kernel, summarise bodies and errors, build new features from the catalogue.
import { initKernel, rebuild } from './kernel.js';
import { FEATURES, defOf, fieldKind } from './features.js';
import { resolveParams, resolveFeature, applyConfig } from './params.js';
import { resolveSketch } from './sketchdims.js';
import { writeSTL } from './stl.js';

let ready = null;
export const initHeadless = () => (ready ||= initKernel());

const round = (v, n = 3) => +Number(v).toFixed(n);

/** Replay the whole timeline (or up to doc.marker) exactly like the UI does. */
export function evaluate(doc) {
  const ps = resolveParams(applyConfig(doc.params || [], doc.configs, doc.activeConfig));
  const evalErr = {};
  const feats = doc.features.map((f) => {
    const r = resolveFeature(f, (n) => ps.values[n], (ff, path) => (fieldKind(ff, path.split('.')[0]) === 'len' ? 'len' : 'num'));
    if (r.error) evalErr[f.id] = r.error;
    let ff = r.params === f.params ? f : { ...f, params: r.params };
    if (f.type === 'sketch') {
      const rs = resolveSketch(ff, (n) => ps.values[n]);
      if (rs.error) evalErr[f.id] ||= rs.error;
      if (rs.params !== ff.params) ff = { ...ff, params: rs.params };
    }
    return ff;
  });
  const result = rebuild(feats, feats.length, { bodyComp: doc.bodyComp }); // always the full timeline (ignores any UI roll-back marker)
  for (const [id, m] of Object.entries(evalErr)) result.errors[id] ||= m;
  return { result, resolved: feats, paramErrors: ps.errors || {} };
}

export function summarize(doc, result) {
  const names = Object.fromEntries(doc.features.map((f, i) => [f.id, `${f.name || f.type} (#${i + 1})`]));
  return {
    units: doc.units || 'mm',
    bodies: result.bodies.map((b) => ({
      id: b.id, name: b.name, volume_mm3: round(b.volume), surface_area_mm2: round(b.area || 0),
      bbox_min: b.bbox.min.map((v) => round(v)), bbox_max: b.bbox.max.map((v) => round(v)),
      size: b.bbox.max.map((v, k) => round(v - b.bbox.min[k])), triangles: b.tris.length / 3,
    })),
    surfaces: (result.surfaces || []).map((q) => ({ id: q.id, name: q.name, triangles: q.tris.length / 3, bbox_min: q.bbox.min.map((v) => round(v)), bbox_max: q.bbox.max.map((v) => round(v)) })),
    errors: Object.entries(result.errors).map(([id, message]) => ({ feature: id, name: names[id] || id, message })),
  };
}

/** Compact, LLM-friendly view of one feature. */
export function describeFeature(f, i) {
  const p = { ...f.params };
  if (p.data) p.data = `<${p.tris || '?'} triangles>`;
  return { index: i, id: f.id, type: f.type, name: f.name, suppressed: !!f.suppressed, params: p, ...(f.exprs ? { expressions: f.exprs } : {}) };
}

// ---- feature catalogue --------------------------------------------------------------------------------------------
const PICKS = new Set(['edges', 'face', 'faces', 'point']);
const fieldDoc = (fld) => ({
  key: fld.key, label: fld.label, kind: fld.type,
  ...(fld.options ? { options: fld.options.map(([v, l]) => (String(v) === String(l) ? v : `${v} (${l})`)) } : {}),
  ...(fld.min !== undefined ? { min: fld.min } : {}), ...(fld.max !== undefined ? { max: fld.max } : {}),
  ...(fld.type === 'body' ? { note: 'a body id from inspect_design' } : {}),
  ...(fld.type === 'sketch' ? { note: 'a sketch feature id' } : {}),
  ...(fld.type === 'bodies' ? { note: 'array of body ids from inspect_design' } : {}),
  ...(fld.type === 'surface' || fld.type === 'surfaces' ? { note: 'surface ids from inspect_design (open surface bodies)' } : {}),
  ...(fld.type === 'planeref' ? { note: 'XY, XZ, YZ or the id of an earlier plane feature' } : {}),
  ...(PICKS.has(fld.type) ? { note: 'a viewport pick in the UI; pass explicit geometry only if you know the format' } : {}),
});

/** key -> {label, stored type, defaults, fields} for every feature kind the UI can create. */
export function catalog() {
  const stub = { lastSketch: '', sketches: [], pathSketch: '', lastSketchOnFace: false, hasBodies: false, selected: '', other: '', topCenter: [0, 0, 0], selectedCenterZ: 0, centerA: [0, 0, 0], centerB: [0, 0, 0] };
  const out = {};
  for (const [key, d] of Object.entries(FEATURES)) {
    out[key] = {
      label: d.label, stored_type: d.type, group: d.group || 'feature',
      defaults: d.make(stub), fields: d.fields.filter((f) => f.type !== 'static').map((f) => fieldDoc(f.type === 'soltype' ? { ...f, type: 'bool', label: 'Thin extrude (wall only)' } : f)),
      ...(d.pickEdges || d.fields.some((f) => PICKS.has(f.type)) ? { needs_ui_picking: true } : {}),
      ...(d.needsBody ? { needs_body: true } : {}),
    };
  }
  return out;
}

/** Build a new feature record from a catalogue key. `overrides` replaces defaults field by field. */
export function makeFeature(doc, result, key, overrides = {}, name) {
  const def = FEATURES[key];
  if (!def) throw new Error(`Unknown feature kind "${key}". Call describe_feature_types for the list.`);
  const bodies = result.bodies;
  const sketches = doc.features.filter((f) => f.type === 'sketch');
  const sel = bodies.at(-1);
  const other = bodies.find((b) => b.id !== sel?.id);
  const ctr = (b) => (b ? b.bbox.min.map((v, k) => round((v + b.bbox.max[k]) / 2)) : [0, 0, 0]);
  const ctx = {
    lastSketch: sketches.at(-1)?.id || '', sketches: sketches.map((k) => k.id),
    pathSketch: [...sketches].reverse().find((k) => (k.params.shapes || []).some((s) => s.open))?.id || '',
    lastSketchOnFace: sketches.at(-1)?.params.plane === 'custom', hasBodies: bodies.length > 0,
    selected: sel?.id || '', other: other?.id || '', surfaces: (result.surfaces || []).map((q) => q.id),
    topCenter: sel ? [ctr(sel)[0], ctr(sel)[1], sel.bbox.max[2]] : [0, 0, 0], selectedCenterZ: sel ? ctr(sel)[2] : 0,
    centerA: ctr(sel), centerB: ctr(other),
  };
  const params = { ...def.make(ctx), ...overrides };
  const id = 'f' + (doc.nextId++);
  const label = name || def.label;
  const dup = doc.features.filter((f) => (f.name || '').startsWith(label)).length;
  return { id, type: def.type, name: dup ? `${label}${dup + 1}` : `${label}1`, params };
}

export const stlOf = (bodies, name) => writeSTL(bodies, name);

export { defOf, FEATURES };
