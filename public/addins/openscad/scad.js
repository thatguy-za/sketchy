// A reader for OpenSCAD scripts, written from OpenSCAD's published language description. It parses a .scad file, runs it
// (variables, functions, modules, loops, conditionals, list comprehensions, the math functions) and returns a tree of solids in
// the JSON form Sketchy's geometry service builds (see src/csg-service.js). It does not use OpenSCAD's code.
//
// What it handles: cube, sphere, cylinder, polyhedron, square, circle, polygon; translate, rotate, scale, mirror, multmatrix,
// color (ignored), offset, hull, minkowski, union, difference, intersection, linear_extrude, rotate_extrude, render, children,
// for, intersection_for, if, let, assert, echo, user modules and functions, $fn $fa $fs.
// What it does not: text(), import(), surface(), projection(), resize(), include/use of other files. Those are skipped and listed
// as warnings, so a model is never silently wrong without a note.

const LIMITS = { steps: 6e6, depth: 400, nodes: 20000, range: 200000, source: 1.5e6 };

// ------------------------------------------------------------------------------------------------ lexer
const KEYWORDS = new Set(['module', 'function', 'if', 'else', 'for', 'let', 'each', 'true', 'false', 'undef', 'include', 'use']);
function lex(src) {
  const out = []; let i = 0, line = 1;
  const err = (m) => { throw Object.assign(new Error(`Line ${line}: ${m}`), { line }); };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e < 0 ? src.length : e + 2); line += (chunk.match(/\n/g) || []).length; i += chunk.length; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 40));
      out.push({ t: 'num', v: parseFloat(m[0]), line }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i, i + 80));
      out.push({ t: KEYWORDS.has(m[0]) ? 'kw' : 'id', v: m[0], line }); i += m[0].length; continue;
    }
    if (c === '"') {
      let s = ''; i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') { const n = src[i + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; i += 2; } else { if (src[i] === '\n') line++; s += src[i++]; } }
      if (i >= src.length) err('a text string is not closed');
      i++; out.push({ t: 'str', v: s, line }); continue;
    }
    const three = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(three)) { out.push({ t: 'op', v: three, line }); i += 2; continue; }
    if ('+-*/%^<>=!?:;,.()[]{}#'.includes(c)) { out.push({ t: 'op', v: c, line }); i++; continue; }
    err(`unexpected character "${c}"`);
  }
  out.push({ t: 'eof', v: '', line });
  return out;
}

// ------------------------------------------------------------------------------------------------ parser
function parse(src) {
  const T = lex(src); let p = 0;
  const peek = (k = 0) => T[p + k], at = (v) => T[p].v === v && (T[p].t === 'op' || T[p].t === 'kw');
  const err = (m, tk = T[p]) => { throw Object.assign(new Error(`Line ${tk.line}: ${m}`), { line: tk.line }); };
  const eat = (v) => { if (!at(v)) err(`expected "${v}" but found "${T[p].v || 'end of file'}"`); return T[p++]; };
  const accept = (v) => (at(v) ? (p++, true) : false);
  const ident = () => { const t = T[p]; if (t.t !== 'id' && !(t.t === 'kw' && ['true', 'false', 'undef'].includes(t.v) === false && false)) err(`expected a name but found "${t.v || 'end of file'}"`); p++; return t.v; };

  function args() { // (a, b, name = c)
    eat('(');
    const a = [];
    while (!at(')')) {
      if (peek().t === 'id' && peek(1).v === '=' && peek(1).t === 'op' && !(peek(2).v === '=' && peek(2).t === 'op')) { const name = T[p].v; p += 2; a.push({ name, e: expr() }); }
      else a.push({ e: expr() });
      if (!accept(',')) break;
    }
    eat(')'); return a;
  }
  function params() { // (a, b = 1)
    eat('('); const ps = [];
    while (!at(')')) { const name = ident(); let def = null; if (accept('=')) def = expr(); ps.push({ name, def }); if (!accept(',')) break; }
    eat(')'); return ps;
  }
  function primary() {
    const t = T[p];
    if (t.t === 'num') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'kw') {
      if (t.v === 'true') { p++; return { k: 'lit', v: true }; }
      if (t.v === 'false') { p++; return { k: 'lit', v: false }; }
      if (t.v === 'undef') { p++; return { k: 'lit', v: undefined }; }
      if (t.v === 'let') { p++; const as = args(); return { k: 'let', as, e: expr(), line: t.line }; }
      if (t.v === 'function') { p++; const ps = params(); return { k: 'lambda', ps, e: expr() }; }
      err(`unexpected "${t.v}"`);
    }
    if (t.t === 'id') { p++; if (at('(')) return { k: 'call', name: t.v, args: args(), line: t.line }; return { k: 'var', name: t.v, line: t.line }; }
    if (at('(')) { p++; const e = expr(); eat(')'); return e; }
    if (at('[')) {
      p++;
      if (at('for') || (at('let') && false)) return listComp();
      if (at(']')) { p++; return { k: 'vec', items: [] }; }
      if (at('for')) return listComp();
      const first = at('each') ? { k: 'each', e: (p++, expr()) } : expr();
      if (at(':')) { p++; const second = expr(); let a = first, s = { k: 'lit', v: 1 }, b = second; if (accept(':')) { s = second; b = expr(); } eat(']'); return { k: 'range', a, s, b }; }
      const items = [first];
      while (accept(',')) { if (at(']')) break; items.push(at('each') ? { k: 'each', e: (p++, expr()) } : expr()); }
      eat(']'); return { k: 'vec', items };
    }
    err(`unexpected "${t.v || 'end of file'}"`);
  }
  function listComp() { // [for (i = ...) expr], with let / if / nested for / each
    const item = () => {
      if (at('for')) {
        p++; eat('('); const gens = []; // for (i = a, j = b) or the C style for (i = 0; i < 3; i = i + 1)
        let cstyle = false, init = [];
        while (!at(';') && !at(')')) { const n = ident(); eat('='); gens.push({ name: n, e: expr() }); if (!accept(',')) break; }
        if (at(';')) { cstyle = true; init = gens.splice(0); p++; const cond = expr(); eat(';'); const step = []; while (!at(')')) { const n = ident(); eat('='); step.push({ name: n, e: expr() }); if (!accept(',')) break; } eat(')'); return { k: 'cfor', init, cond, step, body: item() }; }
        eat(')'); void cstyle; return { k: 'gen', gens, body: item() };
      }
      if (at('if')) { p++; eat('('); const c = expr(); eat(')'); const a = item(); let b = null; if (accept('else')) b = item(); return { k: 'cif', c, a, b }; }
      if (at('let')) { p++; const as = args(); return { k: 'clet', as, body: item() }; }
      if (at('each')) { p++; return { k: 'each', e: expr() }; }
      return expr();
    };
    const body = item(); eat(']'); return { k: 'comp', body };
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (at('[')) { p++; const i = expr(); eat(']'); e = { k: 'index', e, i, line: T[p - 1].line }; }
      else if (at('.') && T[p + 1].t === 'id') { p++; e = { k: 'member', e, name: T[p++].v }; }
      else if (at('(') && e.k !== 'call' && (e.k === 'var' || e.k === 'index' || e.k === 'lambda')) { e = { k: 'callv', f: e, args: args() }; }
      else return e;
    }
  }
  function unary() {
    if (at('!')) { p++; return { k: 'not', e: unary() }; }
    if (at('-')) { p++; return { k: 'neg', e: unary() }; }
    if (at('+')) { p++; return unary(); }
    return postfix();
  }
  const bin = (ops, next) => () => { let l = next(); while (T[p].t === 'op' && ops.includes(T[p].v)) { const o = T[p++].v; l = { k: 'bin', o, l, r: next(), line: T[p - 1].line }; } return l; };
  const mul = bin(['*', '/', '%'], unary), add = bin(['+', '-'], mul), cmp = bin(['<', '<=', '>', '>='], add), eq = bin(['==', '!='], cmp), and = bin(['&&'], eq), or = bin(['||'], and);
  function expr() { const c = or(); if (at('?')) { p++; const a = expr(); eat(':'); const b = expr(); return { k: 'cond', c, a, b }; } return c; }

  function statement() {
    const t = T[p];
    if (at(';')) { p++; return { k: 'empty' }; }
    if (at('{')) { p++; const body = []; while (!at('}')) { if (peek().t === 'eof') err('a "{" is never closed'); body.push(statement()); } p++; return { k: 'block', body }; }
    if (t.t === 'kw' && (t.v === 'include' || t.v === 'use')) { p++; let name = ''; if (at('<')) { p++; while (!at('>') && peek().t !== 'eof') name += T[p++].v; p++; } else if (peek().t === 'str') name = T[p++].v; return { k: 'include', kind: t.v, name, line: t.line }; }
    if (t.t === 'kw' && t.v === 'module') { p++; const name = ident(); const ps = params(); return { k: 'moduledef', name, ps, body: statement() }; }
    if (t.t === 'kw' && t.v === 'function') { p++; const name = ident(); const ps = params(); eat('='); const e = expr(); accept(';'); return { k: 'funcdef', name, ps, e }; }
    if (t.t === 'kw' && t.v === 'if') { p++; eat('('); const c = expr(); eat(')'); const a = statement(); let b = null; if (accept('else')) b = statement(); return { k: 'if', c, a, b }; }
    if (t.t === 'kw' && t.v === 'for') { p++; eat('('); const gens = []; while (!at(')')) { const n = ident(); eat('='); gens.push({ name: n, e: expr() }); if (!accept(',')) break; } eat(')'); return { k: 'for', gens, body: statement() }; }
    if (t.t === 'kw' && t.v === 'let') { p++; const as = args(); return { k: 'letstmt', as, body: statement() }; }
    // modifiers: * (off), ! (root only), # (highlight), % (background)
    if (t.t === 'op' && ['*', '!', '#', '%'].includes(t.v) && (T[p + 1].t === 'id' || T[p + 1].t === 'kw' || T[p + 1].v === '{')) { p++; const s = statement(); return t.v === '*' || t.v === '%' ? { k: 'empty' } : s; }
    if (t.t === 'id') {
      if (peek(1).t === 'op' && peek(1).v === '=') { p += 2; const e = expr(); eat(';'); return { k: 'assign', name: t.v, e, line: t.line }; }
      p++; const a = args();
      if (at(';')) { p++; return { k: 'inst', name: t.v, args: a, child: null, line: t.line }; }
      return { k: 'inst', name: t.v, args: a, child: statement(), line: t.line };
    }
    err(`unexpected "${t.v || 'end of file'}"`);
  }
  const body = []; while (peek().t !== 'eof') body.push(statement());
  return { k: 'block', body };
}

// ------------------------------------------------------------------------------------------------ values
const isNum = (v) => typeof v === 'number';
const isVec = Array.isArray;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const trunc = (v, n = 6) => (Number.isFinite(v) ? +v.toFixed(n) : v);
function fmt(v) { if (v === undefined) return 'undef'; if (isNum(v)) return String(+v.toPrecision(6)); if (isVec(v)) return '[' + v.map(fmt).join(', ') + ']'; if (typeof v === 'string') return v; return String(v); }
function show(v) { return typeof v === 'string' ? JSON.stringify(v) : fmt(v); }
function truthy(v) { return v === undefined ? false : isNum(v) ? v !== 0 : typeof v === 'string' ? v !== '' : isVec(v) ? v.length > 0 : !!v; }
function mul(a, b) {
  if (isNum(a) && isNum(b)) return a * b;
  if (isNum(a) && isVec(b)) return b.map((x) => mul(a, x));
  if (isVec(a) && isNum(b)) return a.map((x) => mul(x, b));
  if (isVec(a) && isVec(b)) {
    if (a.length && isVec(a[0])) { // matrix * vector or matrix * matrix
      if (b.length && isVec(b[0])) return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
      return a.map((row) => row.reduce((s, v, k) => s + v * b[k], 0));
    }
    if (b.length && isVec(b[0])) return b[0].map((_, j) => a.reduce((s, v, k) => s + v * b[k][j], 0));
    return a.reduce((s, v, k) => s + v * b[k], 0);
  }
  return undefined;
}
function addv(a, b, sign) {
  if (isNum(a) && isNum(b)) return a + sign * b;
  if (isVec(a) && isVec(b)) return a.map((x, i) => addv(x, b[i], sign));
  return undefined;
}
function compare(a, b) { return isNum(a) && isNum(b) ? a - b : typeof a === 'string' && typeof b === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : NaN; }
function equal(a, b) { if (isVec(a) && isVec(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i])); return a === b; }

// ------------------------------------------------------------------------------------------------ matrices
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const flat = (m) => m.flat();
const mm = (a, b) => { const o = Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j]; return o; };
const rotX = (a) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; };
const rotY = (a) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
const rotZ = (a) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
function axisAngle(a, v) {
  const l = Math.hypot(...v); if (!l) return I4();
  const [x, y, z] = v.map((c) => c / l), c = Math.cos(a * D2R), s = Math.sin(a * D2R), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

// ------------------------------------------------------------------------------------------------ evaluator
class Env {
  constructor(lex, dyn) { this.vars = new Map(); this.funcs = new Map(); this.mods = new Map(); this.lex = lex; this.dyn = dyn; }
  get(name) {
    if (name[0] === '$') { for (let e = this; e; e = e.dyn) if (e.vars.has(name)) return e.vars.get(name); return undefined; }
    for (let e = this; e; e = e.lex) if (e.vars.has(name)) return e.vars.get(name);
    return undefined;
  }
  has(name) { for (let e = this; e; e = e.lex) if (e.vars.has(name)) return true; return false; }
  func(name) { for (let e = this; e; e = e.lex) if (e.funcs.has(name)) return e.funcs.get(name); return null; }
  mod(name) { for (let e = this; e; e = e.lex) if (e.mods.has(name)) return e.mods.get(name); return null; }
}

/**
 * Run a script. Returns { tree, warnings, echoes, parameters }. overrides: { name: value } replaces top-level assignments (Customizer).
 */
export function runScad(source, { overrides = {}, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  if (typeof source !== 'string' || source.length > L.source) throw new Error('That script is too large to read');
  const ast = parse(source);
  const warnings = new Set(), echoes = [];
  let steps = 0, nodes = 0, depth = 0;
  const tick = (n = 1) => { steps += n; if (steps > L.steps) throw new Error('The script ran too long (more than a few million steps). It may loop without end.'); };
  const fail = (m, line) => { throw Object.assign(new Error(line ? `Line ${line}: ${m}` : m), { line }); };
  const warn = (m) => warnings.add(m);

  // ---- expressions
  function ev(e, env) {
    tick();
    switch (e.k) {
      case 'lit': return e.v;
      case 'var': { if (e.name === 'PI') return Math.PI; const v = env.get(e.name); if (v === undefined && !env.has(e.name) && e.name[0] !== '$') warn(`"${e.name}" is not defined (treated as undef)`); return v; }
      case 'vec': { const o = []; for (const it of e.items) { if (it.k === 'each') { const v = ev(it.e, env); if (isVec(v)) o.push(...v); else if (v !== undefined) o.push(v); } else o.push(ev(it, env)); } return o; }
      case 'range': { const a = ev(e.a, env), s = ev(e.s, env), b = ev(e.b, env); if (![a, s, b].every(isNum)) return []; return rangeOf(a, s, b); }
      case 'comp': return comp(e.body, env);
      case 'neg': { const v = ev(e.e, env); return isNum(v) ? -v : isVec(v) ? v.map((x) => (isNum(x) ? -x : x)) : undefined; }
      case 'not': return !truthy(ev(e.e, env));
      case 'cond': return truthy(ev(e.c, env)) ? ev(e.a, env) : ev(e.b, env);
      case 'bin': {
        if (e.o === '&&') return truthy(ev(e.l, env)) && truthy(ev(e.r, env));
        if (e.o === '||') return truthy(ev(e.l, env)) || truthy(ev(e.r, env));
        const a = ev(e.l, env), b = ev(e.r, env);
        switch (e.o) {
          case '+': return addv(a, b, 1);
          case '-': return addv(a, b, -1);
          case '*': return mul(a, b);
          case '/': return isNum(a) && isNum(b) ? a / b : isVec(a) && isNum(b) ? a.map((x) => (isNum(x) ? x / b : undefined)) : undefined;
          case '%': return isNum(a) && isNum(b) ? a % b : undefined;
          case '<': return compare(a, b) < 0; case '<=': return compare(a, b) <= 0; case '>': return compare(a, b) > 0; case '>=': return compare(a, b) >= 0;
          case '==': return equal(a, b); case '!=': return !equal(a, b);
          default: return undefined;
        }
      }
      case 'index': { const v = ev(e.e, env), i = ev(e.i, env); if (isVec(v) && isNum(i)) return v[Math.floor(i)]; if (typeof v === 'string' && isNum(i)) return v[Math.floor(i)]; return undefined; }
      case 'member': { const v = ev(e.e, env); const k = { x: 0, y: 1, z: 2 }[e.name]; return isVec(v) && k !== undefined ? v[k] : undefined; }
      case 'let': { const sub = new Env(env, env); for (const a of e.as) sub.vars.set(a.name, ev(a.e, sub)); return ev(e.e, sub); }
      case 'lambda': return { fn: e, env };
      case 'callv': { const f = ev(e.f, env); return f && f.fn ? callLambda(f, e.args, env) : undefined; }
      case 'call': return callFunction(e, env);
      default: fail(`cannot evaluate ${e.k}`);
    }
  }
  function rangeOf(a, s, b) {
    if (s === 0) return [];
    if (s > 0 && a > b) return []; if (s < 0 && a < b) return [];
    const n = Math.floor((b - a) / s + 1e-9) + 1;
    if (n > L.range) fail(`a range with ${n} steps is too long`);
    return Array.from({ length: n }, (_, i) => a + i * s);
  }
  function comp(body, env) {
    const out = [];
    const run = (it, e) => {
      tick();
      if (it.k === 'gen') { const sub = new Env(e, e); forEach(it.gens, 0, sub, (s2) => run(it.body, s2)); return; }
      if (it.k === 'cfor') { const sub = new Env(e, e); for (const a of it.init) sub.vars.set(a.name, ev(a.e, sub)); let n = 0; while (truthy(ev(it.cond, sub))) { if (++n > L.range) fail('a list comprehension loops too long'); run(it.body, sub); const nv = it.step.map((a) => [a.name, ev(a.e, sub)]); for (const [k, v] of nv) sub.vars.set(k, v); } return; }
      if (it.k === 'cif') { if (truthy(ev(it.c, e))) run(it.a, e); else if (it.b) run(it.b, e); return; }
      if (it.k === 'clet') { const sub = new Env(e, e); for (const a of it.as) sub.vars.set(a.name, ev(a.e, sub)); run(it.body, sub); return; }
      if (it.k === 'each') { const v = ev(it.e, e); if (isVec(v)) out.push(...v); else if (v !== undefined) out.push(v); return; }
      out.push(ev(it, e));
      if (out.length > L.range) fail('a list is too long');
    };
    run(body, env);
    return out;
  }
  /** Loop over the generators of a for: each binds a name to the items of a list or range. */
  function forEach(gens, i, env, fn) {
    if (i === gens.length) { fn(env); return; }
    const g = gens[i], v = ev(g.e, env);
    const items = isVec(v) ? v : isNum(v) ? [v] : v === undefined ? [] : [v];
    if (items.length > L.range) fail('a loop has too many steps');
    for (const it of items) { const sub = new Env(env, env); sub.vars.set(g.name, it); forEach(gens, i + 1, sub, fn); }
  }

  // ---- functions
  const num1 = (f) => (a) => (isNum(a[0]) ? f(a[0]) : undefined);
  const MATH = {
    sin: num1((x) => Math.sin(x * D2R)), cos: num1((x) => Math.cos(x * D2R)), tan: num1((x) => Math.tan(x * D2R)),
    asin: num1((x) => Math.asin(x) * R2D), acos: num1((x) => Math.acos(x) * R2D), atan: num1((x) => Math.atan(x) * R2D),
    atan2: (a) => (isNum(a[0]) && isNum(a[1]) ? Math.atan2(a[0], a[1]) * R2D : undefined),
    abs: num1(Math.abs), ceil: num1(Math.ceil), floor: num1(Math.floor), round: num1((x) => (x < 0 ? -Math.round(-x) : Math.round(x))), sqrt: num1(Math.sqrt),
    exp: num1(Math.exp), ln: num1(Math.log), log: num1((x) => Math.log10(x)), sign: num1((x) => (x > 0 ? 1 : x < 0 ? -1 : 0)),
    pow: (a) => (isNum(a[0]) && isNum(a[1]) ? Math.pow(a[0], a[1]) : undefined),
    max: (a) => { const l = a.length === 1 && isVec(a[0]) ? a[0] : a; return l.length && l.every(isNum) ? Math.max(...l) : undefined; },
    min: (a) => { const l = a.length === 1 && isVec(a[0]) ? a[0] : a; return l.length && l.every(isNum) ? Math.min(...l) : undefined; },
    len: (a) => (isVec(a[0]) || typeof a[0] === 'string' ? a[0].length : undefined),
    concat: (a) => a.flatMap((x) => (isVec(x) ? x : [x])),
    str: (a) => a.map((x) => (typeof x === 'string' ? x : fmt(x))).join(''),
    norm: (a) => (isVec(a[0]) ? Math.hypot(...a[0]) : undefined),
    cross: (a) => { const [x, y] = a; return isVec(x) && isVec(y) && x.length === 3 && y.length === 3 ? [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]] : undefined; },
    is_undef: (a) => a[0] === undefined, is_num: (a) => isNum(a[0]) && Number.isFinite(a[0]), is_list: (a) => isVec(a[0]), is_string: (a) => typeof a[0] === 'string', is_bool: (a) => typeof a[0] === 'boolean',
    chr: (a) => (isNum(a[0]) ? String.fromCharCode(a[0]) : undefined), ord: (a) => (typeof a[0] === 'string' && a[0] ? a[0].charCodeAt(0) : undefined),
    rands: (a) => { const [lo, hi, n, seed] = a; let s = (seed ?? 1) * 2654435761 % 4294967296 || 1; return Array.from({ length: Math.min(n || 0, 1e5) }, () => { s = (s * 1664525 + 1013904223) % 4294967296; return lo + (hi - lo) * (s / 4294967296); }); },
    lookup: (a) => { const [k, tbl] = a; if (!isNum(k) || !isVec(tbl) || !tbl.length) return undefined; const t = [...tbl].sort((p, q) => p[0] - q[0]); if (k <= t[0][0]) return t[0][1]; if (k >= t.at(-1)[0]) return t.at(-1)[1]; for (let i = 1; i < t.length; i++) if (k <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (k - t[i - 1][0])) / (t[i][0] - t[i - 1][0]); return undefined; },
    version: () => [2021, 1, 0], version_num: () => 20210100,
  };
  function bindArgs(ps, args, env, callEnv, line, what) {
    const sub = new Env(env.lex ?? env, callEnv);
    const named = new Map(), pos = [];
    for (const a of args) { const v = ev(a.e, callEnv); if (a.name) named.set(a.name, v); else pos.push(v); }
    let k = 0;
    for (const p of ps) { if (named.has(p.name)) sub.vars.set(p.name, named.get(p.name)); else if (k < pos.length) sub.vars.set(p.name, pos[k++]); else sub.vars.set(p.name, p.def ? ev(p.def, sub) : undefined); }
    for (const [n, v] of named) if (n[0] === '$') sub.vars.set(n, v); // special variables travel with the call
    void line; void what;
    return sub;
  }
  function callLambda(f, args, env) { depth++; try { if (depth > L.depth) fail('functions call themselves too deeply'); return ev(f.fn.e, bindArgs(f.fn.ps, args, new Env(f.env, env), env)); } finally { depth--; } }
  function callFunction(e, env) {
    const uf = env.func(e.name);
    if (uf) {
      depth++; try { if (depth > L.depth) fail(`"${e.name}" calls itself too deeply`, e.line); const sub = bindArgs(uf.ps, e.args, uf.env, env, e.line, e.name); return ev(uf.e, sub); } finally { depth--; }
    }
    const lv = env.has(e.name) ? env.get(e.name) : undefined;
    if (lv && lv.fn) return callLambda(lv, e.args, env);
    const vals = e.args.map((a) => ev(a.e, env));
    if (MATH[e.name]) return MATH[e.name](vals);
    if (e.name === 'assert') { if (!truthy(vals[0])) fail(`assertion failed${vals[1] ? ': ' + vals[1] : ''}`, e.line); return undefined; }
    if (e.name === 'echo') { echoes.push(vals.map(show).join(', ')); return undefined; }
    if (e.name === 'search' || e.name === 'text' || e.name === 'surface') { warn(`${e.name}() is not supported`); return undefined; }
    warn(`the function "${e.name}" is not defined`);
    return undefined;
  }

  // ---- geometry
  const frag = (env, r) => { const fn = env.get('$fn'), fa = env.get('$fa') ?? 12, fs = env.get('$fs') ?? 2; if (isNum(fn) && fn > 0) return Math.max(3, Math.round(fn)); return Math.max(5, Math.ceil(Math.min(360 / fa, (Math.abs(r) * 2 * Math.PI) / fs))); };
  const dimOf = (n) => (['square', 'circle', 'polygon', 'offset'].includes(n.t) ? 2 : ['union', 'difference', 'intersection', 'hull', 'transform'].includes(n.t) && n.c?.length ? dimOf(n.c[0]) : 3);
  const mk = (n) => { if (++nodes > L.nodes) fail(`The model has more than ${L.nodes} shapes`); return n; };
  const argv = (a, env) => { const named = {}, pos = []; for (const x of a) { const v = ev(x.e, env); if (x.name) named[x.name] = v; else pos.push(v); } return { named, pos, get: (name, i, def) => (name in named ? named[name] : i >= 0 && i < pos.length ? pos[i] : def) }; };
  const vec3 = (v, def = 0) => (isVec(v) ? [isNum(v[0]) ? v[0] : def, isNum(v[1]) ? v[1] : def, isNum(v[2]) ? v[2] : def] : isNum(v) ? [v, v, v] : [def, def, def]);
  const tf = (m, c) => mk({ t: 'transform', m, c });
  /** Evaluate the children of an instantiation, in the caller's scope; returns a list of nodes. */
  const kids = (st, env) => (st.child ? exec(st.child, env) : []);

  const BUILTIN = {
    cube: (st, env) => { const a = argv(st.args, env); const s = a.get('size', 0, 1); return [mk({ t: 'cube', size: vec3(s, 1), center: truthy(a.get('center', 1, false)) })]; },
    sphere: (st, env) => { const a = argv(st.args, env); const r = a.named.d !== undefined ? a.named.d / 2 : a.get('r', 0, 1); return [mk({ t: 'sphere', r, fn: frag(env, r) })]; },
    cylinder: (st, env) => {
      const a = argv(st.args, env); const h = a.get('h', 0, 1);
      let r1 = a.named.d1 !== undefined ? a.named.d1 / 2 : a.named.r1 !== undefined ? a.named.r1 : a.named.d !== undefined ? a.named.d / 2 : a.get('r', 1, 1);
      let r2 = a.named.d2 !== undefined ? a.named.d2 / 2 : a.named.r2 !== undefined ? a.named.r2 : a.named.d !== undefined ? a.named.d / 2 : a.named.r !== undefined ? a.named.r : a.pos[2] !== undefined && a.named.r1 === undefined ? a.pos[2] : r1;
      if (a.pos.length >= 3 && a.named.r1 === undefined && a.named.r === undefined) { r1 = a.pos[1]; r2 = a.pos[2]; }
      return [mk({ t: 'cylinder', h, r1, r2, center: truthy(a.get('center', 3, false)), fn: frag(env, Math.max(r1 || 0, r2 || 0)) })];
    },
    polyhedron: (st, env) => { const a = argv(st.args, env); const faces = a.get('faces', 1, a.named.triangles); if (!isVec(a.get('points', 0)) || !isVec(faces)) fail('polyhedron needs points and faces', st.line); return [mk({ t: 'polyhedron', points: a.get('points', 0), faces })]; },
    square: (st, env) => { const a = argv(st.args, env); const s = a.get('size', 0, 1); return [mk({ t: 'square', size: isVec(s) ? [s[0], s[1]] : [s, s], center: truthy(a.get('center', 1, false)) })]; },
    circle: (st, env) => { const a = argv(st.args, env); const r = a.named.d !== undefined ? a.named.d / 2 : a.get('r', 0, 1); return [mk({ t: 'circle', r, fn: frag(env, r) })]; },
    polygon: (st, env) => { const a = argv(st.args, env); const pts = a.get('points', 0); if (!isVec(pts)) fail('polygon needs points', st.line); const paths = a.get('paths', 1); return [mk({ t: 'polygon', points: pts, ...(isVec(paths) ? { paths } : {}) })]; },
    translate: (st, env) => { const a = argv(st.args, env); const v = vec3(a.get('v', 0, [0, 0, 0])); return grp(st, env, (c) => tf([1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1], c)); },
    rotate: (st, env) => {
      const a = argv(st.args, env); const ang = a.get('a', 0, 0), ax = a.get('v', 1);
      let m;
      if (isVec(ang)) { const [x, y, z] = vec3(ang); m = mm(rotZ(z), mm(rotY(y), rotX(x))); }
      else if (isVec(ax)) m = axisAngle(ang, vec3(ax)); else m = rotZ(isNum(ang) ? ang : 0);
      return grp(st, env, (c) => tf(m, c));
    },
    scale: (st, env) => { const a = argv(st.args, env); const v = vec3(a.get('v', 0, 1), 1); const s = isNum(a.get('v', 0, 1)) ? [a.get('v', 0, 1), a.get('v', 0, 1), a.get('v', 0, 1)] : v; return grp(st, env, (c) => tf([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1], c)); },
    mirror: (st, env) => { const a = argv(st.args, env); const v = vec3(a.get('v', 0, [1, 0, 0])); const l = Math.hypot(...v) || 1, n = v.map((x) => x / l); const m = [1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2], 0, -2 * n[0] * n[1], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2], 0, -2 * n[0] * n[2], -2 * n[1] * n[2], 1 - 2 * n[2] * n[2], 0, 0, 0, 0, 1]; return grp(st, env, (c) => tf(m, c)); },
    multmatrix: (st, env) => { const a = argv(st.args, env); const M = a.get('m', 0); if (!isVec(M) || M.length < 3 || !M.every(isVec)) fail('multmatrix needs a 4 x 4 matrix', st.line); const rows = [...M]; while (rows.length < 4) rows.push([0, 0, 0, 1]); const m = flat(rows.map((r) => [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? (rows.indexOf(r) === 3 ? 1 : 0)])); return grp(st, env, (c) => tf(m, c)); },
    color: (st, env) => kids(st, env), render: (st, env) => kids(st, env), group: (st, env) => kids(st, env),
    union: (st, env) => { const c = kids(st, env); return c.length ? [mk({ t: 'union', c })] : []; },
    difference: (st, env) => { const c = kids(st, env); return c.length ? [mk({ t: 'difference', c })] : []; },
    intersection: (st, env) => { const c = kids(st, env); return c.length ? [mk({ t: 'intersection', c })] : []; },
    hull: (st, env) => { const c = kids(st, env); return c.length ? [mk({ t: 'hull', c })] : []; },
    minkowski: (st, env) => { const c = kids(st, env); return c.length ? [mk({ t: 'minkowski', c })] : []; },
    offset: (st, env) => { const a = argv(st.args, env); const c = kids(st, env); if (!c.length) return []; const r = a.get('r', 0), d = a.named.delta; const n = d !== undefined ? { t: 'offset', delta: d, chamfer: truthy(a.named.chamfer), c } : { t: 'offset', r: isNum(r) ? r : 0, fn: frag(env, Math.abs(isNum(r) ? r : 1)), c }; return [mk(n)]; },
    linear_extrude: (st, env) => {
      const a = argv(st.args, env); const c = kids(st, env).filter((n) => dimOf(n) === 2); if (!c.length) return [];
      const sc = a.get('scale', -1, 1);
      return [mk({ t: 'linear_extrude', h: a.get('height', 0, 100), center: truthy(a.get('center', 1, false)), twist: a.get('twist', -1, 0), slices: a.get('slices', -1, undefined), scale: isVec(sc) ? [sc[0], sc[1]] : [sc, sc], c })];
    },
    rotate_extrude: (st, env) => { const a = argv(st.args, env); const c = kids(st, env).filter((n) => dimOf(n) === 2); if (!c.length) return []; return [mk({ t: 'rotate_extrude', angle: a.get('angle', -1, 360), fn: frag(env, 20), c })]; },
    intersection_for: (st, env) => fail('intersection_for is not supported; use intersection() with a for loop', st.line),
    projection: (st) => { warn('projection() is not supported (skipped)'); void st; return []; },
    text: () => { warn('text() is not supported (skipped)'); return []; },
    surface: () => { warn('surface() is not supported (skipped)'); return []; },
    import: () => { warn('import() is not supported (skipped); export the other file as STL and insert it separately'); return []; },
    resize: (st, env) => { warn('resize() is not supported; the shape keeps its own size'); return kids(st, env); },
    echo: (st, env) => { const vals = st.args.map((x) => ev(x.e, env)); echoes.push(vals.map(show).join(', ')); return kids(st, env); },
    assert: (st, env) => { const vals = st.args.map((x) => ev(x.e, env)); if (!truthy(vals[0])) fail(`assertion failed${vals[1] ? ': ' + vals[1] : ''}`, st.line); return kids(st, env); },
    children: (st, env) => { const a = argv(st.args, env); const ch = env.get('$children_nodes') ?? []; const i = a.pos[0]; if (isNum(i)) return ch[i] ? [ch[i]].flat() : []; if (isVec(i)) return i.flatMap((k) => (ch[k] ? [ch[k]].flat() : [])); return ch.flat(); },
  };
  /** A transform around the children: one transform node per call (children become a union inside it). */
  function grp(st, env, make) { const c = kids(st, env); if (!c.length) return []; return [make(c.length === 1 ? c : [mk({ t: 'union', c })])]; }

  // ---- statements
  function define(body, env) { for (const s of body) { if (s.k === 'moduledef') env.mods.set(s.name, { ...s, env }); else if (s.k === 'funcdef') env.funcs.set(s.name, { ...s, env }); } }
  function block(body, env, top = false) {
    const sub = top ? env : new Env(env, env); // a block is its own scope, so a variable set inside does not leak out
    define(body, sub);
    for (const s of body) if (s.k === 'assign') { const v = top && s.name in overrides ? overrides[s.name] : ev(s.e, sub); sub.vars.set(s.name, v); }
    const out = [];
    for (const s of body) { if (s.k === 'assign' || s.k === 'moduledef' || s.k === 'funcdef') continue; out.push(...exec(s, sub)); }
    return out;
  }
  function exec(s, env) {
    tick();
    switch (s.k) {
      case 'empty': return [];
      case 'block': return block(s.body, env);
      case 'assign': env.vars.set(s.name, ev(s.e, env)); return [];
      case 'moduledef': case 'funcdef': define([s], env); return [];
      case 'include': warn(`${s.kind} <${s.name}> is not supported (the other file is not read)`); return [];
      case 'if': return truthy(ev(s.c, env)) ? exec(s.a, env) : s.b ? exec(s.b, env) : [];
      case 'letstmt': { const sub = new Env(env, env); for (const a of s.as) sub.vars.set(a.name, ev(a.e, sub)); return exec(s.body, sub); }
      case 'for': { const out = []; forEach(s.gens, 0, new Env(env, env), (e2) => out.push(...exec(s.body, e2))); return out; }
      case 'inst': return inst(s, env);
      default: return fail(`cannot run ${s.k}`, s.line);
    }
  }
  function inst(s, env) {
    if (s.name === 'for' || s.name === 'intersection_for') return fail(`${s.name} is not supported here`, s.line);
    const specials = s.args.filter((x) => x.name && x.name[0] === '$');
    if (specials.length) { const e2 = new Env(env, env); for (const x of specials) e2.vars.set(x.name, ev(x.e, env)); env = e2; } // $fn=64 on a call applies to that call and everything inside it
    const um = env.mod(s.name);
    if (um) {
      depth++;
      try {
        if (depth > L.depth) fail(`module "${s.name}" calls itself too deeply`, s.line);
        const sub = bindArgs(um.ps, s.args, um.env, env, s.line, s.name);
        // children are evaluated where the module is called, not inside it
        const childStmts = s.child ? (s.child.k === 'block' ? s.child.body.filter((c) => !['assign', 'moduledef', 'funcdef'].includes(c.k)) : [s.child]) : [];
        const callBlock = s.child && s.child.k === 'block' ? s.child.body.filter((c) => ['assign', 'moduledef', 'funcdef'].includes(c.k)) : [];
        const cenv = new Env(env, env); define(callBlock, cenv); for (const c of callBlock) if (c.k === 'assign') cenv.vars.set(c.name, ev(c.e, cenv));
        sub.vars.set('$children_nodes', childStmts.map((c) => exec(c, cenv)));
        sub.vars.set('$children', childStmts.length);
        return exec(um.body, sub);
      } finally { depth--; }
    }
    const b = BUILTIN[s.name];
    if (b) return b(s, env);
    warn(`the module "${s.name}" is not defined (skipped)`);
    return [];
  }

  // ---- go
  const root = new Env(null, null);
  for (const [k, v] of [['$fn', 0], ['$fa', 12], ['$fs', 2], ['$t', 0], ['$preview', false]]) root.vars.set(k, v);
  const top = block(ast.body, root, true);
  const tree = top.length === 1 ? top[0] : top.length ? { t: 'union', c: top } : null;
  return { tree, warnings: [...warnings], echoes, parameters: listParameters(source) };
}

/** The top-level settings of a script that someone may want to change (Customizer variables): numbers, true/false and short text. */
export function listParameters(source) {
  let ast; try { ast = parse(source); } catch { return []; }
  const out = [];
  for (const s of ast.body) {
    if (s.k === 'moduledef' || s.k === 'funcdef') break; // settings sit above the first module or function
    if (s.k !== 'assign' || s.name[0] === '$' && false) continue;
    const e = s.e; let v;
    if (e.k === 'lit') v = e.v; else if (e.k === 'neg' && e.e.k === 'lit' && isNum(e.e.v)) v = -e.e.v; else continue;
    if (!['number', 'string', 'boolean'].includes(typeof v)) continue;
    out.push({ name: s.name, value: v, type: typeof v });
    if (out.length >= 40) break;
  }
  return out;
}

export { lex as _lex, parse as _parse, trunc as _trunc };
