// The B-rep backend: exact solids on OpenCascade (WebAssembly) through replicad. See docs/BREP-KERNEL-PLAN.md.
//
// Phase 1 covers: primitives, sketch profiles (lines, arcs, circles, ellipses, rectangles, slots, polygons), extrude, revolve,
// booleans (Extrude/Revolve operations, Combine), fillet and chamfer on true edges, holes, mirror, linear and circular patterns.
// brepSupport() says whether a whole design is inside that set; if one feature is not, the design is built by the mesh backend
// and the answer names the feature. The 23 MB WebAssembly file is only fetched by loadBrep(), which the app calls when a
// design needs the B-rep backend or a STEP export, and which caches the result.
import { smoothPath } from './solids.js';
import { planeFrame, shapeToPolygon, findFaceTri, PLANES, sameValue, sketchPath3D, decodeMesh, connectedChains } from './kernel.js';
import { planarFace, findCurvedTri, findEdgeChains, matchChainNear } from './edges.js';
import { profileCells, regionDrawing, outlinesOf, isSplineShape } from './sketch-brep.js';
import { sewMesh, weldSoup } from './sew.js';
import { edgeCutter } from './edgecutter.js';
import { reduceMesh, pieces, soupOfMesh } from './meshtools.js';
import { repairSoup } from './meshrepair.js';
import { matchBrepFace } from './brepface.js';
import { BIGDIST, extrudeRanges, revolveAxis, revolveSweep, edgeFeatureSpec, lostEdgesOutcome, makeApplyOp } from './featurespec.js';
import { openLoops } from './sketchgeo.js';
import { axisFrame, sub, add, scl, dot, unit, cross } from './solids.js';

let R = null, loading = null;
export const brepReady = () => !!R;
/** The replicad module once loaded (the add-in geometry service builds with it). */
export const replicad = () => { if (!R) throw new Error('The exact kernel is not loaded yet'); return R; };
/** The mesh of a shape (verts, tris, volume, area, bbox, faces), cached per shape. */
export const shapeMesh = (shape) => meshShape(shape);

/**
 * Fetch and start OpenCascade once. In the browser pass { locateFile: () => url } with the bundled .wasm URL; in Node no options are needed.
 * Safe to call many times: later calls get the same promise. A failed load can be retried.
 */
export function loadBrep(opts = {}) {
  if (R) return Promise.resolve(R);
  loading ||= (async () => {
    const [{ default: opencascade }, replicad] = await Promise.all([import('replicad-opencascadejs'), import('replicad')]);
    const init = opts.locateFile ? { locateFile: opts.locateFile } : {};
    // The STEP writer prints a transfer report to stdout on every export; keep it out of the log, pass everything else on
    const noise = /^\s*$|^\s*\*{3,}|^\s*\*\*\s|Statistics on Transfer|Step File Name|WorkSession|Transfer Mode|Transferring Shape/;
    init.print = (t) => { if (!noise.test(String(t))) console.log(t); };
    init.printErr = (t) => { if (!noise.test(String(t))) console.error(t); };
    let fail; const failed = new Promise((_, rej) => { fail = rej; });
    if (opts.wasmUrl && opts.onProgress) { // fetch the 23 MB file ourselves so the loading screen can show how much has arrived
      init.instantiateWasm = (imports, receive) => {
        (async () => {
          // Streaming compilation: the browser compiles the module while it downloads, and keeps the compiled code for the next visit
          // (instantiate-from-bytes recompiled 23 MB on every load). A copy already in the HTTP cache is handed over as it is, which is
          // what lets the browser use its compiled-code cache; a download is counted on the way through for the progress display.
          let res = await fetch(opts.wasmUrl, { cache: 'only-if-cached', mode: 'same-origin' }).catch(() => null);
          if (res?.ok) opts.onProgress(opts.totalBytes || 0, opts.totalBytes || 0);
          else {
            res = await fetch(opts.wasmUrl);
            if (!res.ok) throw new Error(`The CAD kernel file could not be loaded (${res.status})`);
            const total = opts.totalBytes || +res.headers.get('content-length') || 0, reader = res.body.getReader();
            let loaded = 0;
            res = new Response(new ReadableStream({ async pull(ctrl) { const { done, value } = await reader.read(); if (done) ctrl.close(); else { loaded += value.length; opts.onProgress(loaded, total); ctrl.enqueue(value); } }, cancel: (why) => reader.cancel(why) }), { headers: { 'content-type': 'application/wasm' } });
          }
          const { instance, module } = await WebAssembly.instantiateStreaming(res, imports);
          receive(instance, module);
        })().catch((e) => fail(e)); // a failed download rejects loadBrep instead of leaving it waiting
        return {}; // the module is delivered through `receive`
      };
    }
    const oc = await Promise.race([opencascade(init), failed]);
    replicad.setOC(oc);
    R = replicad;
    fastFaces(oc);
    return R;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/**
 * replicad lists a shape's faces with a duplicate check that compares every face with every earlier one (one WebAssembly call each):
 * a sewn mesh of 3,200 faces took a second just to be listed. A face of a solid, shell or compound is listed once by the explorer
 * already, so the check is skipped.
 */
function fastFaces(oc) {
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE, ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE, Shape = R.Shape.prototype;
  Object.defineProperty(Shape, 'faces', { configurable: true, get() {
    const ex = new oc.TopExp_Explorer(this.wrapped, FACE, ANY), out = [];
    try { while (ex.More()) { out.push(R.cast(ex.Current())); ex.Next(); } } finally { ex.delete(); }
    return out;
  } });
}

const TWO_PI = Math.PI * 2;

// ---------- which designs the B-rep backend can build ----------
const SHAPES_OK = new Set(['rect', 'rrect', 'circle', 'ellipse', 'ngon', 'slot', 'path', 'point']);
const isSolidShape = (sh) => !sh.lt && sh.t !== 'point';

/**
 * Can the B-rep backend build this whole design? Returns { ok: true } or { ok: false, feature: {id, name, type}, reason }.
 * `features` are the resolved features (as passed to rebuild). Suppressed features are skipped.
 */
export function brepSupport(features) {
  const sketches = {};
  for (const f of features) {
    if (f.suppressed) continue;
    const no = (reason) => ({ ok: false, feature: { id: f.id, name: f.name || f.type, type: f.type }, reason });
    const p = f.params || {};
    switch (f.type) {
      case 'primitive': case 'plane': case 'axis': case 'cpoint': case 'remove': case 'combine': case 'mirror': break;
      case 'sketch3d': break;
      case 'sketch': {
        if (p.faceRef && !p.origin) return no('a sketch placed on a face that has no stored position');
        for (const sh of p.shapes || []) if (!SHAPES_OK.has(sh.t)) return no(`the sketch shape "${sh.t}"`);
        sketches[f.id] = f;
        break;
      }
      case 'emboss': case 'extrude': {
        break;
      }
      case 'revolve': {
        break;
      }
      case 'pattern': break;
      case 'fillet': case 'chamfer':
        break;
      case 'hole': case 'presspull': case 'thickenface': case 'replaceface': break;
      case 'shell':
        break;
      case 'draft': break;
      case 'move': case 'scale': case 'joint': case 'split': case 'boundaryfill': break;
      case 'pipe': break;
      case 'sextrude': case 'srevolve': case 'sstitch': case 'strim': break;
      case 'ssweep': { const r = sweepCheck(null, sketches[p.path], p); if (r) return no(r); break; }
      case 'sloft': { for (const id of p.sketches || []) { const k = sketches[id]; if (k && singleOutline(k)) return no(singleOutline(k)); } break; }
      case 'sthicken': break;
      case 'rib': case 'coil': case 'import': case 'importstep': case 'mclean': case 'mreduce': case 'mseparate': break;
      case 'sweep': {
        const r = sweepCheck(sketches[p.profile], sketches[p.path], p);
        if (r) return no(r);
        break;
      }
      case 'loft': {
        const sks = (p.sketches || []).map((id) => sketches[id]).filter(Boolean);
        if (sks.length < 2) break; // the feature reports it
        for (const sk of sks) { const r = singleOutline(sk); if (r) return no(r); }
        break;
      }
      case 'thread': break;
      default: return { ok: false, feature: { id: f.id, name: f.name || f.type, type: f.type }, reason: `a ${f.type} feature` };
    }
  }
  return { ok: true };
}

/** null when the sketch is one plain closed outline (what Sweep and Loft use), otherwise why not. */
function singleOutline(sk) {
  if (!sk) return null;
  const shapes = (sk.params.shapes || []).filter((x) => !x.open && isSolidShape(x));
  if (shapes.length !== 1) return 'a profile sketch that is not exactly one closed shape';
  if (openLoops((sk.params.shapes || []).filter(isSolidShape)).length) return 'open lines joined into a closed profile';
  return null;
}
function sweepCheck(prof, path, p) {
  if (!path) return null;
  if (prof) { const r = singleOutline(prof); if (r) return r; }
  return null;
}
// ---------- sketch shapes -> exact 2D drawings ----------
const DEG = Math.PI / 180;
const dupe = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

/** The exact kernel turns the stored points of a fit-point spline back into one B-spline edge. */
const SPLINE_FIT = { tolerance: 5e-3, degMin: 3, degMax: 5 }; // a few knots: every knot is a seam the mesher and the booleans pay for
const isSpline = (s, pts) => isSplineShape(s, pts); // (a function, not an alias: sketch-brep and this file import each other)
function splineDrawing(pts, closed) {
  const xy = pts.map((q) => [q[0], q[1]]);
  if (closed) { xy.push(xy[0]); return R.drawPointsInterpolation(xy, SPLINE_FIT, { closeShape: true }); }
  return R.drawPointsInterpolation(xy, SPLINE_FIT);
}
function shapeDrawing(s) {
  const { draw, drawCircle, drawEllipse, drawRoundedRectangle } = R;
  switch (s.t) {
    case 'rect': return draw([s.x, s.y]).lineTo([s.x + s.w, s.y]).lineTo([s.x + s.w, s.y + s.h]).lineTo([s.x, s.y + s.h]).close();
    case 'rrect': {
      const r = Math.max(0, Math.min(s.r || 0, s.w / 2, s.h / 2));
      return r < 1e-6 ? shapeDrawing({ ...s, t: 'rect' }) : drawRoundedRectangle(s.w, s.h, r).translate(s.x + s.w / 2, s.y + s.h / 2);
    }
    case 'circle': return drawCircle(s.r).translate(s.cx, s.cy);
    case 'ellipse': {
      const rot = s.rot || 0;
      const d = s.rx >= s.ry ? drawEllipse(s.rx, s.ry).rotate(rot) : drawEllipse(s.ry, s.rx).rotate(rot + 90);
      return d.translate(s.cx, s.cy);
    }
    case 'ngon': {
      const n = Math.max(3, Math.round(s.n)), rot = (s.rot || 0) * DEG;
      const pts = Array.from({ length: n }, (_, i) => [s.cx + Math.cos(rot + (i / n) * TWO_PI) * s.r, s.cy + Math.sin(rot + (i / n) * TWO_PI) * s.r]);
      let pen = draw(pts[0]);
      for (let i = 1; i < n; i++) pen = pen.lineTo(pts[i]);
      return pen.close();
    }
    case 'slot': {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), r = s.w / 2;
      const at = (cx, cy, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      return draw(at(s.x1, s.y1, ang - Math.PI / 2)).lineTo(at(s.x2, s.y2, ang - Math.PI / 2))
        .threePointsArcTo(at(s.x2, s.y2, ang + Math.PI / 2), at(s.x2, s.y2, ang))
        .lineTo(at(s.x1, s.y1, ang + Math.PI / 2))
        .threePointsArcTo(at(s.x1, s.y1, ang - Math.PI / 2), at(s.x1, s.y1, ang + Math.PI)).close();
    }
    case 'path': {
      const pts = s.pts.filter((q, i, a) => !i || !dupe(q, a[i - 1]));
      if (pts.length > 1 && dupe(pts[0], pts[pts.length - 1])) pts.pop();
      if (pts.length < 3) return null;
      if (isSpline(s, pts)) return splineDrawing(pts, !s.open);
      let pen = draw([pts[0][0], pts[0][1]]);
      for (let i = 1; i <= pts.length; i++) {
        const a = pts[i - 1], b = pts[i % pts.length], bulge = a[2] || 0;
        if (i === pts.length) { if (Math.abs(bulge) > 1e-9) pen = pen.bulgeArcTo([b[0], b[1]], bulge); break; }
        pen = Math.abs(bulge) > 1e-9 ? pen.bulgeArcTo([b[0], b[1]], bulge) : pen.lineTo([b[0], b[1]]);
      }
      return pen.close();
    }
    default: return null;
  }
}

/**
 * The profile regions an extrude or revolve uses, as exact drawings: the regions picked in the feature (`chosen` ids), or the default
 * selection (see sketch-brep.js). Overlapping shapes and open lines that meet end to end make regions like any closed shape.
 */
function profileDrawings(sk, track, chosen) {
  const cells = profileCells(R, sk, (s) => shapeDrawing(s), track);
  const picked = Array.isArray(chosen) && chosen.length ? cells.filter((c) => chosen.includes(c.id)) : cells.filter((c) => c.defaultOn);
  return picked.map((c) => regionDrawing(R, c.face, track));
}
/** The regions of a sketch for the UI, in the same form as kernel.js profilesOf: [{ id, defaultOn, area, polys }]. */
export function profilesOfExact(sk) {
  if (!R) throw new Error('The exact kernel is not loaded yet');
  const garbage = [], track = (o) => { garbage.push(o); return o; };
  try {
    return profileCells(R, sk, (s) => shapeDrawing(s), track).map((c) => ({ id: c.id, defaultOn: c.defaultOn, area: c.area, polys: outlinesOf(R, c.face, track) }));
  } finally { for (const o of garbage) { try { o.delete(); } catch { /* already freed */ } } }
}

/**
 * Fuse or cut two shapes. Plain OpenCascade builders instead of replicad's fuse/cut: replicad simplifies the result inside the builder
 * and the code here used to simplify it again afterwards, and it leaves the builder filling a history (which shape came from which) and
 * checking for inverted solids, none of which is used. About 12 % faster on the 41-feature bench, with the same faces in the result.
 */
function boolean(kind, a, b, simplify = true) {
  const oc = R.getOC();
  const builder = kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped) : new oc.BRepAlgoAPI_Cut(a.wrapped, b.wrapped);
  try {
    builder.SetToFillHistory(false);
    builder.SetCheckInverted(false);
    builder.Build(new oc.Message_ProgressRange());
    if (builder.HasErrors()) throw new Error(`The ${kind === 'fuse' ? 'join' : 'cut'} could not be computed`);
    if (simplify) builder.SimplifyResult(true, true, 0.001); // merge faces that now lie on one surface
    const out = R.cast(builder.Shape());
    if (!R.isShape3D?.(out)) throw new Error(`The ${kind === 'fuse' ? 'join' : 'cut'} did not give a solid`);
    return out;
  } finally { builder.delete(); }
}

// ---------- volume ----------
const ANALYTIC = new Set(['PLANE', 'CYLINDRE', 'CONE', 'SPHERE', 'TORUS']);
/**
 * The volume of a shape. OpenCascade integrates planes, cylinders, cones, spheres and tori exactly, but its default integration of a
 * free-form surface (a spline extrusion, a sweep along a curve) is off by a percent or more, so those shapes are measured over
 * their triangulation instead (`meshed` is true when the shape has just been meshed; otherwise it is meshed here, finely).
 */
function volumeOf(shape, meshed = false, hint) {
  const oc = R.getOC();
  let free = hint;
  if (free === undefined) { free = false; try { free = shape.faces.some((f) => !ANALYTIC.has(f.geomType)); } catch { /* a shape without faces */ } }
  if (!free) return R.measureVolume(shape);
  if (!meshed) { const [lo, hi] = shape.boundingBox.bounds; shape.mesh({ tolerance: Math.max(0.004, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.5e-4), angularTolerance: 0.15 }); }
  const props = new oc.GProp_GProps();
  try { oc.BRepGProp.VolumeProperties(shape.wrapped, props, false, false, true); return props.Mass(); } finally { props.delete(); }
}

// ---------- meshing ----------
const meshCache = new WeakMap(), shapeByKey = new Map();
/** A shape as the kernel's body mesh: welded vertices, triangles, and which B-rep face each triangle belongs to. */
function meshShape(shape) {
  const hit = meshCache.get(shape);
  if (hit) return hit;
  // Two limits tie the triangles to the part: the gap between the surface and its triangles grows with the size of the part (0.15 mm per 100 mm of
  // the part's diagonal, between 0.04 and 0.6 mm), and no triangle turns more than 0.3 rad (17 degrees) from its neighbour, which is below the 35 degree
  // crease the viewport smooths across. A flat face needs neither and stays at two triangles per loop; the result is cached per shape.
  const [lo0, hi0] = shape.boundingBox.bounds, diag = Math.hypot(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
  const m = shape.mesh({ tolerance: Math.min(0.6, Math.max(0.04, diag * 1.5e-3)), angularTolerance: 0.3 });
  const weld = new Map(), verts = [];
  const remap = new Uint32Array(m.vertices.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = m.vertices[i * 3], y = m.vertices[i * 3 + 1], z = m.vertices[i * 3 + 2];
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = weld.get(key);
    if (id === undefined) { id = verts.length / 3; weld.set(key, id); verts.push(x, y, z); }
    remap[i] = id;
  }
  const tris = [], faceOf = [];
  m.faceGroups.forEach((g, gi) => {
    for (let k = g.start; k < g.start + g.count; k += 3) {
      const a = remap[m.triangles[k]], b = remap[m.triangles[k + 1]], c = remap[m.triangles[k + 2]];
      if (a === b || b === c || a === c) continue;
      tris.push(a, b, c); faceOf.push(gi);
    }
  });
  const V = new Float32Array(verts);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V[i + k]); hi[k] = Math.max(hi[k], V[i + k]); }
  // A key for each B-rep face that survives a rebuild of the same geometry: surface type, area-weighted centre and area. Stored with
  // an Appearance (doc.faceAppearance[].brepFace) so a painted face is found again without matching points and normals.
  const acc = m.faceGroups.map(() => ({ a: 0, c: [0, 0, 0], n: [0, 0, 0] }));
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2], g = acc[faceOf[t]];
    const P = (i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
    const A = P(a), B = P(b), C = P(c), u = sub(B, A), w = sub(C, A), n = cross(u, w), ar = Math.hypot(...n) / 2;
    g.a += ar; for (let k = 0; k < 3; k++) { g.c[k] += ((A[k] + B[k] + C[k]) / 3) * ar; g.n[k] += n[k] / 2; }
  }
  const faces = shape.faces.map((f, i) => {
    const g = acc[i] || { a: 0, c: [0, 0, 0], n: [0, 0, 0] }, c = g.a ? g.c.map((v) => v / g.a) : [0, 0, 0], nl = Math.hypot(...g.n);
    return { id: i, type: f.geomType, area: g.a, centroid: c, normal: g.a && nl > 0.9 * g.a ? g.n.map((v) => v / nl) : null, key: `${f.geomType}@${c.map((v) => v.toFixed(2)).join(',')}/${g.a.toFixed(2)}` };
  });
  const o = { key: 'b' + ++meshKey, verts: V, tris: new Uint32Array(tris), faceOf: new Uint32Array(faceOf), faces, volume: (() => { try { const v = volumeOf(shape, true, faces.some((f) => !ANALYTIC.has(f.type))); return Number.isFinite(v) ? v : 0; } catch { return 0; } })(), area: (() => { try { return R.measureArea(shape); } catch { return 0; } })(), bbox: { min: lo, max: hi } };
  meshCache.set(shape, o);
  shapeByKey.set(o.key, new WeakRef(shape)); // so a body shown in the viewport can be found again by its key (interference checks)
  if (shapeByKey.size > 4000) for (const [k, w] of shapeByKey) if (!w.deref()) shapeByKey.delete(k);
  return o;
}

// ---------- the feature loop ----------
let meshKey = 0;
const bboxOfShape = (s) => meshShape(s).bbox;
const fastBox = new WeakMap(), volCache = new WeakMap();
/** A body's bounds without meshing it (the timeline snapshots only need rough bounds). */
const bboxFast = (s) => {
  let b = fastBox.get(s);
  if (!b) { const [lo, hi] = s.boundingBox.bounds; b = { min: [...lo], max: [...hi] }; fastBox.set(s, b); }
  return b;
};

// ---------- the incremental cache ----------
// Like the mesh kernel's: after each feature the state of the design (its bodies and sketches) is kept, so a change to feature k
// replays only features k..end. Shapes that a kept state holds are counted and freed when the last state holding them goes.
const BC = { feats: [], cps: new Map(), out: [], comp: '' };
const held = new Map();
const hold = (s) => held.set(s, (held.get(s) || 0) + 1);
const unhold = (s) => { const c = (held.get(s) || 0) - 1; if (c > 0) held.set(s, c); else { held.delete(s); try { s.delete(); } catch { /* already freed */ } } };
function dropCheckpoint(i) { const cp = BC.cps.get(i); if (!cp) return; for (const e of cp.live) unhold(e.s); for (const e of cp.surfaces) unhold(e.s); BC.cps.delete(i); }
/** Free everything the cache holds (another design was opened, or the setting was switched). */
export function clearBrepCache() {
  for (const i of [...BC.cps.keys()]) dropCheckpoint(i);
  BC.feats = []; BC.out = [];
}

const NO_REFS_OK = new Set(['primitive', 'import', 'importstep']); // these make a body without reading another
const READS_ALL = new Set(['joint']); // these look at bodies they do not name
/**
 * May this unchanged feature take its result from the previous run? Only when nothing it reads has changed since: the bodies and sketches
 * it names (any string in its parameters that is the id of an earlier feature), or, when it names none or leaves the target open
 * ("all bodies", "the first body", automatic), any body at all.
 */
function canReuse(f, live, dirty, knownIds, baseId) {
  if (READS_ALL.has(f.type) || ['sketch', 'sketch3d', 'plane', 'axis', 'cpoint'].includes(f.type)) return false; // cheap, and they set up what later features read
  const found = new Set(), seen = new Set();
  const walk = (v, depth) => {
    if (typeof v === 'string') { const b = baseId(v); if (knownIds.has(b) && b !== f.id) found.add(b); }
    else if (v && typeof v === 'object' && depth < 6 && !seen.has(v)) { seen.add(v); for (const k of Object.keys(v)) walk(v[k], depth + 1); }
  };
  walk(f.params, 0);
  const p = f.params || {}, tgt = p.target, op = p.op;
  const open = ('target' in p && (!tgt || tgt === 'all') && op !== 'new') || op === 'auto' || (tgt && !live.has(baseId(tgt)) && op && op !== 'new'); // reads some body it does not name
  if (dirty.has('*')) return false;
  if (open || (!found.size && !NO_REFS_OK.has(f.type))) return dirty.size === 0;
  for (const id of found) if (dirty.has(id)) return false;
  return true;
}

/**
 * Replay features[0..count) on OpenCascade. Same result shape as kernel.js rebuild() (bodies, errors, notes, snaps ...), with
 * result.backend = { kind: 'brep' }. Bodies carry faceOf (the B-rep face of every triangle) and faces (the face types).
 * opts.keepShapes keeps the replicad shapes in result.shapes (id -> shape) for STEP export; call result.dispose() when done.
 */
export function rebuildBrep(features, count, opts = {}) {
  if (!R) throw new Error('The exact kernel is not loaded yet');
  const garbage = [];
  const track = (o) => { if (o) garbage.push(o); return o; };
  const live = new Map();
  const errors = {}, warnings = {}, notes = {}, lost = {}, shifted = {};
  const snaps = [], surfSnaps = [], sketchUsed = new Set(), sketches = {};
  const surfaces = new Map(); // id -> { id, name, s }: open surfaces (shells and faces), not solids
  let surfCount = 0;
  const addSurface = (id, s, name) => surfaces.set(id, { id, name: name || `Surface${++surfCount}`, s });
  const getSurface = (id) => { const q = surfaces.get(id); if (!q) throw new Error('A surface you picked no longer exists'); return q; };
  let captured = null, preview = null, counter = 0;
  const snap = () => [...live.values()].map((b) => ({ id: b.id, name: b.name, bbox: bboxFast(b.s) }));
  const addBody = (id, s, name) => live.set(id, { id, name: name || `Body${++counter}`, s });
  const getBody = (id) => { const b = live.get(id); if (!b) throw new Error('Referenced body no longer exists'); return b; };
  const vol = (s) => { let v = volCache.get(s); if (v === undefined) { try { v = R.measureVolume(s); } catch { v = 0; } volCache.set(s, v); } return v; }; // measuring a big body costs milliseconds; a shape's volume never changes
  const empty = (s) => !s || vol(s) < 1e-9;
  // merge faces that lie on the same surface after a boolean (the 'optimisation' option of fuse/cut dropped volume in tests)
  const tidy = (s) => { try { return s.simplify(); } catch { return s; } };
  const fuse = (a, b) => track(boolean('fuse', a, b));
  const cut = (a, b) => track(boolean('cut', a, b));
  const union = (list) => list.reduce((a, b) => fuse(a, b));
  const faceNow = (s, ref) => {
    const m = meshShape(s), tri = findFaceTri(m.verts, m.tris, ref.point, ref.normal);
    if (tri < 0) return null;
    const pf = planarFace(m.verts, m.tris, tri);
    return pf ? { point: pf.point, normal: pf.normal } : null;
  };
  const planeOf = (params) => { const fr = planeFrame(params); return { fr, plane: track(new R.Plane(fr.o, fr.x, fr.n)) }; };
  /** A prism of the sketch's regions from height z0 to z1 along the sketch normal. */
  const slab = (drawings, params, z0, z1, extra = {}) => {
    const { fr } = planeOf(params);
    const lo = Math.min(z0, z1), h = Math.abs(z1 - z0), org = add(fr.o, scl(fr.n, lo));
    const plane = track(new R.Plane(org, fr.x, fr.n));
    const parts = drawings.map((d) => track(track(d.clone ? d.clone() : d).sketchOnPlane(plane)).extrude(h, extra.twistAngle || extra.extrusionProfile ? { ...extra, origin: org } : extra));
    parts.forEach(track);
    return union(parts);
  };
  /** The wall of a Thin extrude: the profile grown and shrunk by the wall thickness (mitred corners), the inner prism cut from the outer. */
  const thinSlab = (drawings, params, z0, z1, wall, side) => {
    const { fr } = planeOf(params);
    if (!(wall > 0)) throw new Error('Wall thickness must be positive');
    const grow = side === 'inside' ? 0 : side === 'outside' ? wall : wall / 2, shrink = side === 'inside' ? wall : side === 'outside' ? 0 : wall / 2;
    const lo = Math.min(z0, z1), h = Math.abs(z1 - z0), plane = track(new R.Plane(add(fr.o, scl(fr.n, lo)), fr.x, fr.n));
    const prism = (g) => {
      const parts = [];
      for (const d of drawings) {
        const sk = track(d.sketchOnPlane(plane));
        for (const one of sk.sketches || [sk]) {
          let face = one.face();
          if (g) { // grow the region by g: the outer boundary moves out, the holes shrink; the sign of an offset depends on the wire's direction, so check which way each one went
            const move = (wire, outward) => {
              const area = (w) => R.measureArea(R.makeFace(w.clone())), a0 = area(wire), shouldGrow = outward ? g > 0 : g < 0;
              const first = wire.clone().offset2D(outward ? g : -g, 'intersection');
              return area(first) > a0 === shouldGrow ? first : wire.clone().offset2D(outward ? -g : g, 'intersection');
            };
            face = R.makeFace(move(face.clone().outerWire(), true), face.clone().innerWires().map((w) => move(w, false)));
          }
          parts.push(track(R.basicFaceExtrusion(face, track(new R.Vector(scl(fr.n, h))))));
        }
      }
      return union(parts);
    };
    let wallSolid;
    try { const outer = prism(grow), inner = prism(-shrink); wallSolid = cut(outer, inner); } catch { throw new Error('Wall is too thick for this profile'); }
    if (empty(wallSolid)) throw new Error('Wall is too thick for this profile');
    return wallSolid;
  };
  /** Tilt the side faces of a prism inwards by `deg` degrees, about the sketch plane (+1: the prism lies on the normal's side of it). */
  const taperSolid = (solid, params, off, sgn, deg) => {
    const { fr } = planeOf(params), oc = R.getOC(), dr = new oc.BRepOffsetAPI_DraftAngle(solid.wrapped);
    garbage.push({ delete: () => dr.delete() });
    const neutral = R.makePln(add(fr.o, scl(fr.n, off)), fr.n), dir = R.asDir(scl(fr.n, sgn)), ang = (deg * Math.PI) / 180;
    let n = 0;
    for (const face of solid.faces) {
      if (face.geomType !== 'PLANE' && face.geomType !== 'CYLINDRE') continue;
      if (face.geomType === 'PLANE') { const nv = face.normalAt(); if (Math.abs(dot([nv.x, nv.y, nv.z], fr.n)) > 1e-6) continue; }
      dr.Add(face.wrapped, dir, ang, neutral, true);
      if (!dr.AddDone()) throw new Error('Taper angle too large for this profile');
      n++;
    }
    if (!n) throw new Error('This profile has no side faces to taper');
    dr.Build(new oc.Message_ProgressRange());
    if (!dr.IsDone()) throw new Error('Taper angle too large for this profile');
    return track(R.cast(dr.Shape()));
  };
  const solidFromSketch = (f) => {
    const sk = sketches[f.params.sketch];
    if (!sk) throw new Error('Sketch not found');
    sketchUsed.add(sk.id);
    const drawings = profileDrawings(sk, track, f.params.profiles);
    if (!drawings.length) throw new Error(f.params.profiles?.length ? 'The selected profiles no longer exist — pick them again' : 'Sketch has no closed profile');
    return { drawings, sk };
  };
  const planeGeo = (ref) => {
    const q = features.find((x) => x.id === ref && x.type === 'plane');
    if (q) return { origin: q.params.origin, normal: q.params.normal };
    const fr = planeFrame({ plane: ref });
    return { origin: fr.o, normal: fr.n };
  };
  const intersectTidy = (a, b) => track(tidy(track(a.intersect(b))));
  const brepOps = { // what the shared Join / Cut / Intersect logic (featurespec.js) needs from an exact solid
    get: (b) => b.s, set: (b, s) => { b.s = s; }, isEmpty: empty, volume: vol, bbox: bboxOfShape,
    intersectVolume: (a, b) => { try { return vol(track(a.intersect(b))); } catch { return 0; } }, // disjoint shapes may refuse to intersect
    union: fuse, subtract: cut, intersect: intersectTidy,
    previewMesh: (s) => { const me = meshShape(s); return { verts: me.verts, tris: me.tris }; },
  };
  const opState = { get preview() { return preview; }, set preview(v) { preview = v; } };
  const applyOp = makeApplyOp({ live, notes, warnings, ops: brepOps, opts, addBody, getBody, state: opState });
  /**
   * A body stretched by `s3` (about `c`) as an exact solid, or null. OpenCascade has no general stretch in this build (no GTransform, no
   * NURBS conversion), so it is rebuilt from what made it: an axis-aligned primitive with its dimensions stretched (a cylinder becomes an
   * elliptic cylinder, a sphere an ellipsoid, a cone an elliptic cone) or a plain extrude with its sketch shapes and height stretched.
   * A stretch preserves axis-aligned bounding boxes, so the result is moved to where the stretched box of the original lies.
   */
  const scaleExact = (b, s3, c) => {
    const src = b.s;
    let cand = null;
    const dir = (v) => { const i = v.findIndex((q) => Math.abs(Math.abs(q) - 1) < 1e-9); return i >= 0 && v.every((q, k) => k === i || Math.abs(q) < 1e-9) ? i : -1; };
    if (src._prim) {
      const q = src._prim, [a, bb, cc] = s3;
      if (q.shape === 'box' && !(q.radius > 0)) cand = makePrimitive({ ...q, sx: q.sx * a, sy: q.sy * bb, sz: q.sz * cc, pos: [0, 0, 0] }, track);
      else if (q.shape === 'cylinder') cand = Math.abs(a - bb) < 1e-9 ? makePrimitive({ ...q, radius: q.radius * a, height: q.height * cc, pos: [0, 0, 0] }, track)
        : track(track(track(shapeDrawing({ t: 'ellipse', cx: 0, cy: 0, rx: q.radius * a, ry: q.radius * bb, rot: 0 })).sketchOnPlane('XY')).extrude(q.height * cc));
      else if (q.shape === 'sphere') cand = track(R.makeEllipsoid(q.radius * a, q.radius * bb, q.radius * cc));
      else if (q.shape === 'cone' && q.radius2 > 1e-9) {
        const ell = (r, z) => track(track(shapeDrawing({ t: 'ellipse', cx: 0, cy: 0, rx: r * a, ry: r * bb, rot: 0 })).sketchOnPlane('XY', z));
        cand = track(ell(q.radius, 0).loftWith([ell(q.radius2, q.height * cc)], { ruled: true }));
      }
    } else if (src._extrude) {
      const { sk, p, X } = src._extrude, fr = planeFrame(sk.params), iu = dir(fr.x), iv = dir(fr.y), inn = dir(fr.n);
      if (iu >= 0 && iv >= 0 && inn >= 0) {
        const sU = s3[iu], sV = s3[iv], sN = s3[inn], uni = Math.abs(sU - sV) < 1e-9;
        const one = (sh) => {
          switch (sh.t) {
            case 'rect': return { ...sh, x: sh.x * sU, y: sh.y * sV, w: sh.w * sU, h: sh.h * sV };
            case 'circle': return uni ? { ...sh, cx: sh.cx * sU, cy: sh.cy * sV, r: sh.r * sU } : { t: 'ellipse', cx: sh.cx * sU, cy: sh.cy * sV, rx: sh.r * sU, ry: sh.r * sV, rot: 0 };
            case 'ellipse': { const rot = sh.rot || 0; if (rot % 90) return null; const flip = (rot / 90) % 2 !== 0; return { ...sh, cx: sh.cx * sU, cy: sh.cy * sV, rx: sh.rx * (flip ? sV : sU), ry: sh.ry * (flip ? sU : sV) }; }
            case 'ngon': { const n = Math.max(3, Math.round(sh.n)), rot = (sh.rot || 0) * DEG; return { t: 'path', open: false, pts: Array.from({ length: n }, (_, i) => [(sh.cx + Math.cos(rot + (i / n) * TWO_PI) * sh.r) * sU, (sh.cy + Math.sin(rot + (i / n) * TWO_PI) * sh.r) * sV]) }; }
            case 'path': return sh.pts.some((q) => q[2]) && !uni ? null : { ...sh, pts: sh.pts.map((q) => [q[0] * sU, q[1] * sV, ...q.slice(2)]) };
            case 'rrect': return uni ? { ...sh, x: sh.x * sU, y: sh.y * sU, w: sh.w * sU, h: sh.h * sU, r: sh.r * sU } : null;
            case 'slot': return uni ? { ...sh, x1: sh.x1 * sU, y1: sh.y1 * sU, x2: sh.x2 * sU, y2: sh.y2 * sU, w: sh.w * sU } : null;
            default: return null;
          }
        };
        const shapes = (sk.params.shapes || []).filter((sh) => !sh.lt && sh.t !== 'point').map(one);
        if (shapes.length && shapes.every(Boolean)) {
          const sk2 = { ...sk, params: { ...sk.params, shapes } };
          const drawings = profileDrawings(sk2, track, p.profiles);
          if (drawings.length) cand = union(X.ranges.map(([z0, z1]) => slab(drawings, sk2.params, z0 * sN, z1 * sN)));
        }
      }
    }
    if (!cand) return null;
    const bb0 = bboxFast(src), bb1 = bboxFast(cand);
    const want = bb0.min.map((v, k) => c[k] + (v - c[k]) * s3[k]);
    const moved = track(cand.translate(want.map((v, k) => v - bb1.min[k])));
    const v0 = vol(src), v1 = vol(moved), ratio = s3[0] * s3[1] * s3[2];
    if (!(Math.abs(v1 - v0 * ratio) <= 0.005 * v0 * ratio)) return null; // a stretch must scale the volume by the product of the factors
    return moved;
  };

  const n = Math.min(count, features.length), useCache = opts.cache !== false && !opts.keepShapes;
  let firstDiff = 0;
  const compKey = JSON.stringify(opts.bodyComp || null); // joints move whole components, so a change of components changes everything
  if (useCache && compKey === BC.comp) { const lim = Math.min(BC.feats.length, features.length); while (firstDiff < lim && sameValue(BC.feats[firstDiff], features[firstDiff])) firstDiff++; }
  const previewAt = opts.previewId ? features.findIndex((x) => x.id === opts.previewId) : -1;
  const wanted = Math.min(firstDiff, opts.capture >= 0 ? opts.capture : Infinity, previewAt >= 0 ? previewAt : Infinity);
  // The states built on features that changed are kept aside while this run replays: a later feature that does not depend on anything that
  // changed takes its result from them instead of being built again (see the loop), and whatever is not reused is freed at the end.
  const stale = new Map(), oldFeats = useCache ? BC.feats : [], oldOut = useCache ? BC.out.slice() : [];
  if (useCache) { for (const i of [...BC.cps.keys()]) if (i > firstDiff) { stale.set(i, BC.cps.get(i)); BC.cps.delete(i); } BC.out.length = Math.min(BC.out.length, firstDiff); }
  const OLD_AT_FIRST = useCache ? BC.cps.get(firstDiff) : null; // the state before the first changed feature: still valid
  const dirty = new Set(), knownIds = new Set(features.map((x) => x.id));
  const baseId = (id) => String(id).split('~')[0];
  let reused = 0;
  const resume = useCache ? [...BC.cps.values()].filter((c) => c.i <= Math.min(wanted, n)).sort((a, b) => b.i - a.i)[0] : null;
  const start = resume ? resume.i : 0;
  if (resume) {
    for (const e of resume.live) live.set(e.id, { id: e.id, name: e.name, s: e.s });
    Object.assign(sketches, resume.sketches); counter = resume.counter; surfCount = resume.surfCount;
    for (const e of resume.surfaces) surfaces.set(e.id, { id: e.id, name: e.name, s: e.s });
    for (const id of resume.used) sketchUsed.add(id);
  }
  for (let j = 0; j < start; j++) { const o = BC.out[j]; snaps.push(o.snap); surfSnaps.push(o.surf); if (o.error) errors[features[j].id] = o.error; if (o.warnings) warnings[features[j].id] = o.warnings; if (o.note) notes[features[j].id] = o.note; if (o.lost) lost[features[j].id] = o.lost; if (o.shifted) shifted[features[j].id] = o.shifted; }
  const makeCheckpoint = (i) => {
    if (!useCache || BC.cps.has(i)) return;
    const cp = { i, live: [...live.values()].map((b) => ({ id: b.id, name: b.name, s: b.s })), surfaces: [...surfaces.values()].map((q) => ({ id: q.id, name: q.name, s: q.s })), surfCount, sketches: { ...sketches }, counter, used: [...sketchUsed] };
    for (const e of cp.live) hold(e.s);
    for (const e of cp.surfaces) hold(e.s);
    BC.cps.set(i, cp);
  };
  for (let i = start; i < n; i++) {
    const f0 = features[i];
    makeCheckpoint(i);
    const eng = f0.type === 'emboss' && f0.params.mode === 'engrave';
    const f = f0.type === 'emboss'
      ? { ...f0, type: 'extrude', params: { sketch: f0.params.sketch, profiles: f0.params.profiles, extent: 'distance', distance: (eng ? -1 : 1) * Math.abs(f0.params.depth || 0), flip: false, symmetric: false, op: eng ? 'cut' : 'join', target: f0.params.target || '', toBody: '', taper: 0, twist: 0, scaleTop: 1 } }
      : f0;
    const sn = snap();
    const sf = [...surfaces.values()].map((q) => ({ id: q.id, name: q.name }));
    snaps.push(sn); surfSnaps.push(sf);
    if (opts.capture === i) captured = [...live.values()].map((b) => { const me = meshShape(b.s); return { id: b.id, name: b.name, verts: me.verts, tris: me.tris }; });
    const changed = !(oldFeats[i] && sameValue(oldFeats[i], f0));
    if (stale.size && !changed && !f.suppressed && stale.has(i) && stale.has(i + 1) && oldOut[i] && opts.capture !== i && f.id !== opts.previewId && canReuse(f, live, dirty, knownIds, baseId)) {
      const a = stale.get(i), b = stale.get(i + 1), o = oldOut[i];
      const inA = new Map(a.live.map((e) => [e.id, e])), inB = new Set(b.live.map((e) => e.id));
      for (const e of b.live) { const x = inA.get(e.id); if (!x || x.s !== e.s || x.name !== e.name) live.set(e.id, { id: e.id, name: e.name, s: e.s }); }
      for (const e of a.live) if (!inB.has(e.id)) live.delete(e.id);
      const sA = new Map(a.surfaces.map((e) => [e.id, e])), sB = new Set(b.surfaces.map((e) => e.id));
      for (const e of b.surfaces) { const x = sA.get(e.id); if (!x || x.s !== e.s) surfaces.set(e.id, { id: e.id, name: e.name, s: e.s }); }
      for (const e of a.surfaces) if (!sB.has(e.id)) surfaces.delete(e.id);
      for (const id of b.used) sketchUsed.add(id);
      counter = Math.max(counter, b.counter); surfCount = Math.max(surfCount, b.surfCount);
      if (o.error) errors[f.id] = o.error; if (o.warnings) warnings[f.id] = o.warnings; if (o.note) notes[f.id] = o.note; if (o.lost) lost[f.id] = o.lost; if (o.shifted) shifted[f.id] = o.shifted;
      BC.out[i] = { snap: sn, surf: sf, error: o.error, warnings: o.warnings, note: o.note, lost: o.lost, shifted: o.shifted };
      reused++;
      continue;
    }
    const liveBefore = stale.size ? new Map([...live].map(([k, v]) => [k, v.s])) : null, surfBefore = stale.size ? new Map([...surfaces].map(([k, v]) => [k, v.s])) : null;
    if (!f.suppressed) try {
      const p = f.params;
      switch (f.type) {
        case 'primitive': { const sh = makePrimitive(p, track); sh._prim = p; addBody(f.id, sh, f.name); break; } // _prim: what a non-uniform Scale rebuilds from
        case 'sketch': {
          const fr = p.faceRef, fb = fr && live.get(fr.id), now = fb && faceNow(fb.s, fr);
          if (now && p.origin) {
            const nn = unit(now.normal), d = dot(sub(now.point, fr.point), nn);
            if (Math.abs(d) > 1e-9) { const origin = add(p.origin, scl(nn, d)); sketches[f.id] = { ...f, params: { ...p, origin } }; shifted[f.id] = origin; break; }
          }
          sketches[f.id] = f; break;
        }
        case 'sketch3d': sketches[f.id] = f; break;
        case 'plane': case 'axis': if (p.error) throw new Error(p.error); break;
        case 'cpoint': break;
        case 'extrude': {
          const { drawings, sk } = solidFromSketch(f);
          const X = extrudeRanges(p, sk, (id) => bboxOfShape(getBody(id).s)); // distance, direction and slabs: the same decision the mesh kernel makes
          if (p.taper && X.mode === 'symmetric') throw new Error('Taper cannot be combined with Symmetric');
          if (p.thin && p.taper) throw new Error('Taper cannot be combined with Thin extrude');
          const twist = p.twist || 0, endFactor = p.scaleTop ?? 1, twisted = twist || endFactor !== 1;
          const m = union(X.ranges.map(([z0, z1], i) => {
            let q = p.thin ? thinSlab(drawings, sk.params, z0, z1, p.wall ?? 1, p.wallSide || 'inside')
              : slab(drawings, sk.params, z0, z1, twisted && i === 0 ? { twistAngle: twist, extrusionProfile: { profile: 'linear', endFactor } } : {});
            const tp = i === 0 ? p.taper : p.taper2;
            if (tp) q = taperSolid(q, sk.params, X.off, (z0 + z1) / 2 >= X.off ? 1 : -1, tp);
            return q;
          }));
          if (p.op === 'new' && !p.thin && !p.taper && !p.taper2 && !twisted) m._extrude = { sk, p, X }; // what a non-uniform Scale rebuilds from
          applyOp(f, m, p.op, p.target);
          break;
        }
        case 'revolve': {
          const { drawings, sk } = solidFromSketch(f);
          const fr = planeFrame(sk.params);
          const { o2, th } = revolveAxis(p, sk, features);
          const axO = add(fr.o, add(scl(fr.x, o2[0]), scl(fr.y, o2[1])));
          const axD = unit(add(scl(fr.x, Math.cos(th * DEG)), scl(fr.y, Math.sin(th * DEG))));
          const side = sideOfAxis(profilePolys(sk), o2, th);
          if (side === 0) throw new Error('The profile crosses the axis. Move it to one side, or choose another axis.');
          const { partial, ang, mode } = revolveSweep(p);
          // a partial revolve of a profile on the far side of the axis sweeps its mirror image (as the mesh kernel always did); a full one is the same either way
          const mirrored = side === 1 && partial && ang < 360 ? drawings.map((d) => track(d.mirror([Math.cos(th * DEG), Math.sin(th * DEG)], o2, 'plane'))) : drawings;
          const spin = (angle) => {
            const parts = mirrored.map((d) => track(track(track(d.clone ? d.clone() : d).sketchOnPlane(planeOf(sk.params).plane)).revolve(axD, { origin: axO, angle: angle >= 360 ? undefined : angle })));
            return union(parts);
          };
          const turn = (s, a) => track(s.rotate(a, axO, axD));
          let m;
          if (!partial || ang >= 360) m = spin(360);
          else if (mode === 'symmetric') m = turn(spin(ang), -ang / 2);
          else if (mode === 'two') {
            const a2 = Math.min(Math.max(p.angle2 ?? 0, 1e-3), 360 - ang);
            m = fuse(spin(ang), turn(spin(a2), -a2));
          } else m = spin(ang);
          applyOp(f, m, p.op, p.target);
          break;
        }
        case 'combine': {
          const a = getBody(p.target), given = [].concat(p.tool || [], p.tools || []).filter(Boolean), ids = [...new Set(given)].filter((id) => id !== p.target);
          if (given.includes(p.target)) throw new Error('Target and tool must differ');
          if (!ids.length) throw new Error('Choose at least one tool body');
          const tools = ids.map((id) => getBody(id));
          if (p.op === 'join') a.s = union([a.s, ...tools.map((x) => x.s)]);
          else if (p.op === 'cut') for (const x of tools) a.s = cut(a.s, x.s);
          else for (const x of tools) a.s = track(tidy(track(a.s.intersect(x.s))));
          if (!p.keepTool) for (const id of ids) live.delete(id);
          break;
        }
        case 'mirror': {
          const b = getBody(p.body);
          let nrm, o;
          if (PLANES[p.plane]) { nrm = PLANES[p.plane].n; o = nrm.map((c) => c * (+p.offset || 0)); }
          else {
            const pf = features.find((x) => x.id === p.plane && x.type === 'plane');
            if (!pf || pf.params.error || !pf.params.normal) throw new Error('The mirror plane no longer exists or could not be built');
            nrm = pf.params.normal; o = pf.params.origin.map((c, k) => c + nrm[k] * (+p.offset || 0));
          }
          const mir = track(track(b.s.clone()).mirror(nrm, o));
          if (p.join) b.s = fuse(b.s, mir); else addBody(f.id, mir, f.name);
          break;
        }
        case 'pattern': {
          const b = getBody(p.body);
          if (p.kind === 'path') { // copies at equal steps along a path (or a closed path's full length)
            const pk = sketches[p.path];
            if (!pk) throw new Error('Choose a path sketch');
            sketchUsed.add(pk.id);
            const { pts, closed } = sketchPath3D(pk), P = closed ? [...pts, pts[0]] : pts, seg = [0];
            for (let i = 1; i < P.length; i++) seg.push(seg[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
            const total = seg.at(-1);
            if (!(total > 0)) throw new Error('Path has no length');
            const at = (d) => { let i = 1; while (i < seg.length - 1 && seg[i] < d) i++; const u = (d - seg[i - 1]) / ((seg[i] - seg[i - 1]) || 1); return P[i - 1].map((v, k) => v + (P[i][k] - v) * u); };
            const start = at(0), n = Math.max(2, p.count | 0), copies = [b.s];
            for (let k = 1; k < n; k++) { const q = at((total * k) / (closed ? n : n - 1)); copies.push(track(track(b.s.clone()).translate(sub(q, start)))); }
            b.s = union(copies);
            break;
          }
          if (p.kind === 'face') { // a grid in the plane of a picked flat face
            if (!p.face) throw new Error('Click a flat face to pattern across');
            if (!faceFromRef(getBody(p.faceBody || p.body).s, p.face)) throw new Error('The picked face no longer exists — pick it again');
            const M = axisFrame(p.face.point, p.face.normal), U = [M[0], M[1], M[2]], V = [M[4], M[5], M[6]], copies = [b.s];
            for (let i = 0; i < Math.max(1, p.countU | 0); i++) for (let j = 0; j < Math.max(1, p.countV | 0); j++) {
              if (!i && !j) continue;
              copies.push(track(track(b.s.clone()).translate([0, 1, 2].map((k) => U[k] * p.spacingU * i + V[k] * p.spacingV * j))));
            }
            b.s = union(copies);
            break;
          }
          const cnt = Math.max(1, p.count | 0), skip = new Set(String(p.skip ?? '').split(/[\s,;]+/).map(Number).filter((v) => Number.isInteger(v) && v >= 1 && v <= cnt));
          const full = p.kind === 'circular' && p.angle >= 360, sym = !!p.symmetric && !full && cnt > 1;
          const stepOf = (k) => (sym ? k - (cnt - 1) / 2 : k);
          const pieces = [];
          for (let k = 0; k < cnt; k++) {
            if (skip.has(k + 1)) continue;
            const st = stepOf(k);
            if (!sym && k === 0) { pieces.push(b.s); continue; }
            if (p.kind === 'linear') {
              const div = p.extent === 'extent' && cnt > 1 ? cnt - 1 : 1;
              pieces.push(st === 0 ? b.s : track(track(b.s.clone()).translate(p.spacing.map((v) => (v / div) * st))));
            } else {
              const a = (p.angle / (full ? cnt : Math.max(1, cnt - 1))) * st;
              pieces.push(st === 0 ? b.s : track(track(b.s.clone()).rotate(a, [0, 0, 0], ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[p.axis])));
            }
          }
          if (!pieces.length) throw new Error('Every instance is skipped. Leave at least one.');
          b.s = pieces.length > 1 ? union(pieces) : pieces[0];
          break;
        }
        case 'fillet': case 'chamfer': {
          const { size0: size, byBody } = edgeFeatureSpec(f);
          for (const [bid, edges] of byBody) {
            const b = getBody(bid);
            // find each picked edge again the way the mesh kernel did (by position, direction and the two faces it sits between), on this
            // body's tessellation, then use the exact edges that lie along the matched chain
            const found = [], me = meshShape(b.s), chains = chainsOf(me), todo = [];
            for (const e of edges) {
              const ch = matchChainNear(chains, e.pts, e.nrm);
              if (!ch) { (lost[f.id] ||= []).push(p.edges.indexOf(e)); continue; }
              for (const c of p.tangent ? connectedChains(chains, ch) : [ch]) if (!todo.includes(c)) todo.push(c);
            }
            for (const ch of todo) {
              if (!b.s.edges.some((ed) => edgeOnRef(ed, ch.pts))) { (lost[f.id] ||= []).push(-1); continue; }
              const fr = ch.frames[Math.floor(ch.frames.length / 2)];
              found.push({ pts: ch.pts, nrm: [fr.n1, fr.n2], ch });
            }
            if (!found.length) continue;
            const test = (ed) => found.some((e) => edgeOnRef(ed, e.pts));
            const filter = (fnd) => fnd.when(({ element }) => test(element));
            const before = b.s;
            const viaOpenCascade = () => {
            if (f.type === 'chamfer' && (p.mode === 'two' || p.mode === 'angle')) { // two distances, or a distance and an angle, measured from the first of the edge's two faces
              for (const e of found) {
                const n = (p.flip ? e.nrm?.[1] : e.nrm?.[0]) || [0, 0, 1];
                const face = (fnd) => fnd.when(({ element }) => element.geomType === 'PLANE' && Math.abs(dot(unit(vec3(element.normalAt())), n) - 1) < 1e-3 && Math.abs(dot(sub(vec3(element.center), edgeMid(b.s, e.pts)), n)) < 1e-3);
                const cfg = p.mode === 'angle' ? { distance: size, angle: p.angle ?? 45, selectedFace: face } : { distances: [size, p.distance2 > 0 ? p.distance2 : size], selectedFace: face };
                try { b.s = track(b.s.chamfer(cfg, (fnd) => fnd.when(({ element }) => edgeOnRef(element, e.pts)))); } catch { throw tooLarge(); }
              }
              return;
            }
            let radius = size;
            if (f.type === 'fillet' && p.mode === 'chord' && p.chord > 0) { // the chord is the straight distance between the two tangent points, so the radius follows the angle of the edge
              radius = (ed) => { const e = found.find((x) => edgeOnRef(ed, x.pts)); const n = e?.nrm; const interior = n ? Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(n[0], n[1])))) : Math.PI / 2; return p.chord / (2 * Math.cos(interior / 2)); };
            } else if (f.type === 'fillet' && p.variable) { // from the radius at the start of the picked edge to the one at its end (reverse swaps them)
              if (!(p.radiusEnd > 0)) throw new Error('End radius must be positive');
              const [ra, rb] = p.reverse ? [p.radiusEnd, p.radius] : [p.radius, p.radiusEnd];
              radius = (ed) => {
                const e = found.find((x) => edgeOnRef(ed, x.pts));
                if (!e) return null;
                if (e.pts[0].every((v, k) => Math.abs(v - e.pts.at(-1)[k]) < 1e-6)) return ra; // a closed edge has no start and end
                const a = ed.startPoint, d0 = Math.hypot(a.x - e.pts[0][0], a.y - e.pts[0][1], a.z - e.pts[0][2]), d1 = Math.hypot(a.x - e.pts.at(-1)[0], a.y - e.pts.at(-1)[1], a.z - e.pts.at(-1)[2]);
                return d0 <= d1 ? [ra, rb] : [rb, ra];
              };
            }
            try { b.s = track(f.type === 'fillet' ? b.s.fillet(typeof radius === 'function' ? (ed) => (test(ed) ? radius(ed) : null) : radius, typeof radius === 'function' ? undefined : filter) : b.s.chamfer(size, filter)); }
            catch { throw tooLarge(); }
            };
            // when OpenCascade cannot build it (it often cannot where an edge runs into a rounded corner), build the wedge the way the mesh kernel did:
            // the section of the two faces lofted along the chain, cut from the body (or fused to it on a concave edge)
            const wedgeFits = (ch, kind, sz, o2) => { // the wedge must not reach past the flat faces it is cut from
              for (const at of new Set([0, Math.floor(ch.frames.length / 2), ch.frames.length - 1])) { // the two ends and the middle: an end often lies on flat faces where the middle is a corner blend
              const fr = ch.frames[at], E = ch.pts[at];
              const r = typeof sz === 'object' ? Math.max(sz.r0, sz.r1) : sz, alpha = Math.acos(Math.max(-1, Math.min(1, dot(fr.u1, fr.u2))));
              const t = kind === 'fillet' ? (o2.chord ? o2.chord / 2 : r / Math.tan(alpha / 2)) : Math.max(r, o2.chamfer?.d2 || 0, o2.chamfer?.mode === 'angle' ? (r * Math.sin(o2.chamfer.angle)) / Math.max(Math.sin(alpha + o2.chamfer.angle), 1e-3) : 0);
              const mesh = meshShape(b.s);
              for (const [n, u] of [[fr.n1, fr.u1], [fr.n2, fr.u2]]) {
                let reach = -1;
                mesh.faces.forEach((fc, gi) => {
                  if (fc.type !== 'PLANE' || !fc.normal || dot(fc.normal, n) < 0.999 || Math.abs(dot(sub(fc.centroid, E), n)) > 1e-3) return;
                  for (let k = 0; k < mesh.faceOf.length; k++) if (mesh.faceOf[k] === gi) for (let q = 0; q < 3; q++) { const v = mesh.tris[k * 3 + q] * 3; reach = Math.max(reach, dot(sub([mesh.verts[v], mesh.verts[v + 1], mesh.verts[v + 2]], E), u)); }
                });
                if (reach >= 0 && reach < t * 0.999) return false; // a flat face that ends before the wedge does
              }
              }
              return true;
            };
            const wedgeOnce = (scale, minDelta) => {
              let acc = b.s;
              for (const e of found) {
                const sz = (f.type === 'fillet' && p.variable ? (p.reverse ? { r0: p.radiusEnd, r1: p.radius } : { r0: p.radius, r1: p.radiusEnd }) : size);
                const scaled = typeof sz === 'object' ? { r0: sz.r0 * scale, r1: sz.r1 * scale } : sz * scale;
                const opts2 = { minDelta, ...(f.type === 'chamfer' ? (p.mode === 'two' || p.mode === 'angle' ? { chamfer: { mode: p.mode, d2: p.distance2 * scale, angle: ((p.angle ?? 45) * Math.PI) / 180, flip: !!p.flip } } : {}) : (p.mode === 'chord' && p.chord > 0 ? { chord: p.chord * scale } : {})) };
                if (!wedgeFits(e.ch, f.type, scaled, opts2)) throw new Error('wider than the faces');
                const w = edgeCutter(e.ch, f.type, scaled, opts2), sw = weldSoup(soupOfMesh(w.verts, w.tris)), wedge = sewMesh(R, sw.verts, sw.tris, { track, maxFaces: 100000 }).solid;
                if (!(vol(wedge) > 1e-9)) throw new Error('empty wedge');
                const next = w.convex ? cut(acc, wedge) : fuse(acc, wedge);
                if (empty(next)) throw new Error('nothing left');
                acc = next;
              }
              return acc;
            };
            const wedgeSegments = (scale) => {
              let acc = b.s;
              for (const e of found) {
                const sz = (f.type === 'fillet' && p.variable ? (p.reverse ? { r0: p.radiusEnd, r1: p.radius } : { r0: p.radius, r1: p.radiusEnd }) : size);
                const scaled = typeof sz === 'object' ? { r0: sz.r0 * scale, r1: sz.r1 * scale } : sz * scale;
                const opts2 = f.type === 'chamfer' ? (p.mode === 'two' || p.mode === 'angle' ? { chamfer: { mode: p.mode, d2: p.distance2 * scale, angle: ((p.angle ?? 45) * Math.PI) / 180, flip: !!p.flip } } : {}) : (p.mode === 'chord' && p.chord > 0 ? { chord: p.chord * scale } : {});
                if (!wedgeFits(e.ch, f.type, scaled, opts2)) throw new Error('wider than the faces');
                const n = e.ch.pts.length, last = e.ch.closed ? n : n - 1;
                for (let i = 0; i < last; i++) {
                  const j = (i + 1) % n, sub = { closed: false, pts: [e.ch.pts[i], e.ch.pts[j]], frames: [e.ch.frames[i], e.ch.frames[j]] };
                  const w = edgeCutter(sub, f.type, scaled, opts2), sw = weldSoup(soupOfMesh(w.verts, w.tris)), wedge = sewMesh(R, sw.verts, sw.tris, { track, maxFaces: 100000 }).solid;
                  if (!(vol(wedge) > 1e-12)) continue;
                  const next = w.convex ? cut(acc, wedge) : fuse(acc, wedge);
                  if (!empty(next)) acc = next;
                }
              }
              const moved = Math.abs(vol(before) - vol(acc)), s2 = Math.max(size, p.distance2 || 0, p.chord || 0) * scale;
              if (!(moved >= 0.03 * s2 * s2 * found.reduce((a, e) => a + polyLen(e.pts), 0))) throw new Error('implausible result');
              return acc;
            };
            const sizeMax0 = Math.max(size, p.distance2 || 0, p.chord || 0, p.variable ? p.radiusEnd || 0 : 0), Ltot = found.reduce((a, e) => a + polyLen(e.pts), 0);
            const viaWedges = (scale) => { // a boolean with a thin wedge can come out wrong now and then; a margin or a size a hair different (about 1 %) rebuilds it differently
              let last = null;
              for (const [jitter, minDelta] of [[1, 0.01], [1, 0.06]]) {
                try {
                  const out = wedgeOnce(scale * jitter, minDelta), moved = Math.abs(vol(before) - vol(out)), s2 = sizeMax0 * scale;
                  if (moved >= 0.03 * s2 * s2 * Ltot && moved <= 2 * s2 * s2 * Ltot) return out;
                  last = new Error('implausible result');
                } catch (e) { last = e; }
              }
              try { return wedgeSegments(scale); } catch (e) { throw e || last; } // last resort: one small wedge per piece of the chain, each a simple boolean
            };
            const viaChecked = () => { // OpenCascade sometimes returns a shape without complaint that has barely changed, or lost far too much: check the volume it took
              const v0 = vol(before); viaOpenCascade();
              const sizeMax = Math.max(size, p.distance2 || 0, p.chord || 0, p.variable ? p.radiusEnd || 0 : 0), L = found.reduce((a, e) => a + polyLen(e.pts), 0), moved = Math.abs(v0 - vol(b.s));
              if (!(moved >= 0.05 * sizeMax * sizeMax * L && moved <= 2 * sizeMax * sizeMax * L)) throw new Error('implausible result');
            };
            try { viaChecked(); }
            catch (occError) {
              b.s = before;
              try { b.s = viaWedges(1); }
              catch {
                b.s = before;
                let fits = 0;
                for (const scale of [0.5, 0.25, 0.125]) { try { viaWedges(scale); fits = scale; break; } catch { /* smaller */ } }
                const unit = f.type === 'fillet' ? p.radius : p.distance;
                throw new Error(`Size too large for ${found.length > 1 ? 'these edges' : 'this edge'}: ${unit} mm does not fit${fits ? `; about ${+(unit * fits).toFixed(2)} mm does` : ', and neither do smaller sizes, so check that the edge can be rounded at all'}.`);
              }
            }
          }
          const lostWarn = lostEdgesOutcome(lost[f.id], p.edges.length);
          if (lostWarn) warnings[f.id] = lostWarn;
          break;
        }
        case 'hole': {
          const tool = holeTool(p, track);
          let pos = p.pos;
          const fb = p.face && live.get(p.face.id || p.target), now = fb && faceNow(fb.s, p.face);
          if (now) { const nn = unit(now.normal); pos = add(pos, scl(nn, dot(sub(now.point, p.face.point), nn))); }
          const dir = unit(p.dir), axis = scl(dir, -1);
          applyOp(f, placeAlong(tool, pos, axis, track), 'cut', p.target);
          break;
        }
        case 'move': case 'scale': {
          const b = getBody(p.body);
          const bb = bboxOfShape(b.s);
          const mid = bb.min.map((v, k) => (v + bb.max[k]) / 2);
          let m;
          const s3all = f.type === 'move' ? p.s : (p.mode === 'nonuniform' ? p.s : [p.factor, p.factor, p.factor]);
          if (!s3all.every((v) => Math.abs(v - s3all[0]) < 1e-12)) { // stretching differently along each axis turns curved surfaces into faceted ones: OpenCascade cannot stretch them exactly
            if (!s3all.every((v) => v > 0)) throw new Error('Scale factors must be positive');
            const c = f.type === 'move' ? mid : p.about === 'origin' ? [0, 0, 0] : mid, d = f.type === 'move' && p.mode === 'points' && Array.isArray(p.from) && Array.isArray(p.to) ? p.to.map((v, k) => v - p.from[k]) : [0, 0, 0];
            const rot = f.type === 'move' ? p.r : [0, 0, 0], tr = f.type === 'move' ? p.t : [0, 0, 0];
            if (f.type === 'scale') { // exact when the body can be rebuilt stretched (see scaleExact)
              const ex = (() => { try { return scaleExact(b, s3all, c); } catch { return null; } })();
              if (ex) { notes[f.id] = { op: 'scale', bodies: [b.id], text: 'Stretched exactly: the body was rebuilt from its primitive or extrude with stretched dimensions' }; if (p.copy) addBody(f.id, ex, f.name); else b.s = ex; break; }
              if (meshShape(b.s).faces.some((fc) => fc.type !== 'PLANE')) warnings[f.id] = [{ text: 'Stretching differently along each axis turns curved faces into facets here: OpenCascade cannot stretch them, and only an unchanged box, cylinder, sphere, cone or a plain extrude of simple shapes is rebuilt exactly. Scale it before other features, or sketch the stretched shape.' }];
            }
            const me = meshShape(b.s), V = new Float32Array(me.verts.length);
            const spinXYZ = (q) => { let [x, y, z] = q; const rx = (rot[0] * Math.PI) / 180, ry = (rot[1] * Math.PI) / 180, rz = (rot[2] * Math.PI) / 180; [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)]; [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)]; [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)]; return [x, y, z]; };
            for (let i = 0; i < V.length; i += 3) { const q = spinXYZ([0, 1, 2].map((k) => (me.verts[i + k] - c[k]) * s3all[k])); for (let k = 0; k < 3; k++) V[i + k] = q[k] + c[k] + tr[k] + d[k]; }
            m = track(sewMesh(R, V, me.tris, { track }).solid);
            if (f.type === 'move' ? p.copy : p.copy) addBody(f.id, m, f.name); else b.s = m;
            break;
          }
          if (f.type === 'move') {
            const c = mid, d = p.mode === 'points' && Array.isArray(p.from) && Array.isArray(p.to) ? p.to.map((v, k) => v - p.from[k]) : [0, 0, 0];
            m = track(b.s.clone());
            if (p.s[0] !== 1) m = track(m.scale(p.s[0], c));
            ['X', 'Y', 'Z'].forEach((ax, k) => { if (p.r[k]) m = track(m.rotate(p.r[k], c, ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[ax])); });
            m = track(m.translate(p.t.map((v, k) => v + d[k])));
          } else {
            const c = p.about === 'origin' ? [0, 0, 0] : mid, s3 = p.mode === 'nonuniform' ? p.s : [p.factor, p.factor, p.factor];
            if (!s3.every((v) => v > 0)) throw new Error('Scale factors must be positive');
            m = track(track(b.s.clone()).scale(s3[0], c));
          }
          if (p.copy) addBody(f.id, m, f.name); else b.s = m;
          break;
        }
        case 'split': {
          const b = getBody(p.body);
          let first, second; // the mesh kernel's order: plane: [positive side, negative side]; body: [outside, inside]
          if (p.by === 'body') {
            const tool = getBody(p.tool);
            if (tool === b) throw new Error('Tool must be a different body');
            first = cut(b.s, tool.s); second = intersectTidy(b.s, tool.s);
            if (!p.keepTool) live.delete(p.tool);
          } else {
            const nrm = PLANES[p.plane].n, o = scl(nrm, +p.offset || 0);
            first = intersectTidy(b.s, halfSpace(o, nrm, track)); second = intersectTidy(b.s, halfSpace(o, scl(nrm, -1), track));
          }
          const keep = p.keep || 'both';
          if (keep === 'both') {
            if (!empty(first)) b.s = first; else live.delete(b.id);
            if (!empty(second)) addBody(f.id, second, f.name);
          } else {
            const pick = keep === 'above' || keep === 'outside' ? first : second;
            if (empty(pick)) live.delete(b.id); else b.s = pick;
          }
          break;
        }
        case 'joint': {
          const A = getBody(p.bodyA), B = getBody(p.bodyB);
          if (A === B) throw new Error('Choose two different bodies');
          const o = p.pointB, ax = 'XYZ'.indexOf(p.axis), av = ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[p.axis] || [0, 0, 1];
          const comp = opts.bodyComp?.[A.id];
          const group = comp ? [...live.values()].filter((x) => opts.bodyComp[x.id] === comp) : [A];
          if (group.includes(B)) throw new Error('Both bodies are in the same component; choose bodies from different components');
          const spin = (m, deg3) => ['X', 'Y', 'Z'].reduce((q, name, k) => (deg3[k] ? track(q.rotate(deg3[k], o, ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[name])) : q), m);
          const eul = (deg) => { const r = [0, 0, 0]; r[ax] = deg; return r; };
          const slide = (v) => av.map((c) => c * v);
          const move = (m0) => {
            let m = track(track(m0.clone()).translate(sub(o, p.pointA)));
            switch (p.jtype) {
              case 'revolute': m = spin(m, eul(p.value)); break;
              case 'slider': m = track(m.translate(slide(p.value))); break;
              case 'cylindrical': m = spin(m, eul(p.value)); m = track(m.translate(slide(p.value2))); break;
              case 'planar': { const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3, tr = [0, 0, 0]; tr[a1] = p.value; tr[a2] = p.value2; m = spin(m, eul(p.value3 || 0)); m = track(m.translate(tr)); break; }
              case 'ball': m = spin(m, p.rot); break;
              default: if (p.flip) { const r = [0, 0, 0]; r[(ax + 1) % 3] = 180; m = spin(m, r); }
            }
            return m;
          };
          for (const x of group) x.s = move(x.s);
          break;
        }
        case 'pipe': {
          const path = sketches[p.path];
          if (!path) throw new Error('Choose a path sketch');
          sketchUsed.add(path.id);
          if (!(p.diameter > 0)) throw new Error('Diameter must be positive');
          if (p.wall > 0 && p.wall * 2 >= p.diameter) throw new Error('Wall thickness is too large for this diameter');
          const spine = spineFor(path, p, track, planeOf);
          const t0 = spine.tangentAt(0), start = spine.startPoint;
          const tube = (r) => { const circle = track(R.makeCircle(r, [start.x, start.y, start.z], [t0.x, t0.y, t0.z])), ring = track(R.assembleWire([circle])); return p.corner === 'mitre' ? mitreSweep(ring, spine, track) : track(R.genericSweep(ring, spine, { transitionMode: 'right' })); };
          let m = tube(p.diameter / 2);
          if (p.wall > 0) m = cut(m, tube(p.diameter / 2 - p.wall));
          else { // a solid pipe can be shelled exactly, like a sweep (see the Shell feature)
            const t1 = spine.tangentAt(1), e = spine.endPoint, u = (v, k) => { const n = Math.hypot(v.x, v.y, v.z) || 1; return [k * v.x / n, k * v.y / n, k * v.z / n]; };
            m._hollow = (dt) => tube(p.diameter / 2 + dt);
            m._hollowEnds = [{ at: [start.x, start.y, start.z], dir: u(t0, -1) }, { at: [e.x, e.y, e.z], dir: u(t1, 1) }];
          }
          applyOp(f, m, p.op || 'new', p.target);
          break;
        }
        case 'rib': {
          const sk = sketches[p.sketch];
          if (!sk) throw new Error('Sketch not found');
          sketchUsed.add(sk.id);
          const rects = [];
          for (const s2 of sk.params.shapes) {
            if (s2.t !== 'path' || !s2.open) continue;
            for (let i = 0; i < s2.pts.length - 1; i++) {
              const [a, b2] = [s2.pts[i], s2.pts[i + 1]], dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy);
              if (L < 1e-9) continue;
              const ux = dx / L, uy = dy / L, hw = p.thickness / 2;
              const A = [a[0] - ux * hw, a[1] - uy * hw], B = [b2[0] + ux * hw, b2[1] + uy * hw];
              rects.push(track(R.draw([A[0] - uy * hw, A[1] + ux * hw]).lineTo([B[0] - uy * hw, B[1] + ux * hw]).lineTo([B[0] + uy * hw, B[1] - ux * hw]).lineTo([A[0] + uy * hw, A[1] - ux * hw]).close()));
            }
          }
          if (!rects.length) throw new Error('Draw an open Path in the sketch (the rib centre-line)');
          const h = Math.abs(p.height) || 1e-3;
          const range = p.symmetric ? [-h / 2, h / 2] : p.height < 0 ? [-h, 0] : [0, h];
          applyOp(f, slab(rects, sk.params, range[0], range[1]), p.op, p.target);
          break;
        }
        case 'coil': {
          const Rr = p.diameter / 2, h = p.size / 2;
          if (!(Rr > h) || !(h > 0) || !(p.pitch > 0) || !(p.turns > 0)) throw new Error('Check diameter, section size, pitch and turns');
          const helix = track(R.makeHelix(p.pitch, p.pitch * p.turns, Rr, [0, 0, 0], [0, 0, 1], !!p.left));
          const pl = track(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0]));
          const prof = p.section === 'square' ? R.draw([Rr - h, -h]).lineTo([Rr + h, -h]).lineTo([Rr + h, h]).lineTo([Rr - h, h]).close() : R.drawCircle(h).translate(Rr, 0);
          const wire = track(track(prof.sketchOnPlane(pl)).wire);
          const coil = track(R.genericSweep(wire, helix, { frenet: true }));
          if (R.measureVolume(coil) < 0) throw new Error('The coil came out inside out');
          applyOp(f, placeAlong(coil, p.origin, ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[p.axis] || [0, 0, 1], track), p.op, p.target);
          break;
        }
        case 'importstep': { // a STEP file keeps its true surfaces: one body per solid in the file
          const solids = readSTEP(p.data);
          if (!solids.length) throw new Error('The STEP file has no solids');
          solids.forEach((sd, k) => addBody(k ? `${f.id}~${k + 1}` : f.id, track(sd), k ? `${f.name} ${k + 1}` : f.name));
          break;
        }
        case 'import': { // a mesh becomes a faceted solid (sew.js)
          let w = weldSoup(decodeMesh(p));
          if (p.reduce) { const r = reduceMesh(w.verts, w.tris, { keepPercent: p.reduce.keep, maxDeviation: p.reduce.tolerance }); w = weldSoup(soupOfMesh(r.verts, r.tris)); } // fewer triangles first: the amount is in the step, so it can change later
          addBody(f.id, sewMesh(R, w.verts, w.tris, { track }).solid, f.name);
          break;
        }
        case 'mclean': case 'mreduce': case 'mseparate': { // triangle tools: tessellate the body, work on the triangles, sew the result
          const b = getBody(p.body), me = meshShape(b.s);
          if (f.type === 'mclean') {
            const fixed = repairSoup(soupOfMesh(me.verts, me.tris), { tolerance: Math.max(0, +p.tolerance || 0), minShell: Math.max(0, +p.minShell || 0) }), w = weldSoup(fixed.soup);
            if (!w.tris.length) throw new Error('Cleaning left nothing: lower the piece size limit');
            b.s = sewMesh(R, w.verts, w.tris, { track }).solid;
          } else if (f.type === 'mreduce') {
            const r = reduceMesh(me.verts, me.tris, { keepPercent: p.keep ?? 50, maxDeviation: Math.max(0.001, p.tolerance ?? 0.2) });
            if (!r.tris.length) throw new Error('Reducing removed the whole body; lower the deviation');
            const w = weldSoup(soupOfMesh(r.verts, r.tris));
            b.s = sewMesh(R, w.verts, w.tris, { track }).solid;
          } else {
            const list = pieces(me.tris, me.verts.length / 3);
            if (list.length < 2) throw new Error('This body is one connected piece, so there is nothing to separate');
            const sewn = list.map((tl) => { const soup = new Float32Array(tl.length * 9); tl.forEach((t, n) => { for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) soup[n * 9 + k * 3 + c] = me.verts[me.tris[t * 3 + k] * 3 + c]; }); const w = weldSoup(soup); return sewMesh(R, w.verts, w.tris, { track }); }).sort((x, y) => y.volume - x.volume).map((r) => r.solid); // the biggest piece keeps the body
            const keepName = b.name;
            b.s = sewn[0];
            sewn.slice(1).forEach((sh, k) => addBody(`${f.id}~${k + 2}`, sh, `${keepName} ${k + 2}`));
          }
          break;
        }
        case 'shell': {
          const b = getBody(p.body);
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          const side = p.side || 'inside';
          const open = (p.open || []).map((r) => faceFromRef(b.s, r)).filter(Boolean);
          if (b.s._hollow && b.s._hollowEnds && open.length === (p.open || []).length) { // a swept body: an exact wall from sweeps of the offset profile; the ends are closed by caps unless picked
            const ends = b.s._hollowEnds, near = (fc, e) => Math.hypot(fc.center.x - e.at[0], fc.center.y - e.at[1], fc.center.z - e.at[2]) < 1e-3 + 1e-4 * Math.hypot(...b.s.boundingBox.bounds[1].map((v, k) => v - b.s.boundingBox.bounds[0][k]));
            const openEnd = ends.map((e) => open.some((fc) => fc.geomType === 'PLANE' && near(fc, e)));
            if (open.every((fc) => ends.some((e) => fc.geomType === 'PLANE' && near(fc, e)))) {
              const rawCut = (x, y) => track(x.cut(y)), t = p.thickness, sub = (u, v) => u.map((x, k) => x - v[k]);
              const cavity = (d) => { // the inner sweep, cut back by d from each closed end so the wall closes there
                let c = b.s._hollow(-d);
                ends.forEach((e, i) => { if (!openEnd[i]) c = rawCut(c, halfSpace(sub(e.at, scl(e.dir, d)), e.dir, track)); });
                return c;
              };
              const outer = (d) => { // the sweep of the profile moved out by d, with each closed end face pushed out by d
                let c = b.s._hollow(d);
                const caps = []; // the end faces are found on the plain sweep, before anything is fused to it
                ends.forEach((e, i) => {
                  if (openEnd[i]) return;
                  const face = c.faces.find((fc) => fc.geomType === 'PLANE' && Math.hypot(fc.center.x - e.at[0], fc.center.y - e.at[1], fc.center.z - e.at[2]) < d + 1e-3 + 1e-3 * Math.abs(d));
                  if (!face) throw new Error('The end of the sweep could not be closed');
                  caps.push(track(R.basicFaceExtrusion(face, track(new R.Vector(scl(e.dir, d))))));
                });
                for (const cap of caps) c = track(c.fuse(cap));
                return c;
              };
              let r, failed, viaVoid = false;
              const allClosed = !openEnd.some(Boolean);
              for (const k of [1, 1.002, 0.998]) { // a boolean between surfaces that nearly coincide sometimes fails; a hair more or less thickness gets round it
                if (allClosed) { // the cavity lies wholly inside the outer sweep: the wall is a solid with an inner shell, which needs no boolean (they cost seconds on spline sweeps)
                  try {
                    r = side === 'inside' ? solidWithVoid(b.s, cavity(t * k), track) : side === 'outside' ? solidWithVoid(outer(t * k), b.s, track) : solidWithVoid(outer(t * k / 2), cavity(t * k / 2), track);
                    if (side === 'inside' && R.measureVolume(r) > R.measureVolume(b.s) * 0.99) throw new Error('no wall'); // a cavity that folds over itself leaves next to nothing taken out: let the cut decide
                    failed = null; viaVoid = true; break;
                  } catch (e) { if (/closed|end of the sweep/.test(e?.message || '')) throw e; }
                }
                try { r = side === 'inside' ? rawCut(b.s, cavity(t * k)) : side === 'outside' ? rawCut(outer(t * k), b.s) : rawCut(outer(t * k / 2), cavity(t * k / 2)); failed = null; break; } // plain booleans: simplifying spline faces costs seconds
                catch (e) { failed = e; if (/closed|end of the sweep/.test(e?.message || '')) throw e; }
              }
              if (failed) throw new Error('Wall thickness is too large for this body, or its sections cannot be moved by this amount.');
              if (empty(r) || (!viaVoid && side === 'inside' && volumeOf(r) > volumeOf(b.s) * 0.9999)) throw new Error('Wall thickness is too large for this body'); // an offset profile that folds over itself leaves the body whole
              open.forEach(track);
              b.s = r; break;
            }
          }
          if (!open.length) { // no open face: a closed hollow, the wall between the surface and its offset
            if (!(p.open || []).length) {
              const off = (d) => offsetSolid(b.s, d, track);
              const hollow = (shape, d) => offsetByMesh(shape, d, track); // faceted fallback for surfaces OpenCascade cannot offset (lofts, 3D paths)
              let out = null;
              for (const grow of [off, hollow]) {
                try {
                  const g = (d) => (grow === off ? off(d) : grow(b.s, d));
                  // A faceted cavity lies wholly inside the body, so it is not cut out with a boolean (24 s against a spline sweep): the wall is
                  // made as a solid with an inner shell, which needs no computing. Checked by volume; a boolean is the fallback.
                  const cx = grow === off ? cut : (x, y) => { try { return solidWithVoid(x, y, track); } catch { return cut(x, y); } };
                  const r = side === 'inside' ? cx(b.s, g(-p.thickness)) : side === 'outside' ? cx(g(p.thickness), b.s) : cx(g(p.thickness / 2), g(-p.thickness / 2));
                  const v = vol(r), v0 = vol(b.s);
                  if (empty(r) || v >= v0 * 1.0001 + (side === 'inside' ? 0 : 1e9)) throw new Error('no wall');
                  if (grow === hollow) warnings[f.id] = [{ text: 'This body could not be offset exactly, so the inside of the wall is a faceted copy of the surface. Swept bodies that have been joined to other solids lose their exact hollow; shell the sweep before joining.' }];
                  out = r; break;
                } catch { /* try the other way */ }
              }
              if (!out) throw new Error('Wall thickness is too large for this body, or the shape folds over itself at this thickness.');
              b.s = out; break;
            }
            throw new Error('The picked faces to open no longer exist on this body');
          }
          const wall = (t) => { try { return track(b.s.shell(t, (fnd) => fnd.when(({ element }) => open.some((g) => g.isSame(element))))); } catch { throw new Error('Wall thickness is too large for this body'); } };
          // inward: the wall lies inside the surface; outward: outside it; centred: half on each side
          const out = side === 'inside' ? wall(p.thickness) : side === 'outside' ? wall(-p.thickness) : fuse(wall(-p.thickness / 2), wall(p.thickness / 2));
          if (empty(out) || (side === 'inside' && vol(out) >= vol(b.s) * 0.9999)) throw new Error('Wall thickness is too large for this body'); // OpenCascade sometimes hands back the whole body
          open.forEach(track);
          b.s = out;
          break;
        }
        case 'presspull': {
          if (!p.face) throw new Error('Click a flat face in the viewport');
          const b = getBody(p.body), face = faceFromRef(b.s, p.face);
          if (!face) throw new Error('The picked face no longer exists — pick it again');
          if (face.geomType !== 'PLANE') throw new Error('Press/Pull works on flat faces only');
          if (!p.distance) break;
          const nv = face.normalAt(), slabS = track(R.basicFaceExtrusion(face, track(new R.Vector(scl([nv.x, nv.y, nv.z], p.distance))))); // the material added (distance > 0) or removed (distance < 0)
          if (opts.previewId && opts.previewId === f.id) preview = { op: p.distance < 0 ? 'cut' : 'join', ...brepOps.previewMesh(slabS) };
          b.s = p.distance < 0 ? cut(b.s, slabS) : fuse(b.s, slabS);
          break;
        }
        case 'thickenface': {
          const b = getBody(p.body);
          if (!p.faces?.length) throw new Error('Pick the faces to thicken');
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          let m = b.s;
          for (const fc of p.faces) {
            const face = faceFromRef(m, fc);
            if (!face || face.geomType !== 'PLANE') throw new Error('One of the picked faces is not a flat face of this body any more');
            const nv = face.normalAt(), n = [nv.x, nv.y, nv.z];
            const slabS = track(R.basicFaceExtrusion(face, track(new R.Vector(scl(n, p.dir === 'in' ? -p.thickness : p.thickness)))));
            m = p.dir === 'in' ? cut(m, slabS) : fuse(m, slabS);
            if (empty(m)) throw new Error('Thickening removed the whole body');
          }
          b.s = m;
          break;
        }
        case 'replaceface': {
          const b = getBody(p.body);
          if (!p.face) throw new Error('Pick the flat face to replace');
          const g = planeGeo(p.plane || 'XY'), nt0 = unit(g.normal), ot = add(g.origin, scl(nt0, p.offset || 0));
          const face = faceFromRef(b.s, p.face);
          if (!face || face.geomType !== 'PLANE') throw new Error('The picked face is not a flat face of this body any more');
          const nv = face.normalAt(), nf = [nv.x, nv.y, nv.z], c = dot(nt0, nf);
          if (Math.abs(c) < 0.05) throw new Error('The plane is (nearly) perpendicular to the face; choose a plane that crosses the face direction');
          const nt = c < 0 ? scl(nt0, -1) : nt0, bb = bboxOfShape(b.s), D = 2 * Math.hypot(...bb.max.map((v, k) => v - bb.min[k])) + 2 * Math.hypot(...ot) + 10;
          const up = track(R.basicFaceExtrusion(face, track(new R.Vector(scl(nf, D))))), down = track(R.basicFaceExtrusion(face, track(new R.Vector(scl(nf, -D)))));
          const grow = intersectTidy(up, halfSpace(ot, scl(nt, -1), track)), trim = intersectTidy(down, halfSpace(ot, nt, track)); // grow up to the plane, or trim back to it
          let m = b.s;
          if (vol(trim) > 1e-9) m = cut(m, trim);
          if (vol(grow) > 1e-9) m = fuse(m, grow);
          if (empty(m)) throw new Error('Replacing the face removed the whole body');
          b.s = m;
          break;
        }
        case 'sextrude': case 'srevolve': {
          const sk = sketches[p.sketch];
          if (!sk) throw new Error('Choose a sketch');
          sketchUsed.add(sk.id);
          const oc = R.getOC(), fr = planeFrame(sk.params), plane = planeOf(sk.params).plane;
          const wires = (sk.params.shapes || []).filter(isSolidShape).map((sh) => { const d = sh.open ? openPathDrawing(sh) : shapeDrawing(sh); return d && track(track(track(d).sketchOnPlane(plane)).wire); }).filter(Boolean);
          if (!wires.length) throw new Error(f.type === 'sextrude' ? `${sk.name} has no shapes (draw a path, rectangle, circle...)` : 'The sketch has no shapes to revolve');
          const faces = [];
          if (f.type === 'sextrude') {
            const d = p.distance || 0;
            if (!d) throw new Error('Enter a distance');
            const off = p.symmetric ? -d / 2 : 0;
            for (const w of wires) {
              const moved = off ? track(w.clone().translate(scl(fr.n, off))) : w;
              const mk = new oc.BRepPrimAPI_MakePrism(moved.wrapped, track(new R.Vector(scl(fr.n, d))).wrapped, false, true);
              faces.push(...R.cast(mk.Shape()).faces); mk.delete();
            }
          } else {
            const ang = Math.min(360, Math.max(1, p.angle ?? 360));
            for (const w of wires) {
              const mk = new oc.BRepPrimAPI_MakeRevol(w.wrapped, R.makeAx1(fr.o, fr.y), (ang * Math.PI) / 180, false);
              faces.push(...R.cast(mk.Shape()).faces); mk.delete();
            }
          }
          addSurface(f.id, track(R.weldShellsAndFaces(faces.map(track), true)), f.name);
          break;
        }
        case 'ssweep': {
          const prof = sketches[p.profile], path = sketches[p.path];
          if (!prof || !path) throw new Error('Choose a profile sketch and a path sketch');
          sketchUsed.add(prof.id); sketchUsed.add(path.id);
          const why = sweepCheck(null, path, p);
          if (why) throw new Error(`Not in the exact kernel: ${why}`);
          const spine = spineFor(path, p, track, planeOf), plane = planeOf(prof.params).plane, faces = [];
          for (const sh of (prof.params.shapes || []).filter(isSolidShape)) {
            const d = sh.open ? openPathDrawing(sh) : shapeDrawing(sh);
            if (!d) continue;
            const sweep = track(R.genericSweep(track(track(track(d).sketchOnPlane(plane)).wire), spine, { transitionMode: 'right' }));
            faces.push(...sweep.faces);
          }
          if (!faces.length) throw new Error('The profile sketch has no shapes');
          addSurface(f.id, track(R.weldShellsAndFaces(faces.map(track), true)), f.name);
          break;
        }
        case 'sloft': {
          const sks = (p.sketches || []).map((id) => sketches[id]).filter(Boolean);
          if (sks.length < 2) throw new Error('Choose at least two profile sketches');
          sks.forEach((k) => sketchUsed.add(k.id));
          const secs = sks.map((k) => { const why = singleOutline(k); if (why) throw new Error(`Not in the exact kernel: ${why}`); return track(shapeDrawing((k.params.shapes || []).find((x) => !x.open && isSolidShape(x))).sketchOnPlane(planeOf(k.params).plane)); });
          addSurface(f.id, track(secs[0].loftWith(secs.slice(1), { ruled: true }, true)), f.name);
          break;
        }
        case 'sstitch': {
          const ids = (p.surfaces || []).filter((id) => surfaces.has(id));
          if (ids.length < 1) throw new Error('Pick at least one surface');
          const faces = ids.flatMap((id) => surfaces.get(id).s.faces);
          const shell = track(R.weldShellsAndFaces(faces.map(track), true));
          const closed = !!shell.wrapped.Closed?.();
          let solid = null;
          if (closed) { try { const sd = track(R.makeSolid([shell])); if (R.measureVolume(sd) < 0) throw new Error('inside out'); solid = sd; } catch { solid = null; } }
          for (const id of ids) surfaces.delete(id);
          if (solid) addBody(f.id, solid, f.name);
          else if (p.requireSolid) throw new Error('The surfaces are not a closed shell yet');
          else addSurface(f.id, shell, f.name);
          break;
        }
        case 'sthicken': {
          const q = getSurface(p.surface);
          if (!(p.thickness > 0)) throw new Error('Thickness must be positive');
          const slabs = q.s.faces.map((face) => {
            if (face.geomType !== 'PLANE') return thickenCurved(face, p.thickness, !!p.both, track); // an offset surface with ruled walls
            const nv = face.normalAt(), n = [nv.x, nv.y, nv.z], lo = p.both ? -p.thickness / 2 : 0;
            const base = lo ? track(R.makeCompound([track(face.clone().translate(scl(n, lo)))]).faces[0]) : face;
            return track(R.basicFaceExtrusion(base, track(new R.Vector(scl(n, p.thickness)))));
          });
          surfaces.delete(q.id);
          addBody(f.id, union(slabs), f.name);
          break;
        }
        case 'strim': {
          const q = getSurface(p.surface), g = planeGeo(p.plane || 'XY'), nrm = unit(g.normal), o = add(g.origin, scl(nrm, p.offset || 0)), sgn = p.keep === 'below' ? -1 : 1;
          const oc = R.getOC(), cm = new oc.BRepAlgoAPI_Common(q.s.wrapped, halfSpace(o, scl(nrm, sgn), track).wrapped); // a surface "intersected" with a solid keeps the part inside it
          cm.Build(); cm.SimplifyResult(true, true, 0.001);
          const kept = track(R.cast(cm.Shape())); cm.delete();
          if (!kept.faces.length) throw new Error('Nothing of the surface is left on that side of the plane');
          q.s = kept;
          break;
        }
        case 'boundaryfill': {
          const ids = (p.tools || []).filter((id) => live.has(id));
          if (ids.length < 1 || (p.region === 'common' && ids.length < 2)) throw new Error(p.region === 'common' ? 'Pick at least two tool bodies' : 'Pick the tool bodies that enclose the space');
          const tools = ids.map((id) => live.get(id).s), results = [];
          if (p.region === 'common') {
            const c = tools.slice(1).reduce((a, x) => intersectTidy(a, x), tools[0]);
            if (empty(c)) throw new Error('The tool bodies do not overlap');
            results.push(c);
          } else {
            const all = union(tools.slice()), bb = bboxOfShape(all), pad = 2;
            const box = track(R.makeBox(bb.min.map((v) => v - pad), bb.max.map((v) => v + pad)));
            const space = cut(box, all);
            for (const piece of space.solids) { // the solids that do not reach the padding are enclosed by the tools; the one around everything is not
              track(piece);
              const pb = bboxOfShape(piece);
              if (pb.min.every((v, k) => Math.abs(v - (bb.min[k] - pad)) < 1e-6) && pb.max.every((v, k) => Math.abs(v - (bb.max[k] + pad)) < 1e-6)) continue;
              if (vol(piece) > 1e-6) results.push(piece);
            }
            if (!results.length) throw new Error('No enclosed space found between these bodies');
          }
          results.sort((a, c) => vol(c) - vol(a));
          results.forEach((rm, k) => addBody(k ? `${f.id}~${k + 1}` : f.id, rm, k ? `${f.name} ${k + 1}` : f.name));
          if (!p.keepTools) for (const id of ids) live.delete(id);
          break;
        }
        case 'draft': {
          const b = getBody(p.body);
          if (!p.faces?.length) throw new Error('Pick the faces to draft');
          const ang = ((p.angle || 0) * Math.PI) / 180;
          if (Math.abs(ang) < 1e-9) throw new Error('Enter a draft angle');
          if (Math.abs(ang) >= Math.PI / 4) throw new Error('Draft angle must be under 45 degrees');
          const u = ({ '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] })[p.dir || '+Z'];
          const mv = meshShape(b.s);
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < mv.verts.length; i += 3) { const h = mv.verts[i] * u[0] + mv.verts[i + 1] * u[1] + mv.verts[i + 2] * u[2]; lo = Math.min(lo, h); hi = Math.max(hi, h); }
          const end = p.neutral === 'end', h0 = end ? hi : lo;
          const oc = R.getOC(), dr = new oc.BRepOffsetAPI_DraftAngle(b.s.wrapped);
          garbage.push({ delete: () => dr.delete() });
          for (const fc of p.faces) {
            const face = faceFromRef(b.s, fc);
            if (!face || face.geomType !== 'PLANE') throw new Error('One of the picked faces is not a flat face of this body any more');
            const nv = face.normalAt();
            if (Math.abs(dot([nv.x, nv.y, nv.z], u)) > 0.9) throw new Error('A picked face is parallel to the neutral plane; pick the side faces');
            dr.Add(face.wrapped, R.asDir(end ? scl(u, -1) : u), ang, R.makePln(scl(u, h0), u), true);
            if (!dr.AddDone()) throw new Error('This face cannot be drafted by that angle');
          }
          dr.Build(new oc.Message_ProgressRange());
          if (!dr.IsDone()) throw new Error('The draft could not be built');
          b.s = track(R.cast(dr.Shape()));
          break;
        }
        case 'sweep': {
          const prof = sketches[p.profile], path = sketches[p.path];
          if (!prof || !path) throw new Error('Choose a profile sketch and a path sketch');
          sketchUsed.add(prof.id); sketchUsed.add(path.id);
          const why = sweepCheck(prof, path, p);
          if (why) throw new Error(`Not in the exact kernel: ${why}`);
          const sh = (prof.params.shapes || []).find((x) => !x.open && isSolidShape(x));
          const wire = track(track(shapeDrawing(sh).sketchOnPlane(planeOf(prof.params).plane)).wire);
          const spine = spineFor(path, p, track, planeOf), t0v = spine.tangentAt(0);
          let m = p.corner === 'mitre' ? mitreSweep(wire, spine, track) : track(R.genericSweep(wire, spine, { transitionMode: 'right' }));
          if (R.measureVolume(m) < 0) throw new Error('The sweep came out inside out; flip the profile or the path');
          // OpenCascade cannot offset a sweep's surface, so Shell builds the wall from the same sweep with the profile moved in or out
          m._hollow = (dt) => track(R.genericSweep(track(track(shapeDrawing(sh).offset(dt).sketchOnPlane(planeOf(prof.params).plane)).wire), spineFor(path, p, track, planeOf), { transitionMode: 'right' }));
          { const t1 = spine.tangentAt(1), e = spine.endPoint, u = (v, k) => { const n = Math.hypot(v.x, v.y, v.z) || 1; return [k * v.x / n, k * v.y / n, k * v.z / n]; }; m._hollowEnds = [{ at: [spine.startPoint.x, spine.startPoint.y, spine.startPoint.z], dir: u(t0v, -1) }, { at: [e.x, e.y, e.z], dir: u(t1, 1) }]; } // outward direction at each end
          applyOp(f, m, p.op, p.target);
          break;
        }
        case 'loft': {
          const sks = (p.sketches || []).map((id) => sketches[id]).filter(Boolean);
          if (sks.length < 2) throw new Error('Choose at least two profile sketches');
          sks.forEach((k) => sketchUsed.add(k.id));
          const faces = sks.map((k) => {
            const why = singleOutline(k);
            if (why) throw new Error(`Not in the exact kernel: ${why}`);
            const shp = (k.params.shapes || []).find((x) => !x.open && isSolidShape(x));
            return track(shapeDrawing(shp).sketchOnPlane(planeOf(k.params).plane));
          });
          const m = track(faces[0].loftWith(faces.slice(1), { ruled: true }));
          // Shell builds the wall from the same loft with every section moved in or out in its own plane, and closes the two ends with caps
          const secs = sks.map((k) => ({ k, shp: (k.params.shapes || []).find((x) => !x.open && isSolidShape(x)) }));
          m._hollow = (dt) => {
            const fs = secs.map(({ k, shp }) => track(shapeDrawing(shp).offset(dt).sketchOnPlane(planeOf(k.params).plane)));
            return track(fs[0].loftWith(fs.slice(1), { ruled: true }));
          };
          { const endFace = (face) => m.faces.filter((q) => q.geomType === 'PLANE').sort((a, c) => Math.hypot(a.center.x - face.center.x, a.center.y - face.center.y, a.center.z - face.center.z) - Math.hypot(c.center.x - face.center.x, c.center.y - face.center.y, c.center.z - face.center.z))[0];
            const ends = [secs[0], secs[secs.length - 1]].map(({ k }) => { const o = planeOf(k.params).plane.origin, q = endFace({ center: o }), n = q.normalAt(); return { at: [q.center.x, q.center.y, q.center.z], dir: [n.x, n.y, n.z] }; });
            if (ends.every((e) => Math.hypot(...e.dir) > 0.5)) m._hollowEnds = ends; }
          applyOp(f, m, p.op, p.target);
          break;
        }
        case 'thread': {
          const b = getBody(p.target);
          const groove = threadGroove(p, track);
          b.s = cut(b.s, placeAlong(groove, p.origin, ({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] })[p.axis] || [0, 0, 1], track));
          break;
        }
        case 'remove': getBody(p.body); live.delete(p.body); break;
        case 'sextend': {
          const q = getSurface(p.surface);
          if (!(p.distance > 0)) throw new Error('Distance must be positive');
          q.s = extendSurface(q.s, p.distance, track);
          break;
        }
        default: throw new Error('Unknown feature ' + f.type);
      }
    } catch (e) { errors[f.id] = (e && e.message) || String(e); }
    if (liveBefore) { // what this feature changed, so that later features that read any of it are built again
      for (const [id, b] of live) if (liveBefore.get(id) !== b.s) dirty.add(baseId(id));
      for (const id of liveBefore.keys()) if (!live.has(id)) dirty.add(baseId(id));
      for (const [id, q] of surfaces) if (surfBefore.get(id) !== q.s) dirty.add(baseId(id));
      for (const id of surfBefore.keys()) if (!surfaces.has(id)) dirty.add(baseId(id));
      if (changed || shifted[f.id] || errors[f.id]) dirty.add(f.id);
      { // what this feature did to the bodies in the previous run is gone too whenever it is built again (it may now be suppressed, fail, or do something else)
        const a = stale.get(i) || (i === firstDiff ? OLD_AT_FIRST : null), b = stale.get(i + 1);
        if (!a || !b) dirty.add('*');
        else {
          const inA = new Map(a.live.map((e) => [e.id, e.s])), inB = new Map(b.live.map((e) => [e.id, e.s]));
          for (const [id, sh] of inB) if (inA.get(id) !== sh) dirty.add(baseId(id));
          for (const id of inA.keys()) if (!inB.has(id)) dirty.add(baseId(id));
          const sA = new Map(a.surfaces.map((e) => [e.id, e.s])), sB = new Map(b.surfaces.map((e) => [e.id, e.s]));
          for (const [id, sh] of sB) if (sA.get(id) !== sh) dirty.add(baseId(id));
          for (const id of sA.keys()) if (!sB.has(id)) dirty.add(baseId(id));
        }
      }
    }
    BC.out[i] = { snap: sn, surf: sf, error: errors[f.id], warnings: warnings[f.id], note: notes[f.id], lost: lost[f.id], shifted: shifted[f.id] };
  }
  makeCheckpoint(n);
  if (useCache) { BC.feats = features; BC.comp = compKey; }
  for (const cp of stale.values()) { for (const e of cp.live) unhold(e.s); for (const e of cp.surfaces) unhold(e.s); } // what was not reused goes now (the new states hold what was)
  stale.clear();
  if (opts.discard) { // a step of a rebuild done in pieces (kernel-worker.js): nothing is shown yet, so no meshes are made
    for (const o of garbage) if (!held.has(o)) { try { o.delete(); } catch { /* already freed */ } }
    return { discarded: true };
  }

  const bodies = [...live.values()].map((b) => { const me = meshShape(b.s); return { id: b.id, name: b.name, key: me.key, verts: me.verts, tris: me.tris, faceOf: me.faceOf, faces: me.faces, volume: me.volume, area: me.area, bbox: me.bbox, brep: true }; });
  const surfList = [...surfaces.values()].map((q) => { const me = meshShape(q.s); return { id: q.id, name: q.name, key: me.key, verts: me.verts, tris: me.tris, bbox: me.bbox, surface: true }; });
  const shapes = opts.keepShapes ? new Map([...live.values()].map((b) => [b.id, b.s])) : null;
  const keep = new Set(shapes ? shapes.values() : []);
  for (const o of garbage) if (!keep.has(o) && !held.has(o)) { try { o.delete(); } catch { /* already freed */ } } // whatever no kept state needs
  const out = { bodies, surfaces: surfList, surfSnaps, errors, warnings, notes, lost, snaps, sketchUsed, captured, preview, shifted, stats: { from: start, steps: n - start - reused, reused, total: n }, backend: { kind: 'brep' } };
  if (shapes) { out.shapes = shapes; out.dispose = () => { for (const s of shapes.values()) { try { s.delete(); } catch { /* already freed */ } } }; } // functions cannot cross to a worker, so only an export gets one
  return out;
}

/**
 * A surface grown outward from every open edge by a strip of `dist` that continues the surface straight along its tangent. Each strip is
 * a ruled surface between the edge and the same edge moved out along the in-surface direction at right angles to it, and the strips are
 * sewn to the faces. (Strips of neighbouring edges meet only at the corner point, as the strips of a flat surface extended edge by edge do.)
 */
function extendSurface(shape, dist, track) {
  const oc = R.getOC(), faces = shape.faces, N = 16;
  const owners = []; // each edge with the face that has it, counting how many faces share it
  faces.forEach((fc) => { fc.edges.forEach((e) => { const hit = owners.find((o) => o.e.isSame(e)); if (hit) hit.n++; else owners.push({ e, fc, n: 1 }); }); });
  const free = owners.filter((o) => o.n === 1);
  if (!free.length) throw new Error('The surface has no open edge to extend (it is closed)');
  const strips = [];
  for (const { e, fc } of free) {
    const centre = fc.center, rows = [];
    let side = 0;
    for (let i = 0; i <= N; i++) {
      const u = i / N, pt = e.pointAt(u), tg = e.tangentAt(u), nv = fc.normalAt(pt);
      const out = [tg.y * nv.z - tg.z * nv.y, tg.z * nv.x - tg.x * nv.z, tg.x * nv.y - tg.y * nv.x], l = Math.hypot(...out) || 1;
      const dir = out.map((v) => v / l);
      side += dir[0] * (pt.x - centre.x) + dir[1] * (pt.y - centre.y) + dir[2] * (pt.z - centre.z);
      rows.push({ p: [pt.x, pt.y, pt.z], dir });
    }
    const sgn = side >= 0 ? 1 : -1; // away from the middle of the face
    const moved = rows.map(({ p: q, dir }) => q.map((v, k) => v + sgn * dir[k] * dist));
    const far = e.geomType === 'LINE' ? track(R.makeLine(moved[0], moved[N])) : track(R.makeBSplineApproximation(moved, { tolerance: 1e-4, degMin: 3, degMax: 5 }));
    const th = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    try {
      th.AddWire(track(R.assembleWire([track(e.clone())])).wrapped); th.AddWire(track(R.assembleWire([far])).wrapped); th.Build(new oc.Message_ProgressRange());
      if (!th.IsDone()) throw new Error('strip failed');
      strips.push(...track(R.cast(th.Shape())).faces);
    } catch { throw new Error('The surface could not be extended along one of its edges'); } finally { th.delete(); }
  }
  return track(R.weldShellsAndFaces([...faces.map((f) => track(f.clone())), ...strips], true));
}

/**
 * A curved face (a cylinder, a sphere, a swept or lofted surface) thickened into a solid: the face and its offset along the normal
 * (OpenCascade offsets the surface itself), joined along every boundary edge by a ruled wall, and sewn. `both` splits the thickness
 * over the two sides of the face. Throws when the offset cannot be made (a surface tighter than the thickness).
 */
function thickenCurved(face, t, both, track) {
  const oc = R.getOC();
  const offsetFace = (d) => {
    const o = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      o.PerformByJoin(face.wrapped, d, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange());
      if (!o.IsDone()) throw new Error('offset failed');
      const out = track(R.cast(o.Shape()));
      const f = out.faces;
      if (f.length !== 1) throw new Error('offset split the face');
      return f[0];
    } catch { throw new Error('This curved surface cannot be thickened by that much (it is tighter than the thickness). Try a smaller thickness.'); } finally { o.delete(); }
  };
  const lo = both ? offsetFace(-t / 2) : track(face.clone()), hi = offsetFace(both ? t / 2 : t);
  const wiresOf = (f) => [track(f.clone().outerWire()), ...f.clone().innerWires().map(track)];
  const w1 = wiresOf(lo), w2 = wiresOf(hi);
  if (w1.length !== w2.length) throw new Error('The surface could not be thickened');
  const faces = [lo, hi];
  w1.forEach((w, k) => {
    const th = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    try {
      th.AddWire(w.wrapped); th.AddWire(w2[k].wrapped); th.Build(new oc.Message_ProgressRange());
      if (!th.IsDone()) throw new Error('walls failed');
      faces.push(...track(R.cast(th.Shape())).faces);
    } finally { th.delete(); }
  });
  const welded = track(R.weldShellsAndFaces(faces));
  let solid, v;
  try { solid = track(R.makeSolid([welded])); v = R.measureVolume(solid); } catch { throw new Error('This surface closes on itself (a full revolve, a tube) or has a seam, so it cannot be thickened here; use a part revolve or Shell the solid instead.'); }
  if (v < 0) solid = track(R.makeSolid([track(welded.flipOrientation?.() ?? welded)]));
  if (!(Math.abs(R.measureVolume(solid)) > 1e-9)) throw new Error('The thickened surface is not a closed solid');
  return solid;
}

/**
 * `outer` with `inner` taken out of it, made without a boolean for an inner solid that lies wholly inside the outer one: a solid with two
 * shells, the inner one turned inside out. Throws when the volume is not the difference (the inner solid touches or leaves the outer one).
 */
function solidWithVoid(outer, inner, track) {
  const oc = R.getOC(), shellOf = (x) => { const ex = new oc.TopExp_Explorer(x.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); try { if (!ex.More()) throw new Error('no shell'); return oc.TopoDS.Shell(ex.Current()); } finally { ex.delete(); } };
  const ms = new oc.BRepBuilderAPI_MakeSolid();
  try {
    ms.Add(shellOf(outer)); ms.Add(oc.TopoDS.Shell(shellOf(inner).Reversed()));
    const solid = track(R.cast(ms.Solid()));
    const v = R.measureVolume(solid), want = R.measureVolume(outer) - R.measureVolume(inner);
    if (!(v > 0) || Math.abs(v - want) > 0.02 * Math.abs(want)) throw new Error('not a wall');
    return solid;
  } finally { ms.delete(); }
}

/**
 * A solid grown (d > 0) or shrunk (d < 0) by `d` on every side, for the bodies OpenCascade cannot offset (swept along a spline or around
 * corners): a coarse tessellation is moved along its surface normals (mitred where faces meet at an edge, so the wall keeps its thickness at
 * corners) and sewn back into a faceted solid. Throws when the moved surface folds over itself.
 */
function offsetByMesh(shape, d, track) {
  const [lo0, hi0] = shape.boundingBox.bounds, diag = Math.hypot(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
  // sewing costs far more than meshing, so coarsen until the faceted copy is small (a smooth sweep meshes to thousands of triangles at the fine setting)
  let m, tol = Math.max(0.02, diag * 1.5e-3), ang = 0.35;
  const tolMax = Math.max(tol, Math.abs(d) * 0.4); // coarser than that and the wall would no longer follow the surface
  for (let k = 0; k < 9; k++, tol = Math.min(tolMax, tol * 2), ang = Math.min(1, ang * 1.4)) { m = shape.mesh({ tolerance: tol, angularTolerance: ang }); if (m.triangles.length / 3 <= 1500 || tol >= tolMax) break; }
  if (m.triangles.length / 3 > 12000) throw new Error('This curved body has too much surface to hollow as a faceted wall (more than 12,000 triangles at the coarsest setting); pick faces to open instead.');
  const nv = m.vertices.length / 3, tri = m.triangles, P = (i) => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
  // per output vertex position (the mesh repeats a vertex per face): group by position, and per B-rep face the area-weighted normal there
  const key = (i) => `${Math.round(m.vertices[i * 3] * 1e4)},${Math.round(m.vertices[i * 3 + 1] * 1e4)},${Math.round(m.vertices[i * 3 + 2] * 1e4)}`;
  const ids = new Map(), pos = [], acc = [];
  const id = (i) => { const k = key(i); let v = ids.get(k); if (v === undefined) { v = pos.length; ids.set(k, v); pos.push(P(i)); acc.push(new Map()); } return v; };
  const faceOfTri = new Int32Array(tri.length / 3);
  m.faceGroups.forEach((g, gi) => { for (let k = g.start; k < g.start + g.count; k += 3) faceOfTri[k / 3] = gi; });
  const T = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = id(tri[t]), b = id(tri[t + 1]), c = id(tri[t + 2]);
    if (a === b || b === c || a === c) continue;
    const u = sub(pos[b], pos[a]), w = sub(pos[c], pos[a]), n = cross(u, w);
    T.push([a, b, c]);
    for (const v of [a, b, c]) { const mp = acc[v]; const g = faceOfTri[t / 3], cur = mp.get(g) || [0, 0, 0]; mp.set(g, add(cur, n)); }
  }
  void nv;
  const moved = pos.map((q, v) => {
    const normals = [...acc[v].values()].map((n) => unit(n)).filter((n) => Math.hypot(...n) > 0.5);
    const distinct = [];
    for (const n of normals) if (!distinct.some((o) => dot(o, n) > 0.985)) distinct.push(n); // faces that meet at an edge or corner; a smooth surface is one
    if (!distinct.length) return q;
    const use = distinct.slice(0, 3), K = use.length;
    // the move v with n_k . v = d for every distinct face (least squares, the smallest such move): v = sum a_k n_k with G a = d
    const G = use.map((x) => use.map((y) => dot(x, y)));
    let a;
    if (K === 1) a = [d];
    else if (K === 2) { const det = G[0][0] * G[1][1] - G[0][1] * G[1][0]; a = Math.abs(det) < 1e-6 ? [d / 2, d / 2] : [(d * (G[1][1] - G[0][1])) / det, (d * (G[0][0] - G[1][0])) / det]; }
    else { const [[a0, b0, c0], [a1, b1, c1], [a2, b2, c2]] = G, D = a0 * (b1 * c2 - b2 * c1) - b0 * (a1 * c2 - a2 * c1) + c0 * (a1 * b2 - a2 * b1); if (Math.abs(D) < 1e-6) a = [d / 3, d / 3, d / 3]; else { const sol = (col) => { const Mx = [[a0, b0, c0], [a1, b1, c1], [a2, b2, c2]].map((r) => [...r]); for (let r = 0; r < 3; r++) Mx[r][col] = d; return (Mx[0][0] * (Mx[1][1] * Mx[2][2] - Mx[1][2] * Mx[2][1]) - Mx[0][1] * (Mx[1][0] * Mx[2][2] - Mx[1][2] * Mx[2][0]) + Mx[0][2] * (Mx[1][0] * Mx[2][1] - Mx[1][1] * Mx[2][0])) / D; }; a = [sol(0), sol(1), sol(2)]; } }
    let mv = [0, 0, 0]; use.forEach((n, k) => { mv = add(mv, scl(n, a[k])); });
    const cap = Math.abs(d) * 3; if (Math.hypot(...mv) > cap) mv = scl(unit(mv), cap); // a very sharp corner would shoot off
    return add(q, mv);
  });
  const soup = new Float32Array(T.length * 9);
  T.forEach(([a, b, c], k) => [a, b, c].forEach((v, q) => { soup[k * 9 + q * 3] = moved[v][0]; soup[k * 9 + q * 3 + 1] = moved[v][1]; soup[k * 9 + q * 3 + 2] = moved[v][2]; }));
  const w = weldSoup(soup, 1e-6);
  return sewMesh(R, w.verts, w.tris, { track, maxFaces: 12000 }).solid;
}
/**
 * A sweep along a path of straight segments with mitred corners: each segment is its own straight sweep of the profile (turned with the
 * path, so it stays square to the segment) cut at the plane that bisects the corner, and the pieces are joined. Full width is kept at every
 * corner, which is what a mitred pipe fitting looks like; the default sweep instead rounds the corner as OpenCascade sweeps it.
 */
function mitreSweep(wire, spine, track) {
  const edges = spine.edges;
  if (!edges.length || edges.some((e) => e.geomType !== 'LINE')) throw new Error('Mitred corners need a path made of straight segments (lines); arcs and splines sweep smoothly');
  const pt = (v) => [v.x, v.y, v.z], sub = (a, b) => a.map((x, k) => x - b[k]), norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
  const P = [pt(edges[0].startPoint), ...edges.map((e) => pt(e.endPoint))], T = edges.map((_, i) => norm(sub(P[i + 1], P[i])));
  const [lo, hi] = wire.boundingBox.bounds, ext = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 3 + 1;
  const bis = (i) => (i === 0 ? T[0] : i === T.length ? T[T.length - 1] : norm(add(T[i - 1], T[i]))); // the plane through corner i, as its normal
  const pieces = [];
  let w = wire;
  T.forEach((t, i) => {
    if (i > 0) { // turn the profile with the path
      const prev = T[i - 1], axis = cross(prev, t), sin = Math.hypot(...axis), ang = Math.atan2(sin, dot(prev, t)) * 180 / Math.PI;
      w = track(w.clone().translate(sub(P[i], P[i - 1])));
      if (sin > 1e-9) w = track(w.rotate(ang, P[i], norm(axis))); // rotate consumes its source (it is a clone already)
    }
    const back = scl(t, -ext), a = add(P[i], back), b = add(P[i + 1], scl(t, ext));
    const start = track(w.clone().translate(back)), line = track(R.assembleWire([track(R.makeLine(a, b))]));
    let prism = track(R.genericSweep(start, line, { transitionMode: 'right' }));
    prism = track(track(prism.intersect(halfSpace(P[i], bis(i), track))).intersect(halfSpace(P[i + 1], scl(bis(i + 1), -1), track)));
    pieces.push(prism);
  });
  return pieces.slice(1).reduce((acc, q) => track(acc.fuse(q)), pieces[0]);
}

/** A solid grown (d > 0) or shrunk (d < 0) by `d` on every side. */
function offsetSolid(shape, d, track) {
  const oc = R.getOC(), o = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    o.PerformByJoin(shape.wrapped, d, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange());
    if (!o.IsDone()) throw new Error('offset failed');
    return track(R.cast(o.Shape()));
  } finally { o.delete(); }
}
/** A huge block filling the half space on the side `nrm` points to of the plane through `o`, for splitting. */
function halfSpace(o, nrm, track) {
  const L = 1e5;
  return placeAlong(track(R.makeBox([-L, -L, 0], [L, L, L])), o, nrm, track);
}
/** The solids of a STEP file (its text), with their true surfaces. */
function readSTEP(text) {
  const oc = R.getOC(), name = 'in' + Math.random().toString(36).slice(2) + '.step';
  oc.FS.writeFile('/' + name, new TextEncoder().encode(text));
  const reader = new oc.STEPControl_Reader();
  try {
    if (!reader.ReadFile(name)) throw new Error('Failed to read the STEP file');
    reader.TransferRoots();
    const shape = R.cast(reader.OneShape());
    return shape.solids.length ? shape.solids : [shape];
  } finally { try { oc.FS.unlink('/' + name); } catch { /* already gone */ } reader.delete(); }
}
/** The B-rep face a stored face reference points at: by its face key when it has one, otherwise by point and normal on the current mesh. */
function faceFromRef(shape, ref) {
  const m = meshShape(shape);
  if (ref.brepFace) { const i = matchBrepFace(m.faces, ref); if (i >= 0) return shape.faces[i]; }
  const tri = ref.curved ? findCurvedTri(m.verts, m.tris, ref.point, ref.normal) : findFaceTri(m.verts, m.tris, ref.point, ref.normal);
  return tri < 0 ? null : shape.faces[m.faceOf[tri]] || null;
}
/**
 * The wire a sweep, pipe or surface sweep follows. A path drawn in a sketch keeps its exact lines and arcs; a 3D sketch, or a path
 * with "smooth" on, becomes a spline through its (smoothed) points, as the mesh kernel smoothed the polyline; other paths of corners
 * are followed corner to corner. `planeOfFn` puts a planar sketch on its plane.
 */
function spineFor(path, p, track, planeOfFn) {
  const wireOf = (d) => track(track(track(d).sketchOnPlane(planeOfFn(path.params).plane)).wire);
  if (path.type !== 'sketch3d' && !p.smooth) {
    const shapes = (path.params.shapes || []).filter(isSolidShape);
    const open = shapes.find((x) => x.t === 'path' && x.open) || null, closed = open ? null : shapes.find((x) => x.t === 'path' || x.t === 'circle' || x.t === 'rect' || x.t === 'ngon');
    if (!open && !closed) throw new Error(`${path.name} has no path (draw a Path or any shape)`);
    return wireOf(open ? openPathDrawing(open) : shapeDrawing(closed));
  }
  let { pts, closed } = sketchPath3D(path);
  if (p.smooth && !closed) pts = smoothPath(pts, 3);
  if (pts.length < 2) throw new Error('Path needs at least two points');
  // 2e-2, not tighter: a closer fit leaves ripples in the spine's curvature that the swept surface inherits, and the mesher then spends
  // tens of thousands of triangles on a wall whose inner and outer surfaces ripple differently (a hollow pipe was 87,000)
  if (!closed && (p.smooth || path.params.smooth) && pts.length > 2) return track(R.assembleWire([track(R.makeBSplineApproximation(pts, { tolerance: 2e-2, degMax: 3 }))]));
  const edges = [];
  for (let i = 0; i + 1 < pts.length; i++) edges.push(track(R.makeLine(pts[i], pts[i + 1])));
  if (closed) edges.push(track(R.makeLine(pts.at(-1), pts[0])));
  return track(R.assembleWire(edges));
}
/** An open path of lines and arcs (bulges) as a drawing, for use as a sweep spine. */
function openPathDrawing(s) {
  const pts = s.pts.filter((q, i, a) => !i || !dupe(q, a[i - 1]));
  if (pts.length < 2) throw new Error('Path needs at least two points');
  if (isSpline(s, pts)) return splineDrawing(pts, false);
  let pen = R.draw([pts[0][0], pts[0][1]]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], bulge = a[2] || 0;
    pen = Math.abs(bulge) > 1e-9 ? pen.bulgeArcTo([b[0], b[1]], bulge) : pen.lineTo([b[0], b[1]]);
  }
  return pen.done();
}

// ---------- pieces used by the feature loop ----------
function makePrimitive(p, track) {
  const [px, py, pz] = p.pos;
  let s;
  switch (p.shape) {
    case 'box': {
      s = R.makeBox([px - p.sx / 2, py - p.sy / 2, pz], [px + p.sx / 2, py + p.sy / 2, pz + p.sz]);
      if (p.radius > 0) s = track(s.fillet(Math.min(p.radius, p.sx / 2, p.sy / 2, p.sz / 2) * 0.999));
      return track(s);
    }
    case 'cylinder': return track(R.makeCylinder(p.radius, p.height, [px, py, pz], [0, 0, 1]));
    case 'sphere': return track(track(R.makeSphere(p.radius)).translate([px, py, pz]));
    case 'cone': {
      const r2 = Math.max(p.radius2, 0);
      const pts = [[0, 0], [p.radius, 0], ...(r2 > 1e-9 ? [[r2, p.height]] : []), [0, p.height]];
      return track(track(revolveProfile(pts, track)).translate([px, py, pz]));
    }
    case 'torus': {
      const pl = track(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0]));
      const sk = track(R.drawCircle(p.minor).translate(p.major, 0).sketchOnPlane(pl));
      return track(track(sk.revolve([0, 0, 1], { origin: [0, 0, 0] })).translate([px, py, pz]));
    }
    default: throw new Error('unknown primitive');
  }
}
/** A solid of revolution about the Z axis from a polygon of [radius, z] points. */
function revolveProfile(pts, track) {
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  const pl = track(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])); // local x = X, local y = Z
  return track(track(pen.close().sketchOnPlane(pl)).revolve([0, 0, 1], { origin: [0, 0, 0] }));
}
/** The helical groove of a thread, built along +Z from the origin (cut it from a body after placing it). */
function threadGroove(p, track) {
  const { radius: Rs, pitch, length, depth, internal, left } = p;
  if (!(pitch > 0) || !(length > 0) || !(depth > 0)) throw new Error('Pitch, length and depth must be positive');
  const ov = Math.max(depth * 0.3, 0.05), wt = pitch / 16;
  const wOpen = Math.min(depth * Math.tan(Math.PI / 6) + wt, pitch * 0.48), slope = (wOpen - wt) / depth;
  const prof = internal
    ? [[Rs - ov, -(wOpen + slope * ov)], [Rs + depth, -wt], [Rs + depth, wt], [Rs - ov, wOpen + slope * ov]]
    : [[Rs + ov, -(wOpen + slope * ov)], [Rs - depth, -wt], [Rs - depth, wt], [Rs + ov, wOpen + slope * ov]];
  const helix = track(R.makeHelix(pitch, length, Rs, [0, 0, 0], [0, 0, 1], !!left));
  const wire = track(track(R.draw(prof[0]).lineTo(prof[1]).lineTo(prof[2]).lineTo(prof[3]).close().sketchOnPlane(track(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0])))).wire);
  const groove = track(R.genericSweep(wire, helix, { frenet: true }));
  if (R.measureVolume(groove) < 0) throw new Error('The thread groove came out inside out');
  return groove;
}
function holeTool(p, track) {
  const d = p.diameter, depth = p.through ? BIGDIST : p.depth;
  if (!(d > 0) || !(depth > 0)) throw new Error('Diameter and depth must be positive');
  const e = 0.2, r = d / 2;
  let pts;
  if (p.kind === 'counterbore') {
    if (!(p.cbDia > d)) throw new Error('Counterbore diameter must exceed the hole diameter');
    const cr = p.cbDia / 2;
    pts = [[0, -e], [cr, -e], [cr, p.cbDepth], [r, p.cbDepth], [r, depth], [0, depth]];
  } else if (p.kind === 'countersink') {
    if (!(p.cskDia > d)) throw new Error('Countersink diameter must exceed the hole diameter');
    const h = (p.cskDia - d) / 2 / Math.tan((p.cskAngle * Math.PI) / 360), cr = p.cskDia / 2;
    pts = [[0, -e], [cr, -e], [cr, 0], [r, h], [r, depth], [0, depth]];
  } else pts = [[0, -e], [r, -e], [r, depth], [0, depth]];
  const tool = revolveProfile(pts, track);
  if (!p.thread) return tool;
  const groove = threadGroove({ radius: d / 2, pitch: p.pitch, length: Math.min(p.threadLength, depth), depth: p.pitch * 0.6134, internal: true, left: false }, track);
  return track(tool.fuse(groove)); // the hole and its thread are one tool
}
/** Move a shape built along +Z from the origin so its Z axis points along `axis` from `pos`. */
function placeAlong(s, pos, axis, track) {
  const M = axisFrame(pos, axis), z = [M[8], M[9], M[10]];
  let out = s;
  const cz = dot([0, 0, 1], z);
  if (cz < 1 - 1e-12) {
    const rot = cz < -1 + 1e-12 ? { ax: [1, 0, 0], ang: 180 } : { ax: unit(cross([0, 0, 1], z)), ang: (Math.acos(cz) * 180) / Math.PI };
    out = track(out.rotate(rot.ang, [0, 0, 0], rot.ax));
  }
  return track(out.translate(pos));
}
/** The outlines of a sketch's closed solid shapes, for deciding which side of an axis they lie on. */
const profilePolys = (sk) => (sk.params.shapes || []).filter((s) => !s.open && isSolidShape(s)).map(shapeToPolygon);
/** 'near' when the profile lies where the mesh kernel revolves it as drawn, 'far' on the other side of the axis, 'cross' when it straddles it. */
function sideOfAxis(polys, o2, th) {
  const c = Math.cos(th * DEG), s = Math.sin(th * DEG);
  let lo = Infinity, hi = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) {
    const d = -(x - o2[0]) * s + (y - o2[1]) * c; // signed distance from the axis; negative is the side the mesh kernel keeps
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  if (lo < -1e-6 && hi > 1e-6) return 0;
  return hi > 1e-6 ? 1 : -1;
}

const vec3 = (v) => [v.x, v.y, v.z];
/** The middle of a picked edge, as a point on the body (the mid point of the stored polyline's first and last point is only a hint). */
const edgeMid = (shape, pts) => { const a = pts[0], b = pts.at(-1); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; };
const chainCache = new WeakMap();
/** The sharp-edge chains of a body's mesh, found once per mesh. */
const chainsOf = (me) => { let c = chainCache.get(me); if (!c) { c = findEdgeChains(me.verts, 3, me.tris); chainCache.set(me, c); } return c; };
const polyLen = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); return l; };
function distToPoly(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * u, p[1] - a[1] - ab[1] * u, p[2] - a[2] - ab[2] * u));
  }
  return best;
}
/** Does this B-rep edge lie along the stored edge chain (a polyline of the mesh edge the user picked)? */
function edgeOnRef(ed, pts) {
  let ext = 0;
  for (let k = 0; k < 3; k++) { const v = pts.map((q) => q[k]); ext = Math.max(ext, Math.max(...v) - Math.min(...v)); }
  const tol = 0.03 + 0.003 * ext;
  for (const u of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) {
    const q = ed.pointAt(u);
    if (distToPoly([q.x, q.y, q.z], pts) > tol) return false;
  }
  return true;
}

// ---------- STEP ----------
/**
 * Exact STEP (AP242) for a design the B-rep backend supports: rebuilds it on OpenCascade and writes every body (or the ones in
 * `ids`). Returns { blob, bodies } or throws with the reason a design cannot be exported exactly.
 */
export function exactStep(features, { ids, name = 'Sketchy', colors = {} } = {}) {
  const sup = brepSupport(features);
  if (!sup.ok) throw new Error(`${sup.feature.name}: ${sup.reason}`);
  const res = rebuildBrep(features, features.length, { keepShapes: true, cache: false });
  try {
    if (Object.keys(res.errors).length) throw new Error('The design has errors, so it cannot be exported exactly: ' + Object.values(res.errors)[0]);
    const list = [...res.shapes].filter(([id]) => !ids || ids.includes(id)).map(([id, shape]) => ({ shape, name: res.bodies.find((b) => b.id === id)?.name || id, ...(colors[id] ? { color: colors[id] } : {}) }));
    if (!list.length) throw new Error('Nothing to export');
    const blob = R.exportSTEP(list);
    return { blob, bodies: list.length };
  } finally { res.dispose(); }
}

export const brepBackend = { name: 'brep', ready: brepReady, load: loadBrep, support: brepSupport, rebuild: rebuildBrep, exactStep };

/** The exact shape behind a body of the last result (by its mesh key), or null when it has been freed. */
function shapeOfBody(b) {
  const sh = shapeByKey.get(b.key)?.deref();
  if (!sh) return null;
  try { void sh.wrapped; return sh; } catch { return null; }
}
/** A body's shape: the exact one if it is still alive, otherwise its triangles sewn into a faceted solid. */
function bodyShape(b, track) {
  return shapeOfBody(b) || sewMesh(R, ...Object.values(weldSoup(soupOfMesh(b.verts, b.tris))), { track }).solid;
}
/** Pairs of bodies that overlap: [{ a, b, volume }] (the Interference check). */
export function interferenceOf(bodies) {
  const garbage = [], track = (o) => { garbage.push(o); return o; }, out = [];
  try {
    const shapes = bodies.map((b) => { try { return bodyShape(b, track); } catch { return null; } });
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      if (!shapes[i] || !shapes[j]) continue;
      let v = 0;
      try { const x = track(shapes[i].intersect(shapes[j])); v = Math.abs(R.measureVolume(x)); } catch { v = 0; }
      if (v > 1e-6) out.push({ a: bodies[i], b: bodies[j], volume: v });
    }
  } finally { for (const o of garbage) { try { o.delete(); } catch { /* shared handle */ } } }
  return out;
}
/**
 * What changed between two versions of a design, from two results built with keepShapes: the volume only the new one has (added),
 * only the old one has (removed) and what both have (kept), each as { verts, tris, volume } or null.
 */
export function compareResults(a, b) {
  const garbage = [], track = (o) => { garbage.push(o); return o; };
  const union = (res) => { const list = [...(res.shapes?.values() || [])]; return list.length ? list.reduce((x, y) => track(x.fuse(y))) : null; };
  const out = (sh) => { if (!sh) return null; try { if (!(Math.abs(R.measureVolume(sh)) > 1e-9)) return null; } catch { return null; } const m = shapeMesh(sh); return { verts: m.verts, tris: m.tris, volume: m.volume }; };
  try {
    const A = union(a), B = union(b), safe = (f) => { try { return f(); } catch { return null; } };
    return { added: out(B && (A ? safe(() => track(B.cut(A))) : B)), removed: out(A && (B ? safe(() => track(A.cut(B))) : A)), kept: out(A && B ? safe(() => track(A.intersect(B))) : null) };
  } finally { a.dispose?.(); b.dispose?.(); for (const o of garbage) { try { o.delete(); } catch { /* shared handle */ } } }
}
/** Offset a closed polygon by d (outward positive) with mitred corners; returns the largest resulting polygon or null. */
export function offsetPolygonExact(poly, d) {
  const garbage = [], track = (o) => { garbage.push(o); return o; };
  try {
    let pen = R.draw(poly[0]);
    for (let i = 1; i < poly.length; i++) pen = pen.lineTo(poly[i]);
    const off = track(track(pen.close()).offset(d, { lineJoinType: 'miter' }));
    const sk = track(off.sketchOnPlane('XY')), loops = [];
    for (const piece of sk.sketches || [sk]) loops.push(outlinesOf(R, track(piece.face()), track)[0]);
    const area = (pl) => Math.abs(pl.reduce((acc, [x1, y1], i) => { const [x2, y2] = pl[(i + 1) % pl.length]; return acc + (x1 * y2 - x2 * y1); }, 0));
    return loops.length ? loops.reduce((m, q) => (area(q) > area(m) ? q : m)) : null;
  } catch { return null; } finally { for (const o of garbage) { try { o.delete(); } catch { /* shared handle */ } } }
}
