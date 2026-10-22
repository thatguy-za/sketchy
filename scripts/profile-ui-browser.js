// Browser-side timings for docs/PERFORMANCE.md. Run in the page of a signed-in session on a built or dev server, with a new empty design
// open (it replaces that design's features, nothing is saved). With the browser tool: javascript_tool with this file's text; by hand: paste
// it into the console. It returns an object of milliseconds and frame rates. `await window.__profileUI()` after pasting, or evaluate the
// file as an expression. Uses window.__sketchy (main.js) and the performance marks sketchy-boot, -kernel, -shell, -first-result.
window.__profileUI = async function profileUI() {
  const s = window.__sketchy, out = {}, round = (v) => Math.round(v * 10) / 10;
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // ---- start-up (the page was loaded before this ran)
  const marks = Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, round(e.startTime)]));
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, round(e.startTime)]));
  out.startup = { marks, paint };
  // ---- designs
  const prim = (id, shape, params) => ({ id, type: 'primitive', name: id, params: { shape, pos: [0, 0, 0], op: 'new', ...params } });
  const design = () => {
    const f = [prim('base', 'box', { sx: 200, sy: 120, sz: 20, radius: 0 })];
    for (let i = 0; i < 12; i++) f.push({ id: 'h' + i, type: 'hole', name: 'Hole' + i, params: { target: 'base', pos: [-80 + (i % 6) * 32, -30 + Math.floor(i / 6) * 60, 20], dir: [0, 0, 1], kind: i % 3 === 0 ? 'counterbore' : 'simple', diameter: 8, cbDia: 14, cbDepth: 4, through: true, depth: 8 } });
    for (let i = 0; i < 12; i++) {
      f.push({ id: 's' + i, type: 'sketch', name: 'Sketch' + i, params: { plane: 'XY', offset: 20, shapes: [{ t: 'rrect', x: -90 + i * 14, y: -10, w: 10, h: 20, r: 2 }] } });
      f.push({ id: 'e' + i, type: 'extrude', name: 'Extrude' + i, params: { sketch: 's' + i, profiles: null, extent: 'distance', distance: 6, op: 'join', target: 'base', thin: false, wall: 1, wallSide: 'inside', flip: false, symmetric: false, taper: 0, twist: 0, scaleTop: 1 } });
    }
    f.push(prim('cy', 'cylinder', { pos: [0, 0, 20], radius: 10, height: 15 }));
    f.push({ id: 'hh', type: 'hole', name: 'Last', params: { target: 'base', pos: [0, 0, 20], dir: [0, 0, 1], kind: 'simple', diameter: 5, through: false, depth: 6 } });
    return f;
  };
  // wait until the app has applied a new result; resolves with the milliseconds since `t0`
  const applied = (t0, timeout = 60000) => new Promise((res) => { const r0 = s.result; const tick = () => { if (s.result !== r0 && !s.kernelState().busy) res(performance.now() - t0); else if (performance.now() - t0 > timeout) res(-1); else setTimeout(tick, 1); }; tick(); });
  const setFeatures = async (feats) => { const t0 = performance.now(); s.doc.features = feats; s.doc.marker = feats.length; s.doc.nextId = 1000; s.refresh(); return applied(t0); };
  const edit = async (id, key, delta) => { const f = s.doc.features.find((x) => x.id === id); f.params = { ...f.params, [key]: f.params[key] + delta }; const t0 = performance.now(); s.refresh(); return applied(t0); };
  out.rebuild = {};
  out.rebuild.openDesign41 = round(await setFeatures(design()));
  for (const [label, id, key] of [['dimension of the first feature', 'base', 'sx'], ['dimension of a middle feature', 'h5', 'diameter'], ['dimension of the last feature', 'hh', 'diameter']]) {
    const t = []; for (let i = 0; i < 3; i++) t.push(await edit(id, key, i % 2 ? -1 : 1));
    out.rebuild[label] = round(med(t));
  }
  { const t0 = performance.now(); s.doc.features.push({ id: 'zz', type: 'hole', name: 'New', params: { target: 'base', pos: [10, 10, 20], dir: [0, 0, 1], kind: 'simple', diameter: 4, through: false, depth: 4 } }); s.doc.marker = s.doc.features.length; s.refresh(); out.rebuild['add a hole'] = round(await applied(t0)); }
  out.kernel = s.kernelState();
  // ---- a drag: a new value every animation frame for 30 frames, the way a manipulator or a slider sends them
  { const f = s.doc.features.find((x) => x.id === 'hh'), t0 = performance.now(); let sent = 0, shown = 0, last = s.result;
    for (let i = 0; i < 30; i++) { f.params = { ...f.params, diameter: 5 + (i % 5) * 0.2 }; s.refresh(); sent++; await raf(); if (s.result !== last) { shown++; last = s.result; } }
    const dragMs = performance.now() - t0, t1 = performance.now();
    f.params = { ...f.params, diameter: 6.5 }; s.refresh();
    const lag = await applied(t1);
    out.drag = { valuesSent: sent, resultsShownWhileDragging: shown, valuesPerSecond: round(sent / (dragMs / 1000)), msFromLastValueToLastResult: round(lag) };
  }
  // ---- frame rate of orbiting
  const orbit = async (label, frames = 90) => {
    const vp = s.vp, cam = vp.camera, tg = vp.controls.target; const times = [];
    vp.setMoving?.(true);
    let prev = await raf();
    for (let i = 0; i < frames; i++) {
      const off = cam.position.clone().sub(tg), a = 0.03, c = Math.cos(a), sn = Math.sin(a);
      cam.position.set(tg.x + off.x * c - off.y * sn, tg.y + off.x * sn + off.y * c, tg.z + off.z); vp.controls.update();
      const now = await raf(); times.push(now - prev); prev = now;
    }
    vp.setMoving?.(false);
    const total = times.reduce((a, b) => a + b, 0);
    out.orbit ||= {}; out.orbit[label] = { fps: round(1000 / (total / times.length)), medianFrameMs: round(med(times)), worstFrameMs: round(Math.max(...times)) };
  };
  await orbit('41-feature design');
  // ---- a big model: 150 spheres (about 300,000 triangles)
  { const f = []; for (let i = 0; i < 150; i++) f.push(prim('b' + i, 'sphere', { radius: 8, pos: [(i % 15) * 20, Math.floor(i / 15) * 20, 0] }));
    out.rebuild.build150Spheres = round(await setFeatures(f));
    out.triangles = s.result.bodies.reduce((a, b) => a + b.tris.length / 3, 0);
    await sleep(300); await orbit('150 spheres'); }
  return out;
};
