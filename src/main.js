import './style.css';
import * as THREE from 'three';
import { icon } from './icons.js';
import { initKernel, rebuild, shapeToPolygon, PLANES, encodeFloats } from './kernel.js';
import { FEATURES, defOf } from './features.js';
import { parseSTL, writeSTL } from './stl.js';
import { Viewport } from './viewport.js';
import { findEdgeChains, matchChain, roundPts } from './edges.js';
import { acct, call, refreshAccount, requireLogin, showAuth, showDesigns, signOut, setAccountMenuHandler, modal } from './account.js';
import { evalExpr, resolveParams, resolveFeature, isPlainNumber, NAME_RE, RESERVED } from './params.js';
import { findEdgeChains as chainsOf } from './edges.js';
import { ficon, uicon } from './ficons.js';
import { CMD, WORKSPACE_TABS, TOOLBAR, SKETCH_TOOLBAR, WORKSPACES } from './commands.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PRINTERS = {
  'Bambu Lab X1 / P1 (256³)': [256, 256, 256], 'Prusa MK4 (250×210×220)': [250, 210, 220], 'Prusa MINI (180³)': [180, 180, 180],
  'Creality Ender-3 (220×220×250)': [220, 220, 250], 'Voron 2.4 (350³)': [350, 350, 350],
};

// ------------------------------------------------------------------ state
const blankDoc = () => ({ name: 'Untitled', features: [], marker: 0, nextId: 1, params: [] });
let doc = blankDoc();
let undoStack = [], redoStack = [];
let result = { bodies: [], errors: {}, snaps: [], sketchUsed: new Set() };
let dirty = false;
let tab = 'SOLID';
let selFeature = null;           // timeline selection
let paramState = { values: {}, errors: {} };
let resolvedMap = {};
let measure = null;
let navMode = 'orbit';
let originVis = false;
let dataOpen = false;
let lastCmd = null;
let playTimer = null;
let dialog = null;               // {index, isNew, pre, mode}
let sketch = null;               // active sketch session
const hiddenBodies = new Set();
const sketchVis = {};
const collapsed = { views: true, origin: true };
let bedName = localStorage.getItem('sketchy.bed') || Object.keys(PRINTERS)[0];

let vp;
const snapshot = () => ({ features: [...doc.features], marker: doc.marker, nextId: doc.nextId, params: [...(doc.params || [])] });
const restore = (s) => { doc.features = [...s.features]; doc.marker = s.marker; doc.nextId = s.nextId; doc.params = [...(s.params || [])]; };
function pushUndo(s) { undoStack.push(s); if (undoStack.length > 100) undoStack.shift(); redoStack = []; markDirty(); }
function markDirty() { dirty = true; $('#doc-dirty').classList.add('on'); scheduleAutosave(); }
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'error' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2500);
}
const uniqueName = (base) => {
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(base + n)) n++;
  return base + n;
};
const featureIndex = (id) => doc.features.findIndex((f) => f.id === id);
const sketchesBefore = (i) => doc.features.slice(0, i).filter((f) => f.type === 'sketch');
const limit = () => (sketch ? sketch.index : doc.marker);

// ------------------------------------------------------------------ rebuild / refresh
let pending = false;
function refresh() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; refreshNow(); }); } }
function refreshNow() {
  const pickF = dialog && defOf(doc.features[dialog.index])?.pickEdges;
  paramState = resolveParams(doc.params || []);
  const evalErr = {};
  const feats = doc.features.map((f) => {
    const r = resolveFeature(f, (n) => paramState.values[n]);
    if (r.error) evalErr[f.id] = r.error;
    return r.params === f.params ? f : { ...f, params: r.params };
  });
  resolvedMap = Object.fromEntries(feats.map((f) => [f.id, f.params]));
  try { result = rebuild(feats, limit(), { capture: pickF ? dialog.index : -1 }); }
  catch (e) { console.error(e); toast('Kernel error: ' + e.message, true); return; }
  for (const [id, m] of Object.entries(evalErr)) result.errors[id] ||= m;
  vp.setBodies(result.bodies.filter((b) => !hiddenBodies.has(b.id)));
  for (const id of [...vp.selected]) if (!result.bodies.some((b) => b.id === id)) vp.selected.delete(id);
  vp.refreshMaterials();
  drawSketches();
  updatePickEdges();
  if (dialog) updateFaceHL();
  renderTree(); renderTimeline(); renderRibbon(); renderStatus();
  $('#btn-undo').disabled = !undoStack.length || !!dialog || !!sketch;
  $('#btn-redo').disabled = !redoStack.length || !!dialog || !!sketch;
  if (dialog) renderDialogErrors();
}

function updatePickEdges() {
  const f = dialog && doc.features[dialog.index];
  if (!f || !defOf(f)?.pickEdges || !result.captured) return vp.setPickEdges([]);
  const entries = [];
  for (const b of result.captured) {
    if (hiddenBodies.has(b.id)) continue;
    for (const chain of findEdgeChains(b.verts, 3, b.tris)) {
      entries.push({ body: b.id, chain, selected: f.params.edges.some((e) => e.body === b.id && matchChain([chain], e.pts)) });
    }
  }
  vp.setPickEdges(entries);
}
function toggleEdge(entry) {
  const f = doc.features[dialog.index];
  const pts = roundPts(entry.chain.pts);
  const has = f.params.edges.some((e) => e.body === entry.body && matchChain([entry.chain], e.pts));
  const edges = has ? f.params.edges.filter((e) => !(e.body === entry.body && matchChain([entry.chain], e.pts))) : [...f.params.edges, { body: entry.body, pts }];
  updateParam(dialog.index, 'edges', edges);
  renderDialog();
}

function renderStatus() {
  const n = result.bodies.length;
  const tris = result.bodies.reduce((a, b) => a + b.tris.length / 3, 0);
  $('#statusbar').textContent = `${n} ${n === 1 ? 'body' : 'bodies'} · ${tris.toLocaleString()} triangles · mm`;
}

// ------------------------------------------------------------------ toolbar (Fusion-style)
CMD.cancelpick = { label: 'Cancel', icon: 'remove' };
const MEASURE_MODE = { measure: 'dist', angle: 'angle', edgelen: 'edge', faces: 'faces' };
const CUSTOM = {
  parameters: () => openParameters(),
  importstl: () => $('#file-stl').click(),
  measure: () => startMeasure('dist'), angle: () => startMeasure('angle'), edgelen: () => startMeasure('edge'), faces: () => startMeasure('faces'),
  properties: () => showInfo(),
  print3d: () => exportSTL(false), print3dsel: () => exportSTL(true),
  printer: () => printerMenu($('#ribbon')),
  buildvol: () => { vp.opts.bed = !vp.opts.bed; vp.refreshMaterials(); renderRibbon(); },
  select: () => {}, finishsketch: () => finishSketch(), cancelpick: () => cancelSketch(),
};
function runCommand(id, ev) {
  const c = CMD[id];
  if (!c) return;
  if (c.off) return toast(`${c.label} isn't available in Sketchy yet.`);
  if (c.sk) { if (sketch && !sketch.picking) setSketchTool(c.sk); return; }
  if (c.skAction === 'delete') return sketchDeleteSelected();
  if (sketch && !['select', 'finishsketch', 'cancelpick'].includes(id)) return toast('Finish the sketch first.');
  if (id === 'remove') { lastCmd = id; return deleteSelection(); }
  if (c.feature) { lastCmd = id; return startFeature(c.feature); }
  CUSTOM[id]?.(ev);
  if (!['select', 'finishsketch', 'cancelpick'].includes(id)) lastCmd = id;
}
function deleteSelection() {
  if (!vp.selected.size) return startFeature('remove');
  const pre = snapshot();
  for (const id of vp.selected) { doc.features.splice(doc.marker, 0, { id: 'f' + doc.nextId++, type: 'remove', name: uniqueName('Remove'), params: { body: id } }); doc.marker++; }
  vp.selected.clear(); pushUndo(pre); refresh();
}
const menuItems = (ids) => ids.map((id) => (id === '|' ? { sep: true } : { label: CMD[id].label, ficon: CMD[id].icon, hint: CMD[id].key, dim: !!CMD[id].off, run: () => runCommand(id) }));

function workspaceMenu() {
  const r = $('#btn-workspace').getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, WORKSPACES.map((w) => ({ label: w, check: w === 'DESIGN', dim: w !== 'DESIGN', run: () => w !== 'DESIGN' && toast(`${w} isn't available in Sketchy.`) })));
}

function renderRibbon() {
  const wb = $('#btn-workspace');
  wb.innerHTML = `<span>DESIGN</span>${uicon('caret', 9, 0)}`;
  wb.onclick = workspaceMenu; wb.dataset.menu = 1;
  const picking = !!sketch?.picking, inSketch = !!sketch && !picking;
  const tabList = sketch ? ['SKETCH'] : WORKSPACE_TABS;
  const tabsEl = $('#tabs');
  tabsEl.innerHTML = tabList.map((t) => `<button class="tab ${t === (sketch ? 'SKETCH' : tab) ? 'active' : ''} ${t === 'SKETCH' ? 'sketch-tab' : ''}" data-t="${t}">${t}</button>`).join('');
  tabsEl.querySelectorAll('.tab').forEach((b) => (b.onclick = () => { if (!sketch) { tab = b.dataset.t; renderRibbon(); } }));
  const groups = picking ? [{ label: 'CREATE SKETCH', show: ['cancelpick'], menu: [] }] : inSketch ? SKETCH_TOOLBAR : TOOLBAR[tab] || [];
  const host = $('#ribbon');
  host.innerHTML = '';
  let placedRight = false;
  for (const g of groups) {
    const el = document.createElement('div');
    el.className = 'group';
    if (g.right && !placedRight) { el.classList.add('right'); placedRight = true; }
    el.innerHTML = '<div class="group-items"></div><div class="group-label"></div>';
    for (const id of g.show) {
      const c = CMD[id];
      const b = document.createElement('button');
      const off = c.off || g.allOff;
      const active = (c.sk && sketch?.tool === c.sk) || (MEASURE_MODE[id] && measure?.mode === MEASURE_MODE[id]) || (id === 'buildvol' && vp.opts.bed);
      b.className = 'fbtn' + (off ? ' off' : '') + (active ? ' active' : '') + (g.big ? ' sel-big' : '') + (g.finish ? ' finish' : '');
      b.title = `${c.label}${c.key ? ` (${c.key})` : ''}`;
      b.innerHTML = ficon(c.icon, g.big ? 40 : 30) + (g.finish ? '<span>FINISH SKETCH</span>' : '');
      b.disabled = !!dialog && !sketch;
      b.onclick = (ev) => runCommand(id, ev);
      el.firstChild.appendChild(b);
    }
    const lab = el.lastChild;
    lab.innerHTML = g.finish ? '&nbsp;' : g.label + (g.menu.length ? uicon('caret', 7, 0) : '');
    if (g.menu.length) {
      lab.dataset.menu = 1;
      lab.onclick = () => { if (dialog && !sketch) return; const r = lab.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, menuItems(g.menu)); };
    } else lab.style.cursor = 'default';
    host.appendChild(el);
  }
}

// ------------------------------------------------------------------ browser tree
function renderTree() {
  const rows = [];
  const R = (d, label, o = {}) => rows.push({ d, label, ...o });
  const open = (k) => !collapsed[k];
  const folder = (d, key, label, kind, o, kids) => { R(d, label, { key, kind, twist: true, ...o }); if (open(key)) kids(); };
  const visBodies = result.bodies.filter((b) => !hiddenBodies.has(b.id)).length;
  R(0, doc.name === 'Untitled' ? '(Unsaved)' : doc.name, { key: 'root', kind: 'comp', twist: true, root: true, eye: result.bodies.length ? visBodies > 0 : true,
    onEye: () => { const hide = visBodies > 0; result.bodies.forEach((b) => (hide ? hiddenBodies.add(b.id) : hiddenBodies.delete(b.id))); refresh(); } });
  if (open('root')) {
    folder(1, 'docset', 'Document Settings', 'gear', {}, () => { R(2, 'Units: mm, g', { kind: 'file', dim: true }); R(2, 'Part Design', { kind: 'body', dim: true }); });
    folder(1, 'views', 'Named Views', 'folder', {}, () => R(2, 'Home', { kind: 'camera', click: () => vp.home() }));
    folder(1, 'origin', 'Origin', 'folder', { eye: originVis, onEye: () => { originVis = !originVis; vp.setOriginVisible(originVis); renderTree(); } }, () => {
      for (const n of ['XY', 'XZ', 'YZ']) R(2, n, { kind: 'plane', dim: true });
      for (const n of ['X', 'Y', 'Z']) R(2, n, { kind: 'axis', dim: true });
      R(2, 'Origin', { kind: 'point', dim: true });
    });
    if ((doc.params || []).length) folder(1, 'params', 'Parameters', 'gear', {}, () => doc.params.forEach((p) => R(2, p.name, { kind: 'file', val: paramState.errors[p.name] ? '⚠' : `= ${+paramState.values[p.name]?.toFixed(4)}`, click: openParameters })));
    if (result.bodies.length) {
      const anyVis = visBodies > 0;
      folder(1, 'bodies', 'Bodies', 'folder', { eye: anyVis, onEye: () => { result.bodies.forEach((b) => (anyVis ? hiddenBodies.add(b.id) : hiddenBodies.delete(b.id))); refresh(); } }, () => result.bodies.forEach((b) => {
        R(2, b.name, { kind: 'body', eye: !hiddenBodies.has(b.id), sel: vp.selected.has(b.id), onEye: () => { hiddenBodies.has(b.id) ? hiddenBodies.delete(b.id) : hiddenBodies.add(b.id); refresh(); }, click: (ev) => selectBody(b.id, ev.shiftKey) });
      }));
    }
    const sk = doc.features.map((f, i) => [f, i]).filter(([f, i]) => f.type === 'sketch' && i < limit() + (sketch ? 1 : 0));
    if (sk.length) {
      const visOf = (f) => sketchVis[f.id] ?? !result.sketchUsed.has(f.id);
      folder(1, 'sketches', 'Sketches', 'folder', { eye: sk.some(([f]) => visOf(f)), onEye: () => { const v = !sk.some(([f]) => visOf(f)); sk.forEach(([f]) => (sketchVis[f.id] = v)); drawSketches(); renderTree(); } }, () => sk.forEach(([f]) => {
        R(2, f.name, { kind: 'sketch', eye: visOf(f), sel: selFeature === f.id, onEye: () => { sketchVis[f.id] = !visOf(f); drawSketches(); renderTree(); }, click: () => selectFeature(f.id), dbl: () => editFeature(featureIndex(f.id)) });
      }));
    }
    const joints = doc.features.filter((f, i) => f.type === 'joint' && i < limit());
    if (joints.length) folder(1, 'joints', 'Joints', 'folder', {}, () => joints.forEach((f) => R(2, f.name, { kind: 'link', sel: selFeature === f.id, click: () => selectFeature(f.id), dbl: () => editFeature(featureIndex(f.id)) })));
  }
  const KIND = { comp: 'comp', gear: 'gear', folder: 'folder', file: 'file', body: 'body', sketch: 'sketchi', plane: 'plane', axis: 'axis', point: 'point', link: 'link', camera: 'camera' };
  const host = $('#tree');
  host.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'tree-row' + (r.root ? ' root' : '') + (r.sel ? ' sel' : '') + (r.dim ? ' dim' : '');
    el.style.setProperty('--d', r.d);
    el.innerHTML = `<span class="tw ${r.twist && open(r.key) ? 'open' : ''}">${r.twist ? uicon('chevR', 11, 2) : ''}</span>`
      + `<span class="eyeb ${r.eye === false ? 'off' : ''}">${r.eye !== undefined ? uicon(r.eye ? 'eye' : 'eyeOff', 15, 1.5) : ''}</span>`
      + `<span class="kind">${r.kind ? uicon(KIND[r.kind], 16, 1.4) : ''}</span><span class="lbl">${esc(r.label)}</span>` + (r.val ? `<span class="val">${esc(r.val)}</span>` : '');
    if (r.twist) el.onclick = () => { collapsed[r.key] = open(r.key); renderTree(); };
    else if (r.click) el.onclick = r.click;
    if (r.dbl) el.ondblclick = r.dbl;
    if (r.onEye) el.querySelector('.eyeb').onclick = (e) => { e.stopPropagation(); r.onEye(); };
    host.appendChild(el);
  }
}

// ------------------------------------------------------------------ timeline
function fiName(f) {
  const d = defOf(f);
  let n = d?.icon || f.type;
  if (n === 'import') n = 'importstl';
  return n;
}
function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; } }
function renderTimeline() {
  const host = $('#timeline');
  host.innerHTML = '';
  const shownMarker = sketch ? sketch.index : doc.marker;
  const mk = () => {
    const m = document.createElement('div');
    m.className = 'tl-marker'; m.title = 'Drag to roll back the timeline';
    m.onpointerdown = (e) => {
      if (sketch || dialog) return;
      stopPlay();
      m.setPointerCapture(e.pointerId);
      m.onpointermove = (ev) => {
        const items = [...host.querySelectorAll('.tl-item')];
        let pos = 0;
        items.forEach((it, i) => { const r = it.getBoundingClientRect(); if (ev.clientX > r.left + r.width / 2) pos = i + 1; });
        if (pos !== doc.marker) { doc.marker = pos; refresh(); }
      };
      m.onpointerup = () => { m.onpointermove = null; };
    };
    return m;
  };
  if (!doc.features.length) host.innerHTML = '<span class="tl-empty">Every operation you perform appears here. Drag the marker to roll back; double-click an item to edit.</span>';
  doc.features.forEach((f, i) => {
    if (i === shownMarker && !sketch) host.appendChild(mk());
    const el = document.createElement('div');
    el.className = 'tl-item' + (i >= shownMarker ? ' off' : '') + (result.errors[f.id] ? ' err' : '') + (selFeature === f.id ? ' sel' : '') + (f.suppressed ? ' supp' : '');
    el.title = f.name + (result.errors[f.id] ? ` — ${result.errors[f.id]}` : '');
    el.innerHTML = ficon(fiName(f), 24);
    el.onclick = () => selectFeature(f.id);
    el.ondblclick = () => editFeature(i);
    el.oncontextmenu = (e) => { e.preventDefault(); featureMenu(e, i); };
    host.appendChild(el);
  });
  if (shownMarker >= doc.features.length && doc.features.length && !sketch) host.appendChild(mk());
  else if (!doc.features.length) host.insertAdjacentElement('afterbegin', mk());
  host.scrollLeft = host.scrollWidth;
  const c = $('#tl-controls');
  if (!c.dataset.ready) {
    c.dataset.ready = 1;
    const btn = (ic, title, fn) => { const b = document.createElement('button'); b.title = title; b.innerHTML = uicon(ic, 15, 0); b.onclick = () => { if (sketch || dialog) return; fn(); refresh(); }; c.appendChild(b); };
    btn('first', 'Go to beginning', () => { stopPlay(); doc.marker = 0; });
    btn('prev', 'Previous', () => { stopPlay(); doc.marker = Math.max(0, doc.marker - 1); });
    btn('play', 'Play', () => {
      stopPlay();
      if (doc.marker >= doc.features.length) doc.marker = 0;
      playTimer = setInterval(() => { if (doc.marker >= doc.features.length) return stopPlay(); doc.marker++; refresh(); }, 450);
    });
    btn('next', 'Next', () => { stopPlay(); doc.marker = Math.min(doc.features.length, doc.marker + 1); });
    btn('last', 'Go to end', () => { stopPlay(); doc.marker = doc.features.length; });
  }
}

function selectFeature(id) { selFeature = id; renderTimeline(); renderTree(); }
function featureMenu(ev, i) {
  const f = doc.features[i];
  showMenu(ev.clientX, ev.clientY, [
    { label: 'Edit Feature', run: () => editFeature(i) },
    { label: 'Roll Back Here', run: () => { doc.marker = i + 1; refresh(); } },
    { label: f.suppressed ? 'Unsuppress' : 'Suppress', run: () => mutate(() => { doc.features[i] = { ...f, suppressed: !f.suppressed }; }) },
    { sep: true },
    { label: 'Delete', run: () => mutate(() => { doc.features.splice(i, 1); if (doc.marker > i) doc.marker--; }) },
  ]);
}
function mutate(fn) { pushUndo(snapshot()); fn(); refresh(); }

// ------------------------------------------------------------------ menus
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
    if (it.head) { m.insertAdjacentHTML('beforeend', `<div class="mh">${esc(it.head)}</div>`); continue; }
    const e = document.createElement('div');
    e.className = 'mi' + (it.disabled ? ' disabled' : '') + (it.check !== undefined ? ' check' + (it.check ? ' on' : '') : '');
    if (it.dim) e.style.opacity = '.55';
    const ic = it.ficon ? ficon(it.ficon, 22) : it.uicon ? uicon(it.uicon, 16) : it.icon ? icon(it.icon, 16) : it.check === undefined ? '<span class="ph"></span>' : '';
    e.innerHTML = ic + `<span>${esc(it.label)}</span>` + (it.hint ? `<small>${it.hint}</small>` : '');
    e.onclick = () => { m.hidden = true; it.run(); };
    m.appendChild(e);
  }
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 10)) + 'px';
}
addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('[data-menu]')) $('#menu').hidden = true; }, true);

function printerMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    ...Object.keys(PRINTERS).map((n) => ({ label: n, check: n === bedName, run: () => setBed(n, PRINTERS[n]) })),
    { sep: true },
    { label: 'Custom…', run: () => { const s = prompt('Build volume X,Y,Z in mm', '200,200,200'); const v = s?.split(',').map(Number); if (v?.length === 3 && v.every((n) => n > 0)) setBed('Custom', v); } },
  ]);
}
function setBed(name, size) { bedName = name; localStorage.setItem('sketchy.bed', name); vp.opts.bedSize = size; vp.opts.bed = true; vp.buildBed(); vp.refreshMaterials(); renderRibbon(); toast(`Build volume: ${name}`); }

function fileMenu() {
  const r = $('#btn-menu').getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [
    { label: 'New Design', uicon: 'newdoc', hint: 'Ctrl+N', run: newDoc },
    { label: 'Open…', uicon: 'folder', run: () => toggleDataPanel(true) },
    { label: 'Open from my computer…', uicon: 'upload', run: () => $('#file-proj').click() },
    { sep: true },
    { label: acct.server ? 'Save' : 'Save (download)', uicon: 'save', hint: 'Ctrl+S', run: () => save(false) },
    { label: 'Save As…', uicon: 'save', run: () => save(true) },
    { label: 'Export project file', uicon: 'upload', run: downloadProject },
    { sep: true },
    { label: 'Insert Mesh (STL)…', ficon: 'insertmesh', run: () => $('#file-stl').click() },
    { label: 'Export STL (visible bodies)', ficon: 'threed', run: () => exportSTL(false) },
    { label: 'Export STL (selected)', ficon: 'threed', disabled: !vp.selected.size, run: () => exportSTL(true) },
  ]);
}

// ------------------------------------------------------------------ selection
function selectBody(id, additive = false) {
  if (!additive) vp.selected.clear();
  if (id) (additive && vp.selected.has(id) ? vp.selected.delete(id) : vp.selected.add(id));
  vp.refreshMaterials(); renderTree(); renderRibbon();
}

// ------------------------------------------------------------------ features: create / edit
const ctx = () => {
  const sks = sketchesBefore(doc.marker);
  const sel = [...vp.selected][0] || result.bodies[0]?.id || '';
  const selB = result.bodies.find((b) => b.id === sel) || result.bodies[0];
  const otherB = result.bodies.find((b) => b.id !== selB?.id);
  const ctr = (b) => (b ? b.bbox.min.map((v, k) => +((v + b.bbox.max[k]) / 2).toFixed(3)) : [0, 0, 0]);
  return {
    lastSketch: sks.length ? sks[sks.length - 1].id : '',
    sketches: sks.map((k) => k.id),
    pathSketch: [...sks].reverse().find((k) => k.params.shapes.some((sh) => sh.open))?.id || '',
    lastSketchOnFace: sks.length > 0 && sks[sks.length - 1].params.plane === 'custom',
    hasBodies: result.bodies.length > 0,
    selected: sel,
    other: otherB?.id || '',
    topCenter: selB ? [ctr(selB)[0], ctr(selB)[1], selB.bbox.max[2]] : [0, 0, 0],
    selectedCenterZ: selB ? ctr(selB)[2] : 0,
    centerA: ctr(selB), centerB: ctr(otherB),
  };
};

function startFeature(key) {
  if (dialog || sketch) return;
  endMeasure();
  const def = FEATURES[key];
  if (key === 'sketch') return startSketchPlanePick();
  const c = ctx();
  if (['extrude', 'revolve', 'rib'].includes(key) && !c.lastSketch) return toast('Create a sketch first.', true);
  if (['sweep', 'loft'].includes(key) && c.sketches.length < 2) return toast(`${def.label} needs two sketches (a profile and ${key === 'sweep' ? 'a path' : 'a second profile'}).`, true);
  if (['move', 'combine', 'mirror', 'pattern', 'remove', 'fillet', 'chamfer'].includes(key) || def.needsBody) { if (!result.bodies.length) return toast('There are no bodies yet — create one first.', true); }
  if (def.needsBodies && result.bodies.length < def.needsBodies) return toast(`${def.label} needs at least ${def.needsBodies} bodies.`, true);
  const pre = snapshot();
  const params = def.make(c);
  if (key === 'combine') params.tool = result.bodies.find((b) => b.id !== params.target)?.id || '';
  const type = def.type;
  const f = { id: 'f' + doc.nextId++, type, name: uniqueName(def.label.replace(/ \/.*/, '')), params };
  doc.features.splice(doc.marker, 0, f);
  doc.marker++;
  openDialog(featureIndex(f.id), true, pre);
}
function editFeature(i) {
  const f = doc.features[i];
  if (!f || dialog || sketch) return;
  if (f.type === 'sketch') return enterSketch(i, false);
  if (f.type === 'import') return toast('Imported meshes have no editable parameters.');
  openDialog(i, false, snapshot());
}

function updateParam(i, key, val) {
  const f = doc.features[i];
  doc.features[i] = { ...f, params: { ...f.params, [key]: val } };
  refresh();
}

function openDialog(index, isNew, pre) {
  dialog = { index, isNew, pre, mode: 'translate', pick: null, focusKey: null, hover: null };
  const ff = defOf(doc.features[index]).fields.find((x) => x.type === 'face' || x.type === 'faces');
  if (ff) dialog.pick = { kind: ff.type, key: ff.key };
  selFeature = doc.features[index].id;
  $('#props-wrap').classList.add('open');
  renderDialog();
  refresh();
  setupGizmo();
}

function bodiesBefore(i) { return result.snaps[i] || result.bodies; }

const resolvedAt = (f, path) => { const [k, i] = path.split('.'); const v = resolvedMap[f.id]?.[k]; return i === undefined ? v : v?.[+i]; };

/** Set a numeric field from text that may be a plain number or an expression over user parameters. */
function commitNumber(i, path, text, fld) {
  const f = doc.features[i];
  let val, expr = null;
  if (isPlainNumber(text)) {
    val = parseFloat(text);
    if (fld.min !== undefined) val = Math.max(fld.min, val);
    if (fld.max !== undefined) val = Math.min(fld.max, val);
  } else {
    try { val = evalExpr(text, (n) => paramState.values[n]); expr = text.trim(); }
    catch (e) { return { ok: false, err: e.message }; }
  }
  const [key, idx] = path.split('.');
  const params = { ...f.params };
  if (idx !== undefined) { const arr = [...params[key]]; arr[+idx] = val; params[key] = arr; } else params[key] = val;
  const exprs = { ...(f.exprs || {}) };
  if (expr) exprs[path] = expr; else delete exprs[path];
  doc.features[i] = { ...f, params, exprs: Object.keys(exprs).length ? exprs : undefined };
  refresh();
  return { ok: true, value: val, expr };
}
/** Replace several params at once (viewport picking, gizmo); drops expressions for those keys. */
function patchParams(i, patch) {
  const f = doc.features[i];
  const exprs = Object.fromEntries(Object.entries(f.exprs || {}).filter(([path]) => !(path.split('.')[0] in patch)));
  doc.features[i] = { ...f, params: { ...f.params, ...patch }, exprs: Object.keys(exprs).length ? exprs : undefined };
  refresh();
}

function renderDialog() {
  if (!dialog) return;
  const f = doc.features[dialog.index];
  const def = defOf(f);
  const wrap = $('#props-wrap');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon(fiName(f), 20)}${esc(f.name.toUpperCase())}</div><div class="body"></div>
    <div class="foot"><button class="btn" id="d-cancel">Cancel</button><button class="btn primary" id="d-ok">OK</button></div></div>`;
  const body = wrap.querySelector('.body');
  if (def.gizmo) {
    body.insertAdjacentHTML('beforeend', `<div class="row"><label>Gizmo</label><select id="d-mode"><option value="translate">Translate</option><option value="rotate">Rotate</option></select></div><div class="sep"></div>`);
    const s = body.querySelector('#d-mode'); s.value = dialog.mode;
    s.onchange = () => { dialog.mode = s.value; setupGizmo(); };
  }
  const idx = dialog.index;
  const rerender = () => { renderDialog(); setupGizmo(); };
  for (const fld of def.fields) {
    if (fld.show && !fld.show(f.params)) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${fld.label}</label><div class="ctl"></div>`;
    const ctl = row.querySelector('.ctl');
    const val = f.params[fld.key];
    const set = (v) => updateParam(idx, fld.key, v);
    const numIn = (path, v) => {
      const box = document.createElement('span');
      box.className = 'numwrap';
      const n = document.createElement('input');
      n.type = 'text'; n.inputMode = 'decimal'; n.className = 'num'; n.autocomplete = 'off'; n.spellcheck = false;
      const expr = f.exprs?.[path];
      n.value = expr ?? String(+(+v).toFixed(4));
      const calc = document.createElement('small');
      calc.className = 'calc';
      if (expr) { const rv = resolvedAt(f, path); calc.textContent = typeof rv === 'number' ? `= ${+rv.toFixed(4)}` : ''; }
      n.oninput = () => {
        const txt = n.value.trim();
        if (!txt) return;
        const r = commitNumber(idx, path, txt, fld);
        n.classList.toggle('bad', !r.ok);
        n.title = r.ok ? '' : r.err;
        calc.textContent = r.ok && r.expr ? `= ${+r.value.toFixed(4)}` : r.ok ? '' : r.err;
        if (r.ok && (fld.key === 'kind' || def.gizmo)) setupGizmo();
      };
      n.onkeydown = (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const cur = parseFloat(n.value);
        if (isNaN(cur) || !isPlainNumber(n.value)) return;
        e.preventDefault();
        n.value = String(+(cur + (e.key === 'ArrowUp' ? 1 : -1) * (fld.step ?? 1)).toFixed(4));
        n.oninput();
      };
      box.append(n, calc);
      return box;
    };
    const vec3 = () => {
      const g = document.createElement('div'); g.className = 'v3';
      [0, 1, 2].forEach((k) => g.appendChild(numIn(`${fld.key}.${k}`, val[k])));
      return g;
    };
    if (fld.type === 'edges') {
      ctl.innerHTML = `<span>${val.length} selected</span> <button class="btn" id="d-edgeclear" style="margin-left:8px">Clear</button><div style="color:var(--muted);font-size:11px;margin-top:4px">Click edges in the viewport to add or remove them.</div>`;
      ctl.querySelector('button').onclick = () => { set([]); renderDialog(); };
    } else if (fld.type === 'num') ctl.appendChild(numIn(fld.key, val));
    else if (fld.type === 'vec3') ctl.appendChild(vec3());
    else if (fld.type === 'point') {
      ctl.appendChild(vec3());
      const bar = document.createElement('div'); bar.className = 'pick-row';
      const pk = document.createElement('button');
      const active = dialog.pick?.kind === 'point' && dialog.pick.key === fld.key;
      pk.className = 'btn sm' + (active ? ' on' : ''); pk.textContent = active ? 'Click a body…' : 'Pick in viewport';
      pk.onclick = () => { dialog.pick = active ? null : { kind: 'point', key: fld.key, dirKey: fld.dirKey }; renderDialog(); };
      bar.appendChild(pk);
      if (fld.centerOf) {
        const cb = document.createElement('button'); cb.className = 'btn sm'; cb.textContent = 'Body centre';
        cb.onclick = () => {
          const b = bodiesBefore(idx).find((x) => x.id === f.params[fld.centerOf]);
          if (b) { patchParams(idx, { [fld.key]: b.bbox.min.map((v, k) => +((v + b.bbox.max[k]) / 2).toFixed(3)) }); renderDialog(); }
        };
        bar.appendChild(cb);
      }
      ctl.appendChild(bar);
    } else if (fld.type === 'face' || fld.type === 'faces') {
      const list = fld.type === 'face' ? (val ? [val] : []) : val || [];
      ctl.innerHTML = `<span>${list.length ? `${list.length} face${list.length > 1 ? 's' : ''} selected` : 'None selected'}</span> <button class="btn sm" style="margin-left:6px">Clear</button><div class="note">${fld.type === 'face' ? 'Click a flat face, then drag it in the viewport or type a distance.' : 'Click flat faces to open (optional). Click again to deselect.'}</div>`;
      ctl.querySelector('button').onclick = () => { patchParams(idx, { [fld.key]: fld.type === 'face' ? null : [] }); renderDialog(); };
    } else if (fld.type === 'bool') {
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!val; c.onchange = () => { set(c.checked); if (['thread', 'through', 'internal'].includes(fld.key)) rerender(); }; ctl.appendChild(c);
    } else if (fld.type === 'sketchlist') {
      const opts = sketchesBefore(idx);
      const list = [...(val || [])];
      const commit = (l) => { set(l); renderDialog(); };
      list.forEach((id, k) => {
        const line = document.createElement('div'); line.style.cssText = 'display:flex;gap:4px;margin-bottom:3px';
        const s = document.createElement('select'); s.style.flex = 1;
        s.innerHTML = `<option value="">Select sketch…</option>` + opts.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
        s.value = id; s.onchange = () => commit(list.map((x, j) => (j === k ? s.value : x)));
        line.appendChild(s);
        if (list.length > 2) { const x = document.createElement('button'); x.className = 'btn sm'; x.textContent = '✕'; x.onclick = () => commit(list.filter((_, j) => j !== k)); line.appendChild(x); }
        ctl.appendChild(line);
      });
      const add = document.createElement('button'); add.className = 'btn sm'; add.textContent = '+ Add profile'; add.onclick = () => commit([...list, '']); ctl.appendChild(add);
    } else {
      const s = document.createElement('select');
      let opts;
      if (fld.type === 'select') opts = fld.options;
      else if (fld.type === 'body') opts = [['', fld.optional || 'Select body…'], ...bodiesBefore(idx).map((b) => [b.id, b.name])];
      else opts = [['', 'Select sketch…'], ...sketchesBefore(idx).map((k) => [k.id, k.name])];
      s.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      s.value = val ?? '';
      s.onfocus = () => { dialog.focusKey = fld.key; };
      s.onchange = () => { set(s.value); if (['op', 'kind', 'extent', 'by', 'mode', 'jtype'].includes(fld.key)) rerender(); else if (def.gizmo) setupGizmo(); };
      ctl.appendChild(s);
      if (fld.type === 'body') ctl.insertAdjacentHTML('beforeend', '<div class="note">…or click a body in the viewport.</div>');
    }
    body.appendChild(row);
  }
  if (Object.keys(paramState.values).length) body.insertAdjacentHTML('beforeend', `<div class="note">Fields accept expressions, e.g. <b>${esc(Object.keys(paramState.values)[0])} / 2 + 1 mm</b></div>`);
  body.insertAdjacentHTML('beforeend', '<div id="d-err"></div>');
  $('#d-ok').onclick = closeDialog.bind(null, true);
  $('#d-cancel').onclick = closeDialog.bind(null, false);
  renderDialogErrors();
  updateFaceHL();
}

function updateFaceHL() {
  if (!dialog) return vp.showFaces([], null);
  const f = doc.features[dialog.index];
  const list = [];
  for (const fld of defOf(f).fields) {
    if (fld.type === 'face' && f.params[fld.key]) {
      const fc = f.params[fld.key], d = defOf(f).dragFace ? resolvedMap[f.id]?.distance ?? f.params.distance ?? 0 : 0;
      list.push({ normal: fc.normal, point: fc.point.map((c, k) => c + fc.normal[k] * d), id: f.params.body });
    }
    if (fld.type === 'faces') for (const o of f.params[fld.key] || []) list.push({ ...o, id: f.params.body });
  }
  vp.showFaces(list, dialog.hover);
}

const sameFace = (a, b) => Math.abs(a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2]) > 0.999
  && Math.abs((a.point[0] - b.point[0]) * b.normal[0] + (a.point[1] - b.point[1]) * b.normal[1] + (a.point[2] - b.point[2]) * b.normal[2]) < 0.02;

/** Viewport click while a dialog with a pick mode is open. */
function dialogPick(e) {
  const pk = dialog.pick, i = dialog.index, f = doc.features[i];
  if (pk.kind === 'point') {
    const sn = vp.pickSnap(e);
    if (!sn) return;
    const patch = { [pk.key]: sn.point.map((v) => +v.toFixed(3)) };
    if (pk.dirKey) { const tg = vp.pickPlanarFace(e); if (tg?.normal) patch[pk.dirKey] = tg.normal.map((v) => +v.toFixed(4)); }
    patchParams(i, patch);
    dialog.pick = null; renderDialog(); setupGizmo();
    return;
  }
  const tg = vp.pickPlanarFace(e);
  if (!tg) return;
  if (tg.curved) return toast('Pick a flat (planar) face.', true);
  const entry = { point: tg.point, normal: tg.normal };
  if (pk.kind === 'face') patchParams(i, { [pk.key]: entry, body: tg.id });
  else {
    const cur = f.params[pk.key] || [];
    const has = cur.some((o) => sameFace(o, entry));
    patchParams(i, { [pk.key]: has ? cur.filter((o) => !sameFace(o, entry)) : [...cur, entry], ...(f.params.body ? {} : { body: tg.id }) });
  }
  renderDialog();
}
/** Viewport click on a body while a dialog with body fields is open: fills the focused / first empty one. */
function bodyFieldPick(e) {
  const f = doc.features[dialog.index];
  const flds = defOf(f).fields.filter((x) => x.type === 'body' && (!x.show || x.show(f.params)));
  if (!flds.length) return;
  const h = vp.pickBody(e);
  if (!h) return;
  const key = (flds.find((x) => x.key === dialog.focusKey) || flds.find((x) => !f.params[x.key]) || flds[0]).key;
  updateParam(dialog.index, key, h.id);
  renderDialog(); setupGizmo();
}

function renderDialogErrors() {
  const host = $('#d-err');
  if (!host || !dialog) return;
  const e = result.errors[doc.features[dialog.index]?.id];
  host.innerHTML = e ? `<div class="row err-row">${icon('warn', 14)} ${esc(e)}</div>` : '';
}
function closeDialog(ok) {
  if (!dialog) return;
  const { pre } = dialog;
  vp.hideGizmo();
  vp.showFaces([], null);
  if (ok) {
    const f = doc.features[dialog.index];
    if (result.errors[f.id] && !confirm('This feature has an error:\n' + result.errors[f.id] + '\n\nKeep it anyway?')) return;
    pushUndo(pre);
  } else restore(pre);
  dialog = null;
  $('#props-wrap').classList.remove('open');
  refresh();
}

// move gizmo wiring
function setupGizmo() {
  vp.hideGizmo();
  if (!dialog) return;
  const f = doc.features[dialog.index];
  if (!defOf(f).gizmo) return;
  const b = bodiesBefore(dialog.index).find((x) => x.id === f.params.body);
  if (!b) return;
  const c = b.bbox.min.map((v, k) => (v + b.bbox.max[k]) / 2);
  const t = f.params.t;
  vp.showGizmo(c.map((v, k) => v + t[k]), f.params.r, dialog.mode, (pos, rot) => {
    const cur = doc.features[dialog.index];
    doc.features[dialog.index] = { ...cur, exprs: undefined, params: { ...cur.params, t: pos.map((v, k) => +(v - c[k]).toFixed(3)), r: rot.map((v) => +v.toFixed(2)) } };
    refresh();
    clearTimeout(setupGizmo.t); setupGizmo.t = setTimeout(() => { if (dialog) { const keep = dialog.mode; renderDialog(); dialog.mode = keep; } }, 120);
  });
}

// ------------------------------------------------------------------ sketch mode
function startSketchPlanePick() {
  vp.planeHandles.visible = true;
  $('#hud').innerHTML = '<b>Sketch</b> — select a plane (blue = Top, green = Front, red = Right) or click a flat face of a body · Esc to cancel';
  sketch = { picking: true, index: doc.marker };
  applyNavMode();
  renderRibbon();
}
function enterSketch(index, isNew, plane) {
  const wasMarker = sketch?.picking ? sketch.marker ?? doc.marker : doc.marker;
  const pre = snapshot();
  if (isNew) {
    const f = { id: 'f' + doc.nextId++, type: 'sketch', name: uniqueName('Sketch'), params: { offset: 0, shapes: [], ...(typeof plane === 'string' ? { plane } : plane) } };
    doc.features.splice(index, 0, f);
    doc.marker = index + 1;
    pre.marker = index;
  }
  sketch = { index, isNew, pre, savedMarker: isNew ? doc.marker : wasMarker, tool: 'rect', sel: -1, pts: null, snap: 1, snapOn: true, sides: 6, grid: null };
  applyNavMode();
  doc.marker = Math.max(doc.marker, index + 1);
  selFeature = doc.features[index].id;
  vp.planeHandles.visible = false;
  vp.hideGround = true; vp.grid.visible = false;
  $('#props-wrap').classList.add('open', 'sketch');
  const p = doc.features[index].params;
  vp.lookAtPlane(p);
  buildSketchGrid();
  renderSketchPanel(); setSketchTool('rect'); refresh();
}
const curSketch = () => doc.features[sketch.index];
function setSketchShapes(shapes, push = true) {
  const f = curSketch();
  doc.features[sketch.index] = { ...f, params: { ...f.params, shapes } };
  refresh();
}
function buildSketchGrid() {
  if (sketch.grid) { vp.scene.remove(sketch.grid); }
  const p = curSketch().params;
  const g = new THREE.Group();
  const gr = new THREE.GridHelper(400, 400 / sketch.snap, 0x7d8794, 0xb8bec7);
  gr.rotation.x = Math.PI / 2;
  gr.material.transparent = true; gr.material.opacity = 0.5;
  g.add(gr);
  g.matrixAutoUpdate = false;
  g.matrix.copy(vp.planeMatrix(p));
  sketch.grid = g;
  vp.scene.add(g);
}
function setSketchTool(t) {
  sketch.tool = t; sketch.pts = null; sketch.sel = -1;
  vp.overlay.clear();
  const hints = { rect: 'Click two opposite corners', circle: 'Click the center, then a point on the circumference', ngon: 'Click the center, then a vertex', path: 'Click points of an open path (sweep / rib centre-line) · Enter or double-click to finish', line: 'Click points · click first point, press Enter or double-click to close' };
  $('#hud').innerHTML = `<b>Sketch · ${curSketch().name}</b> — ${hints[t]} · Esc to cancel the current shape`;
  renderRibbon(); renderSketchPanel();
}
function renderSketchPanel() {
  if (!sketch || sketch.picking) return;
  const p = curSketch().params;
  const wrap = $('#props-wrap');
  const sh = p.shapes;
  const fieldsFor = (s) => ({ rect: ['x', 'y', 'w', 'h'], circle: ['cx', 'cy', 'r'], ngon: ['cx', 'cy', 'r', 'n', 'rot'], path: [] }[s.t]);
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('sketch', 20)}SKETCH PALETTE</div><div class="body">
    <div class="mh" style="font-weight:700;margin:0 0 4px">Options</div>
    <div class="row"><label>Sketch plane</label><select id="sp-plane">${[...['XY', 'XZ', 'YZ'], ...(p.plane === 'custom' ? ['custom'] : [])].map((k) => `<option ${k === p.plane ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="row"><label>Plane offset</label><input id="sp-off" type="number" step="1" value="${p.offset}"></div>
    <div class="row"><label>Snap (mm)</label><select id="sp-snap">${[0.1, 0.5, 1, 2, 5, 10].map((v) => `<option ${v === sketch.snap ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label>Polygon sides</label><input id="sp-sides" type="number" min="3" max="64" value="${sketch.sides}"></div>
    <label class="chk"><input type="checkbox" id="sp-grid" ${sketch.grid?.visible === false ? '' : 'checked'}> Sketch Grid</label>
    <label class="chk"><input type="checkbox" id="sp-snapon" ${sketch.snapOn === false ? '' : 'checked'}> Snap</label>
    <div style="margin:6px 0"><button class="btn" id="sp-lookat">Look At</button></div>
    <div class="sep"></div><div class="mh" style="font-weight:700;margin-bottom:4px">Shapes (${sh.length})</div><div id="sp-list"></div>
    <div class="note">Nested shapes become holes. To sketch on a body, start a new sketch and click one of its flat faces.</div></div>
    <div class="foot"><button class="btn" id="sp-cancel">Cancel</button><button class="btn primary" id="sp-ok">Finish Sketch</button></div></div>`;
  const list = $('#sp-list');
  sh.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'shape-item' + (i === sketch.sel ? ' sel' : '');
    item.innerHTML = `${ficon({ rect: 'rect', circle: 'circle', ngon: 'ngon', path: s.open ? 'path' : 'line' }[s.t], 18)}<span>${s.open ? 'Path' : { rect: 'Rectangle', circle: 'Circle', ngon: 'Polygon', path: 'Polyline' }[s.t]} ${i + 1}</span><button class="x" title="Delete">✕</button>`;
    item.onclick = () => { sketch.sel = i; renderSketchPanel(); drawSketches(); renderRibbon(); };
    item.querySelector('.x').onclick = (e) => { e.stopPropagation(); setSketchShapes(sh.filter((_, k) => k !== i)); sketch.sel = -1; renderSketchPanel(); };
    list.appendChild(item);
    if (i === sketch.sel && fieldsFor(s).length) {
      const g = document.createElement('div');
      g.className = 'shape-fields';
      for (const k of fieldsFor(s)) {
        const l = document.createElement('label');
        l.innerHTML = `${k}<input type="number" step="${k === 'n' ? 1 : 0.5}" value="${+s[k].toFixed(3)}">`;
        l.querySelector('input').oninput = (e) => { const v = parseFloat(e.target.value); if (isNaN(v)) return; setSketchShapes(sh.map((o, j) => (j === i ? { ...o, [k]: v } : o))); };
        g.appendChild(l);
      }
      list.appendChild(g);
    }
  });
  $('#sp-plane').onchange = (e) => {
    if (e.target.value === 'custom') return;
    setSketchParam({ plane: e.target.value, origin: undefined, normal: undefined, xdir: undefined }); vp.lookAtPlane(curSketch().params); renderSketchPanel();
  };
  $('#sp-off').oninput = (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setSketchParam({ offset: v }); };
  $('#sp-snap').onchange = (e) => { sketch.snap = +e.target.value; buildSketchGrid(); };
  $('#sp-sides').oninput = (e) => { sketch.sides = Math.max(3, Math.min(64, Math.round(+e.target.value) || 6)); };
  $('#sp-grid').onchange = (e) => { if (sketch.grid) sketch.grid.visible = e.target.checked; };
  $('#sp-snapon').onchange = (e) => { sketch.snapOn = e.target.checked; };
  $('#sp-lookat').onclick = () => vp.lookAtPlane(curSketch().params);
  $('#sp-ok').onclick = finishSketch;
  $('#sp-cancel').onclick = cancelSketch;
}
function setSketchParam(patch) {
  const f = curSketch();
  doc.features[sketch.index] = { ...f, params: { ...f.params, ...patch } };
  buildSketchGrid(); refresh();
}
function sketchDeleteSelected() { if (sketch.sel >= 0) { setSketchShapes(curSketch().params.shapes.filter((_, i) => i !== sketch.sel)); sketch.sel = -1; renderSketchPanel(); } }
function leaveSketch() {
  if (sketch.grid) vp.scene.remove(sketch.grid);
  vp.overlay.clear(); vp.planeHandles.visible = false; vp.highlightFace(null);
  vp.hideGround = false; vp.grid.visible = vp.opts.grid;
  sketch = null;
  applyNavMode();
  $('#hud').innerHTML = '';
  $('#props-wrap').classList.remove('open', 'sketch');
}
function finishSketch() {
  if (!sketch) return;
  if (sketch.picking) return cancelSketch();
  const { pre, isNew, savedMarker, index } = sketch;
  if ((sketch.tool === 'line' || sketch.tool === 'path') && sketch.pts?.length >= 2) closePath();
  const empty = !curSketch().params.shapes.length;
  if (isNew && empty) { restore(pre); toast('Empty sketch discarded'); }
  else { pushUndo(pre); doc.marker = isNew ? index + 1 : Math.max(savedMarker, index + 1); }
  leaveSketch(); refresh();
}
function cancelSketch() {
  if (!sketch) return;
  if (sketch.picking) { vp.planeHandles.visible = false; vp.highlightFace(null); sketch = null; $('#hud').innerHTML = ''; return renderRibbon(); }
  restore(sketch.pre); doc.marker = sketch.savedMarker > doc.features.length ? doc.features.length : doc.marker;
  if (!sketch.isNew) doc.marker = sketch.savedMarker;
  leaveSketch(); refresh();
}

const snapPt = (pt) => (sketch.snapOn === false ? pt : pt.map((v) => Math.round(v / sketch.snap) * sketch.snap));
function sketchPointer(ev, kind) {
  const p = curSketch().params;
  const raw = vp.planePoint(ev, p);
  if (!raw) return;
  const pt = snapPt(raw);
  const s = sketch;
  if (kind === 'move') {
    s.cursor = pt;
    if (s.pts) drawPreview();
    else $('#statusbar').textContent = `u ${pt[0].toFixed(2)}  v ${pt[1].toFixed(2)} mm`;
    return;
  }
  const add = (shape) => { setSketchShapes([...p.shapes, shape]); s.pts = null; vp.overlay.clear(); renderSketchPanel(); };
  if (s.tool === 'line' || s.tool === 'path') {
    if (!s.pts) s.pts = [];
    const first = s.pts[0];
    if (s.tool === 'line' && first && s.pts.length >= 3 && Math.hypot(first[0] - pt[0], first[1] - pt[1]) < s.snap * 0.5) return closePath();
    if (!s.pts.length || s.pts[s.pts.length - 1][0] !== pt[0] || s.pts[s.pts.length - 1][1] !== pt[1]) s.pts.push(pt);
    drawPreview();
    return;
  }
  if (!s.pts) { s.pts = [pt]; return; }
  const [a] = s.pts;
  if (s.tool === 'rect') {
    const w = Math.abs(pt[0] - a[0]), h = Math.abs(pt[1] - a[1]);
    if (w > 0 && h > 0) add({ t: 'rect', x: Math.min(a[0], pt[0]), y: Math.min(a[1], pt[1]), w, h });
  } else {
    const r = Math.hypot(pt[0] - a[0], pt[1] - a[1]);
    if (r > 0) add(s.tool === 'circle' ? { t: 'circle', cx: a[0], cy: a[1], r } : { t: 'ngon', cx: a[0], cy: a[1], r, n: s.sides, rot: (Math.atan2(pt[1] - a[1], pt[0] - a[0]) * 180) / Math.PI });
  }
}
function closePath() {
  const s = sketch;
  const open = s.tool === 'path';
  if (s.pts && s.pts.length >= (open ? 2 : 3)) setSketchShapes([...curSketch().params.shapes, open ? { t: 'path', open: true, pts: s.pts } : { t: 'path', pts: s.pts }]);
  s.pts = null; vp.overlay.clear(); renderSketchPanel();
}
function drawPreview() {
  const s = sketch, p = curSketch().params;
  vp.overlay.clear();
  const c = s.cursor || s.pts[0];
  let poly = [], info = '';
  if (s.tool === 'line' || s.tool === 'path') { poly = [...s.pts, c]; info = `L ${Math.hypot(c[0] - s.pts.at(-1)[0], c[1] - s.pts.at(-1)[1]).toFixed(2)} mm`; }
  else {
    const [a] = s.pts;
    if (s.tool === 'rect') { poly = shapeToPolygon({ t: 'rect', x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) }); info = `W ${Math.abs(c[0] - a[0]).toFixed(2)} × H ${Math.abs(c[1] - a[1]).toFixed(2)} mm`; }
    else { const r = Math.hypot(c[0] - a[0], c[1] - a[1]); poly = shapeToPolygon(s.tool === 'circle' ? { t: 'circle', cx: a[0], cy: a[1], r } : { t: 'ngon', cx: a[0], cy: a[1], r, n: s.sides, rot: (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI }); info = `R ${r.toFixed(2)} mm  (Ø ${(r * 2).toFixed(2)})`; }
  }
  const pts = poly.map((q) => vp.planeTo3D(p, q));
  const closed = s.tool !== 'line' && s.tool !== 'path';
  const line = closed ? new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf08c00 })) : new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf08c00 }));
  vp.overlay.add(line);
  $('#statusbar').textContent = info;
}

const sketchMat = new THREE.LineBasicMaterial({ color: 0x2b6cb0 });
const sketchMatActive = new THREE.LineBasicMaterial({ color: 0x0b6bcb });
const sketchMatSel = new THREE.LineBasicMaterial({ color: 0xf08c00 });
function drawSketches() {
  if (!vp) return;
  vp.sketchGroup.clear();
  doc.features.forEach((f, i) => {
    if (f.type !== 'sketch' || f.suppressed) return;
    const active = sketch && sketch.index === i;
    if (!active && (i >= limit() || !(sketchVis[f.id] ?? !result.sketchUsed.has(f.id)))) return;
    f.params.shapes.forEach((s, k) => {
      const poly = shapeToPolygon(s);
      if (poly.length < 2) return;
      const pts = poly.map((q) => vp.planeTo3D(f.params, q));
      const m = active ? (k === sketch.sel ? sketchMatSel : sketchMatActive) : sketchMat;
      vp.sketchGroup.add(new (s.open ? THREE.Line : THREE.LineLoop)(new THREE.BufferGeometry().setFromPoints(pts), m));
    });
  });
}

// ------------------------------------------------------------------ parameters dialog
function openParameters() {
  if (dialog || sketch) return;
  endMeasure();
  const pre = snapshot();
  let changed = false;
  const m = modal(`<div class="modal-title">Parameters</div><div class="modal-body">
    <div class="hint">Name a dimension once, then type the name (or any expression such as <b>width/2 + 3 mm</b>) into feature fields. Lengths are mm; <code>sin cos tan sqrt min max pi</code> and units <code>mm cm m in</code> work.</div>
    <div class="ptable" id="pt"></div><div><button class="btn" id="p-add">+ Add parameter</button></div></div>
    <div class="modal-foot"><button class="btn primary" data-x>Done</button></div>`, () => { if (changed) { pushUndo(pre); refresh(); } });
  m.el.classList.add('wide');
  m.el.querySelector('[data-x]').onclick = m.close;
  const host = m.el.querySelector('#pt');
  const apply = (list) => { doc.params = list; changed = true; markDirty(); refresh(); };
  const draw = () => {
    host.innerHTML = '<div class="h">Name</div><div class="h">Expression</div><div class="h">Value</div><div class="h">Comment</div><div></div>';
    const list = doc.params || [];
    list.forEach((p, i) => {
      const name = document.createElement('input'); name.value = p.name; name.spellcheck = false;
      const ex = document.createElement('input'); ex.value = p.expr; ex.spellcheck = false;
      const val = document.createElement('div'); val.className = 'val';
      const cm = document.createElement('input'); cm.value = p.comment || ''; cm.placeholder = 'optional';
      const del = document.createElement('button'); del.className = 'icon-btn danger'; del.innerHTML = icon('remove', 16); del.title = 'Delete';
      const showVal = () => {
        const r = resolveParams(doc.params || []);
        const err = r.errors[(doc.params[i] || {}).name];
        val.className = 'val' + (err ? ' err' : '');
        val.textContent = err ? err : r.values[doc.params[i].name] !== undefined ? +r.values[doc.params[i].name].toFixed(4) : '';
      };
      name.oninput = () => {
        const v = name.value.trim();
        const dup = (doc.params || []).some((q, j) => j !== i && q.name === v);
        const bad = !NAME_RE.test(v) || RESERVED.has(v) || dup;
        name.classList.toggle('bad', bad);
        name.title = bad ? (dup ? 'Name already used' : 'Use letters, digits and _ (not starting with a digit); not a reserved word') : '';
        if (!bad) { apply(doc.params.map((q, j) => (j === i ? { ...q, name: v } : q))); showVal(); }
      };
      ex.oninput = () => { apply(doc.params.map((q, j) => (j === i ? { ...q, expr: ex.value } : q))); ex.classList.toggle('bad', !!paramState.errors[doc.params[i].name]); showVal(); };
      cm.oninput = () => apply(doc.params.map((q, j) => (j === i ? { ...q, comment: cm.value } : q)));
      del.onclick = () => { apply(doc.params.filter((_, j) => j !== i)); draw(); };
      host.append(name, ex, val, cm, del);
      showVal();
    });
    if (!list.length) host.insertAdjacentHTML('beforeend', '<div class="hint" style="grid-column:1/-1">No parameters yet.</div>');
  };
  m.el.querySelector('#p-add').onclick = () => {
    let n = 1; const used = new Set((doc.params || []).map((q) => q.name));
    while (used.has('d' + n)) n++;
    apply([...(doc.params || []), { name: 'd' + n, expr: '10', comment: '' }]);
    draw();
    host.querySelector('input')?.focus();
  };
  draw();
}

// ------------------------------------------------------------------ measure
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function startMeasure(mode) {
  if (dialog || sketch) return;
  const log = measure?.log || [];
  vp.setMeasureOverlay([], []); vp.setPickEdges([]); vp.showFaces([], null);
  measure = { mode, pts: [], faces: [], log };
  if (mode === 'edge') {
    const entries = [];
    for (const b of result.bodies) if (!hiddenBodies.has(b.id)) for (const chain of chainsOf(b.verts, 3, b.tris)) entries.push({ body: b.id, chain, selected: false });
    vp.setPickEdges(entries);
  }
  const hint = { dist: 'Click two points (vertices snap)', angle: 'Click three points: first end, vertex, second end', edge: 'Click an edge', faces: 'Click two flat faces' }[mode];
  $('#hud').innerHTML = `<b>Measure</b> — ${hint} · Esc to finish`;
  $('#props-wrap').classList.add('open');
  renderMeasurePanel(); renderRibbon();
}
function endMeasure() {
  if (!measure) return;
  measure = null;
  vp.setMeasureOverlay([], []); vp.setPickEdges([]); vp.showFaces([], null);
  $('#hud').innerHTML = '';
  $('#props-wrap').classList.remove('open');
  renderRibbon();
}
function logMeasure(title, value, detail) { measure.log.unshift({ title, value, detail }); renderMeasurePanel(); }
function renderMeasurePanel() {
  if (!measure) return;
  const wrap = $('#props-wrap');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('measure', 20)}MEASURE</div><div class="body">${
    measure.log.length ? measure.log.map((m) => `<div class="meas"><small>${esc(m.title)}</small><b>${esc(m.value)}</b>${m.detail ? `<small>${esc(m.detail)}</small>` : ''}</div>`).join('') : '<div class="note">Results appear here. Distances are in millimetres.</div>'
  }</div><div class="foot"><button class="btn" id="m-clear">Clear</button><button class="btn primary" id="m-done">Done</button></div></div>`;
  $('#m-clear').onclick = () => { measure.log = []; measure.pts = []; vp.setMeasureOverlay([], []); renderMeasurePanel(); };
  $('#m-done').onclick = endMeasure;
}
function measureHover(e) {
  if (!measure) return;
  if (measure.mode === 'edge') { const en = vp.pickEdge(e); if (en !== vp.pickHover) { vp.pickHover = en; vp.rebuildPickEdges(); } }
  else if (measure.mode === 'faces') { const tg = vp.pickPlanarFace(e); vp.showFaces(measure.faces.map((f) => ({ id: f.id, point: f.point, normal: f.normal })), tg?.face ? tg : null); }
}
function measureClick(e) {
  const M = measure;
  const fmt = (v) => v.toFixed(3);
  if (M.mode === 'dist' || M.mode === 'angle') {
    const sn = vp.pickSnap(e);
    if (!sn) return;
    const need = M.mode === 'dist' ? 2 : 3;
    if (M.pts.length >= need) M.pts = [];
    M.pts.push(sn.point);
    const lines = M.pts.length > 1 ? [M.pts] : [];
    vp.setMeasureOverlay(M.pts, lines);
    if (M.pts.length === need) {
      if (M.mode === 'dist') {
        const [a, b] = M.pts;
        logMeasure('Distance', `${fmt(dist3(a, b))} mm`, `ΔX ${fmt(b[0] - a[0])}  ΔY ${fmt(b[1] - a[1])}  ΔZ ${fmt(b[2] - a[2])}`);
      } else {
        const [a, v, c] = M.pts;
        const u = [a[0] - v[0], a[1] - v[1], a[2] - v[2]], w = [c[0] - v[0], c[1] - v[1], c[2] - v[2]];
        const lu = Math.hypot(...u), lw = Math.hypot(...w);
        if (!lu || !lw) return toast('The points must be distinct.', true);
        const ang = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw)))) * 180) / Math.PI;
        logMeasure('Angle', `${ang.toFixed(2)}°`, `Supplement ${(180 - ang).toFixed(2)}°  ·  legs ${fmt(lu)} / ${fmt(lw)} mm`);
      }
    }
  } else if (M.mode === 'edge') {
    const en = vp.pickEdge(e);
    if (!en) return;
    const pts = en.chain.pts, closed = en.chain.closed;
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += dist3(pts[i], pts[i + 1]);
    if (closed) L += dist3(pts[pts.length - 1], pts[0]);
    let detail = closed ? 'Closed loop' : `${pts.length - 1} segment${pts.length > 2 ? 's' : ''}`;
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
    const rs = pts.map((p) => dist3(p, c)), rm = rs.reduce((a, b) => a + b, 0) / rs.length;
    if (closed && rm > 0 && Math.max(...rs.map((r) => Math.abs(r - rm))) / rm < 0.02) detail = `Circle · Ø ${fmt(rm * 2)} mm · R ${fmt(rm)} mm`;
    logMeasure('Edge length', `${fmt(L)} mm`, detail);
    vp.setMeasureOverlay([], [closed ? [...pts, pts[0]] : pts]);
  } else if (M.mode === 'faces') {
    const tg = vp.pickPlanarFace(e);
    if (!tg) return;
    if (tg.curved) return toast('Pick flat faces.', true);
    if (M.faces.length >= 2) M.faces = [];
    M.faces.push({ id: tg.id, point: tg.point, normal: tg.normal });
    vp.showFaces(M.faces, null);
    if (M.faces.length === 2) {
      const [a, b] = M.faces;
      const dt = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
      const ang = (Math.acos(Math.min(1, Math.abs(dt))) * 180) / Math.PI;
      const dd = Math.abs((b.point[0] - a.point[0]) * a.normal[0] + (b.point[1] - a.point[1]) * a.normal[1] + (b.point[2] - a.point[2]) * a.normal[2]);
      if (ang < 0.05) logMeasure('Distance between parallel faces', `${fmt(dd)} mm`, 'Faces are parallel');
      else logMeasure('Angle between faces', `${ang.toFixed(2)}°`, `Supplement ${(180 - ang).toFixed(2)}°`);
    }
  }
}

// ------------------------------------------------------------------ inspect / print
function showInfo() {
  if (dialog || sketch) return;
  const bodies = result.bodies.filter((b) => (vp.selected.size ? vp.selected.has(b.id) : true) && !hiddenBodies.has(b.id));
  const wrap = $('#props-wrap');
  const [bx, by, bz] = vp.opts.bedSize;
  const rows = bodies.map((b) => {
    const s = b.bbox.max.map((v, k) => v - b.bbox.min[k]);
    const fits = s[0] <= bx && s[1] <= by && s[2] <= bz;
    const vol = b.volume / 1000;
    return `<div class="sep"></div><b>${esc(b.name)}</b>
      <div class="stat"><span>Size (mm)</span><b>${s.map((v) => v.toFixed(2)).join(' × ')}</b></div>
      <div class="stat"><span>Volume</span><b>${vol.toFixed(3)} cm³</b></div>
      <div class="stat"><span>Surface area</span><b>${(b.area / 100).toFixed(2)} cm²</b></div>
      <div class="stat"><span>Mass (PLA, solid)</span><b>${(vol * 1.24).toFixed(1)} g</b></div>
      <div class="stat"><span>Fits ${esc(bedName.split(' (')[0])}</span><b class="${fits ? 'ok' : 'warn'}">${fits ? 'Yes' : 'No — too large'}</b></div>`;
  }).join('');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('properties', 20)}PROPERTIES</div><div class="body">${bodies.length ? `<div class="stat"><span>Bodies</span><b>${bodies.length}</b></div>` + rows : 'No bodies to inspect.'}</div><div class="foot"><button class="btn primary" id="i-close">Close</button></div></div>`;
  wrap.classList.add('open');
  $('#i-close').onclick = () => { wrap.classList.remove('open'); };
}

// ------------------------------------------------------------------ files
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportSTL(selectedOnly) {
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!selectedOnly || vp.selected.has(b.id)));
  if (!bodies.length) return toast('Nothing to export.', true);
  download(writeSTL(bodies, doc.name), `${doc.name}.stl`);
  toast(`Exported ${bodies.length} body${bodies.length > 1 ? 's' : ''} as STL`);
}
async function importSTL(file) {
  try {
    const soup = parseSTL(await file.arrayBuffer());
    const pre = snapshot();
    const name = file.name.replace(/\.stl$/i, '');
    const f = { id: 'f' + doc.nextId++, type: 'import', name, params: { data: encodeFloats(soup), tris: soup.length / 9 } };
    doc.features.splice(doc.marker, 0, f); doc.marker++;
    pushUndo(pre);
    result = rebuild(doc.features, doc.marker);
    if (result.errors[f.id]) { restore(pre); undoStack.pop(); refresh(); return toast(`Import failed: ${result.errors[f.id]} (mesh must be watertight)`, true); }
    vp.fitted = false; refresh();
    toast(`Imported ${name} (${(soup.length / 9).toLocaleString()} triangles)`);
  } catch (e) { toast('Import failed: ' + e.message, true); }
}
function captureThumb() {
  try {
    const src = vp.renderer.domElement;
    vp.renderer.render(vp.scene, vp.camera);
    const c = document.createElement('canvas');
    c.width = 240; c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#eef1f4'; g.fillRect(0, 0, 240, 240);
    const side = Math.min(src.width, src.height);
    g.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, 240, 240);
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
}
const projectJSON = (name = doc.name, withThumb = false) => JSON.stringify({ format: 'sketchy', version: 1, ...doc, name, ...(withThumb ? { thumb: captureThumb() } : {}) });
function loadProject(txt) {
  const d = JSON.parse(txt);
  if (d.format !== 'sketchy') throw new Error('Not a Sketchy project');
  doc = { name: d.name, features: d.features, marker: d.marker, nextId: d.nextId, params: d.params || [], saves: d.saves || 0 };
  undoStack = []; redoStack = []; vp.selected.clear(); hiddenBodies.clear();
  dirty = false; $('#doc-dirty').classList.remove('on'); $('#doc-name').textContent = doc.name;
  vp.fitted = false; refresh();
}
const safeName = (n) => n.replace(/[^\w .()-]/g, '_').slice(0, 80) || 'Untitled';
async function save(as) {
  let name = doc.name;
  if (acct.server && !(await requireLogin())) return;
  if (as || name === 'Untitled') { const n = prompt('Design name', name === 'Untitled' ? 'My design' : name); if (!n) return; name = safeName(n); }
  if (acct.server) {
    doc.saves = (doc.saves || 0) + 1;
    const r = await call('PUT', '/projects/' + encodeURIComponent(name), projectJSON(name, true));
    if (!r.ok) return toast('Save failed: ' + (r.data?.error || r.status), true);
    toast(`Saved "${name}" to your designs`);
  } else download(new Blob([projectJSON(name)], { type: 'application/json' }), `${name}.sketchy.json`);
  doc.name = name; $('#doc-name').textContent = name;
  dirty = false; $('#doc-dirty').classList.remove('on');
}
function downloadProject() { download(new Blob([projectJSON()], { type: 'application/json' }), `${doc.name}.sketchy.json`); }
function openFromServer() { toggleDataPanel(true); }
function newDoc() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  doc = blankDoc(); undoStack = []; redoStack = []; vp.selected.clear(); hiddenBodies.clear();
  dirty = false; $('#doc-dirty').classList.remove('on'); $('#doc-name').textContent = 'Untitled'; vp.fitted = false; refresh();
}
let autosaveT;
function scheduleAutosave() {
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => { try { localStorage.setItem('sketchy.autosave', projectJSON()); } catch { /* too large */ } }, 800);
}

// ------------------------------------------------------------------ undo / redo
function undo() { if (dialog || sketch || !undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); markDirty(); refresh(); }
function redo() { if (dialog || sketch || !redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); markDirty(); refresh(); }

// ------------------------------------------------------------------ viewport events
function bindViewport() {
  const cv = $('#gl');
  let down = null, rdown = null;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => { if (e.button === 2) rdown = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerup', (e) => { if (e.button === 2 && rdown && Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) < 5 && !sketch?.pts) openMarking(e.clientX, e.clientY); rdown = null; });
  cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
  cv.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || vp.gizmo.dragging) { down = null; return; }
    down = null;
    if (sketch?.picking) {
      const tg = vp.pickSketchTarget(e);
      if (tg?.plane) enterSketch(sketch.index, true, tg.plane);
      else if (tg?.face) { vp.highlightFace(null); enterSketch(sketch.index, true, tg.face); }
      else if (tg?.curved) toast('Pick a flat (planar) face.', true);
      return;
    }
    if (sketch) {
      if (sketch.tool && sketch.tool !== 'select') sketchPointer(e, 'click');
      return;
    }
    if (measure) { measureClick(e); return; }
    if (dialog) {
      if (defOf(doc.features[dialog.index])?.pickEdges) { const en = vp.pickEdge(e); if (en) toggleEdge(en); }
      else if (dialog.pick) dialogPick(e);
      else bodyFieldPick(e);
      return;
    }
    const hit = vp.pickBody(e);
    selectBody(hit?.id, e.shiftKey || e.ctrlKey || e.metaKey);
  });
  // Press/Pull: drag the picked face along its normal
  $('#viewport').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== cv || !dialog) return;
    const f = doc.features[dialog.index];
    if (!defOf(f).dragFace || !f.params.face) return;
    const tg = vp.pickPlanarFace(e), fc = f.params.face;
    const cur = resolvedMap[f.id]?.distance ?? f.params.distance ?? 0;
    const moved = { normal: fc.normal, point: fc.point.map((c, k) => c + fc.normal[k] * cur) };
    if (!tg?.face || tg.id !== f.params.body || !(sameFace(tg, fc) || sameFace(tg, moved))) return;
    const r = cv.getBoundingClientRect();
    const P0 = new THREE.Vector3(...tg.point), N = new THREE.Vector3(...fc.normal);
    const proj = (p) => { const q = p.clone().project(vp.camera); return [((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height]; };
    const a = proj(P0), b = proj(P0.clone().addScaledVector(N, 10));
    const sd = [b[0] - a[0], b[1] - a[1]], l2 = sd[0] * sd[0] + sd[1] * sd[1];
    if (l2 < 9) return;
    e.stopPropagation();
    vp.controls.enabled = false;
    const start = { x: e.clientX, y: e.clientY, d: f.params.distance || 0 };
    const fld = defOf(f).fields.find((x) => x.key === 'distance');
    const move = (ev) => {
      const d = Math.round((start.d + 10 * (((ev.clientX - start.x) * sd[0] + (ev.clientY - start.y) * sd[1]) / l2)) * 2) / 2;
      commitNumber(dialog.index, 'distance', String(d), fld);
      const inp = $('#props-wrap input.num'); if (inp) inp.value = String(d);
    };
    const up = () => { removeEventListener('pointermove', move); vp.controls.enabled = true; renderDialog(); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }, true);
  cv.addEventListener('dblclick', () => { if (sketch?.tool === 'line' || sketch?.tool === 'path') closePath(); });
  let hoverRaf = false;
  cv.addEventListener('pointermove', (e) => {
    if (sketch && !sketch.picking) return sketchPointer(e, 'move');
    if (e.buttons || hoverRaf) return;
    if (measure) { measureHover(e); return; }
    if (dialog) {
      if (!defOf(doc.features[dialog.index])?.pickEdges) {
        if (dialog.pick && dialog.pick.kind !== 'point') {
          hoverRaf = true;
          requestAnimationFrame(() => { hoverRaf = false; if (!dialog) return; const tg = vp.pickPlanarFace(e); dialog.hover = tg?.face ? tg : null; updateFaceHL(); });
        }
        return;
      }
      const en = vp.pickEdge(e);
      if (en !== vp.pickHover) { vp.pickHover = en; vp.rebuildPickEdges(); }
      return;
    }
    if (sketch?.picking) { const tg = vp.pickSketchTarget(e); vp.highlightFace(tg?.face ? tg : null); return; }
    hoverRaf = true;
    requestAnimationFrame(() => {
      hoverRaf = false;
      const h = sketch ? null : vp.pickBody(e)?.id || null;
      if (h !== vp.hover) { vp.hover = h; vp.refreshMaterials(); }
    });
  });
}

function applyNavMode() {
  if (!vp) return;
  const B = THREE.MOUSE;
  vp.controls.mouseButtons.LEFT = sketch && !sketch.picking ? -1 : { orbit: B.ROTATE, pan: B.PAN, zoom: B.DOLLY, zwin: -1 }[navMode];
  const hud = { pan: 'Pan: drag to move the view', zoom: 'Zoom: drag up/down', zwin: 'Zoom Window: drag a rectangle' }[navMode];
  if (hud && !sketch && !measure && !dialog) $('#hud').innerHTML = hud + ' · Esc to exit';
  else if (!hud && !sketch && !measure && !dialog && /Pan:|Zoom/.test($('#hud').textContent)) $('#hud').innerHTML = '';
}
function setNavMode(m) { navMode = m; applyNavMode(); buildNavBar(); }
function lookAtNearest() {
  const d = vp.camera.position.clone().sub(vp.controls.target).normalize();
  const ax = [d.x, d.y, d.z].map(Math.abs);
  const k = ax.indexOf(Math.max(...ax));
  const v = [0, 0, 0]; v[k] = Math.sign([d.x, d.y, d.z][k]) || 1;
  vp.lookAlong(v, k === 2 ? [0, 1, 0] : [0, 0, 1]);
}
function showAll() { hiddenBodies.clear(); Object.keys(sketchVis).forEach((k) => delete sketchVis[k]); originVis = false; vp.setOriginVisible(false); refresh(); }

function buildNavBar() {
  const nb = $('#navbar');
  nb.innerHTML = '';
  const b = (ic, title, fn, o = {}) => {
    const el = document.createElement('button');
    el.className = 'nb' + (o.on ? ' on' : '');
    el.title = title;
    el.innerHTML = uicon(ic, 19, 1.5) + (o.caret ? uicon('caret', 8, 0).replace('class="ui"', 'class="ui cr"') : '');
    if (o.caret) el.dataset.menu = 1;
    el.onclick = (e) => fn(e);
    nb.appendChild(el);
  };
  const sep = () => nb.insertAdjacentHTML('beforeend', '<span class="nsep"></span>');
  b('orbit', 'Orbit (Shift + middle mouse)', () => setNavMode('orbit'), { caret: true });
  b('camera', 'Look At', lookAtNearest);
  b('hand', 'Pan (middle mouse)', () => setNavMode(navMode === 'pan' ? 'orbit' : 'pan'), { on: navMode === 'pan' });
  b('zoom', 'Zoom (mouse wheel)', () => setNavMode(navMode === 'zoom' ? 'orbit' : 'zoom'), { on: navMode === 'zoom', caret: false });
  b('zoomwin', 'Zoom Window · Fit', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.top - 90, [
      { label: 'Zoom Window', uicon: 'zoomwin', run: () => setNavMode('zwin') },
      { label: 'Fit', uicon: 'fit', hint: '', run: () => vp.fit() },
    ]);
  }, { on: navMode === 'zwin', caret: true });
  sep();
  b('monitor', 'Display Settings', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const style = vp.opts.wire ? 'wire' : vp.opts.edges ? 'edges' : 'shaded';
    const setStyle = (st) => () => { vp.opts.wire = st === 'wire'; vp.opts.edges = st !== 'shaded'; vp.refreshMaterials(); };
    showMenu(r.left - 30, r.top - 300, [
      { head: 'VISUAL STYLE' },
      { label: 'Shaded', check: style === 'shaded', run: setStyle('shaded') },
      { label: 'Shaded with Visible Edges Only', check: style === 'edges', run: setStyle('edges') },
      { label: 'Wireframe', check: style === 'wire', run: setStyle('wire') },
      { sep: true },
      { head: 'CAMERA' },
      { label: 'Orthographic', check: vp.opts.ortho, run: () => vp.setOrtho(true) },
      { label: 'Perspective', check: !vp.opts.ortho, run: () => vp.setOrtho(false) },
      { sep: true },
      { head: 'OBJECT VISIBILITY' },
      { label: 'Origin', check: originVis, run: () => { originVis = !originVis; vp.setOriginVisible(originVis); renderTree(); } },
      { label: 'Build volume', check: vp.opts.bed, run: () => { vp.opts.bed = !vp.opts.bed; vp.refreshMaterials(); renderRibbon(); } },
    ]);
  }, { caret: true });
  b('grid2', 'Grid and Snaps', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left - 20, r.top - 100, [
      { label: 'Show Grid', check: vp.opts.grid, run: () => { vp.opts.grid = !vp.opts.grid; vp.refreshMaterials(); } },
      { label: 'Snap to Grid', check: !sketch || sketch.snapOn !== false, run: () => { if (sketch) sketch.snapOn = sketch.snapOn === false; } },
    ]);
  }, { caret: true });
  b('viewports', 'Viewports', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left - 20, r.top - 100, [{ label: 'Single View', check: true, run: () => {} }, { label: 'Two Views: Horizontal', dim: true, run: () => toast('Multiple viewports are not available yet.') }]);
  }, { caret: true });
}

function bindZoomWindow() {
  const vpEl = $('#viewport'), z = $('#zwin'), cv = $('#gl');
  let st = null;
  vpEl.addEventListener('pointerdown', (e) => {
    if (navMode !== 'zwin' || e.button !== 0 || e.target !== cv) return;
    e.stopPropagation();
    const r = vpEl.getBoundingClientRect();
    st = { x: e.clientX - r.left, y: e.clientY - r.top };
    Object.assign(z.style, { display: 'block', left: st.x + 'px', top: st.y + 'px', width: '0px', height: '0px' });
    const move = (ev) => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      Object.assign(z.style, { left: Math.min(x, st.x) + 'px', top: Math.min(y, st.y) + 'px', width: Math.abs(x - st.x) + 'px', height: Math.abs(y - st.y) + 'px' });
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      z.style.display = 'none';
      const cr = cv.getBoundingClientRect();
      vp.zoomToRect(st.x + r.left - cr.left, st.y + r.top - cr.top, ev.clientX - cr.left, ev.clientY - cr.top);
      st = null;
      setNavMode('orbit');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }, true);
}

// ------------------------------------------------------------------ marking menu (right-click)
function closeMarking() { const h = $('#marking'); h.hidden = true; h.innerHTML = ''; }
function openMarking(x, y) {
  closeMarking();
  const host = $('#marking');
  host.hidden = false;
  const mm = document.createElement('div');
  mm.className = 'mm';
  const cx = Math.max(150, Math.min(x, innerWidth - 150)), cy = Math.max(200, Math.min(y, innerHeight - 90));
  mm.style.left = cx + 'px'; mm.style.top = cy + 'px';
  const done = (fn) => () => { closeMarking(); fn(); };
  const items = [];
  if (dialog) items.push({ uicon: 'check', label: 'OK', key: '⏎', run: () => closeDialog(true) }, { uicon: 'close', label: 'Cancel', key: 'Esc', run: () => closeDialog(false) }, { sep: true });
  if (sketch && !sketch.picking) items.push({ ficon: 'finish', label: 'Finish Sketch', run: finishSketch }, { sep: true });
  items.push({ uicon: 'zoomwin', label: 'Fit', run: () => vp.fit() }, { uicon: 'camera', label: 'Look At', run: lookAtNearest }, { uicon: 'home', label: 'Home View', run: () => vp.home() },
    { sep: true }, { uicon: 'eye', label: 'Show All', run: showAll }, { sep: true });
  for (const id of ['extrude', 'fillet', 'hole', 'sketch', 'measure', 'parameters', 'importstl']) items.push({ ficon: CMD[id].icon, label: CMD[id].label, key: CMD[id].key, run: () => runCommand(id) });
  const list = document.createElement('div');
  list.className = 'mm-list';
  for (const it of items) {
    if (it.sep) { list.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
    const e = document.createElement('div');
    e.className = 'mi';
    e.innerHTML = (it.ficon ? ficon(it.ficon, 20) : uicon(it.uicon, 16)) + `<span>${esc(it.label)}</span>` + (it.key ? `<small>${it.key}</small>` : '');
    e.onclick = done(it.run);
    list.appendChild(e);
  }
  list.style.top = '-80px';
  mm.appendChild(list);
  const last = lastCmd && CMD[lastCmd];
  const pills = [
    { dx: 0, dy: -62, label: last ? `Repeat ${last.label}` : 'Repeat', f: last?.icon, dim: !last, run: () => runCommand(lastCmd) },
    { dx: -108, dy: -32, label: 'Delete', u: 'close', red: true, dim: !vp.selected.size, run: deleteSelection },
    { dx: 108, dy: -32, label: 'Press Pull', f: 'presspull', run: () => runCommand('presspull') },
    { dx: -126, dy: 2, label: 'Undo', u: 'undo', dim: !undoStack.length, run: undo },
    { dx: 126, dy: 2, label: 'Redo', u: 'redo', dim: !redoStack.length, run: redo },
    { dx: -114, dy: 36, label: 'Move/Copy', f: 'move', run: () => runCommand('move') },
    { dx: 114, dy: 36, label: 'Hole', f: 'hole', run: () => runCommand('hole') },
    { dx: 0, dy: 70, label: 'Sketch ▾', run: () => runCommand('sketch') },
  ];
  for (const pl of pills) {
    const b = document.createElement('div');
    b.className = 'pill' + (pl.dim ? ' dim' : '');
    b.style.left = pl.dx + 'px'; b.style.top = pl.dy + 'px';
    b.innerHTML = `<span>${esc(pl.label)}</span>` + (pl.f ? ficon(pl.f, 20) : pl.u ? `<span style="color:${pl.red ? '#e0453a' : '#555'};display:grid">${uicon(pl.u, 16, pl.red ? 2.4 : 1.6)}</span>` : '');
    b.onclick = done(pl.run);
    mm.appendChild(b);
  }
  host.appendChild(mm);
  const lr = list.getBoundingClientRect();
  if (lr.top < 6) mm.style.top = cy + (6 - lr.top) + 'px';
  host.onpointerdown = (e) => { if (e.target === host) closeMarking(); };
  host.oncontextmenu = (e) => { e.preventDefault(); closeMarking(); };
}

// ------------------------------------------------------------------ quick search (S)
function openQuickSearch() {
  closeMarking();
  const host = $('#marking');
  host.hidden = false;
  host.innerHTML = `<div class="qs"><input placeholder="Search commands…" autocomplete="off" spellcheck="false"><div class="qs-list"></div></div>`;
  const input = host.querySelector('input'), list = host.querySelector('.qs-list');
  let hot = 0, shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = Object.entries(CMD).filter(([id, c]) => !id.startsWith('sk_') && id !== 'cancelpick' && id !== 'finishsketch' && (!q || c.label.toLowerCase().includes(q))).slice(0, 40);
    hot = Math.min(hot, Math.max(shown.length - 1, 0));
    list.innerHTML = '';
    shown.forEach(([id, c], i) => {
      const e = document.createElement('div');
      e.className = 'mi' + (i === hot ? ' hot' : '');
      e.innerHTML = ficon(c.icon, 22) + `<span>${esc(c.label)}</span>` + (c.key ? `<small>${c.key}</small>` : c.off ? '<small>soon</small>' : '');
      e.onclick = () => { closeMarking(); runCommand(id); };
      list.appendChild(e);
    });
  };
  input.oninput = () => { hot = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { hot = Math.min(hot + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hot = Math.max(hot - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { const t = shown[hot]; closeMarking(); if (t) runCommand(t[0]); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Escape') { closeMarking(); e.stopPropagation(); }
  };
  host.onpointerdown = (e) => { if (e.target === host) closeMarking(); };
  draw(); input.focus();
}

// ------------------------------------------------------------------ data panel (saved designs)
function toggleDataPanel(force) {
  dataOpen = force ?? !dataOpen;
  try { localStorage.setItem('sketchy.data', dataOpen ? '1' : '0'); } catch { /* ignore */ }
  $('#data-panel').classList.toggle('open', dataOpen);
  $('#btn-data').classList.toggle('on', dataOpen);
  if (dataOpen) renderDataPanel();
  setTimeout(() => vp?.resize(), 0);
}
async function renderDataPanel() {
  const host = $('#data-panel');
  host.innerHTML = `<div class="dp-top"><span class="count" id="dp-count"></span><button id="dp-refresh" title="Refresh">${uicon('refresh', 16)}</button><button id="dp-search" title="Search">${uicon('search', 16)}</button><button id="dp-close" title="Close">${uicon('close', 16)}</button></div>
    <div class="dp-tabs"><button class="dp-tab active">Data</button></div>
    <div class="dp-actions"><button class="btn" id="dp-new">New Design</button></div>
    <div class="dp-grid" id="dp-grid"><div class="dp-empty">Loading…</div></div>`;
  $('#dp-close').onclick = () => toggleDataPanel(false);
  $('#dp-refresh').onclick = renderDataPanel;
  $('#dp-search').onclick = () => toast('Search is not available yet.');
  $('#dp-new').onclick = () => { newDoc(); };
  const grid = $('#dp-grid');
  const card = (name, o = {}) => {
    const el = document.createElement('div');
    el.className = 'dp-card' + (name === doc.name ? ' current' : '');
    const when = o.modified ? new Date(o.modified) : new Date();
    const fmt = `${String(when.getDate()).padStart(2, '0')}/${String(when.getMonth() + 1).padStart(2, '0')}/${when.getFullYear()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    el.innerHTML = `<div class="dp-thumb">${o.thumb ? `<img alt="" src="/api/projects/${encodeURIComponent(name)}/thumb?${o.modified | 0}">` : ficon('box', 40)}</div>
      <div class="dp-info"><div class="dp-name"><svg class="ui" viewBox="0 0 24 24" width="16" height="16"><path d="M12 2L21 7V17L12 22L3 17V7Z" fill="#f08c00"/><path d="M12 12L21 7M12 12V22M12 12L3 7" stroke="#fff" stroke-width="1.5" fill="none"/></svg><span>${esc(name)}</span></div>
      <div class="dp-date">${fmt}</div><div class="dp-bottom">${o.del ? `<button class="dp-del" title="Delete">${uicon('remove', 15)}</button>` : ''}<span class="dp-ver">V${o.ver || 1} ▾</span></div></div>
      <span class="dp-open" title="Open">${uicon('file', 16)}</span>`;
    return el;
  };
  if (acct.server && acct.user) {
    const r = await call('GET', '/projects');
    if (!r.ok) { grid.innerHTML = `<div class="dp-empty">${esc(r.data?.error || 'Could not load designs.')}</div>`; return; }
    $('#dp-count').textContent = `${r.data.length} design${r.data.length === 1 ? '' : 's'}`;
    grid.innerHTML = '';
    if (!r.data.length) grid.innerHTML = '<div class="dp-empty">No designs yet. Use <b>Save</b> (Ctrl+S) to store the current model in your profile.</div>';
    for (const pr of r.data) {
      const el = card(pr.name, { modified: pr.modified, thumb: pr.thumb, ver: pr.ver, del: true });
      el.onclick = async (e) => {
        if (e.target.closest('.dp-del')) return;
        if (dirty && !confirm('Discard unsaved changes?')) return;
        const d = await call('GET', '/projects/' + encodeURIComponent(pr.name));
        if (!d.ok) return toast(d.data?.error || 'Could not open design.', true);
        try { loadProject(typeof d.data === 'string' ? d.data : JSON.stringify(d.data)); doc.name = pr.name; $('#doc-name').textContent = pr.name; refresh(); } catch (x) { toast(x.message, true); }
      };
      el.querySelector('.dp-del').onclick = async () => {
        if (!confirm(`Delete "${pr.name}" permanently?`)) return;
        await call('DELETE', '/projects/' + encodeURIComponent(pr.name));
        renderDataPanel();
      };
      grid.appendChild(el);
    }
  } else {
    $('#dp-count').textContent = acct.server ? 'Signed out' : 'Offline';
    grid.innerHTML = '';
    if (doc.features.length || doc.name !== 'Untitled') grid.appendChild(card(doc.name, { ver: (doc.saves || 0) + 1 }));
    grid.insertAdjacentHTML('beforeend', acct.server
      ? `<div class="dp-empty">Sign in to see the designs saved on this server.<br><button class="btn primary" id="dp-signin" style="margin-top:10px">Sign in</button></div>`
      : '<div class="dp-empty">Saving to the server needs the Sketchy container (<code>docker compose up</code>). Use <b>File → Open from my computer</b> to open a project file.</div>');
    $('#dp-signin')?.addEventListener('click', async () => { if (await showAuth()) renderDataPanel(); });
  }
}

function bindKeys() {
  addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (!$('#marking').hidden) { if (e.key === 'Escape') closeMarking(); return; }
    if (mod && key === 's') { e.preventDefault(); save(false); return; }
    if (mod && key === 'n') { e.preventDefault(); newDoc(); return; }
    if (typing) { if (e.key === 'Enter' && !document.activeElement.closest('.modal')) document.activeElement.blur(); return; }
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      if (navMode !== 'orbit') { setNavMode('orbit'); return; }
      if (measure) { endMeasure(); return; }
      if (sketch?.pts) { sketch.pts = null; vp.overlay.clear(); } else if (sketch) cancelSketch(); else if (dialog) closeDialog(false);
      return;
    }
    if (e.key === 'Enter' && (sketch?.tool === 'line' || sketch?.tool === 'path') && sketch.pts) { closePath(); return; }
    if (sketch && !sketch.picking) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sketch.sel >= 0) sketchDeleteSelected();
      const t = { l: 'sk_line', r: 'sk_rect', c: 'sk_circle' }[key];
      if (t && !mod) runCommand(t);
      return;
    }
    if (dialog) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (vp.selected.size) deleteSelection(); return; }
    if (mod) return;
    const map = { e: 'extrude', q: 'presspull', f: 'fillet', m: 'move', h: 'hole', j: 'joint', i: 'measure' };
    if (map[key]) runCommand(map[key]);
    else if (key === 's') { e.preventDefault(); openQuickSearch(); }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const caret = uicon('caret', 7, 0).replace('class="ui"', 'class="ui caret"');
  const set = (id, html) => { $('#' + id).innerHTML = html; };
  set('btn-home', uicon('home', 18, 1.5)); set('btn-data', uicon('grid', 18, 1.5));
  set('btn-menu', uicon('file', 18, 1.5) + caret); set('btn-save', uicon('save', 18, 1.5));
  set('btn-undo', uicon('undo', 18, 1.5) + caret); set('btn-redo', uicon('redo', 18, 1.5) + caret);
  set('btn-newtab', uicon('plus', 18, 1.8)); set('btn-job', uicon('jobs', 20, 1.5)); set('btn-ext', uicon('sparkle', 18, 1.4));
  set('btn-clock', uicon('clock', 18, 1.5)); set('btn-bell', uicon('bell', 18, 1.5)); set('btn-help', uicon('help', 18, 1.5));
  set('btn-closedoc', uicon('close', 12, 2));
  document.querySelector('.doc-ic').innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2L21 7V17L12 22L3 17V7Z" fill="#f08c00"/><path d="M12 12L21 7M12 12V22M12 12L3 7" stroke="#fff" stroke-width="1.5" fill="none"/></svg>';
  set('pt-collapse', uicon('collapse', 12, 1.6)); set('pt-min', uicon('minus', 12, 2)); set('btn-addcomment', uicon('plus', 14, 2));
  set('tl-settings', uicon('gear', 18, 1.5)); set('cube-home', uicon('home', 14, 1.6)); set('cube-menu', uicon('caret', 10, 0));
  $('#viewport').insertAdjacentHTML('beforeend', '<div id="loading" style="position:absolute;inset:0;display:grid;place-items:center;color:#667">Loading CAD kernel…</div>');
  await initKernel();
  vp = new Viewport($('#gl'), $('#cube'));
  vp.opts.bedSize = PRINTERS[bedName] || vp.opts.bedSize;
  vp.buildBed();
  vp.home();
  $('#loading')?.remove();
  buildNavBar(); bindViewport(); bindZoomWindow(); bindKeys();
  $('#btn-menu').dataset.menu = 1;
  $('#btn-menu').onclick = fileMenu;
  $('#btn-save').onclick = () => save(false);
  $('#btn-undo').onclick = undo; $('#btn-redo').onclick = redo;
  $('#btn-home').onclick = () => toggleDataPanel(true);
  $('#btn-data').onclick = () => toggleDataPanel();
  $('#btn-newtab').onclick = newDoc; $('#btn-closedoc').onclick = newDoc;
  $('#btn-job').onclick = () => toast('No background jobs.');
  $('#btn-ext').onclick = openQuickSearch;
  $('#btn-clock').onclick = () => toast('Recent saves appear in the data panel.');
  $('#btn-bell').onclick = () => toast('No new notifications.');
  $('#btn-help').onclick = () => toast('Tip: press S to search every command, right-click for the marking menu.');
  $('#pt-min').onclick = $('#pt-collapse').onclick = () => $('#browser').classList.toggle('min');
  $('#btn-addcomment').onclick = () => toast('Comments are not available yet.');
  $('#tl-settings').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left - 150, r.top - 80, [{ label: 'Capture position', dim: true, run: () => toast('Not available yet.') }, { label: 'Collapse all features', dim: true, run: () => toast('Not available yet.') }]); };
  $('#cube-home').onclick = () => vp.home();
  $('#cube-menu').dataset.menu = 1;
  $('#cube-menu').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left - 140, r.bottom + 4, [{ label: 'Go Home', uicon: 'home', run: () => vp.home() }, { sep: true }, { label: 'Orthographic', check: vp.opts.ortho, run: () => vp.setOrtho(true) }, { label: 'Perspective', check: !vp.opts.ortho, run: () => vp.setOrtho(false) }]); };
  $('#file-stl').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSTL(f); };
  $('#file-proj').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) try { loadProject(await f.text()); } catch (x) { toast(x.message, true); } };
  $('#viewport').addEventListener('dragover', (e) => e.preventDefault());
  $('#viewport').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && /\.stl$/i.test(f.name)) importSTL(f); });
  await refreshAccount();
  setAccountMenuHandler((anchor) => { const r = anchor.getBoundingClientRect(); showMenu(r.right - 200, r.bottom + 4, [{ head: `SIGNED IN AS ${acct.user.toUpperCase()}` }, { label: 'My Designs…', uicon: 'folder', run: () => toggleDataPanel(true) }, { sep: true }, { label: 'Sign out', run: async () => { await signOut(); toast('Signed out'); if (dataOpen) renderDataPanel(); } }]); });
  try { const a = localStorage.getItem('sketchy.autosave'); if (a) { const d = JSON.parse(a); if (d.features?.length) { loadProject(a); toast('Restored your last session'); } } } catch { /* ignore */ }
  if (localStorage.getItem('sketchy.data') === '1') toggleDataPanel(true);
  refresh();
  window.__sketchy = { get doc() { return doc; }, get result() { return result; }, vp, startFeature, rebuild, refresh, runCommand, openMarking };
}
boot();
