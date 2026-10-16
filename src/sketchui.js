// Sketch interaction layer (familiar CAD style): inference snapping, type-in dimensions while drawing,
// and a Select tool with hover, drag, resize handles and editable dimension labels.
//
// `app` provides: vp, THREE, sketch() (state, may be null), params() (current sketch params),
// setShapes(shapes), renderPanel(), redrawSketch(), evalExpr(text) -> number | throws.
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { shapeToPolygon, offsetPolygon } from './kernel.js';
import { setDim, getDim } from './sketchdims.js';
import { keyPoints, segOf, conAnchor, CON_GLYPH, CON_LABEL } from './sketchcons.js';
import { filletVertex } from './sketchgeo.js';
import { mirrorShape, trimAt, fitSpline, primitivesOf, ptAt, primPoints, nearestPrim } from './sketchedit.js';
import { arcOf, bulgeFrom3, bulgeFromTangent, endTangent, bulgeFromRadius, segmentLength, pathPolygon } from './sketchgeo.js';

import { UNIT_TABLE, getUnits, lenF, dispStr } from './units.js';
const fmt = (v) => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(3)));
const D2R = Math.PI / 180;

export function createSketchUI(app) {
  const { vp, THREE } = app;
  const view = document.getElementById('viewport');
  const canvas = document.getElementById('gl');
  const S = () => app.sketch();
  const P = () => app.params();
  const shapes = () => P().shapes;

  let dimbox = null, labels = [], drag = null, lastInfer = null, badges = [];
  const CON = { con_h: 'horizontal', con_v: 'vertical', con_coin: 'coincident', con_conc: 'concentric', con_equal: 'equal', con_par: 'parallel', con_perp: 'perpendicular' };
  const CON_HINT = { horizontal: ['a line segment'], vertical: ['a line segment'], parallel: ['the segment to adjust', 'the reference segment'], perpendicular: ['the segment to adjust', 'the reference segment'], coincident: ['the point to move', 'the point to meet'], concentric: ['the shape to move', 'the reference shape'], equal: ['the first segment or circle', 'the second (same kind)'] };

  // ------------------------------------------------------------ coordinates
  const evPx = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const toUV = (ev) => vp.planePoint(ev, P());
  const scr = (uv) => vp.toScreen(vp.planeTo3D(P(), uv));
  const ppmAt = (uv = [0, 0]) => { const a = scr(uv), b = scr([uv[0] + 1, uv[1]]); return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

  function stepNow() {
    const s = S();
    if (s && typeof s.snap === 'number') return s.snap;
    const ppm = ppmAt(s?.cursor || [0, 0]);
    const steps = UNIT_TABLE[getUnits()].steps.map((x) => x * lenF());
    return steps.find((st) => st * ppm >= 14) || steps[steps.length - 1];
  }

  // ------------------------------------------------------------ snapping + inference
  function candidates(exclude = -1) {
    const out = [{ p: [0, 0], kind: 'Origin' }];
    shapes().forEach((s, i) => {
      if (i === exclude) return;
      if (s.t === 'rect' || s.t === 'rrect') {
        const { x, y, w, h } = s;
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach((p) => out.push({ p, kind: 'Endpoint' }));
        [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].forEach((p) => out.push({ p, kind: 'Midpoint' }));
        out.push({ p: [x + w / 2, y + h / 2], kind: 'Center' });
      } else if (s.t === 'slot') {
        out.push({ p: [s.x1, s.y1], kind: 'Center' }, { p: [s.x2, s.y2], kind: 'Center' });
      } else if (s.t === 'ellipse') {
        out.push({ p: [s.cx, s.cy], kind: 'Center' }, { p: [s.cx + s.rx, s.cy], kind: 'Quadrant' }, { p: [s.cx - s.rx, s.cy], kind: 'Quadrant' }, { p: [s.cx, s.cy + s.ry], kind: 'Quadrant' }, { p: [s.cx, s.cy - s.ry], kind: 'Quadrant' });
      } else if (s.t === 'circle') {
        out.push({ p: [s.cx, s.cy], kind: 'Center' });
        [[s.cx + s.r, s.cy], [s.cx - s.r, s.cy], [s.cx, s.cy + s.r], [s.cx, s.cy - s.r]].forEach((p) => out.push({ p, kind: 'Quadrant' }));
      } else if (s.t === 'ngon') {
        out.push({ p: [s.cx, s.cy], kind: 'Center' });
        shapeToPolygon(s).forEach((p) => out.push({ p, kind: 'Endpoint' }));
      } else if (s.t === 'path') {
        s.pts.forEach((p, k) => { out.push({ p, kind: 'Endpoint' }); const q = s.pts[k + 1] || (!s.open ? s.pts[0] : null); if (q) out.push({ p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], kind: 'Midpoint' }); });
      }
    });
    for (const p of S().pts || []) out.push({ p, kind: 'Endpoint' });
    return out;
  }

  function snapPoint(ev, raw, exclude = -1) {
    const s = S();
    if (ev.ctrlKey || ev.metaKey) return { pt: raw, kind: null };
    const px = evPx(ev), cands = candidates(exclude);
    let best = null, bd = 11;
    for (const c of cands) { const q = scr(c.p); const d = Math.hypot(q.x - px.x, q.y - px.y); if (d < bd) { bd = d; best = c; } }
    if (best) return { pt: best.p.slice(), kind: best.kind };
    const ppm = ppmAt(raw);
    let gu = null, gv = null, bu = 6 / ppm, bv = 6 / ppm;
    for (const c of cands) {
      if (Math.abs(c.p[0] - raw[0]) < bu) { bu = Math.abs(c.p[0] - raw[0]); gu = c.p; }
      if (Math.abs(c.p[1] - raw[1]) < bv) { bv = Math.abs(c.p[1] - raw[1]); gv = c.p; }
    }
    const st = stepNow();
    const grid = (x) => (s.snapOn === false ? x : Math.round(x / st) * st);
    const pt = [gu ? gu[0] : grid(raw[0]), gv ? gv[1] : grid(raw[1])];
    return { pt, kind: gu || gv ? 'Aligned' : null, guides: { gu, gv } };
  }

  // ------------------------------------------------------------ shape building while drawing
  const FIELDS = {
    rect: [{ k: 'w', l: 'W' }, { k: 'h', l: 'H' }],
    circle: [{ k: 'd', l: 'Ø' }],
    ngon: [{ k: 'r', l: 'R' }],
    crect: [{ k: 'w', l: 'W' }, { k: 'h', l: 'H' }],
    rrect: [{ k: 'w', l: 'W' }, { k: 'h', l: 'H' }, { k: 'r', l: 'R' }],
    slot: [{ k: 'len', l: 'L' }, { k: 'w', l: 'W' }],
    ellipse: [{ k: 'a', l: 'A' }, { k: 'b', l: 'B' }],
    arc: [{ k: 'len', l: 'L' }, { k: 'ang', l: '∠' }],
    offset: [{ k: 'd', l: 'D' }],
    sfillet: [{ k: 'r', l: 'R' }],
    line: [{ k: 'len', l: 'L' }, { k: 'ang', l: '∠' }],
    path: [{ k: 'len', l: 'L' }, { k: 'ang', l: '∠' }],
  };
  const fieldsFor = (s) => (s.tool === 'arc' && s.pts?.length === 2 ? [{ k: 'r', l: 'R' }] : FIELDS[s.tool]);
  function live(tool, pts, cur) {
    if (tool === 'offset') return { d: S().offD ?? 2 };
    if (tool === 'sfillet') return { r: S().filR ?? 2 };
    if (tool === 'arc' && pts.length === 2) { const b = bulgeFrom3(pts[0], cur, pts[1]); return { r: b ? arcOf(pts[0], pts[1], b).r : 0 }; }
    const a = pts[pts.length - 1];
    const dx = cur[0] - a[0], dy = cur[1] - a[1];
    const sess = S();
    const isC = tool === 'crect';
    return { w: Math.abs(dx) * (isC ? 2 : 1), h: Math.abs(dy) * (isC ? 2 : 1), d: Math.hypot(dx, dy) * 2, a: Math.abs(dx), b: Math.abs(dy), len: Math.hypot(dx, dy), ang: ((Math.atan2(dy, dx) / D2R) + 360) % 360, ...(tool === 'slot' ? { w: sess.slotW ?? 6 } : {}), ...(tool === 'ngon' ? { r: Math.hypot(dx, dy) } : tool === 'rrect' ? { r: sess.cornerR ?? 3 } : {}) };
  }
  function drawnShape(tool, pts, cur, typed) {
    const a = pts[0], dx = cur[0] - a[0], dy = cur[1] - a[1];
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    if (tool === 'rect') {
      const w = typed.w ?? Math.abs(dx), h = typed.h ?? Math.abs(dy);
      return { t: 'rect', x: sx > 0 ? a[0] : a[0] - w, y: sy > 0 ? a[1] : a[1] - h, w, h };
    }
    if (tool === 'crect') {
      const w = typed.w ?? Math.abs(dx) * 2, h = typed.h ?? Math.abs(dy) * 2;
      return { t: 'rect', x: a[0] - w / 2, y: a[1] - h / 2, w, h };
    }
    if (tool === 'rrect') {
      const w = typed.w ?? Math.abs(dx), h = typed.h ?? Math.abs(dy);
      return { t: 'rrect', x: sx > 0 ? a[0] : a[0] - w, y: sy > 0 ? a[1] : a[1] - h, w, h, r: Math.max(0, Math.min(typed.r ?? S().cornerR ?? 3, w / 2, h / 2)) };
    }
    if (tool === 'slot') {
      const len = typed.len ?? Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      return { t: 'slot', x1: a[0], y1: a[1], x2: a[0] + len * Math.cos(ang), y2: a[1] + len * Math.sin(ang), w: typed.w ?? S().slotW ?? 6 };
    }
    if (tool === 'ellipse') return { t: 'ellipse', cx: a[0], cy: a[1], rx: typed.a ?? Math.abs(dx), ry: typed.b ?? Math.abs(dy), rot: 0 };
    if (tool === 'circle') return { t: 'circle', cx: a[0], cy: a[1], r: typed.d != null ? typed.d / 2 : Math.hypot(dx, dy) };
    if (tool === 'ngon') return { t: 'ngon', cx: a[0], cy: a[1], r: typed.r ?? Math.hypot(dx, dy), n: S().sides, rot: Math.atan2(dy, dx) / D2R };
    return null;
  }
  function segEnd(pts, cur, typed) {
    const a = pts[pts.length - 1];
    const lv = live('line', pts, cur);
    const len = typed.len ?? lv.len, ang = (typed.ang ?? lv.ang) * D2R;
    return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
  }

  // path with the in-progress segment appended (tangent arc when arc mode is on)
  function previewPathPts(s, cur, typed) {
    const end = segEnd(s.pts, cur, typed);
    const pts = s.pts.map((p) => [...p]);
    const n = pts.length;
    if (s.arcMode && n >= 2) { const t = endTangent(pts[n - 2], pts[n - 1], pts[n - 2][2] || 0); pts[n - 1][2] = bulgeFromTangent(pts[n - 1], t, end); }
    pts.push(end);
    return pts;
  }
  function arcPreviewPts(s, cur, typed) {
    if (s.pts.length === 1) return [s.pts[0], segEnd(s.pts, cur, typed)];
    const [p0, p1] = s.pts;
    let b = bulgeFrom3(p0, cur, p1);
    if (typed.r != null && b) b = bulgeFromRadius(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), typed.r, Math.sign(b));
    return [[p0[0], p0[1], b], p1];
  }

  // exact offsets for simple shapes, polygon offset otherwise
  function offsetShape(sh, d) {
    if (sh.t === 'circle') return sh.r + d > 1e-3 ? { ...sh, r: sh.r + d } : null;
    if (sh.t === 'rect') {
      if (d >= 0) return { t: 'rrect', x: sh.x - d, y: sh.y - d, w: sh.w + 2 * d, h: sh.h + 2 * d, r: d };
      return sh.w + 2 * d > 1e-3 && sh.h + 2 * d > 1e-3 ? { ...sh, x: sh.x - d, y: sh.y - d, w: sh.w + 2 * d, h: sh.h + 2 * d } : null;
    }
    if (sh.t === 'rrect') {
      const w = sh.w + 2 * d, h = sh.h + 2 * d;
      return w > 1e-3 && h > 1e-3 ? { ...sh, x: sh.x - d, y: sh.y - d, w, h, r: Math.max(0, Math.min(sh.r + d, w / 2, h / 2)) } : null;
    }
    if (sh.t === 'slot') return sh.w + 2 * d > 1e-3 ? { ...sh, w: sh.w + 2 * d } : null;
    if (sh.t === 'path' && sh.open) return null;
    const poly = offsetPolygon(shapeToPolygon(sh), d);
    return poly && poly.length >= 3 ? { t: 'path', pts: poly } : null;
  }
  function filletedShape(sh, vi, r) {
    if (sh.t === 'rect') {
      const pts = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]];
      const np = filletVertex(pts, true, vi, r);
      return np ? { t: 'path', pts: np } : null;
    }
    if (sh.t === 'path') { const np = filletVertex(sh.pts, !sh.open, vi, r); return np ? { ...sh, pts: np } : null; }
    return null;
  }
  const vertexIndex = (k) => +String(k).replace(/^[pc]/, '');

  // ------------------------------------------------------------ overlay drawing
  const mat = (c, o = 1) => new THREE.LineBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthTest: false });
  const line3 = (pts, color, closed = false, dashed = false, width = 3) => {
    const p3 = pts.map((q) => vp.planeTo3D(P(), q));
    let l;
    if (dashed) { // guides stay thin and dashed
      l = new (closed ? THREE.LineLoop : THREE.Line)(new THREE.BufferGeometry().setFromPoints(p3), new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.8, depthTest: false }));
      l.computeLineDistances();
    } else { // thick, drawn over everything, with a soft outline so it shows on a pale face and on the dark background
      const g = new THREE.Group();
      const edge = vp.fatLine(p3, new LineMaterial({ color: vp.dark ? 0x0a0d11 : 0xffffff, linewidth: width + 2, depthTest: false }), closed); edge.renderOrder = 19;
      const core = vp.fatLine(p3, new LineMaterial({ color, linewidth: width, depthTest: false }), closed); core.renderOrder = 20;
      g.add(edge, core); return g;
    }
    l.renderOrder = 20;
    return l;
  };
  function redraw() {
    vp.overlay.clear();
    const s = S();
    if (!s || s.picking) return;
    const cur = s.cursor;
    drawEditPreview(s, cur);
    if (s.pts?.length && cur) {
      const typed = s.dim?.typed || {};
      if (s.tool === 'line' || s.tool === 'path') {
        vp.overlay.add(line3(pathPolygon(previewPathPts(s, cur, typed), false), (vp.dark ? 0xe6e8eb : 0x2d3138)));
      } else if (s.tool === 'arc') {
        vp.overlay.add(line3(pathPolygon(arcPreviewPts(s, cur, typed), false), (vp.dark ? 0xe6e8eb : 0x2d3138)));
      } else if (s.tool === 'offset' && s.off) {
        const res = offsetShape(shapes()[s.off.idx], typed.d ?? s.offD ?? 2);
        if (res) vp.overlay.add(line3(shapeToPolygon(res), 0xf08c00, true));
      } else if (s.tool === 'sfillet' && s.fil) {
        const res = filletedShape(shapes()[s.fil.s], s.fil.vi, typed.r ?? s.filR ?? 2);
        if (res) vp.overlay.add(line3(shapeToPolygon(res), 0xf08c00, res.t !== 'path' || !res.open));
      } else {
        const sh = drawnShape(s.tool, s.pts, cur, typed);
        if (sh) vp.overlay.add(line3(shapeToPolygon(sh), (vp.dark ? 0xe6e8eb : 0x2d3138), true));
      }
    }
    // inference markers + guides
    if (lastInfer && cur) {
      const ppm = ppmAt(cur), sz = 5 / ppm;
      if (lastInfer.kind && lastInfer.kind !== 'Aligned') {
        const [u, v] = cur;
        const pts = lastInfer.kind === 'Center' ? Array.from({ length: 16 }, (_, i) => [u + Math.cos((i / 16) * 6.283) * sz, v + Math.sin((i / 16) * 6.283) * sz])
          : lastInfer.kind === 'Midpoint' ? [[u - sz, v - sz], [u + sz, v - sz], [u, v + sz]]
          : lastInfer.kind === 'Quadrant' ? [[u - sz, v], [u, v - sz], [u + sz, v], [u, v + sz]]
          : [[u - sz, v - sz], [u + sz, v - sz], [u + sz, v + sz], [u - sz, v + sz]];
        vp.overlay.add(line3(pts, lastInfer.kind === 'Endpoint' ? 0xe0453a : 0x1d9a57, true));
      }
      const g = lastInfer.guides;
      if (g?.gu) vp.overlay.add(line3([g.gu, [g.gu[0], cur[1]]], 0xf08c00, false, true));
      if (g?.gv) vp.overlay.add(line3([g.gv, [cur[0], g.gv[1]]], 0xf08c00, false, true));
    }
    if (s.conA && shapes()[s.conA.s]) {
      const sh = shapes()[s.conA.s];
      const p = s.conA.k ? keyPoints(sh).find((q) => q.k === s.conA.k)?.p : s.conA.seg != null ? (() => { const sg = segOf(sh, s.conA.seg); return sg && [(sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2]; })() : keyPoints(sh)[0]?.p;
      if (p) { const z = 6 / ppmAt(p); vp.overlay.add(line3([[p[0] - z, p[1] - z], [p[0] + z, p[1] - z], [p[0] + z, p[1] + z], [p[0] - z, p[1] + z]], 0xf08c00, true)); }
    }
    // selection handles
    if (s.tool === 'select' && s.sel >= 0 && shapes()[s.sel]) {
      for (const h of handlesOf(shapes()[s.sel])) {
        const sz = 4 / ppmAt(h.p);
        vp.overlay.add(line3([[h.p[0] - sz, h.p[1] - sz], [h.p[0] + sz, h.p[1] - sz], [h.p[0] + sz, h.p[1] + sz], [h.p[0] - sz, h.p[1] + sz]], 0x0b6bcb, true));
      }
    }
  }

  // ------------------------------------------------------------ dimension box (typing while drawing)
  function closeDimbox() { dimbox?.remove(); dimbox = null; }
  function openDimbox() {
    const s = S();
    const fields = fieldsFor(s);
    if (!fields) return;
    if (!dimbox) {
      dimbox = document.createElement('div');
      dimbox.id = 'dimbox';
      dimbox.innerHTML = '<svg class="dimsvg"></svg>' + fields.map((f) => `<label data-k="${f.k}"><span>${f.l}</span><input data-k="${f.k}" inputmode="decimal" autocomplete="off" spellcheck="false"><i class="lk" title="Locked: you typed this value"></i></label>`).join('');
      view.appendChild(dimbox);
      const inputs = [...dimbox.querySelectorAll('input')];
      inputs.forEach((inp, i) => {
        inp.onfocus = () => { inp.value = inp.value.replace(/\s*(mm|cm|m|in|ft|°)$/, ''); inp.select(); };
        inp.oninput = () => {
          const k = inp.dataset.k, txt = inp.value.trim();
          if (!s.dim.exprs) s.dim.exprs = {};
          if (txt === '' || txt === '-') { delete s.dim.typed[k]; delete s.dim.exprs[k]; inp.classList.remove('bad'); redraw(); return; }
          try { s.dim.typed[k] = app.evalExpr(txt, k === 'ang' ? 'num' : 'len'); inp.classList.remove('bad'); if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(txt)) delete s.dim.exprs[k]; else s.dim.exprs[k] = txt; } catch { inp.classList.add('bad'); }
          redraw();
        };
        inp.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Tab') { e.preventDefault(); inputs[(i + (e.shiftKey ? inputs.length - 1 : 1)) % inputs.length].focus(); }
          else if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancelShape(); }
        };
      });
    }
    updateDimbox();
  }
  const ARROW = 5;
  /** Dimension line from a to b (screen px) with arrowheads and extension lines from the measured points p and q. */
  function dimLine(a, b, p, q) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const head = (t, dir) => `<path d="M${t.x} ${t.y}l${dir * (ux * 9 - uy * ARROW)} ${dir * (uy * 9 + ux * ARROW)}M${t.x} ${t.y}l${dir * (ux * 9 + uy * ARROW)} ${dir * (uy * 9 - ux * ARROW)}"/>`;
    const ext = (from, to) => { const ex = to.x - from.x, ey = to.y - from.y, el = Math.hypot(ex, ey) || 1; return `<line x1="${from.x + (ex / el) * 4}" y1="${from.y + (ey / el) * 4}" x2="${to.x + (ex / el) * 8}" y2="${to.y + (ey / el) * 8}"/>`; };
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>${head(a, 1)}${head(b, -1)}${ext(p, a)}${ext(q, b)}`;
  }
  /** On-canvas dimension fields: each value sits on its own dimension line beside the shape. */
  function layoutDimbox(s, lv) {
    const svg = dimbox.querySelector('.dimsvg'), place = {};
    let lines = '';
    const cur = s.cursor, typed = s.dim.typed;
    if (['rect', 'crect', 'rrect'].includes(s.tool)) {
      const sh = drawnShape(s.tool, s.pts, cur, typed);
      const c = [[sh.x, sh.y], [sh.x + sh.w, sh.y], [sh.x + sh.w, sh.y + sh.h], [sh.x, sh.y + sh.h]].map(scr);
      const L = Math.min(...c.map((q) => q.x)), R = Math.max(...c.map((q) => q.x)), T = Math.min(...c.map((q) => q.y)), B = Math.max(...c.map((q) => q.y));
      const yb = B + 34, xl = L - 50;
      lines += dimLine({ x: L, y: yb }, { x: R, y: yb }, { x: L, y: B }, { x: R, y: B });
      lines += dimLine({ x: xl, y: T }, { x: xl, y: B }, { x: L, y: T }, { x: L, y: B });
      place.w = { x: (L + R) / 2, y: yb };
      place.h = { x: xl, y: (T + B) / 2 };
      if (place.r) place.r = null;
    } else if ((s.tool === 'line' || s.tool === 'path') && s.pts.length) {
      const a = s.pts[s.pts.length - 1], e = segEnd(s.pts, cur, typed), A = scr(a), E = scr(e);
      const dx = E.x - A.x, dy = E.y - A.y, L = Math.hypot(dx, dy);
      if (L > 30) {
        let nx = -dy / L, ny = dx / L; if (ny > 0) { nx = -nx; ny = -ny; } // offset to the upper side of the line
        const o = 30, A2 = { x: A.x + nx * o, y: A.y + ny * o }, E2 = { x: E.x + nx * o, y: E.y + ny * o };
        lines += dimLine(A2, E2, A, E);
        place.len = { x: (A2.x + E2.x) / 2, y: (A2.y + E2.y) / 2 };
        place.ang = { x: A.x - 56 * Math.sign(dx || 1), y: A.y + 24 };
      }
    } else if (s.tool === 'circle' && s.pts.length) {
      const sh = drawnShape('circle', s.pts, cur, typed), C = scr([sh.cx, sh.cy]), r = ppmAt([sh.cx, sh.cy]) * sh.r;
      lines += `<line x1="${C.x - r}" y1="${C.y}" x2="${C.x + r}" y2="${C.y}"/>`;
      place.d = { x: C.x + r + 70, y: C.y };
      lines += `<line x1="${C.x + r}" y1="${C.y}" x2="${C.x + r + 12}" y2="${C.y}"/>`;
    }
    svg.innerHTML = lines;
    const labels = [...dimbox.querySelectorAll('label')], vw = view.clientWidth, vh = view.clientHeight;
    const stack = scr(cur);
    let n = 0;
    for (const lb of labels) {
      const pos = place[lb.dataset.k];
      lb.classList.toggle('placed', !!pos);
      if (pos) { lb.style.left = Math.max(70, Math.min(vw - 70, pos.x)) + 'px'; lb.style.top = Math.max(16, Math.min(vh - 16, pos.y)) + 'px'; }
      else { lb.style.left = Math.min(stack.x + 82, vw - 70) + 'px'; lb.style.top = Math.min(stack.y + 30 + n * 30, vh - 20) + 'px'; n++; }
    }
  }
  function updateDimbox() {
    const s = S();
    if (!dimbox || !s.pts?.length || !s.cursor) return;
    const lv = live(s.tool, s.pts, s.cursor), unit = getUnits();
    for (const inp of dimbox.querySelectorAll('input')) {
      const k = inp.dataset.k;
      const typed = s.dim.typed[k] != null;
      inp.classList.toggle('live', !typed);
      inp.parentNode.classList.toggle('typed', typed);
      if (document.activeElement !== inp && !typed) inp.value = k === 'ang' ? fmt(lv.ang) + '°' : `${dispStr(lv[k])} ${unit}`;
    }
    layoutDimbox(s, lv);
  }

  // ------------------------------------------------------------ commit / cancel
  function addShape(sh) {
    app.setShapes([...shapes(), sh]);
    app.renderPanel();
  }
  function resetDraw() { const s = S(); s.pts = null; s.dim = { typed: {} }; s.arcMode = false; s.off = null; s.fil = null; closeDimbox(); redraw(); }
  function cancelShape() { resetDraw(); }
  function commit(cursorOverride) {
    const s = S();
    if (!s.pts?.length) return;
    const cur = cursorOverride || s.cursor || s.pts[0];
    const typed = s.dim.typed;
    if (s.tool === 'offset' && s.off) {
      const d = typed.d ?? s.offD ?? 2;
      const res = offsetShape(shapes()[s.off.idx], d);
      if (!res) { app.toast?.('That offset is not possible for this shape.'); return; }
      if (typed.d != null) s.offD = typed.d;
      resetDraw(); addShape(res);
      return;
    }
    if (s.tool === 'sfillet' && s.fil) {
      const r = typed.r ?? s.filR ?? 2;
      const res = filletedShape(shapes()[s.fil.s], s.fil.vi, r);
      if (!res) { app.toast?.('The radius does not fit between those segments.'); return; }
      if (typed.r != null) s.filR = typed.r;
      const idx = s.fil.s;
      resetDraw();
      app.setShapes(shapes().map((o, i) => (i === idx ? res : o)));
      app.renderPanel();
      return;
    }
    if (s.tool === 'arc') {
      if (s.pts.length === 1) {
        const end = segEnd(s.pts, cur, typed);
        if (Math.hypot(end[0] - s.pts[0][0], end[1] - s.pts[0][1]) < 1e-9) return;
        s.pts.push(end); s.dim = { typed: {} };
        closeDimbox(); openDimbox(); redraw();
        return;
      }
      const ap = arcPreviewPts(s, cur, typed);
      if (!ap[0][2]) { app.toast?.('The three points are in a line — move the third point off the chord.'); return; }
      resetDraw();
      addShape({ t: 'path', open: true, pts: ap });
      return;
    }
    if (s.tool === 'line' || s.tool === 'path') {
      const end = segEnd(s.pts, cur, typed);
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(end[0] - last[0], end[1] - last[1]) < 1e-9) return;
      const np = s.pts.length;
      if (s.arcMode && np >= 2) { const t = endTangent(s.pts[np - 2], last, s.pts[np - 2][2] || 0); s.pts[np - 1] = [last[0], last[1], bulgeFromTangent(last, t, end)]; }
      s.pts.push(end);
      s.dim = { typed: {} };
      // keep the dim box for the next segment
      if (dimbox) for (const inp of dimbox.querySelectorAll('input')) { inp.value = ''; inp.classList.remove('bad'); }
      dimbox?.querySelector('input')?.blur();
      redraw();
      return;
    }
    const sh = drawnShape(s.tool, s.pts, cur, typed);
    if (!sh) return;
    const size = sh.t === 'rect' || sh.t === 'rrect' ? Math.min(sh.w, sh.h) : sh.t === 'slot' ? Math.min(sh.w, Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1)) : sh.t === 'ellipse' ? Math.min(sh.rx, sh.ry) : sh.r;
    if (!(size > 1e-6)) return;
    const exMap = { rect: { w: 'w', h: 'h' }, rrect: { w: 'w', h: 'h', r: 'r' }, circle: { d: 'd' }, ngon: { r: 'r' }, slot: { len: 'len', w: 'w' }, ellipse: { a: 'a', b: 'b' } }[sh.t];
    const ex = {};
    for (const [k, txt] of Object.entries(s.dim.exprs || {})) if (exMap?.[k]) ex[exMap[k]] = txt;
    if (Object.keys(ex).length) sh.ex = ex;
    if (sh.t === 'rrect' && typed.r != null) s.cornerR = typed.r;
    if (sh.t === 'slot' && typed.w != null) s.slotW = typed.w;
    resetDraw();
    addShape(sh);
  }
  function finishPath() {
    const s = S();
    if (!s?.pts) return;
    const open = s.tool === 'path';
    if (s.pts.length >= (open ? 2 : 3)) addShape(open ? { t: 'path', open: true, pts: s.pts } : { t: 'path', pts: s.pts });
    resetDraw();
  }

  // ------------------------------------------------------------ select tool: hit testing + handles
  function handlesOf(sh) {
    if (sh.t === 'slot') {
      const dx = sh.x2 - sh.x1, dy = sh.y2 - sh.y1, L = Math.hypot(dx, dy) || 1;
      return [{ id: 'a', p: [sh.x1, sh.y1] }, { id: 'b', p: [sh.x2, sh.y2] }, { id: 'w', p: [(sh.x1 + sh.x2) / 2 - (dy / L) * (sh.w / 2), (sh.y1 + sh.y2) / 2 + (dx / L) * (sh.w / 2)] }];
    }
    if (sh.t === 'ellipse') return [{ id: 'rx', p: [sh.cx + sh.rx, sh.cy] }, { id: 'ry', p: [sh.cx, sh.cy + sh.ry] }];
    if (sh.t === 'rect' || sh.t === 'rrect') {
      const { x, y, w, h } = sh;
      return [
        { id: 'c0', p: [x, y] }, { id: 'c1', p: [x + w, y] }, { id: 'c2', p: [x + w, y + h] }, { id: 'c3', p: [x, y + h] },
        { id: 'e0', p: [x + w / 2, y] }, { id: 'e1', p: [x + w, y + h / 2] }, { id: 'e2', p: [x + w / 2, y + h] }, { id: 'e3', p: [x, y + h / 2] },
      ];
    }
    if (sh.t === 'circle') return [{ id: 'r', p: [sh.cx + sh.r, sh.cy] }];
    if (sh.t === 'ngon') { const a = sh.rot * D2R; return [{ id: 'v', p: [sh.cx + sh.r * Math.cos(a), sh.cy + sh.r * Math.sin(a)] }]; }
    if (sh.t === 'path') return sh.pts.map((p, i) => ({ id: 'p' + i, p }));
    return [];
  }
  function applyHandle(sh, id, uv) {
    const [u, v] = uv;
    if (sh.t === 'slot') {
      if (id === 'a') return { ...sh, x1: u, y1: v };
      if (id === 'b') return { ...sh, x2: u, y2: v };
      const dx = sh.x2 - sh.x1, dy = sh.y2 - sh.y1, L = Math.hypot(dx, dy) || 1;
      const d = Math.abs(((u - sh.x1) * -dy + (v - sh.y1) * dx) / L) * 2;
      return d > 1e-3 ? { ...sh, w: d } : sh;
    }
    if (sh.t === 'ellipse') { const rx = id === 'rx' ? Math.abs(u - sh.cx) : sh.rx, ry = id === 'ry' ? Math.abs(v - sh.cy) : sh.ry; return rx > 1e-3 && ry > 1e-3 ? { ...sh, rx, ry } : sh; }
    if (sh.t === 'rect' || sh.t === 'rrect') {
      let x0 = sh.x, y0 = sh.y, x1 = sh.x + sh.w, y1 = sh.y + sh.h;
      if (id === 'c0') { x0 = u; y0 = v; } else if (id === 'c1') { x1 = u; y0 = v; } else if (id === 'c2') { x1 = u; y1 = v; } else if (id === 'c3') { x0 = u; y1 = v; }
      else if (id === 'e0') y0 = v; else if (id === 'e1') x1 = u; else if (id === 'e2') y1 = v; else if (id === 'e3') x0 = u;
      const nx = Math.min(x0, x1), ny = Math.min(y0, y1), nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0);
      if (nw < 1e-3 || nh < 1e-3) return sh;
      return { ...sh, x: nx, y: ny, w: nw, h: nh, ...(sh.t === 'rrect' ? { r: Math.min(sh.r, nw / 2, nh / 2) } : {}) };
    }
    if (sh.t === 'circle') { const r = Math.hypot(u - sh.cx, v - sh.cy); return r > 1e-3 ? { ...sh, r } : sh; }
    if (sh.t === 'ngon') { const r = Math.hypot(u - sh.cx, v - sh.cy); return r > 1e-3 ? { ...sh, r, rot: Math.atan2(v - sh.cy, u - sh.cx) / D2R } : sh; }
    if (sh.t === 'path') { const i = +id.slice(1); return { ...sh, pts: sh.pts.map((p, k) => (k === i ? (p[2] ? [u, v, p[2]] : [u, v]) : p)) }; }
    return sh;
  }
  const anchorOf = (sh) => (sh.t === 'rect' || sh.t === 'rrect' ? [sh.x, sh.y] : sh.t === 'slot' ? [sh.x1, sh.y1] : sh.t === 'path' ? sh.pts[0] : [sh.cx, sh.cy]);
  function translate(sh, du, dv) {
    if (sh.t === 'slot') return { ...sh, x1: sh.x1 + du, y1: sh.y1 + dv, x2: sh.x2 + du, y2: sh.y2 + dv };
    if (sh.t === 'rect' || sh.t === 'rrect') return { ...sh, x: sh.x + du, y: sh.y + dv };
    if (sh.t === 'path') return { ...sh, pts: sh.pts.map(([a, b, c]) => (c ? [a + du, b + dv, c] : [a + du, b + dv])) };
    return { ...sh, cx: sh.cx + du, cy: sh.cy + dv };
  }
  function pointInPoly(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) && pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
  }
  function hitShape(px) {
    let best = -1, bd = Infinity;
    shapes().forEach((sh, i) => {
      const poly = shapeToPolygon(sh).map(scr);
      if (poly.length < 2) return;
      let d = Infinity;
      const n = sh.open ? poly.length - 1 : poly.length;
      for (let k = 0; k < n; k++) d = Math.min(d, segDist(px, poly[k], poly[(k + 1) % poly.length]));
      let score = d <= 7 ? d : Infinity;
      if (!sh.open && score === Infinity && pointInPoly(px, poly)) score = 1000 + 1; // inside: lower priority than edges
      if (score < bd) { bd = score; best = i; }
    });
    return best;
  }
  function hitHandle(px) {
    const s = S();
    if (s.sel < 0 || !shapes()[s.sel]) return null;
    for (const h of handlesOf(shapes()[s.sel])) { const q = scr(h.p); if (Math.hypot(q.x - px.x, q.y - px.y) < 9) return h; }
    return null;
  }

  // ------------------------------------------------------------ dimension labels on the selected shape
  function clearLabels() { labels.forEach((l) => l.el.remove()); labels = []; }
  function labelSpecs(sh) {
    const mk = (id, at, off, prefix) => ({ id, val: getDim(sh, id), at, off, prefix, set: (v) => setDim(sh, id, v) });
    if (sh.t === 'rect') return [mk('w', [sh.x + sh.w / 2, sh.y + sh.h], [0, -16]), mk('h', [sh.x + sh.w, sh.y + sh.h / 2], [30, 0])];
    if (sh.t === 'rrect') return [mk('w', [sh.x + sh.w / 2, sh.y + sh.h], [0, -16]), mk('h', [sh.x + sh.w, sh.y + sh.h / 2], [30, 0]), mk('r', [sh.x + sh.w - sh.r, sh.y + sh.h - sh.r], [-26, 16], 'R')];
    if (sh.t === 'circle') return [mk('d', [sh.cx + sh.r, sh.cy], [32, 0], 'Ø')];
    if (sh.t === 'ngon') return [mk('r', [sh.cx + (sh.r / 2) * Math.cos(sh.rot * D2R), sh.cy + (sh.r / 2) * Math.sin(sh.rot * D2R)], [0, -14], 'R')];
    if (sh.t === 'slot') { const mid = [(sh.x1 + sh.x2) / 2, (sh.y1 + sh.y2) / 2]; return [mk('len', mid, [0, -16], 'L'), mk('w', mid, [0, 16], 'W')]; }
    if (sh.t === 'ellipse') return [mk('a', [sh.cx + sh.rx / 2, sh.cy], [0, -14], 'A'), mk('b', [sh.cx, sh.cy + sh.ry / 2], [30, 0], 'B')];
    if (sh.t === 'path') {
      const out = [];
      const n = sh.open ? sh.pts.length - 1 : sh.pts.length;
      for (let i = 0; i < n; i++) {
        const a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length];
        out.push(mk('s' + i, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [0, -14], a[2] ? 'R' : undefined));
      }
      return out;
    }
    return [];
  }
  function syncLabels() {
    const s = S();
    const sh = s && s.tool === 'select' && s.sel >= 0 ? shapes()[s.sel] : null;
    if (!sh) { if (labels.length) clearLabels(); return; }
    const specs = labelSpecs(sh);
    const key = specs.map((x) => x.id).join(',') + ':' + s.sel;
    if (!labels.length || labels.key !== key) {
      clearLabels();
      labels = specs.map((sp) => {
        const el = document.createElement('div');
        el.className = 'dimlbl';
        el.innerHTML = `${sp.prefix ? `<span>${sp.prefix}</span>` : ''}<input inputmode="decimal" autocomplete="off" spellcheck="false">`;
        view.appendChild(el);
        const inp = el.querySelector('input');
        inp.onfocus = () => inp.select();
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') inp.blur(); };
        inp.oninput = () => {
          const txt = inp.value.trim();
          let v, expr = null;
          try { v = app.evalExpr(txt, 'len'); if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(txt)) expr = txt; } catch { inp.classList.add('bad'); return; }
          if (!(v > 0)) { inp.classList.add('bad'); return; }
          inp.classList.remove('bad');
          const cur = shapes()[S().sel];
          const spec = labelSpecs(cur).find((x) => x.id === sp.id);
          if (!spec) return;
          const ex = { ...(cur.ex || {}) };
          if (expr) ex[sp.id] = expr; else delete ex[sp.id];
          const ns = { ...spec.set(v) };
          if (Object.keys(ex).length) ns.ex = ex; else delete ns.ex;
          app.setShapes(shapes().map((o, i) => (i === S().sel ? ns : o)));
        };
        return { id: sp.id, el, inp };
      });
      labels.key = key;
    }
    for (const l of labels) {
      const spec = specs.find((x) => x.id === l.id);
      if (!spec) continue;
      const curSh = shapes()[S().sel];
      if (document.activeElement !== l.inp) { l.inp.value = curSh?.ex?.[l.id] ?? dispStr(spec.val); l.inp.title = curSh?.ex?.[l.id] ? `= ${dispStr(spec.val)} ${getUnits()}` : ''; }
      l.inp.classList.toggle('expr', !!curSh?.ex?.[l.id]);
      const sp = scr(spec.at);
      l.el.style.left = sp.x + spec.off[0] + 'px';
      l.el.style.top = sp.y + spec.off[1] + 'px';
    }
  }

  // ------------------------------------------------------------ constraint picking
  function hitSegment(px) {
    let best = null, bd = 8;
    shapes().forEach((sh, i) => {
      if (sh.t !== 'path') return;
      const n = sh.open ? sh.pts.length - 1 : sh.pts.length;
      for (let k = 0; k < n; k++) {
        const [a, b] = segOf(sh, k);
        const d = segDist(px, scr(a), scr(b));
        if (d < bd) { bd = d; best = { s: i, seg: k }; }
      }
    });
    return best;
  }
  function hitKeyPoint(px) {
    let best = null, bd = 10;
    shapes().forEach((sh, i) => { for (const kp of keyPoints(sh)) { const q = scr(kp.p); const d = Math.hypot(q.x - px.x, q.y - px.y); if (d < bd) { bd = d; best = { s: i, k: kp.k }; } } });
    return best;
  }
  function conStatus(type) {
    const s = S();
    document.getElementById('statusbar').textContent = `${CON_LABEL[type]}: select ${CON_HINT[type][s.conA ? 1 : 0]}`;
  }
  function conPick(px) {
    const s = S(), type = CON[s.tool];
    const two = !['horizontal', 'vertical'].includes(type);
    let hit = null;
    if (type === 'coincident') hit = hitKeyPoint(px);
    else if (type === 'concentric') { const i = hitShape(px); hit = i >= 0 ? { s: i } : null; }
    else if (type === 'equal') { hit = hitSegment(px) || (() => { const i = hitShape(px); return i >= 0 && ['circle', 'ngon'].includes(shapes()[i].t) ? { s: i } : null; })(); }
    else hit = hitSegment(px);
    if (!hit) return;
    if (!two) { addCon({ t: type, a: hit }); return; }
    if (!s.conA) { s.conA = hit; conStatus(type); redraw(); return; }
    if (hit.s === s.conA.s && hit.seg === s.conA.seg && hit.k === s.conA.k) return;
    addCon({ t: type, a: s.conA, b: hit });
    s.conA = null;
  }
  function addCon(c) {
    app.setCons([...app.cons(), c]);
    document.getElementById('statusbar').textContent = `${CON_LABEL[c.t]} constraint added`;
    redraw();
  }
  function syncBadges() {
    const s = S();
    const cons = s ? app.cons() : [];
    const sh = s ? shapes() : [];
    const key = JSON.stringify(cons);
    if (badges.key !== key) {
      badges.forEach((b) => b.el.remove());
      badges = cons.map((c, i) => {
        const el = document.createElement('button');
        el.className = 'conbadge'; el.textContent = CON_GLYPH[c.t]; el.title = `${CON_LABEL[c.t]} — click to delete`;
        el.onpointerdown = (e) => { e.stopPropagation(); };
        el.onclick = (e) => { e.stopPropagation(); app.setCons(app.cons().filter((_, k) => k !== i)); };
        view.appendChild(el);
        return { el, c };
      });
      badges.key = key;
    }
    for (const b of badges) {
      const at = conAnchor(sh, b.c);
      if (!at) { b.el.style.display = 'none'; continue; }
      const sp = scr(at);
      b.el.style.display = '';
      b.el.style.left = sp.x + 12 + 'px'; b.el.style.top = sp.y - 12 + 'px';
    }
  }

  // ------------------------------------------------------------ mirror / trim / spline / project
  const DARK = () => (vp.dark ? 0xe6e8eb : 0x2d3138);
  /** Nearest straight segment (of any shape, rectangles included) under the cursor, as a mirror line. */
  function linePrimAt(px) {
    let best = null, bd = 9;
    shapes().forEach((sh, si) => primitivesOf(sh).prims.forEach((p) => {
      if (p.k !== 'L') return;
      const d = segDist(px, scr(p.a), scr(p.b));
      if (d < bd) { bd = d; best = { si, a: p.a, b: p.b }; }
    }));
    return best;
  }
  const mirrorCopies = (idxs, a, b) => idxs.map((i) => mirrorShape(shapes()[i], a, b));
  function drawEditPreview(s, cur) {
    if (s.tool === 'mirror' && s.mir) {
      for (const i of s.mir.sel) { const sh = shapes()[i]; if (sh) vp.overlay.add(line3(shapeToPolygon(sh), 0xf08c00, !sh.open)); }
      if (s.mir.phase === 'line' && s.mir.line) {
        vp.overlay.add(line3([s.mir.line.a, s.mir.line.b], 0x1d63b8));
        for (const m of mirrorCopies(s.mir.sel, s.mir.line.a, s.mir.line.b)) vp.overlay.add(line3(shapeToPolygon(m), 0xf08c00, !m.open, true));
      }
    } else if (s.tool === 'trim' && s.trimPrev) {
      for (const pl of s.trimPrev) if (pl.length > 1) vp.overlay.add(line3(pl, 0xe0453a));
    } else if (s.tool === 'spline' && s.pts?.length && cur) {
      vp.overlay.add(line3(fitSpline([...s.pts, cur], false), DARK()));
      for (const q of s.pts) { const z = 4 / ppmAt(q); vp.overlay.add(line3([[q[0] - z, q[1] - z], [q[0] + z, q[1] - z], [q[0] + z, q[1] + z], [q[0] - z, q[1] + z]], 0x1d63b8, true)); }
    }
  }
  function finishSpline(closed = false) {
    const s = S();
    const pts = (s.pts || []).slice();
    s.pts = null; s.dim = { typed: {} };
    if (pts.length < 2) { redraw(); return; }
    addShape({ t: 'path', open: !closed, spline: true, pts: fitSpline(pts, closed) });
    redraw();
  }
  function applyMirror(a, b) {
    const s = S(), sel = s.mir.sel;
    app.setShapes([...shapes(), ...mirrorCopies(sel, a, b)]);
    s.mir = { sel: [], phase: 'pick' };
    app.toast?.(`Mirrored ${sel.length} ${sel.length > 1 ? 'shapes' : 'shape'}. Pick more shapes, or press Esc.`);
    app.renderPanel(); redraw();
  }
  function editPointer(ev, kind, raw, px) {
    const s = S();
    const sn = snapPoint(ev, raw);
    s.cursor = sn.pt;
    if (s.tool === 'mirror') {
      s.mir ||= { sel: [], phase: 'pick' };
      if (kind === 'move') {
        if (s.mir.phase === 'line') { const h = linePrimAt(px); s.mir.line = h ? { a: h.a, b: h.b } : null; canvas.style.cursor = h ? 'pointer' : ''; }
        else { const i = hitShape(px); canvas.style.cursor = i >= 0 ? 'pointer' : ''; }
        redraw(); return;
      }
      if (kind !== 'down') return;
      if (s.mir.phase === 'line') { const h = linePrimAt(px); if (h) applyMirror(h.a, h.b); else app.toast?.('Click a straight line to mirror across, or press X or Y for a sketch axis.'); return; }
      const i = hitShape(px);
      if (i < 0) return;
      s.mir.sel = s.mir.sel.includes(i) ? s.mir.sel.filter((x) => x !== i) : [...s.mir.sel, i];
      redraw(); return;
    }
    if (s.tool === 'trim') {
      const tol = 12 / ppmAt(raw), res = trimAt(shapes(), raw, tol);
      if (kind === 'move') { s.trimPrev = res?.removed || null; canvas.style.cursor = res ? 'pointer' : ''; redraw(); return; }
      if (kind !== 'down' || !res) return;
      const delta = res.shapes.length - shapes().length + 1;
      app.setShapes(res.shapes);
      app.remapCons?.(res.index, delta);
      s.trimPrev = null; s.sel = -1;
      app.renderPanel(); redraw();
      return;
    }
    if (s.tool === 'spline') {
      if (kind === 'move') { redraw(); return; }
      if (kind !== 'down') return;
      s.pts ||= [];
      if (s.pts.length >= 3 && Math.hypot(scr(s.pts[0]).x - px.x, scr(s.pts[0]).y - px.y) < 10) { finishSpline(true); return; }
      s.pts.push(sn.pt); s.dim = { typed: {} };
      redraw(); return;
    }
    if (s.tool === 'project') {
      if (kind === 'move') { const hit = app.projectHover?.(ev); canvas.style.cursor = hit ? 'pointer' : ''; return; }
      if (kind !== 'down') return;
      const found = app.projectPick?.(ev, ev.shiftKey) || [];
      if (!found.length) { app.toast?.('Click a model edge to include it. Shift-click includes every edge of that body.'); return; }
      app.setShapes([...shapes(), ...found]);
      app.toast?.(`Included ${found.length} ${found.length > 1 ? 'curves' : 'curve'} from the model`);
      app.renderPanel(); redraw();
    }
  }

  // ------------------------------------------------------------ pointer routing
  function status(info, pt) {
    const el = document.getElementById('statusbar');
    el.textContent = `${info?.kind ? info.kind + ' · ' : ''}u ${dispStr(pt[0], 3)}  v ${dispStr(pt[1], 3)} ${getUnits()}`;
  }
  function pointer(ev, kind) {
    const s = S();
    if (!s || s.picking) return;
    const raw = toUV(ev);
    if (!raw) return;
    const px = evPx(ev);

    if (s.tool === 'select') {
      if (kind === 'down') {
        const h = hitHandle(px);
        if (h) { drag = { type: 'handle', id: h.id, idx: s.sel }; return; }
        const i = hitShape(px);
        if (i >= 0) {
          s.sel = i; drag = { type: 'move', idx: i, start: raw, orig: shapes()[i], anchor: anchorOf(shapes()[i]) };
          app.redrawSketch(); app.renderPanel(); redraw();
        } else if (s.sel >= 0) { s.sel = -1; app.redrawSketch(); app.renderPanel(); redraw(); }
        return;
      }
      if (kind === 'move') {
        if (drag) {
          if (drag.type === 'handle') {
            const sn = snapPoint(ev, raw, drag.idx);
            lastInfer = sn; s.cursor = sn.pt;
            app.setShapes(shapes().map((o, i) => (i === drag.idx ? applyHandle(o, drag.id, sn.pt) : o)));
            status(sn, sn.pt);
          } else {
            const want = [drag.anchor[0] + raw[0] - drag.start[0], drag.anchor[1] + raw[1] - drag.start[1]];
            const sn = snapPoint(ev, want, drag.idx);
            lastInfer = sn; s.cursor = sn.pt;
            app.setShapes(shapes().map((o, i) => (i === drag.idx ? translate(drag.orig, sn.pt[0] - drag.anchor[0], sn.pt[1] - drag.anchor[1]) : o)));
          }
          redraw();
          return;
        }
        const hh = hitHandle(px) ? 'handle' : null;
        const hv = hh ? s.hover : hitShape(px);
        canvas.style.cursor = hh ? 'move' : hv >= 0 ? 'pointer' : '';
        if (hv !== s.hover) { s.hover = hv; app.redrawSketch(); }
        const sn = snapPoint(ev, raw);
        s.cursor = sn.pt; status(sn, sn.pt);
        return;
      }
      if (kind === 'up') { if (drag) { drag = null; lastInfer = null; app.renderPanel(); redraw(); } return; }
      return;
    }

    if (['mirror', 'trim', 'spline', 'project'].includes(s.tool)) { editPointer(ev, kind, raw, px); return; }
    if (s.tool?.startsWith('con_')) {
      if (kind === 'down') conPick(px);
      else if (kind === 'move') { const type = CON[s.tool]; conStatus(type); }
      return;
    }
    if (s.tool === 'offset' || s.tool === 'sfillet') {
      const sn0 = snapPoint(ev, raw);
      s.cursor = sn0.pt;
      if (kind === 'move') { if (s.pts?.length) updateDimbox(); redraw(); return; }
      if (kind !== 'down') return;
      if (s.tool === 'offset' ? s.off : s.fil) { commit(); return; }
      if (s.tool === 'offset') {
        const i = hitShape(px);
        if (i < 0) return;
        if (shapes()[i].t === 'path' && shapes()[i].open) { app.toast?.('Offset works on closed shapes.'); return; }
        s.off = { idx: i };
      } else {
        const h = hitKeyPoint(px);
        const sh = h && shapes()[h.s];
        if (!sh || !['rect', 'path'].includes(sh.t) || h.k === 'ctr') { app.toast?.('Click a corner of a rectangle or path.'); return; }
        s.fil = { s: h.s, vi: vertexIndex(h.k) };
      }
      s.pts = [[0, 0]]; s.dim = { typed: {} };
      openDimbox(); redraw();
      return;
    }
    if (s.tool === 'dim') {
      if (kind === 'down') { const i = hitShape(px); if (i >= 0) { s.sel = i; app.setTool('select'); setTimeout(() => labels[0]?.inp.focus(), 40); } }
      return;
    }

    // drawing tools
    const sn = snapPoint(ev, raw);
    if (kind === 'move') {
      lastInfer = sn; s.cursor = sn.pt;
      status(sn, sn.pt);
      if (s.pts?.length) updateDimbox();
      redraw();
      return;
    }
    if (kind !== 'down') return;
    lastInfer = sn; s.cursor = sn.pt;
    if (!s.dim) s.dim = { typed: {} };
    if (s.tool === 'line' || s.tool === 'path') {
      if (!s.pts) { s.pts = [sn.pt]; openDimbox(); redraw(); return; }
      const first = s.pts[0];
      if (s.tool === 'line' && s.pts.length >= 3 && Math.hypot(first[0] - sn.pt[0], first[1] - sn.pt[1]) < 1e-6) {
        const np = s.pts.length, last = s.pts[np - 1];
        if (s.arcMode) { const t = endTangent(s.pts[np - 2], last, s.pts[np - 2][2] || 0); s.pts[np - 1] = [last[0], last[1], bulgeFromTangent(last, t, first)]; }
        finishPath(); return;
      }
      commit(sn.pt);
      return;
    }
    if (!s.pts) { s.pts = [sn.pt]; s.dim = { typed: {} }; openDimbox(); redraw(); return; }
    commit(sn.pt);
  }
  function dblclick() { const s = S(); if (s && (s.tool === 'line' || s.tool === 'path') && s.pts) { s.pts.pop(); finishPath(); } else if (s?.tool === 'spline' && s.pts) { s.pts.pop(); finishSpline(false); } }

  // ------------------------------------------------------------ keyboard
  function key(e) {
    const s = S();
    if (!s || s.picking) return false;
    if (s.tool === 'mirror' && s.mir) { // mirror: Enter = go to the mirror-line step, X / Y = mirror across a sketch axis
      if (e.key === 'Escape' && (s.mir.sel.length || s.mir.phase === 'line')) { s.mir = { sel: [], phase: 'pick' }; redraw(); return true; }
      if (e.key === 'Enter' && s.mir.sel.length && s.mir.phase === 'pick') { s.mir.phase = 'line'; app.toast?.('Now click the line to mirror across (or press X or Y).'); redraw(); return true; }
      if (s.mir.sel.length && /^[xyXY]$/.test(e.key) && !e.metaKey && !e.ctrlKey) { applyMirror(...(/x/i.test(e.key) ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]])); return true; }
    }
    if (s.tool === 'spline' && e.key === 'Enter' && s.pts?.length) { finishSpline(false); return true; }
    if (e.key === 'Escape') {
      if (s.pts?.length) { cancelShape(); return true; }
      if (s.tool !== 'select') { app.setTool('select'); return true; }
      if (s.sel >= 0) { s.sel = -1; app.redrawSketch(); app.renderPanel(); redraw(); return true; }
      return true;
    }
    if (e.key === 'Enter') {
      if (s.pts?.length) {
        if ((s.tool === 'line' || s.tool === 'path') && !Object.keys(s.dim?.typed || {}).length) { finishPath(); return true; }
        commit(); return true;
      }
      return false;
    }
    if ((s.tool === 'line' || s.tool === 'path') && s.pts?.length >= 2 && (e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey) {
      s.arcMode = !s.arcMode;
      document.getElementById('statusbar').textContent = s.arcMode ? 'Tangent arc — press A to go back to lines' : 'Line mode';
      redraw();
      return true;
    }
    if (s.pts?.length && dimbox && /^[0-9.\-]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const inp = [...dimbox.querySelectorAll('input')].find((i) => s.dim.typed[i.dataset.k] == null) || dimbox.querySelector('input');
      inp.focus(); inp.value = e.key; inp.dispatchEvent(new Event('input'));
      return true;
    }
    if (s.tool === 'select' && s.sel >= 0 && /^Arrow/.test(e.key)) {
      const st = e.shiftKey ? stepNow() * 10 : stepNow();
      const [du, dv] = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
      app.setShapes(shapes().map((o, i) => (i === s.sel ? translate(o, du, dv) : o)));
      return true;
    }
    return false;
  }

  function frame() {
    const s = S();
    if (!s || s.picking) return;
    if (s.pts?.length) updateDimbox();
    syncLabels();
    syncBadges();
    const st = stepNow();
    if (s.gridStep !== st) { s.gridStep = st; app.rebuildGrid(st); }
  }
  function activate() {
    const s = S();
    s.pts = null; s.dim = { typed: {} }; s.hover = -1; s.cursor = null; s.arcMode = false; s.conA = null; s.off = null; s.fil = null;
    drag = null; lastInfer = null;
    closeDimbox(); clearLabels(); redraw();
    canvas.style.cursor = '';
  }
  function deactivate() { badges.forEach((b) => b.el.remove()); badges = []; closeDimbox(); clearLabels(); drag = null; lastInfer = null; canvas.style.cursor = ''; vp.overlay.clear(); }

  return { pointer, key, dblclick, finishPath, cancelShape, activate, deactivate, frame, redraw, stepNow, refreshLabels: () => { clearLabels(); } };
}
