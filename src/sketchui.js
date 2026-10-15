// Sketch interaction layer (Fusion-style): inference snapping, type-in dimensions while drawing,
// and a Select tool with hover, drag, resize handles and editable dimension labels.
//
// `app` provides: vp, THREE, sketch() (state, may be null), params() (current sketch params),
// setShapes(shapes), renderPanel(), redrawSketch(), evalExpr(text) -> number | throws.
import { shapeToPolygon } from './kernel.js';

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const fmt = (v) => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(3)));
const D2R = Math.PI / 180;

export function createSketchUI(app) {
  const { vp, THREE } = app;
  const view = document.getElementById('viewport');
  const canvas = document.getElementById('gl');
  const S = () => app.sketch();
  const P = () => app.params();
  const shapes = () => P().shapes;

  let dimbox = null, labels = [], drag = null, lastInfer = null;

  // ------------------------------------------------------------ coordinates
  const evPx = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const toUV = (ev) => vp.planePoint(ev, P());
  const scr = (uv) => vp.toScreen(vp.planeTo3D(P(), uv));
  const ppmAt = (uv = [0, 0]) => { const a = scr(uv), b = scr([uv[0] + 1, uv[1]]); return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

  function stepNow() {
    const s = S();
    if (s && typeof s.snap === 'number') return s.snap;
    const ppm = ppmAt(s?.cursor || [0, 0]);
    return STEPS.find((st) => st * ppm >= 14) || STEPS[STEPS.length - 1];
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
    line: [{ k: 'len', l: 'L' }, { k: 'ang', l: '∠' }],
    path: [{ k: 'len', l: 'L' }, { k: 'ang', l: '∠' }],
  };
  function live(tool, pts, cur) {
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

  // ------------------------------------------------------------ overlay drawing
  const mat = (c, o = 1) => new THREE.LineBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthTest: false });
  const line3 = (pts, color, closed = false, dashed = false) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map((q) => vp.planeTo3D(P(), q)));
    const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.8, depthTest: false }) : mat(color);
    const l = new (closed ? THREE.LineLoop : THREE.Line)(g, m);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 20;
    return l;
  };
  function redraw() {
    vp.overlay.clear();
    const s = S();
    if (!s || s.picking) return;
    const cur = s.cursor;
    if (s.pts?.length && cur) {
      const typed = s.dim?.typed || {};
      if (s.tool === 'line' || s.tool === 'path') {
        const end = segEnd(s.pts, cur, typed);
        vp.overlay.add(line3([...s.pts, end], 0xf08c00));
      } else {
        const sh = drawnShape(s.tool, s.pts, cur, typed);
        if (sh) vp.overlay.add(line3(shapeToPolygon(sh), 0xf08c00, true));
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
    const fields = FIELDS[s.tool];
    if (!fields) return;
    if (!dimbox) {
      dimbox = document.createElement('div');
      dimbox.id = 'dimbox';
      dimbox.innerHTML = fields.map((f) => `<label><span>${f.l}</span><input data-k="${f.k}" inputmode="decimal" autocomplete="off" spellcheck="false"></label>`).join('');
      view.appendChild(dimbox);
      const inputs = [...dimbox.querySelectorAll('input')];
      inputs.forEach((inp, i) => {
        inp.onfocus = () => inp.select();
        inp.oninput = () => {
          const k = inp.dataset.k, txt = inp.value.trim();
          if (txt === '' || txt === '-') { delete s.dim.typed[k]; inp.classList.remove('bad'); redraw(); return; }
          try { s.dim.typed[k] = app.evalExpr(txt); inp.classList.remove('bad'); } catch { inp.classList.add('bad'); }
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
  function updateDimbox() {
    const s = S();
    if (!dimbox || !s.pts?.length || !s.cursor) return;
    const lv = live(s.tool, s.pts, s.cursor);
    for (const inp of dimbox.querySelectorAll('input')) {
      const k = inp.dataset.k;
      const typed = s.dim.typed[k] != null;
      inp.classList.toggle('live', !typed);
      if (document.activeElement !== inp && !typed) inp.value = fmt(k === 'ang' ? lv.ang : lv[k]);
    }
    const sp = scr(s.cursor);
    dimbox.style.left = Math.min(sp.x + 22, view.clientWidth - 150) + 'px';
    dimbox.style.top = Math.min(sp.y + 22, view.clientHeight - 100) + 'px';
  }

  // ------------------------------------------------------------ commit / cancel
  function addShape(sh) {
    app.setShapes([...shapes(), sh]);
    app.renderPanel();
  }
  function resetDraw() { const s = S(); s.pts = null; s.dim = { typed: {} }; closeDimbox(); redraw(); }
  function cancelShape() { resetDraw(); }
  function commit(cursorOverride) {
    const s = S();
    if (!s.pts?.length) return;
    const cur = cursorOverride || s.cursor || s.pts[0];
    const typed = s.dim.typed;
    if (s.tool === 'line' || s.tool === 'path') {
      const end = segEnd(s.pts, cur, typed);
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(end[0] - last[0], end[1] - last[1]) < 1e-9) return;
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
    if (sh.t === 'path') { const i = +id.slice(1); return { ...sh, pts: sh.pts.map((p, k) => (k === i ? [u, v] : p)) }; }
    return sh;
  }
  const anchorOf = (sh) => (sh.t === 'rect' || sh.t === 'rrect' ? [sh.x, sh.y] : sh.t === 'slot' ? [sh.x1, sh.y1] : sh.t === 'path' ? sh.pts[0] : [sh.cx, sh.cy]);
  function translate(sh, du, dv) {
    if (sh.t === 'slot') return { ...sh, x1: sh.x1 + du, y1: sh.y1 + dv, x2: sh.x2 + du, y2: sh.y2 + dv };
    if (sh.t === 'rect' || sh.t === 'rrect') return { ...sh, x: sh.x + du, y: sh.y + dv };
    if (sh.t === 'path') return { ...sh, pts: sh.pts.map(([a, b]) => [a + du, b + dv]) };
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
    if (sh.t === 'slot') {
      const L = Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1);
      return [
        { id: 'len', val: L, at: [(sh.x1 + sh.x2) / 2, (sh.y1 + sh.y2) / 2], off: [0, -16], set: (v) => { const k = L > 1e-9 ? v / L : 1; return { ...sh, x2: sh.x1 + (sh.x2 - sh.x1) * k, y2: sh.y1 + (sh.y2 - sh.y1) * k }; }, prefix: 'L' },
        { id: 'w', val: sh.w, at: [(sh.x1 + sh.x2) / 2, (sh.y1 + sh.y2) / 2], off: [0, 16], set: (v) => ({ ...sh, w: v }), prefix: 'W' },
      ];
    }
    if (sh.t === 'ellipse') return [
      { id: 'a', val: sh.rx, at: [sh.cx + sh.rx / 2, sh.cy], off: [0, -14], set: (v) => ({ ...sh, rx: v }), prefix: 'A' },
      { id: 'b', val: sh.ry, at: [sh.cx, sh.cy + sh.ry / 2], off: [30, 0], set: (v) => ({ ...sh, ry: v }), prefix: 'B' },
    ];
    if (sh.t === 'rrect') return [
      { id: 'w', val: sh.w, at: [sh.x + sh.w / 2, sh.y + sh.h], off: [0, -16], set: (v) => ({ ...sh, w: v, r: Math.min(sh.r, v / 2) }) },
      { id: 'h', val: sh.h, at: [sh.x + sh.w, sh.y + sh.h / 2], off: [30, 0], set: (v) => ({ ...sh, h: v, r: Math.min(sh.r, v / 2) }) },
      { id: 'r', val: sh.r, at: [sh.x + sh.w - sh.r, sh.y + sh.h - sh.r], off: [-26, 16], set: (v) => ({ ...sh, r: Math.min(v, sh.w / 2, sh.h / 2) }), prefix: 'R' },
    ];
    if (sh.t === 'rect') {
      return [
        { id: 'w', val: sh.w, at: [sh.x + sh.w / 2, sh.y + sh.h], off: [0, -16], set: (v) => ({ ...sh, w: v }) },
        { id: 'h', val: sh.h, at: [sh.x + sh.w, sh.y + sh.h / 2], off: [30, 0], set: (v) => ({ ...sh, h: v }) },
      ];
    }
    if (sh.t === 'circle') return [{ id: 'd', val: sh.r * 2, at: [sh.cx + sh.r, sh.cy], off: [32, 0], set: (v) => ({ ...sh, r: v / 2 }), prefix: 'Ø' }];
    if (sh.t === 'ngon') return [{ id: 'r', val: sh.r, at: [sh.cx + sh.r / 2 * Math.cos(sh.rot * D2R), sh.cy + sh.r / 2 * Math.sin(sh.rot * D2R)], off: [0, -14], set: (v) => ({ ...sh, r: v }), prefix: 'R' }];
    if (sh.t === 'path') {
      const out = [];
      const n = sh.open ? sh.pts.length - 1 : sh.pts.length;
      for (let i = 0; i < n; i++) {
        const a = sh.pts[i], b = sh.pts[(i + 1) % sh.pts.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        out.push({ id: 's' + i, val: len, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], off: [0, -14], set: (v) => {
          const k = len > 1e-9 ? v / len : 1;
          const j = (i + 1) % sh.pts.length;
          return { ...sh, pts: sh.pts.map((p, q) => (q === j ? [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] : p)) };
        } });
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
          let v;
          try { v = app.evalExpr(inp.value.trim()); } catch { inp.classList.add('bad'); return; }
          if (!(v > 0)) { inp.classList.add('bad'); return; }
          inp.classList.remove('bad');
          const cur = shapes()[S().sel];
          const spec = labelSpecs(cur).find((x) => x.id === sp.id);
          if (spec) app.setShapes(shapes().map((o, i) => (i === S().sel ? spec.set(v) : o)));
        };
        return { id: sp.id, el, inp };
      });
      labels.key = key;
    }
    for (const l of labels) {
      const spec = specs.find((x) => x.id === l.id);
      if (!spec) continue;
      if (document.activeElement !== l.inp) l.inp.value = fmt(spec.val);
      const sp = scr(spec.at);
      l.el.style.left = sp.x + spec.off[0] + 'px';
      l.el.style.top = sp.y + spec.off[1] + 'px';
    }
  }

  // ------------------------------------------------------------ pointer routing
  function status(info, pt) {
    const el = document.getElementById('statusbar');
    el.textContent = `${info?.kind ? info.kind + ' · ' : ''}u ${pt[0].toFixed(2)}  v ${pt[1].toFixed(2)} mm`;
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
      if (s.tool === 'line' && s.pts.length >= 3 && Math.hypot(first[0] - sn.pt[0], first[1] - sn.pt[1]) < 1e-6) { finishPath(); return; }
      commit(sn.pt);
      return;
    }
    if (!s.pts) { s.pts = [sn.pt]; s.dim = { typed: {} }; openDimbox(); redraw(); return; }
    commit(sn.pt);
  }
  function dblclick() { const s = S(); if (s && (s.tool === 'line' || s.tool === 'path') && s.pts) { s.pts.pop(); finishPath(); } }

  // ------------------------------------------------------------ keyboard
  function key(e) {
    const s = S();
    if (!s || s.picking) return false;
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
    const st = stepNow();
    if (s.gridStep !== st) { s.gridStep = st; app.rebuildGrid(st); }
  }
  function activate() {
    const s = S();
    s.pts = null; s.dim = { typed: {} }; s.hover = -1; s.cursor = null;
    drag = null; lastInfer = null;
    closeDimbox(); clearLabels(); redraw();
    canvas.style.cursor = '';
  }
  function deactivate() { closeDimbox(); clearLabels(); drag = null; lastInfer = null; canvas.style.cursor = ''; vp.overlay.clear(); }

  return { pointer, key, dblclick, finishPath, cancelShape, activate, deactivate, frame, redraw, stepNow, refreshLabels: () => { clearLabels(); } };
}
