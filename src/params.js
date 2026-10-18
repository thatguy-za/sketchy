// User parameters + expression evaluation. Feature fields may hold an expression ("width/2 + 3 mm")
// stored in feature.exprs[path]; the numeric result is substituted before the kernel replays the timeline.
// Lengths are millimetres; angles are degrees (trig functions take/return degrees).

import { lenF } from './units.js';
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
    if (!m) throw new Error(`"${src[i]}" is not allowed in an expression. Use numbers, parameter names, + - * / ^, brackets and units like mm.`);
    if (m[1] !== undefined) toks.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: 'id', v: m[2] });
    else toks.push({ t: 'op', v: m[3] === '**' ? '^' : m[3] });
    i = re.lastIndex;
  }
  return toks;
}

/**
 * Evaluate an expression string. `scope(name)` returns a parameter's value (millimetres for lengths) or undefined.
 * kind 'len': plain numbers mean document units (so "5" is 5 in an inch document); 'num': plain numbers are unitless.
 * Explicit unit suffixes (mm, cm, m, in, ft) always win.
 */
/** The closest name to a mistyped one (one or two letters off, or a different capital), or null. */
export function closestName(name, candidates) {
  const lower = name.toLowerCase();
  const dist = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  let best = null, bd = 3;
  for (const c of candidates) { const d = c.toLowerCase() === lower ? 0.5 : dist(lower, c.toLowerCase()); if (d < bd && d <= Math.max(1, Math.floor(name.length / 3))) { bd = d; best = c; } }
  return best;
}

export function evalExpr(src, scope = () => undefined, kind = 'len') {
  let numScale = kind === 'len' ? lenF() : 1;
  const toks = tokenize(String(src));
  if (!toks.length) throw new Error('Type a number or an expression, for example 20 or width * 2.');
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (t && t.t === 'op' && t.v === v) { p++; return true; } return false; };
  const unitOf = () => { const t = toks[p]; if (t && t.t === 'id' && t.v in UNITS) { p++; return UNITS[t.v]; } return null; };

  function expr() { let v = term(); for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; } }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) { const d = unary(); if (d === 0) throw new Error('This divides by zero.'); v /= d; }
      else return v;
    }
  }
  function unary() { if (eat('-')) return -unary(); if (eat('+')) return unary(); return power(); }
  function power() { const b = postfix(); return eat('^') ? Math.pow(b, unary()) : b; }
  function postfix() { let v = primary(); const u = unitOf(); if (u !== null) v *= u; return v; }
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error('The expression ends too early. Something is missing after the last symbol.');
    if (t.t === 'num') {
      const nx = peek();
      if (nx && nx.t === 'id' && nx.v in UNITS) { p++; return t.v * UNITS[nx.v]; }
      return t.v * numScale;
    }
    if (t.t === 'op' && t.v === '(') { const v = expr(); if (!eat(')')) throw new Error('A closing bracket ) is missing.'); return v; }
    if (t.t === 'id') {
      if (peek() && peek().t === 'op' && peek().v === '(' && FUNCS[t.v]) {
        p++;
        const args = [];
        const keep = numScale; numScale = 1; // function arguments are unitless
        if (!eat(')')) { do args.push(expr()); while (eat(',')); if (!eat(')')) throw new Error('A closing bracket ) is missing.'); }
        numScale = keep;
        const r = FUNCS[t.v](...args);
        if (!Number.isFinite(r)) throw new Error(`${t.v}() cannot be worked out for that value.`);
        return r;
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      const v = scope(t.v);
      if (v === undefined) {
        const near = closestName(t.v, [...(scope.names ? scope.names() : []), ...Object.keys(FUNCS), ...Object.keys(CONSTS)]);
        throw new Error(`There is no parameter called "${t.v}"${near ? `. Did you mean "${near}"?` : '. Add it under Manage, Change Parameters.'}`);
      }
      return v;
    }
    throw new Error(`"${t.v}" is not expected here.`);
  }
  const v = expr();
  if (p < toks.length) throw new Error(`"${toks[p].v}" is not expected here. Is an operator (+ - * /) missing before it?`);
  if (!Number.isFinite(v)) throw new Error('This does not work out to a number.');
  return Math.round(v * 1e9) / 1e9;
}

/** @returns {{values: Record<string, number>, errors: Record<string, string>}} for a list of {name, expr}. */
/** Parameters as seen through a configuration: its expressions replace the defaults (blank = inherit). */
export function applyConfig(params, configs, activeId) {
  const cfg = (configs || []).find((c) => c.id === activeId);
  if (!cfg) return params || [];
  return (params || []).map((p) => (cfg.values?.[p.name]?.toString().trim() ? { ...p, expr: String(cfg.values[p.name]) } : p));
}

export function resolveParams(list) {
  const defs = new Map(list.map((p) => [p.name, p]));
  const values = {}, errors = {}, state = {};
  const get = (name) => {
    if (name in values) return values[name];
    const d = defs.get(name);
    if (!d) return undefined;
    if (state[name] === 'busy') throw new Error(`"${name}" depends on itself, directly or through other parameters.`);
    if (errors[name]) throw new Error(`"${name}" has an error of its own, fix that first.`);
    state[name] = 'busy';
    try { values[name] = evalExpr(d.expr, getScope, d.unit === 'number' || d.unit === 'angle' ? 'num' : 'len'); }
    catch (e) { errors[name] = e.message; throw e; }
    finally { state[name] = 'done'; }
    return values[name];
  };
  const getScope = Object.assign((n) => get(n), { names: () => [...defs.keys()] });
  for (const d of list) { try { get(d.name); } catch (e) { errors[d.name] ||= e.message; } }
  return { values, errors };
}

export const isPlainNumber = (s) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(String(s).trim());

/**
 * Substitute expressions of a feature into numeric params.
 * exprs keys: "distance" or "pos.1" (index into a vector). Returns {params, error}.
 */
export function resolveFeature(f, scope, kindOf) {
  if (!f.exprs || !Object.keys(f.exprs).length) return { params: f.params };
  const params = { ...f.params };
  let error = null;
  for (const [path, src] of Object.entries(f.exprs)) {
    const [key, idx] = path.split('.');
    try {
      const v = evalExpr(src, scope, kindOf ? kindOf(f, path) : 'len');
      if (idx === undefined) params[key] = v;
      else { if (!Array.isArray(params[key]) || params[key] === f.params[key]) params[key] = [...f.params[key]]; params[key][+idx] = v; }
    } catch (e) { error = error || `${path}: ${e.message}`; }
  }
  return { params, error };
}
