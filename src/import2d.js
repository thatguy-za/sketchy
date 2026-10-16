// 2D importers that turn SVG / DXF / text into sketch shapes ({t:'path', pts:[[x,y,bulge?]], open?} or {t:'circle'}).
// All results are in millimetres with +Y up.
import opentype from 'opentype.js';
import regularUrl from '@fontsource/roboto/files/roboto-latin-400-normal.woff?url';
import boldUrl from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';

const PX_MM = 25.4 / 96;
const fonts = {};

/** Close shapes whose polyline ends where it starts, drop zero-length points. */
function tidy(pts, closed) {
  const out = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out.at(-1)[0], p[1] - out.at(-1)[1]) > 1e-6) out.push(p);
  if (closed && out.length > 1 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) < 1e-6) out.pop();
  return out;
}
const mkPath = (pts, closed) => { const t = tidy(pts, closed); return t.length >= (closed ? 3 : 2) ? (closed ? { t: 'path', pts: t } : { t: 'path', open: true, pts: t }) : null; };

// ---------------- SVG
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function parseTransform(s) {
  let m = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of (s || '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let t = null;
    if (fn === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    else if (fn === 'scale') t = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (fn === 'rotate') { const r = (a[0] * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r); t = [c, n, -n, c, 0, 0]; if (a.length > 2) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]); }
    else if (fn === 'matrix') t = a;
    else if (fn === 'skewX') t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0];
    if (t) m = mul(m, t);
  }
  return m;
}
function arcPoints(x1, y1, rx, ry, phi, fa, fs, x2, y2) { // SVG endpoint arc -> polyline
  if (!rx || !ry) return [[x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const p = (phi * Math.PI) / 180, c = Math.cos(p), s = Math.sin(p);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI; else if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dth) / (Math.PI / 24)));
  const out = [];
  for (let i = 1; i <= n; i++) { const t = th1 + (dth * i) / n; out.push([c * rx * Math.cos(t) - s * ry * Math.sin(t) + cx, s * rx * Math.cos(t) + c * ry * Math.sin(t) + cy]); }
  return out;
}
/** Flatten an SVG path 'd' into subpaths [{pts:[[x,y]], closed}] in user units. */
function flattenPath(d) {
  const toks = [...d.matchAll(/([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g)].map((m) => m[1] || +m[2]);
  const subs = [];
  let i = 0, cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', lc = null, lq = null;
  const num = () => toks[i++];
  const flag = () => num();
  const start = (nx, ny) => { cur = { pts: [[nx, ny]], closed: false }; subs.push(cur); sx = nx; sy = ny; };
  const bez = (p0, p1, p2, p3) => { for (let k = 1; k <= 16; k++) { const t = k / 16, u = 1 - t; cur.pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); } };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++];
    else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { if (cur) cur.closed = true; x = sx; y = sy; lc = lq = null; continue; }
    if (C === 'M') { x = ox + num(); y = oy + num(); start(x, y); lc = lq = null; }
    else if (C === 'L') { x = ox + num(); y = oy + num(); if (!cur) start(x, y); else cur.pts.push([x, y]); lc = lq = null; }
    else if (C === 'H') { x = (rel ? x : 0) + num(); cur.pts.push([x, y]); lc = lq = null; }
    else if (C === 'V') { y = (rel ? y : 0) + num(); cur.pts.push([x, y]); lc = lq = null; }
    else if (C === 'C') { const p1 = [ox + num(), oy + num()], p2 = [ox + num(), oy + num()], p3 = [ox + num(), oy + num()]; bez([x, y], p1, p2, p3); lc = p2; lq = null; [x, y] = p3; }
    else if (C === 'S') { const p1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y], p2 = [ox + num(), oy + num()], p3 = [ox + num(), oy + num()]; bez([x, y], p1, p2, p3); lc = p2; lq = null; [x, y] = p3; }
    else if (C === 'Q' || C === 'T') {
      const q = C === 'Q' ? [ox + num(), oy + num()] : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y];
      const p3 = [ox + num(), oy + num()];
      bez([x, y], [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3);
      lq = q; lc = null; [x, y] = p3;
    } else if (C === 'A') {
      const rx = num(), ry = num(), phi = num(), fa = flag(), fs = flag(), nx = ox + num(), ny = oy + num();
      cur.pts.push(...arcPoints(x, y, rx, ry, phi, fa, fs, nx, ny)); x = nx; y = ny; lc = lq = null;
    } else break;
  }
  return subs;
}

/** @returns {shapes[]} sketch shapes in mm; SVG Y-down is flipped, and the result is centred on the origin. */
export function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('not a valid SVG file');
  const root = doc.documentElement;
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const unitScale = (v) => { const m = /^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/.exec(v || ''); if (!m) return null; return +m[1] * ({ mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: PX_MM }[m[2] || 'px']); };
  let scale = PX_MM;
  const wmm = unitScale(root.getAttribute('width'));
  if (wmm && vb.length === 4 && vb[2] > 0) scale = wmm / vb[2];
  const out = [];
  const num = (e, a, d = 0) => parseFloat(e.getAttribute(a)) || d;
  const emit = (subs, m) => {
    for (const s of subs) {
      const pts = s.pts.map(([px, py]) => [(m[0] * px + m[2] * py + m[4]) * scale, -(m[1] * px + m[3] * py + m[5]) * scale]);
      const sh = mkPath(pts, s.closed);
      if (sh) out.push(sh);
    }
  };
  const walk = (el, parent) => {
    const m = mul(parent, parseTransform(el.getAttribute('transform')));
    const tag = el.localName;
    if (['defs', 'clipPath', 'mask', 'symbol', 'metadata', 'title', 'desc', 'style'].includes(tag)) return;
    if (tag === 'path') emit(flattenPath(el.getAttribute('d') || ''), m);
    else if (tag === 'rect') {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (w > 0 && h > 0) emit([{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }], m);
    } else if (tag === 'circle' || tag === 'ellipse') {
      const rx = tag === 'circle' ? num(el, 'r') : num(el, 'rx'), ry = tag === 'circle' ? rx : num(el, 'ry'), cx = num(el, 'cx'), cy = num(el, 'cy');
      if (rx > 0 && ry > 0) emit([{ pts: Array.from({ length: 64 }, (_, k) => [cx + rx * Math.cos((k / 64) * 2 * Math.PI), cy + ry * Math.sin((k / 64) * 2 * Math.PI)]), closed: true }], m);
    } else if (tag === 'line') emit([{ pts: [[num(el, 'x1'), num(el, 'y1')], [num(el, 'x2'), num(el, 'y2')]], closed: false }], m);
    else if (tag === 'polygon' || tag === 'polyline') {
      const n = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
      const pts = []; for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k], n[k + 1]]);
      emit([{ pts, closed: tag === 'polygon' }], m);
    }
    for (const c of el.children) walk(c, m);
  };
  walk(root, vb.length === 4 && vb.every(Number.isFinite) ? [1, 0, 0, 1, -vb[0], -vb[1]] : [1, 0, 0, 1, 0, 0]);
  return centre(out);
}

// ---------------- DXF
/** LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE/VERTEX and SPLINE (control polygon). Lines/arcs that touch are joined into paths. */
export function parseDXF(text) {
  const raw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([parseInt(raw[i], 10), raw[i + 1].trim()]);
  // INSUNITS: 1 in, 4 mm, 5 cm, 6 m
  let unit = 1;
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') { const v = +pairs[i + 1]?.[1]; unit = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 }[v] ?? 1; break; }
  const ents = [];
  let sec = '', cur = null;
  for (const [c, v] of pairs) {
    if (c === 0) {
      if (v === 'SECTION') { cur = null; continue; }
      if (v === 'ENDSEC') { sec = ''; cur = null; continue; }
      cur = sec === 'ENTITIES' ? { type: v, g: [] } : null;
      if (cur) ents.push(cur);
    } else if (c === 2 && !cur && !sec) sec = v;
    else if (cur) cur.g.push([c, v]);
  }
  const f = (e, code, d = 0) => { const r = e.g.find((p) => p[0] === code); return r ? parseFloat(r[1]) : d; };
  const all = (e, code) => e.g.filter((p) => p[0] === code).map((p) => parseFloat(p[1]));
  const segs = [], shapes = [];
  for (let k = 0; k < ents.length; k++) {
    const e = ents[k];
    if (e.type === 'LINE') segs.push({ a: [f(e, 10), f(e, 20)], b: [f(e, 11), f(e, 21)], bulge: 0 });
    else if (e.type === 'ARC') {
      const cx = f(e, 10), cy = f(e, 20), r = f(e, 40), a0 = (f(e, 50) * Math.PI) / 180;
      let a1 = (f(e, 51) * Math.PI) / 180; if (a1 <= a0) a1 += 2 * Math.PI;
      segs.push({ a: [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], b: [cx + r * Math.cos(a1), cy + r * Math.sin(a1)], bulge: Math.tan((a1 - a0) / 4) });
    } else if (e.type === 'CIRCLE') shapes.push({ t: 'circle', cx: f(e, 10) * unit, cy: f(e, 20) * unit, r: f(e, 40) * unit });
    else if (e.type === 'LWPOLYLINE') {
      const xs = all(e, 10), ys = all(e, 20), bs = [];
      // bulges (42) belong to the vertex they follow; walk the group list in order
      let vi = -1; for (const [c, v] of e.g) { if (c === 10) vi++; else if (c === 42 && vi >= 0) bs[vi] = parseFloat(v); }
      const closed = (f(e, 70) & 1) === 1;
      const pts = xs.map((x, i) => (bs[i] ? [x * unit, ys[i] * unit, bs[i]] : [x * unit, ys[i] * unit]));
      const sh = mkPath(pts, closed); if (sh) shapes.push(sh);
    } else if (e.type === 'POLYLINE') {
      const closed = (f(e, 70) & 1) === 1, pts = [];
      for (let j = k + 1; j < ents.length && ents[j].type === 'VERTEX'; j++) pts.push(ents[j].g.some((p) => p[0] === 42 && +p[1]) ? [f(ents[j], 10) * unit, f(ents[j], 20) * unit, f(ents[j], 42)] : [f(ents[j], 10) * unit, f(ents[j], 20) * unit]);
      const sh = mkPath(pts, closed); if (sh) shapes.push(sh);
    } else if (e.type === 'SPLINE') {
      const xs = all(e, 10), ys = all(e, 20), sh = mkPath(xs.map((x, i) => [x * unit, ys[i] * unit]), (f(e, 70) & 1) === 1); if (sh) shapes.push(sh);
    }
  }
  // join touching LINE/ARC segments into chains
  const tol = 1e-4 / unit, used = new Array(segs.length).fill(false);
  const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < Math.max(tol, 1e-4);
  const rev = (s) => ({ a: s.b, b: s.a, bulge: -s.bulge });
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = [segs[i]], grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j], head = chain[0], tail = chain.at(-1);
        if (same(tail.b, s.a)) chain.push(s); else if (same(tail.b, s.b)) chain.push(rev(s));
        else if (same(head.a, s.b)) chain.unshift(s); else if (same(head.a, s.a)) chain.unshift(rev(s));
        else continue;
        used[j] = true; grew = true;
      }
    }
    const closed = chain.length > 2 && same(chain[0].a, chain.at(-1).b);
    const pts = chain.map((s) => (s.bulge ? [s.a[0] * unit, s.a[1] * unit, s.bulge] : [s.a[0] * unit, s.a[1] * unit]));
    if (!closed) pts.push([chain.at(-1).b[0] * unit, chain.at(-1).b[1] * unit]);
    const sh = mkPath(pts, closed); if (sh) shapes.push(sh);
  }
  return shapes;
}

// ---------------- Text
async function loadFont(bold) {
  const k = bold ? 'b' : 'r';
  if (!fonts[k]) fonts[k] = opentype.parse(await (await fetch(bold ? boldUrl : regularUrl)).arrayBuffer());
  return fonts[k];
}
/** Glyph outlines as closed paths. `height` is the font size in mm. Counters (holes in a, o, e…) are separate paths and become holes via nesting. */
export async function textShapes(str, height = 10, bold = false) {
  const font = await loadFont(bold);
  const lines = String(str).split('\n');
  const out = [];
  lines.forEach((ln, row) => {
    // lay glyphs out by hand (opentype's GSUB shaping chokes on some fonts)
    const sc = height / font.unitsPerEm, cmds = [];
    let pen = 0, prev = null;
    for (const ch of ln) {
      const g = font.charToGlyph(ch);
      if (prev) pen += font.getKerningValue(prev, g) * sc;
      cmds.push(...g.getPath(pen, 0, height).commands);
      pen += g.advanceWidth * sc; prev = g;
    }
    const path = { commands: cmds }; // y down, baseline at 0
    const dy = -row * height * 1.25;
    let sub = [], px = 0, py = 0;
    const flush = () => { const sh = mkPath(sub.map(([x, y]) => [x, y + dy]), true); if (sh) out.push(sh); sub = []; };
    for (const c of path.commands) {
      if (c.type === 'M') { if (sub.length) flush(); sub = [[c.x, -c.y]]; px = c.x; py = c.y; }
      else if (c.type === 'L') { sub.push([c.x, -c.y]); px = c.x; py = c.y; }
      else if (c.type === 'Q') { for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; sub.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, -(u * u * py + 2 * u * t * c.y1 + t * t * c.y)]); } px = c.x; py = c.y; }
      else if (c.type === 'C') { for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; sub.push([u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, -(u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y)]); } px = c.x; py = c.y; }
      else if (c.type === 'Z') { flush(); }
    }
    if (sub.length) flush();
  });
  return out;
}

/** Shift shapes so their bounding box is centred on the origin (imports start in a predictable place). */
export function centre(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const each = (fn) => shapes.forEach((s) => (s.t === 'circle' ? [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]] : s.pts).forEach(fn));
  each((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  if (!Number.isFinite(x0)) return shapes;
  const dx = -(x0 + x1) / 2, dy = -(y0 + y1) / 2;
  return shapes.map((s) => (s.t === 'circle' ? { ...s, cx: s.cx + dx, cy: s.cy + dy } : { ...s, pts: s.pts.map((p) => (p.length > 2 ? [p[0] + dx, p[1] + dy, p[2]] : [p[0] + dx, p[1] + dy])) }));
}
