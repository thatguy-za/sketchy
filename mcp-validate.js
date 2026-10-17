// Strict checks on what an assistant sends to a tool. The tool schemas (mcp.js) describe the arguments; this enforces them, and puts
// hard limits on how big and how deep a value can be, so a malformed or hostile request is refused before any work is done.

const LIMITS = { depth: 8, nodes: 20000, string: 4000, array: 5000, keys: 200, keyLength: 48 };
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_RE = /^[A-Za-z_$][\w$.-]{0,47}$/;
// Short text arguments get tighter limits than the general string cap.
const SHORT = { design: 80, name: 80, kind: 40, feature: 80, expr: 500, unit: 20, comment: 500 };

/** Deep limits on any JSON value: depth, size, string length, finite numbers, safe keys. Returns an error string or null. */
export function checkValue(v, path = 'value', st = { nodes: 0 }, depth = 0) {
  if (++st.nodes > LIMITS.nodes) return `${path}: too large (more than ${LIMITS.nodes} values)`;
  if (depth > LIMITS.depth) return `${path}: nested more than ${LIMITS.depth} levels deep`;
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path}: numbers must be finite`;
  if (typeof v === 'string') return v.length > LIMITS.string ? `${path}: text longer than ${LIMITS.string} characters` : null;
  if (Array.isArray(v)) {
    if (v.length > LIMITS.array) return `${path}: more than ${LIMITS.array} items`;
    for (let i = 0; i < v.length; i++) { const e = checkValue(v[i], `${path}[${i}]`, st, depth + 1); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > LIMITS.keys) return `${path}: more than ${LIMITS.keys} fields`;
    for (const k of keys) {
      if (BAD_KEYS.has(k) || !KEY_RE.test(k)) return `${path}: field name "${k.slice(0, 20)}" is not allowed`;
      const e = checkValue(v[k], `${path}.${k}`, st, depth + 1); if (e) return e;
    }
    return null;
  }
  return `${path}: unsupported value`;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : typeof v === t);

function check(schema, v, path, top) {
  if (schema.type && !isType(v, schema.type)) return `${path} must be ${schema.type === 'integer' ? 'a whole number' : 'a ' + schema.type} (got ${typeOf(v)})`;
  if (schema.enum && !schema.enum.includes(v)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (schema.type === 'string') {
    const max = SHORT[path.split('.').pop().replace(/\[\d+\]/g, '')] ?? LIMITS.string;
    if (v.length > max) return `${path} is too long (at most ${max} characters)`;
    if (path.split('.').pop() !== 'comment' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return `${path} contains control characters`;
  }
  if (schema.type === 'integer' || schema.type === 'number') { if (Math.abs(v) > 1e9) return `${path} is out of range`; }
  if (schema.type === 'array') {
    if (v.length > (schema.maxItems ?? 1000)) return `${path} has too many items`;
    if (schema.items) for (let i = 0; i < v.length; i++) { const e = check(schema.items, v[i], `${path}[${i}]`); if (e) return e; }
  }
  if (schema.type === 'object') {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (v[r] === undefined) return `${path === 'arguments' ? '' : path + '.'}${r} is required`;
    for (const k of Object.keys(v)) {
      if (props[k]) { const e = check(props[k], v[k], path === 'arguments' ? k : `${path}.${k}`); if (e) return e; }
      else if (top || schema.additionalProperties === false) return `unknown field "${k.slice(0, 30)}". Allowed: ${Object.keys(props).join(', ') || '(none)'}`;
      else { const e = checkValue(v[k], `${path}.${k}`); if (e) return e; } // free-form objects (a feature's params): size and depth limits only
    }
  }
  return null;
}

/** Validate a tool call's arguments against its schema. Returns an error message, or null when fine. */
export function validateArguments(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const deep = checkValue(args, 'arguments');
  if (deep) return deep;
  return check(schema, args, 'arguments', true);
}
