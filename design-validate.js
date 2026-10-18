// Structure checks for a saved design (the project JSON). A design is replayed by the app, and by the MCP workers on the server,
// so a hand-made file with a million features, a pattern of a billion copies or a thousand-level nesting is a way to make the
// server do unbounded work. The size limit alone does not catch that. Every limit can be changed with an environment variable
// (0 = no limit); the defaults are far above anything a person draws.

const num = (name, def) => { const v = process.env[name]; return v === undefined || v === '' ? def : Math.max(0, Math.floor(+v) || 0); };
export const LIMITS = {
  features: num('MAX_FEATURES', 2000),
  params: num('MAX_PARAMS', 1000),
  array: num('MAX_ARRAY_LENGTH', 100000), // points of a path, entries of a list
  depth: num('MAX_NESTING', 24),
  importTriangles: num('MAX_IMPORT_TRIANGLES', 2000000), // all imported meshes of one design together
  count: num('MAX_PATTERN_COUNT', 10000), // copies, columns, rows, turns
  nodes: 5000000,
};
const COUNT_KEYS = new Set(['count', 'countU', 'countV', 'turns', 'steps', 'segments', 'copies']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns null when the design is acceptable, otherwise a sentence that says what is wrong. */
export function validateDesign(d, L = LIMITS) {
  if (!isObj(d)) return 'A design must be a JSON object.';
  if (d.features !== undefined) {
    if (!Array.isArray(d.features)) return 'The design\'s feature list is not a list.';
    if (L.features && d.features.length > L.features) return `This design has ${d.features.length} features; the limit is ${L.features}.`;
    for (const f of d.features) {
      if (!isObj(f)) return 'A feature in this design is not an object.';
      if (typeof f.id !== 'string' || f.id.length > 64 || typeof f.type !== 'string' || f.type.length > 40) return 'A feature in this design has no valid id or type.';
      if (f.params !== undefined && !isObj(f.params)) return `Feature "${String(f.name || f.id).slice(0, 40)}" has parameters in the wrong form.`;
      if (f.exprs !== undefined) {
        if (!isObj(f.exprs)) return `Feature "${String(f.name || f.id).slice(0, 40)}" has expressions in the wrong form.`;
        for (const e of Object.values(f.exprs)) if (typeof e !== 'string' || e.length > 1000) return `Feature "${String(f.name || f.id).slice(0, 40)}" has an expression that is too long.`;
      }
    }
  }
  if (d.params !== undefined) {
    if (!Array.isArray(d.params)) return 'The design\'s parameter list is not a list.';
    if (L.params && d.params.length > L.params) return `This design has ${d.params.length} parameters; the limit is ${L.params}.`;
    for (const p of d.params) if (!isObj(p) || typeof p.name !== 'string' || p.name.length > 64 || (p.expr !== undefined && (typeof p.expr !== 'string' || p.expr.length > 1000))) return 'A parameter in this design is not valid.';
  }
  // one walk over everything: nesting, list lengths, odd keys, huge counts, imported mesh size
  let nodes = 0, tris = 0;
  const stack = [[d, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (++nodes > L.nodes) return 'This design is too large to process.';
    if (L.depth && depth > L.depth) return `This design is nested more than ${L.depth} levels deep.`;
    if (Array.isArray(v)) {
      if (L.array && v.length > L.array) return `This design has a list of ${v.length} entries; the limit is ${L.array}.`;
      for (const x of v) if (x !== null && typeof x === 'object') stack.push([x, depth + 1]);
    } else {
      for (const [k, x] of Object.entries(v)) {
        if (BAD_KEYS.has(k)) return `This design contains the reserved key "${k}".`;
        if (COUNT_KEYS.has(k) && typeof x === 'number' && L.count && x > L.count) return `"${k}" is ${x}; the limit is ${L.count}.`;
        if (k === 'n' && typeof x === 'number' && x > 1000 && depth > 3) return 'A shape has more than 1000 sides.';
        if (x !== null && typeof x === 'object') stack.push([x, depth + 1]);
      }
      if (v.type === 'import' && isObj(v.params) && depth === 3) { // an imported mesh: what it claims must match what it carries
        const t = Number(v.params.tris), data = v.params.data;
        if (!Number.isFinite(t) || t < 0 || typeof data !== 'string') return `Imported part "${String(v.name || '').slice(0, 40)}" has no mesh data.`;
        if (data.length > t * 48 + 64) return `Imported part "${String(v.name || '').slice(0, 40)}" carries more data than its triangle count says.`;
        tris += t;
        if (L.importTriangles && tris > L.importTriangles) return `The imported meshes have ${tris} triangles together; the limit is ${L.importTriangles}.`;
      }
    }
  }
  return null;
}
