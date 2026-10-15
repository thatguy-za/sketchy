// User parameters + expression evaluation. Feature fields may hold an expression ("width/2 + 3 mm")
// stored in feature.exprs[path]; the numeric result is substituted before the kernel replays the timeline.
// Lengths are millimetres; angles are degrees (trig functions take/return degrees).

const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, '°': 1 };
const FUNCS = {
  sin: (x) => Math.sin((x * Math.PI) / 180), cos: (x) => Math.cos((x * Math.PI) / 180), tan: (x) => Math.tan((x * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI, acos: (x) => (Math.acos(x) * 180) / Math.PI, atan: (x) => (Math.atan(x) * 180) / Math.PI,
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow, ln: Math.log, log: Math.log10, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, e: Math.E };
export const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS), ...Object.keys(UNITS)]);
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_°][A-Za-z0-9_]*|°)|(\*\*|[-+*/^(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected "${src[i]}"`);
    if (m[1] !== undefined) toks.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: 'id', v: m[2] });
    else toks.push({ t: 'op', v: m[3] === '**' ? '^' : m[3] });
    i = re.lastIndex;
  }
  return toks;
}

/** Evaluate an expression string. `scope(name)` returns a parameter's numeric value or undefined. */
export function evalExpr(src, scope = () => undefined) {
  const toks = tokenize(String(src));
  if (!toks.length) throw new Error('Empty expression');
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (t && t.t === 'op' && t.v === v) { p++; return true; } return false; };
  const unitOf = () => { const t = toks[p]; if (t && t.t === 'id' && t.v in UNITS) { p++; return UNITS[t.v]; } return null; };

  function expr() { let v = term(); for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; } }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) { const d = unary(); if (d === 0) throw new Error('Division by zero'); v /= d; }
      else return v;
    }
  }
  function unary() { if (eat('-')) return -unary(); if (eat('+')) return unary(); return power(); }
  function power() { const b = postfix(); return eat('^') ? Math.pow(b, unary()) : b; }
  function postfix() { let v = primary(); const u = unitOf(); if (u !== null) v *= u; return v; }
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error('Unexpected end');
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = expr(); if (!eat(')')) throw new Error('Missing )'); return v; }
    if (t.t === 'id') {
      if (peek() && peek().t === 'op' && peek().v === '(' && FUNCS[t.v]) {
        p++;
        const args = [];
        if (!eat(')')) { do args.push(expr()); while (eat(',')); if (!eat(')')) throw new Error('Missing )'); }
        const r = FUNCS[t.v](...args);
        if (!Number.isFinite(r)) throw new Error(`${t.v}() is not defined for that input`);
        return r;
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      const v = scope(t.v);
      if (v === undefined) throw new Error(`Unknown name "${t.v}"`);
      return v;
    }
    throw new Error(`Unexpected "${t.v}"`);
  }
  const v = expr();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  if (!Number.isFinite(v)) throw new Error('Not a finite number');
  return Math.round(v * 1e9) / 1e9;
}

/** @returns {{values: Record<string, number>, errors: Record<string, string>}} for a list of {name, expr}. */
export function resolveParams(list) {
  const defs = new Map(list.map((p) => [p.name, p]));
  const values = {}, errors = {}, state = {};
  const get = (name) => {
    if (name in values) return values[name];
    const d = defs.get(name);
    if (!d) return undefined;
    if (state[name] === 'busy') throw new Error(`Circular reference via "${name}"`);
    if (errors[name]) throw new Error(`"${name}" has an error`);
    state[name] = 'busy';
    try { values[name] = evalExpr(d.expr, get); }
    catch (e) { errors[name] = e.message; throw e; }
    finally { state[name] = 'done'; }
    return values[name];
  };
  for (const d of list) { try { get(d.name); } catch (e) { errors[d.name] ||= e.message; } }
  return { values, errors };
}

export const isPlainNumber = (s) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(String(s).trim());

/**
 * Substitute expressions of a feature into numeric params.
 * exprs keys: "distance" or "pos.1" (index into a vector). Returns {params, error}.
 */
export function resolveFeature(f, scope) {
  if (!f.exprs || !Object.keys(f.exprs).length) return { params: f.params };
  const params = { ...f.params };
  let error = null;
  for (const [path, src] of Object.entries(f.exprs)) {
    const [key, idx] = path.split('.');
    try {
      const v = evalExpr(src, scope);
      if (idx === undefined) params[key] = v;
      else { if (!Array.isArray(params[key]) || params[key] === f.params[key]) params[key] = [...f.params[key]]; params[key][+idx] = v; }
    } catch (e) { error = error || `${path}: ${e.message}`; }
  }
  return { params, error };
}
