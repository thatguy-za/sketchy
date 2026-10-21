import { keyPoints } from './sketchcons.js';

// What a sketch is made of, written down once: the shape types, line types and constraints the app, the kernel and the
// assistants all use. The MCP instructions, the describe_sketch tool and the checks on what an assistant sends are built from
// this table, so they cannot drift from each other. All lengths are in millimetres (the kernel's unit).

/** Shape types: the fields each takes, an example, and a note. `num` fields are finite numbers; `pts` is a list of [x, y] or [x, y, bulge]. */
export const SHAPES = {
  rect: { fields: { x: 'num', y: 'num', w: 'pos', h: 'pos' }, example: { t: 'rect', x: 0, y: 0, w: 40, h: 20 }, note: 'x, y is the lower-left corner.' },
  rrect: { fields: { x: 'num', y: 'num', w: 'pos', h: 'pos', r: 'nonneg' }, example: { t: 'rrect', x: 0, y: 0, w: 40, h: 20, r: 3 }, note: 'A rectangle with rounded corners of radius r.' },
  circle: { fields: { cx: 'num', cy: 'num', r: 'pos' }, example: { t: 'circle', cx: 0, cy: 0, r: 5 }, note: 'Center and radius.' },
  ellipse: { fields: { cx: 'num', cy: 'num', rx: 'pos', ry: 'pos' }, optional: { rot: 'num' }, example: { t: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5, rot: 0 }, note: 'rot is degrees.' },
  ngon: { fields: { cx: 'num', cy: 'num', r: 'pos', n: 'int3' }, optional: { rot: 'num' }, example: { t: 'ngon', cx: 0, cy: 0, r: 10, n: 6, rot: 0 }, note: 'A regular polygon, r is the circumscribed radius, n sides.' },
  slot: { fields: { x1: 'num', y1: 'num', x2: 'num', y2: 'num', w: 'pos' }, example: { t: 'slot', x1: 0, y1: 0, x2: 20, y2: 0, w: 6 }, note: 'Centre-to-centre slot: round ends at (x1, y1) and (x2, y2), total width w.' },
  path: { fields: { pts: 'pts' }, optional: { open: 'bool' }, example: { t: 'path', pts: [[0, 0], [10, 0], [10, 10]] }, note: 'A closed polygon, or an open path with "open": true (for sweep, rib, pipe and pattern paths, and for revolve centerlines). A point may be [x, y, bulge] to make the segment that starts there an arc: bulge = tan(sweep angle / 4), positive counter-clockwise.' },
  point: { fields: { x: 'num', y: 'num' }, example: { t: 'point', x: 5, y: 5 }, note: 'A reference point; it never forms a profile.' },
};
/** Any shape may carry lt: 'construction' (guide geometry, never part of a profile) or 'centerline' (the axis a Revolve can use). */
export const LINE_TYPES = { construction: 'Guide geometry. Not part of any profile; constraints can still use it.', centerline: 'A line (an open path of 2 or more points) that a Revolve can spin around (axis "centerline").' };

/**
 * Constraints go in params.cons. Each names shapes by index in params.shapes (a.s, b.s, c.s) and, where needed, a segment of a
 * path (seg, counting from 0) or a named point (k). They are solved together (src/sketchsolve.js): the shape named first (a) moves to meet
 * the one named second (b), sizes and segment lengths are kept where the constraints allow, and Fix pins what it names.
 */
export const CONSTRAINTS = {
  horizontal: { refs: ['a'], needs: 'a.s, a.seg', note: 'Make a path segment horizontal.' },
  vertical: { refs: ['a'], needs: 'a.s, a.seg', note: 'Make a path segment vertical.' },
  parallel: { refs: ['a', 'b'], needs: 'a.s, a.seg, b.s, b.seg', note: 'Turn segment a to run parallel to segment b.' },
  perpendicular: { refs: ['a', 'b'], needs: 'a.s, a.seg, b.s, b.seg', note: 'Turn segment a to meet segment b at 90 degrees.' },
  equal: { refs: ['a', 'b'], needs: 'a.s (and a.seg for paths), b.s (and b.seg)', note: 'Give two lines, two arcs, two circles or two polygons the same size.' },
  coincident: { refs: ['a', 'b'], needs: 'a.s, a.k, b.s, b.k', note: 'Move point a.k of shape a onto point b.k of shape b.' },
  concentric: { refs: ['a', 'b'], needs: 'a.s, b.s', note: 'Give two circles, arcs, polygons or ellipses the same centre.' },
  collinear: { refs: ['a', 'b'], needs: 'a.s, a.seg, b.s, b.seg', note: 'Put segment a on the same line as segment b.' },
  midpoint: { refs: ['a', 'b'], needs: 'a.s, a.k, b.s, b.seg', note: 'Put point a.k at the middle of segment b.' },
  tangent: { refs: ['a', 'b'], needs: 'a.s, a.seg (or a circle), b.s, b.seg (or a circle)', note: 'Make a line and a circle or arc touch, or two circles touch.' },
  symmetry: { refs: ['a', 'b', 'c'], needs: 'a.s, a.k, b.s, b.k, c.s, c.seg', note: 'Mirror point b.k across the line c to place point a.k.' },
  fix: { refs: ['a'], needs: 'a.s, optionally a.k', note: 'Lock a shape (or one point of it) where it is; other constraints cannot move it.' },
};
export const POINT_KEYS = {
  rect: 'c0 (lower-left), c1 (lower-right), c2 (upper-right), c3 (upper-left), ctr', rrect: 'c0, c1, c2, c3, ctr',
  circle: 'c (centre)', ngon: 'c', ellipse: 'c', slot: 'a, b (the two end centres)', point: 'p', path: 'p0, p1, p2 ... one per point',
};
/** Driving dimensions: shape.ex = { field: "expression" } sets a field from a parameter expression, e.g. { w: "width/2" }. */
export const DIMENSIONS = { rect: ['w', 'h'], rrect: ['w', 'h', 'r'], circle: ['d'], ngon: ['r'], slot: ['len', 'w'], ellipse: ['a', 'b'], path: ['s0', 's1', '...  (the length or radius of segment i)'] };

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const CHECKS = {
  num, pos: (v) => num(v) && v > 0, nonneg: (v) => num(v) && v >= 0, int3: (v) => Number.isInteger(v) && v >= 3 && v <= 200, bool: (v) => typeof v === 'boolean',
  pts: (v) => Array.isArray(v) && v.length >= 2 && v.length <= 5000 && v.every((p) => Array.isArray(p) && p.length >= 2 && p.length <= 3 && p.every(num)),
};
const WHAT = { num: 'a number', pos: 'a number above 0', nonneg: 'a number of 0 or more', int3: 'a whole number from 3 to 200', bool: 'true or false', pts: 'a list of at least 2 points, each [x, y] or [x, y, bulge]' };

/** Check a list of shapes. Returns a list of plain-language problems (empty when fine), each saying which shape and what to do. */
export function checkShapes(shapes) {
  const out = [];
  if (!Array.isArray(shapes)) return ['params.shapes must be a list of shapes.'];
  if (shapes.length > 2000) return ['A sketch can hold at most 2000 shapes.'];
  shapes.forEach((s, i) => {
    const at = `Shape #${i} (${s && typeof s === 'object' ? s.t : typeof s})`;
    if (!s || typeof s !== 'object') return out.push(`${at} is not an object.`);
    const def = SHAPES[s.t];
    if (!def) return out.push(`${at}: unknown shape type "${s.t}". Shape types are: ${Object.keys(SHAPES).join(', ')}.`);
    for (const [k, kind] of Object.entries({ ...def.fields, ...(def.optional || {}) })) {
      const required = k in def.fields;
      if (s[k] === undefined) { if (required) out.push(`${at} needs "${k}" (${WHAT[kind]}). Example: ${JSON.stringify(def.example)}`); continue; }
      if (!CHECKS[kind](s[k])) out.push(`${at}: "${k}" must be ${WHAT[kind]}, got ${JSON.stringify(s[k])?.slice(0, 40)}.`);
    }
    if (s.t === 'rrect' && num(s.r) && num(s.w) && num(s.h) && s.r > Math.min(s.w, s.h) / 2 + 1e-9) out.push(`${at}: r (${s.r}) is more than half of the shorter side. Use ${+(Math.min(s.w, s.h) / 2).toFixed(3)} or less.`);
    if (s.t === 'path' && s.open === undefined && CHECKS.pts(s.pts) && s.pts.length < 3) out.push(`${at}: a closed path needs at least 3 points. Add "open": true for a line.`);
    if (s.lt !== undefined && !LINE_TYPES[s.lt]) out.push(`${at}: lt must be ${Object.keys(LINE_TYPES).map((k) => `"${k}"`).join(' or ')} (or left out), got ${JSON.stringify(s.lt)}.`);
    if (s.lt === 'centerline' && !(s.t === 'path' && s.open && s.pts?.length >= 2)) out.push(`${at}: a centerline must be an open path of 2 or more points.`);
  });
  return out;
}

/** Check constraints against their shapes. */
export function checkCons(cons, shapes) {
  const out = [];
  if (!Array.isArray(cons)) return ['params.cons must be a list of constraints.'];
  if (cons.length > 2000) return ['A sketch can hold at most 2000 constraints.'];
  cons.forEach((c, i) => {
    const at = `Constraint #${i}`;
    const def = c && CONSTRAINTS[c.t];
    if (!def) return out.push(`${at}: unknown type "${c?.t}". Types are: ${Object.keys(CONSTRAINTS).join(', ')}.`);
    for (const r of def.refs) {
      const ref = c[r];
      if (!ref || !Number.isInteger(ref.s) || !shapes?.[ref.s]) { out.push(`${at} (${c.t}): "${r}.s" must be the index of a shape in params.shapes (0 to ${(shapes?.length || 0) - 1}). It needs ${def.needs}.`); continue; }
      const sh = shapes[ref.s];
      if (ref.seg !== undefined && !(sh.t === 'path' && Number.isInteger(ref.seg) && ref.seg >= 0 && ref.seg < sh.pts.length)) out.push(`${at} (${c.t}): "${r}.seg" ${ref.seg} is not a segment of shape #${ref.s} (a ${sh.t}${sh.t === 'path' ? ` with ${sh.pts.length} points, so segments 0 to ${sh.pts.length - 1}` : ', which has no segments'}).`);
      if (ref.k !== undefined && !keyPoints(sh).some((q) => q.k === ref.k)) out.push(`${at} (${c.t}): shape #${ref.s} (a ${sh.t}) has no point "${ref.k}". Its points are: ${POINT_KEYS[sh.t] || 'none'}.`);
    }
  });
  return out;
}

/** The whole description as text: what goes in a sketch feature. Used in the MCP instructions and by describe_sketch. */
export function describeSketchText() {
  const shapes = Object.entries(SHAPES).map(([t, d]) => `- ${JSON.stringify(d.example)}  ${d.note}`).join('\n');
  const cons = Object.entries(CONSTRAINTS).map(([t, d]) => `  ${t}: ${d.needs}. ${d.note}`).join('\n');
  return `Shapes (params.shapes), lengths in mm. Closed shapes nested inside another become holes:\n${shapes}\n`
    + `Any shape can have "lt": "construction" (guide only, never a profile) or "lt": "centerline" (an open path a Revolve can use as its axis).\n`
    + `Constraints (params.cons, optional) name shapes by index and segments or points: {"t":"horizontal","a":{"s":0,"seg":1}}. They are solved together; the first shape (a) moves to meet the second (b), sizes are kept where possible, and a "fix" pins its target. Types:\n${cons}\n`
    + `Named points (k): ${Object.entries(POINT_KEYS).map(([t, k]) => `${t}: ${k}`).join('; ')}.\n`
    + `Driving dimensions: a shape may carry "ex": {"w": "width/2"} to take a field from a named parameter.`;
}
