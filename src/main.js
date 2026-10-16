import './style.css';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { icon } from './icons.js';
import { initKernel, rebuild, resolvePlanes, shapeToPolygon, PLANES, encodeFloats, profilesOf, planeFrame, findFaceTri, interference } from './kernel.js';
import { FEATURES, defOf, LAST, fieldKind } from './features.js';
import { parseSTL, writeSTL } from './stl.js';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluate as evaluateDoc } from './headless.js';
import { initA11y } from './a11y.js';
import { initTheme, getTheme, setTheme, onTheme } from './theme.js';
initTheme();
const LOGO_MARK = '<svg viewBox="0 0 64 64" width="16" height="16"><rect x="4" y="4" width="56" height="56" rx="14" fill="#169b62"/><path d="M40 22C36 17 24 18 24 26C24 34 40 30 40 39C40 47 27 48 22 42" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>';
import { parseSVG, parseDXF, textShapes } from './import2d.js';
import { repairSoup, describeRepair } from './meshrepair.js';
import { writeOBJ, write3MF, writeSTEP } from './exporters.js';
import { Viewport } from './viewport.js';
import { findEdgeChains, matchChain, roundPts, planarFace, norm as vnorm } from './edges.js';
import { acct, call, refreshAccount, ensureSignedIn, requireLogin, showAuth, showDesigns, signOut, setAccountMenuHandler, setAccountChangeHandler, modal, showChangePassword, showAccount, openUserMenu, showAdmin } from './account.js';
import { evalExpr, resolveParams, applyConfig, resolveFeature, isPlainNumber, NAME_RE, RESERVED } from './params.js';
import { saveDialog, askName, confirmBox, alertBox, chooseFolder, safeName as fileSafeName } from './files.js';
import { UNIT_TABLE, UNIT_NAMES, setUnits, getUnits, lenF, dispStr, fmtLen, fmtArea, fmtVolume, niceStep } from './units.js';
import { findEdgeChains as chainsOf } from './edges.js';
import { ficon, uicon } from './ficons.js';
import { createSketchUI } from './sketchui.js';
import { resolveSketch } from './sketchdims.js';
import { CON_GLYPH, CON_LABEL } from './sketchcons.js';
import { CMD, WORKSPACE_TABS, TOOLBAR, SKETCH_TOOLBAR } from './commands.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PRINTERS = {
  'Bambu Lab X1 / P1 (256³)': [256, 256, 256], 'Prusa MK4 (250×210×220)': [250, 210, 220], 'Prusa MINI (180³)': [180, 180, 180],
  'Creality Ender-3 (220×220×250)': [220, 220, 250], 'Voron 2.4 (350³)': [350, 350, 350],
};

// ------------------------------------------------------------------ state
const blankDoc = () => ({ name: 'Untitled', features: [], marker: 0, nextId: 1, params: [], appearance: {}, units: 'mm', components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [] });
let bedName = localStorage.getItem('sketchy.bed') || Object.keys(PRINTERS)[0];
let doc = blankDoc();
let undoStack = [], redoStack = [];
let result = { bodies: [], errors: {}, snaps: [], sketchUsed: new Set() };
let dirty = false;
let tab = 'SOLID';
let selFeature = null;           // timeline selection (primary)
let selSet = new Set();          // timeline multi-selection
let paramState = { values: {}, errors: {} };
let resolvedMap = {};
let measure = null;
let navMode = 'orbit';
let SU = null;
let profileHover = null;
const profileCache = new WeakMap();
let originVis = false;
const canvasHidden = new Set();
const planeHidden = new Set(); // construction planes hidden in the viewport
let dataOpen = false;
let lastCmd = null;
const loadPriority = () => { try { return localStorage.getItem('sketchy.selPriority') === 'body' ? 'body' : 'face'; } catch { return 'face'; } };
let prefPriority = loadPriority(); // what a plain click picks: faces by default; whole bodies if you chose that
let selPriority = prefPriority;
const savePriority = (v) => { prefPriority = v; try { localStorage.setItem('sketchy.selPriority', v); } catch { /* storage unavailable */ } };
let selMode = 'click';           // click | window | freeform | paint (drag-selection tools)
let selFace = null;
let selEdges = [];
let profSel = new Set(), profHover = null; // idle sketch-region selection: keys "sketchId|profileId"
let edgeHover = null;
const chainCache = new WeakMap();
let playTimer = null;
let dialog = null;               // {index, isNew, pre, mode}
let sketch = null;               // active sketch session
const hiddenBodies = new Set();
const sketchVis = {};
const collapsed = { views: true, origin: true };

let vp;
const snapshot = () => ({ features: [...doc.features], marker: doc.marker, nextId: doc.nextId, params: [...(doc.params || [])], appearance: { ...(doc.appearance || {}) }, components: (doc.components || []).map((c) => ({ ...c })), bodyComp: { ...(doc.bodyComp || {}) }, configs: JSON.parse(JSON.stringify(doc.configs || [])), activeConfig: doc.activeConfig || null, canvases: (doc.canvases || []).map((c) => ({ ...c })) });
const restore = (s) => { doc.features = [...s.features]; doc.marker = s.marker; doc.nextId = s.nextId; doc.params = [...(s.params || [])]; doc.appearance = { ...(s.appearance || {}) }; doc.components = (s.components || []).map((c) => ({ ...c })); doc.bodyComp = { ...(s.bodyComp || {}) }; doc.configs = JSON.parse(JSON.stringify(s.configs || [])); doc.activeConfig = s.activeConfig || null; doc.canvases = (s.canvases || []).map((c) => ({ ...c })); };
function pushUndo(s) { undoStack.push(s); if (undoStack.length > 100) undoStack.shift(); redoStack = []; markDirty(); }
function markDirty() { dirty = true; $('#doc-dirty').classList.add('on'); scheduleAutosave(); scheduleServerSave(); nameUntitled(); }
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
  paramState = resolveParams(applyConfig(doc.params || [], doc.configs, doc.activeConfig));
  const evalErr = {};
  let feats = doc.features.map((f) => {
    const r = resolveFeature(f, (n) => paramState.values[n], (ff, path) => (fieldKind(ff, path.split('.')[0]) === 'len' ? 'len' : 'num'));
    if (r.error) evalErr[f.id] = r.error;
    let ff = r.params === f.params ? f : { ...f, params: r.params };
    if (f.type === 'sketch') {
      const rs = resolveSketch(ff, (n) => paramState.values[n]);
      if (rs.error) evalErr[f.id] ||= rs.error;
      if (rs.params !== ff.params) ff = { ...ff, params: rs.params };
    }
    return ff;
  });
  feats = resolvePlanes(feats);
  feats.forEach((f, i) => { // keep sketches that sit on a construction plane in step with it (no undo entry)
    const orig = doc.features[i];
    if (f.type === 'sketch' && f.params.planeRef && orig && orig.params.planeRef && (orig.params.plane !== 'custom' || ['origin', 'normal', 'xdir'].some((k) => !orig.params[k] || orig.params[k].some((v, j) => Math.abs(v - f.params[k][j]) > 1e-9)))) {
      doc.features[i] = { ...orig, params: { ...orig.params, plane: 'custom', origin: f.params.origin, normal: f.params.normal, xdir: f.params.xdir } };
    }
  });
  resolvedMap = Object.fromEntries(feats.map((f) => [f.id, f.params]));
  vp.setCanvases((doc.canvases || []).map((c) => ({ ...c, hidden: canvasHidden.has(c.id) })));
  vp.setConstructionPlanes(feats.filter((f, i) => f.type === 'plane' && !f.suppressed && i < limit()).map((f) => ({ id: f.id, name: f.name, origin: f.params.origin, normal: f.params.normal, xdir: f.params.xdir, hidden: planeHidden.has(f.id) })));
  try { result = rebuild(feats, limit(), { bodyComp: doc.bodyComp, capture: pickF ? dialog.index : -1, previewId: dialog ? doc.features[dialog.index]?.id : null }); }
  catch (e) { console.error(e); toast('Kernel error: ' + e.message, true); return; }
  for (const [id, m] of Object.entries(evalErr)) result.errors[id] ||= m;
  vp.bodyColors = doc.appearance || {};
  vp.setBodies([...result.bodies, ...(result.surfaces || [])].filter((b) => !hiddenBodies.has(b.id)));
  for (const id of [...vp.selected]) if (!result.bodies.some((b) => b.id === id)) vp.selected.delete(id);
  vp.refreshMaterials();
  drawSketches();
  updateProfileView();
  vp.setPreview(dialog ? result.preview : null);
  updateManip();
  updatePickEdges();
  if (selFace && !result.bodies.some((b) => b.id === selFace.id)) selFace = null;
  updateEdgeView();
  if (dialog) updateFaceHL(); else if (!sketch && !measure) vp.showFaces(selFace ? [selFace] : [], null);
  renderTree(); renderTimeline(); renderRibbon(); renderStatus();
  $('#btn-undo').disabled = !undoStack.length || !!dialog || !!sketch;
  $('#btn-redo').disabled = !redoStack.length || !!dialog || !!sketch;
  if (dialog) renderDialogErrors();
}

// ---- sketch profile regions
function profilesFor(sk) {
  const params = resolvedMap[sk.id] || sk.params;
  let r = profileCache.get(params);
  if (!r) { try { r = profilesOf({ ...sk, params }); } catch { r = []; } profileCache.set(params, r); }
  return r;
}
function effectiveProfiles(df, sk) {
  const items = profilesFor(sk);
  const ids = df.params.profiles?.filter((id) => items.some((i) => i.id === id));
  return new Set(ids?.length ? ids : items.filter((i) => i.defaultOn).map((i) => i.id));
}
function updateProfileView() {
  if (!vp) return;
  let sk = null, pickable = false, selected = null;
  if (sketch && !sketch.picking) { if (sketch.showProfile !== false) sk = curSketch(); }
  else if (dialog) {
    const df = doc.features[dialog.index];
    if (defOf(df)?.fields.some((x) => x.type === 'profiles')) { sk = doc.features.find((k) => k.id === df.params.sketch); pickable = true; if (sk) selected = effectiveProfiles(df, sk); }
  }
  if (!sk && !sketch && !dialog && !measure) { // nothing active: show the regions of visible, unused sketches so they can be picked
    const groups = [];
    doc.features.forEach((f, i) => {
      if (f.type !== 'sketch' || f.suppressed || i >= limit() || !(sketchVis[f.id] ?? !result.sketchUsed.has(f.id))) return;
      groups.push({ items: profilesFor(f), params: resolvedMap[f.id] || f.params, pickable: true, sk: f.id });
    });
    const live = new Set(groups.flatMap((g) => g.items.map((it) => `${g.sk}|${it.id}`)));
    profSel = new Set([...profSel].filter((k) => live.has(k)));
    vp.setProfileGroups(groups);
    vp.setProfileState(profSel, profHover);
    return;
  }
  if (!sk || sk.type !== 'sketch') { vp.setProfiles([], null); return; }
  vp.setProfiles(profilesFor(sk), sk.params, pickable);
  vp.setProfileState(selected, profileHover);
}

// ---- direct edge selection (hover / click edges, then Fillet or Chamfer)
function chainsFor(b) {
  let c = chainCache.get(b);
  if (!c) { c = chainsOf(b.verts, 3, b.tris); chainCache.set(b, c); }
  return c;
}
function edgeEntries() {
  const out = [];
  for (const b of result.bodies) if (!hiddenBodies.has(b.id)) for (const chain of chainsFor(b)) out.push({ body: b.id, chain });
  return out;
}
function resolveSelEdges() {
  const out = [];
  for (const e of selEdges) {
    const b = result.bodies.find((x) => x.id === e.body);
    const ch = b && matchChain(chainsFor(b), e.pts);
    if (ch) out.push({ e, chain: ch });
  }
  selEdges = out.map((x) => x.e);
  return out.map((x) => x.chain);
}
function updateEdgeView() {
  if (!vp) return;
  if (dialog || sketch || measure) { vp.showEdges([], null); return; }
  const chains = resolveSelEdges();
  vp.showEdges(chains, edgeHover?.chain || null);
  if (chains.length) $('#hud').innerHTML = `<b>${chains.length} edge${chains.length > 1 ? 's' : ''} selected</b> — press F to fillet · use Chamfer in MODIFY · Esc to clear`;
  else if (/edges? selected/.test($('#hud').textContent)) $('#hud').innerHTML = '';
}
function toggleSelEdge(en, additive) {
  const pts = roundPts(en.chain.pts);
  const same = (e) => e.body === en.body && matchChain([en.chain], e.pts);
  const has = selEdges.some(same);
  if (!additive) { selEdges = has && selEdges.length === 1 ? [] : [{ body: en.body, pts }]; }
  else selEdges = has ? selEdges.filter((e) => !same(e)) : [...selEdges, { body: en.body, pts }];
  selFace = null; vp.selected.clear(); vp.refreshMaterials(); vp.showFaces([], null);
  updateEdgeView(); renderTree(); renderRibbon();
}
/** All edges around a flat face (its perimeter), as {body, pts} entries. */
function edgesOfFace(f) {
  const b = result.bodies.find((x) => x.id === f.id);
  if (!b) return [];
  const tri = findFaceTri(b.verts, b.tris, f.point, f.normal);
  if (tri < 0) return [];
  const face = planarFace(b.verts, b.tris, tri);
  if (!face) return [];
  const V = (i) => [b.verts[i * 3], b.verts[i * 3 + 1], b.verts[i * 3 + 2]];
  const tris = face.tris.map((t) => [V(b.tris[t * 3]), V(b.tris[t * 3 + 1]), V(b.tris[t * 3 + 2])]);
  const dist2Seg = (p, a, c) => { const ab = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]; const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1; const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)); return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]); };
  const onBoundary = (p) => tris.some(([a, c, d]) => Math.min(dist2Seg(p, a, c), dist2Seg(p, c, d), dist2Seg(p, d, a)) < 2e-3);
  const n = f.normal, d0 = n[0] * f.point[0] + n[1] * f.point[1] + n[2] * f.point[2];
  return chainsFor(b)
    .filter((ch) => ch.pts.every((p) => Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d0) < 2e-3 && onBoundary(p)))
    .map((ch) => ({ body: b.id, pts: roundPts(ch.pts) }));
}

// ---- on-canvas distance manipulator (extrude arrow + value box)
function updateManip() {
  if (!vp) return;
  const box = $('#manip-label');
  const hide = () => { vp.setManip(null); box.hidden = true; $('#manip-tip').hidden = true; };
  if (!dialog) return hide();
  const df = doc.features[dialog.index], m = defOf(df)?.manip;
  const rp = resolvedMap[df.id] || df.params;
  if (!m || (m.show && !m.show(rp))) return hide();
  if (m.edge) {
    // arrow from the middle of the first selected edge along the bisector of its two faces
    const e0 = df.params.edges?.[0];
    const cap = e0 && result.captured?.find((b) => b.id === e0.body);
    const ch = cap && matchChain(chainsOf(cap.verts, 3, cap.tris), e0.pts);
    if (!ch) return hide();
    const k = Math.floor(ch.pts.length / 2), fr = ch.frames[k] || ch.frames[0];
    const dir = vnorm([fr.u1[0] + fr.u2[0], fr.u1[1] + fr.u2[1], fr.u1[2] + fr.u2[2]]);
    const val = +rp[m.key] || 0;
    vp.setManip(ch.pts[k], dir, val);
    box.hidden = false;
    const inp2 = box.querySelector('input');
    if (document.activeElement !== inp2) inp2.value = df.exprs?.[m.key] ?? dispStr(val);
    return;
  }
  const sk = doc.features.find((k) => k.id === df.params[m.sketch]);
  if (!sk || sk.type !== 'sketch') return hide();
  const pts = [];
  if (defOf(df).fields.some((x) => x.type === 'profiles')) {
    const sel = effectiveProfiles(df, sk);
    for (const pr of profilesFor(sk)) if (sel.has(pr.id)) pr.polys.forEach((pl) => pts.push(...pl));
  } else sk.params.shapes.forEach((sh) => pts.push(...shapeToPolygon(sh)));
  if (!pts.length) return hide();
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const u = (Math.min(...xs) + Math.max(...xs)) / 2, v = (Math.min(...ys) + Math.max(...ys)) / 2;
  const fr = planeFrame(sk.params);
  const base = [0, 1, 2].map((k) => fr.o[k] + fr.x[k] * u + fr.y[k] * v);
  const dist = +rp[m.key] || 0;
  vp.setManip(base, fr.n, rp.symmetric ? dist / 2 : dist);
  box.hidden = false;
  const inp = box.querySelector('input');
  if (document.activeElement !== inp) inp.value = df.exprs?.[m.key] ?? dispStr(dist);
}
function bindManip() {
  const box = $('#manip-label'), inp = box.querySelector('input'), cv = $('#gl');
  const manipFrame = () => {
    if (box.hidden || !vp.manip) return;
    const sp = vp.toScreen(vp.manip.label), tipEl = $('#manip-tip');
    tipEl.hidden = false; tipEl.textContent = inp.value && /^[-\d.]/.test(inp.value) ? (+parseFloat(inp.value)).toFixed(2) : inp.value;
    tipEl.style.left = (sp.x + 24) + 'px'; tipEl.style.top = (sp.y - 4) + 'px';
    box.style.left = (sp.x + 100) + 'px'; box.style.top = (sp.y + 34) + 'px'; // value box sits off to the lower right of the arrow
    const hide = sp.behind ? 'none' : '';
    box.style.display = hide; tipEl.style.display = hide;
  };
  vp.onFrame = () => { manipFrame(); if (sketch && !sketch.picking && SU) SU.frame(); };
  inp.oninput = () => {
    if (!dialog) return;
    const df = doc.features[dialog.index], m = defOf(df).manip, fld = defOf(df).fields.find((x) => x.key === m.key);
    const r = commitNumber(dialog.index, m.key, inp.value.trim() || '0', fld);
    inp.classList.toggle('bad', !r.ok);
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { inp.blur(); closeDialog(true); } else if (e.key === 'Escape') { inp.blur(); closeDialog(false); } };
  inp.onfocus = () => inp.select();
  $('#viewport').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== cv || !dialog || !vp.manip || !vp.pickManip(e)) return;
    const df = doc.features[dialog.index], m = defOf(df).manip, fld = defOf(df).fields.find((x) => x.key === m.key);
    e.stopPropagation();
    vp.controls.enabled = false;
    const sym = !!(resolvedMap[df.id] || df.params).symmetric;
    const move = (ev) => {
      let d = vp.manipDistance(ev);
      if (d == null) return;
      if (!ev.shiftKey) d = Math.round(d * 2) / 2;
      commitNumber(dialog.index, m.key, dispStr(sym ? d * 2 : d, 6), fld);
    };
    const up = () => { removeEventListener('pointermove', move); vp.controls.enabled = true; renderDialog(); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }, true);
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

const paramShow = (p, v) => (v === undefined ? '' : p.unit === 'number' ? String(+v.toFixed(4)) : p.unit === 'angle' ? `${+v.toFixed(4)}°` : fmtLen(v));
function unitsMenu(anchor) {
  const r = (anchor || $('#tree')).getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [{ head: 'DOCUMENT UNITS' }, ...Object.keys(UNIT_TABLE).map((u) => ({ label: `${UNIT_NAMES[u]} (${u})`, check: getUnits() === u, run: () => setDocUnits(u) }))]);
}
function setDocUnits(u) {
  if (u === getUnits()) return;
  doc.units = u; setUnits(u); markDirty();
  if (dialog) renderDialog();
  renderTree(); renderStatus(); renderSketchPanel?.(); refresh();
  toast(`Units: ${UNIT_NAMES[u]}. Everything is stored in millimetres, so existing geometry doesn't change.`);
}
function renderStatus() {
  const n = result.bodies.length;
  const tris = result.bodies.reduce((a, b) => a + b.tris.length / 3, 0);
  $('#statusbar').textContent = `${n} ${n === 1 ? 'body' : 'bodies'} · ${tris.toLocaleString()} triangles · ${getUnits()}`;
}

// ------------------------------------------------------------------ toolbar (familiar CAD style)
CMD.cancelpick = { label: 'Cancel', icon: 'remove' };
const MEASURE_MODE = { measure: 'dist', angle: 'angle', edgelen: 'edge', faces: 'faces' };
const CUSTOM = {
  parameters: () => openParameters(),
  newcomp: () => newComponent(),
  derive: () => showInsertDesign(false), cfg2: () => showInsertDesign(true),
  canvas: () => pickCanvasImage(),
  cfg1: () => showConfigurations(), cfg3: (ev) => showConfigMenu(ev?.currentTarget),
  importstl: () => $('#file-stl').click(),
  measure: () => startMeasure('dist'), angle: () => startMeasure('angle'), edgelen: () => startMeasure('edge'), faces: () => startMeasure('faces'),
  properties: () => showInfo(),
  interference: () => showInterference(),
  section: () => showSection(),
  drivejoints: () => showDriveJoints(),
  svg: () => pick2D('.svg,image/svg+xml'), dxf: () => pick2D('.dxf'), sk_text: () => showTextDialog(),
  asbuilt: () => startAsBuilt(),
  export: () => exportDialog(),
  printer: () => printerMenu($('#ribbon')),
  buildvol: () => { vp.opts.bed = !vp.opts.bed; vp.refreshMaterials(); renderRibbon(); },
  select: (ev) => selectionMenu(ev?.currentTarget), finishsketch: () => finishSketch(), cancelpick: () => cancelSketch(),
};
function runCommand(id, ev) {
  const c = CMD[id];
  if (!c) return;
  if (c.off) return toast(c.why || `${c.label} isn't available in Sketchy yet.`);
  if (c.sk) { if (sketch && !sketch.picking) setSketchTool(c.sk); return; }
  if (c.skAction === 'delete') return sketchDeleteSelected();
  if (sketch && !['select', 'finishsketch', 'cancelpick', 'svg', 'dxf', 'sk_text'].includes(id)) return toast('Finish the sketch first.');
  if (id === 'remove') { lastCmd = id; return deleteSelection(); }
  if (selFace && id === 'extrude') { lastCmd = id; return startFeature('presspull'); }
  if (selFace && id === 'sketch') { lastCmd = id; return sketchOnSelectedFace(); }
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

function selectionMenu(anchor) {
  const r = (anchor || $('#ribbon')).getBoundingClientRect();
  showMenu(r.left - 60, r.bottom + 2, [
    { head: 'SELECTION PRIORITY' },
    { label: 'Body priority', check: selPriority === 'body', run: () => { selPriority = 'body'; savePriority('body'); selFace = null; vp.showFaces([], null); toast('Click selects whole bodies.'); } },
    { label: 'Face priority (default)', check: selPriority === 'face', run: () => { selPriority = 'face'; savePriority('face'); vp.selected.clear(); vp.refreshMaterials(); toast('Click selects flat faces — then press Q, E (pull), H (hole) or Create Sketch.'); } },
    { sep: true },
    { head: 'SELECTION MODE' },
    ...[['click', 'Click selection', 'Click picks a face (or a body, if you chose body priority); double-click picks the whole body; drag orbits.'], ['window', 'Window selection', 'Drag a rectangle: left to right takes bodies fully inside, right to left takes any it touches.'], ['freeform', 'Freeform selection', 'Drag a loop around bodies to select every body it touches.'], ['paint', 'Paint selection', 'Drag over bodies to select them. Middle mouse or Esc to leave.']]
      .map(([m, label, tip]) => ({ label, check: selMode === m, run: () => { selMode = m; if (m !== 'click' && selPriority === 'face') { selPriority = 'body'; selFace = null; vp.showFaces([], null); } else if (m === 'click') selPriority = prefPriority; toast(`${tip}${m !== 'click' ? ' Hold Shift to add. Esc for click selection.' : ''}`); renderRibbon(); } })),
  ]);
}
function sketchOnSelectedFace() {
  const n = selFace.normal.map((c) => (Math.abs(c) < 1e-6 ? 0 : +c.toFixed(6)));
  const d = n[0] * selFace.point[0] + n[1] * selFace.point[1] + n[2] * selFace.point[2];
  const nl = Math.hypot(...n), nn = n.map((c) => c / nl);
  const xdir = Math.abs(nn[2]) > 0.99 ? [1, 0, 0] : [-nn[1] / Math.hypot(nn[0], nn[1]), nn[0] / Math.hypot(nn[0], nn[1]), 0].map((q) => +q.toFixed(6));
  selFace = null; vp.showFaces([], null);
  sketch = { picking: true, index: doc.marker };
  enterSketch(sketch.index, true, { plane: 'custom', origin: n.map((c) => +(c * d).toFixed(4)), normal: nn.map((c) => +c.toFixed(6)), xdir });
}
function renderRibbon() {
  vp.hold('sketch', !!sketch);
  const wb = $('#btn-workspace');
  wb.innerHTML = '<span>DESIGN</span>'; wb.setAttribute('aria-label', 'Design workspace'); wb.disabled = true; wb.style.cursor = 'default';
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
      b.dataset.tip = JSON.stringify({ t: c.label, k: c.key || '', d: c.desc || (c.off ? 'Not available in Sketchy yet.' : '') });
      b.innerHTML = ficon(c.icon, g.big ? 40 : 30) + (g.finish ? '<span>FINISH SKETCH</span>' : '');
      b.disabled = !!dialog && !sketch;
      b.onclick = (ev) => runCommand(id, ev);
      b.setAttribute('aria-label', c.label); if (off) b.setAttribute('aria-disabled', 'true');
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
    folder(1, 'docset', 'Document Settings', 'gear', {}, () => { R(2, `Units: ${getUnits()}, g`, { kind: 'file', click: (ev) => unitsMenu(ev.currentTarget) }); R(2, 'Part Design', { kind: 'body', dim: true }); });
    folder(1, 'views', 'Named Views', 'folder', {}, () => R(2, 'Home', { kind: 'camera', click: () => vp.home(true) }));
    folder(1, 'origin', 'Origin', 'folder', { eye: originVis, onEye: () => { originVis = !originVis; vp.setOriginVisible(originVis); renderTree(); } }, () => {
      for (const n of ['XY', 'XZ', 'YZ']) R(2, n, { kind: 'plane', dim: true });
      for (const n of ['X', 'Y', 'Z']) R(2, n, { kind: 'axis', dim: true });
      R(2, 'Origin', { kind: 'point', dim: true });
    });
    const planes = doc.features.map((f, i) => [f, i]).filter(([f, i]) => f.type === 'plane' && i < limit());
    if (planes.length) folder(1, 'construction', 'Construction', 'folder', {}, () => planes.forEach(([f]) => R(2, f.name, { kind: 'plane', eye: !planeHidden.has(f.id), sel: selSet.has(f.id), onEye: () => { planeHidden.has(f.id) ? planeHidden.delete(f.id) : planeHidden.add(f.id); refresh(); }, click: (ev) => selectFeature(f.id, ev), dbl: () => editFeature(featureIndex(f.id)) })));
    if ((doc.canvases || []).length) folder(1, 'canvases', 'Canvases', 'folder', {}, () => doc.canvases.forEach((c) => R(2, c.name, { kind: 'camera', ctx: { kind: 'canvas', id: c.id }, eye: !canvasHidden.has(c.id), onEye: () => { canvasHidden.has(c.id) ? canvasHidden.delete(c.id) : canvasHidden.add(c.id); refresh(); }, dbl: () => showCanvasDialog(c) })));
    if ((doc.params || []).length) folder(1, 'params', 'Parameters', 'gear', {}, () => { const ac = (doc.configs || []).find((c) => c.id === doc.activeConfig); if (ac) R(2, `Configuration: ${ac.name}`, { kind: 'file', dim: true }); doc.params.forEach((p) => R(2, p.name, { kind: 'file', val: paramState.errors[p.name] ? '⚠' : `= ${paramShow(p, paramState.values[p.name])}`, click: openParameters })); });
    const bodyRow = (b, d) => R(d, b.name, { kind: 'body', ctx: { kind: 'body', id: b.id }, eye: !hiddenBodies.has(b.id), sel: vp.selected.has(b.id), onEye: () => { hiddenBodies.has(b.id) ? hiddenBodies.delete(b.id) : hiddenBodies.add(b.id); refresh(); }, click: (ev) => selectBody(b.id, ev.shiftKey) });
    for (const comp of doc.components || []) {
      const mine = result.bodies.filter((b) => doc.bodyComp?.[b.id] === comp.id);
      const vis = mine.some((b) => !hiddenBodies.has(b.id));
      folder(1, 'comp:' + comp.id, comp.name, 'comp', { ctx: { kind: 'component', id: comp.id }, eye: mine.length ? vis : true, onEye: () => { mine.forEach((b) => (vis ? hiddenBodies.add(b.id) : hiddenBodies.delete(b.id))); refresh(); }, dbl: () => renameComponent(comp.id) }, () => { if (mine.length) mine.forEach((b) => bodyRow(b, 2)); else R(2, 'Empty', { kind: 'file', dim: true }); });
    }
    if ((result.surfaces || []).length) {
      const sv = result.surfaces.some((q) => !hiddenBodies.has(q.id));
      folder(1, 'surfaces', 'Surfaces', 'folder', { eye: sv, onEye: () => { result.surfaces.forEach((q) => (sv ? hiddenBodies.add(q.id) : hiddenBodies.delete(q.id))); refresh(); } }, () => result.surfaces.forEach((q) => R(2, q.name, { kind: 'body', ctx: { kind: 'body', id: q.id }, eye: !hiddenBodies.has(q.id), sel: vp.selected.has(q.id), onEye: () => { hiddenBodies.has(q.id) ? hiddenBodies.delete(q.id) : hiddenBodies.add(q.id); refresh(); }, click: (ev) => selectBody(q.id, ev.shiftKey) })));
    }
    const loose = result.bodies.filter((b) => !(doc.components || []).some((c) => c.id === doc.bodyComp?.[b.id]));
    if (loose.length) {
      const anyVis = loose.some((b) => !hiddenBodies.has(b.id));
      folder(1, 'bodies', 'Bodies', 'folder', { eye: anyVis, onEye: () => { loose.forEach((b) => (anyVis ? hiddenBodies.add(b.id) : hiddenBodies.delete(b.id))); refresh(); } }, () => loose.forEach((b) => bodyRow(b, 2)));
    }
    const sk = doc.features.map((f, i) => [f, i]).filter(([f, i]) => f.type === 'sketch' && i < limit() + (sketch ? 1 : 0));
    if (sk.length) {
      const visOf = (f) => sketchVis[f.id] ?? !result.sketchUsed.has(f.id);
      folder(1, 'sketches', 'Sketches', 'folder', { eye: sk.some(([f]) => visOf(f)), onEye: () => { const v = !sk.some(([f]) => visOf(f)); sk.forEach(([f]) => (sketchVis[f.id] = v)); drawSketches(); renderTree(); } }, () => sk.forEach(([f]) => {
        R(2, f.name, { kind: 'sketch', eye: visOf(f), sel: selSet.has(f.id), ctx: { kind: 'sketch', id: f.id }, onEye: () => { sketchVis[f.id] = !visOf(f); drawSketches(); renderTree(); }, click: (ev) => selectFeature(f.id, ev), dbl: () => editFeature(featureIndex(f.id)) });
      }));
    }
    const joints = doc.features.filter((f, i) => f.type === 'joint' && i < limit());
    if (joints.length) folder(1, 'joints', 'Joints', 'folder', {}, () => joints.forEach((f) => R(2, f.name, { kind: 'link', sel: selSet.has(f.id), ctx: { kind: 'feature', id: f.id }, click: (ev) => selectFeature(f.id, ev), dbl: () => editFeature(featureIndex(f.id)) })));
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
    if (r.ctx) el.oncontextmenu = (e) => { e.preventDefault(); treeMenu(e, r.ctx); };
    if (r.ctx?.kind === 'body') { el.onmouseenter = () => { vp.hover = r.ctx.id; vp.refreshMaterials(); }; el.onmouseleave = () => { vp.hover = null; vp.refreshMaterials(); }; }
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
    el.className = 'tl-item' + (i >= shownMarker ? ' off' : '') + (result.errors[f.id] ? ' err' : '') + (selSet.has(f.id) ? ' sel' : '') + (f.suppressed ? ' supp' : '');
    el.title = f.name + (result.errors[f.id] ? ` — ${result.errors[f.id]}` : '');
    el.innerHTML = ficon(fiName(f), 24);
    el.onclick = (e) => { if (tlDragged) { tlDragged = false; return; } selectFeature(f.id, e); };
    el.ondblclick = () => editFeature(i);
    el.oncontextmenu = (e) => { e.preventDefault(); if (!selSet.has(f.id)) { selSet = new Set([f.id]); selFeature = f.id; renderTimeline(); } featureMenu(e, i); };
    el.onpointerdown = (e) => startTimelineDrag(e, el, i);
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

function selectFeature(id, ev) {
  const idx = featureIndex(id);
  if (ev && (ev.ctrlKey || ev.metaKey)) { selSet.has(id) ? selSet.delete(id) : selSet.add(id); }
  else if (ev && ev.shiftKey && selFeature) {
    const a = featureIndex(selFeature), [lo, hi] = a < idx ? [a, idx] : [idx, a];
    selSet = new Set(doc.features.slice(lo, hi + 1).map((f) => f.id));
  } else selSet = new Set([id]);
  selFeature = id;
  renderTimeline(); renderTree();
}

// ---- feature dependencies (used by suppress, reorder)
function refsOf(f) {
  const ids = new Set(doc.features.map((x) => x.id));
  const out = new Set();
  const walk = (v) => { if (typeof v === 'string') { if (ids.has(v) && v !== f.id) out.add(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(f.params);
  return out;
}
function dependentsOf(ids) {
  const out = new Set();
  let grew = true;
  const roots = new Set(ids);
  while (grew) {
    grew = false;
    for (const f of doc.features) {
      if (roots.has(f.id) || out.has(f.id)) continue;
      const r = refsOf(f);
      if ([...r].some((x) => roots.has(x) || out.has(x))) { out.add(f.id); grew = true; }
    }
  }
  return out;
}
function dependenciesOf(ids) {
  const out = new Set();
  const stack = [...ids];
  while (stack.length) {
    const f = doc.features.find((x) => x.id === stack.pop());
    if (!f) continue;
    for (const r of refsOf(f)) if (!out.has(r) && !ids.includes(r)) { out.add(r); stack.push(r); }
  }
  return out;
}
function setSuppressed(ids, flag) {
  // suppressing also suppresses everything that depends on it; unsuppressing restores dependents and prerequisites
  const set = new Set(ids);
  for (const d of dependentsOf(ids)) set.add(d);
  if (!flag) for (const d of dependenciesOf(ids)) set.add(d);
  const extra = [...set].filter((id) => !ids.includes(id) && doc.features.find((x) => x.id === id)?.suppressed !== flag).length;
  mutate(() => { doc.features = doc.features.map((f) => (set.has(f.id) ? { ...f, suppressed: flag } : f)); });
  if (extra) toast(`${flag ? 'Also suppressed' : 'Also restored'} ${extra} related feature${extra > 1 ? 's' : ''}.`);
}
function deleteFeatures(ids) {
  const set = new Set(ids);
  mutate(() => {
    const before = doc.features.slice(0, doc.marker).filter((f) => set.has(f.id)).length;
    doc.features = doc.features.filter((f) => !set.has(f.id));
    doc.marker = Math.max(0, doc.marker - before);
    selSet = new Set(); selFeature = null;
  });
}
function moveFeature(from, to) {
  if (from === to || from + 1 === to) return;
  const f = doc.features[from];
  const dest = to > from ? to - 1 : to;
  // static dependency check
  const deps = refsOf(f);
  const range = to > from ? doc.features.slice(from + 1, dest + 1) : doc.features.slice(dest, from);
  for (const g of range) {
    if (to > from && refsOf(g).has(f.id)) return toast(`"${g.name}" depends on "${f.name}", so it can't move past it.`, true);
    if (to < from && deps.has(g.id)) return toast(`"${f.name}" depends on "${g.name}", so it can't move before it.`, true);
  }
  const pre = snapshot();
  const feats = [...doc.features];
  feats.splice(from, 1);
  feats.splice(dest, 0, f);
  const m = doc.marker;
  const newMarker = from < m && dest >= m ? m - 1 : from >= m && dest < m ? m + 1 : m;
  const old = rebuild(doc.features, doc.marker).errors;
  const res = rebuild(feats, newMarker).errors;
  const bad = Object.keys(res).filter((k) => !old[k]);
  if (bad.length) return toast(`Moving "${f.name}" there would break "${doc.features.find((x) => x.id === bad[0])?.name || 'a feature'}".`, true);
  pushUndo(pre);
  doc.features = feats; doc.marker = newMarker;
  refresh();
}
let tlDragged = false;
function startTimelineDrag(e, el, i) {
  if (e.button !== 0 || sketch || dialog) return;
  const host = $('#timeline');
  const sx = e.clientX;
  let active = false, drop = -1, ind = null;
  const items = () => [...host.querySelectorAll('.tl-item')];
  const move = (ev) => {
    if (!active && Math.abs(ev.clientX - sx) > 6) { active = true; el.style.opacity = '.4'; ind = document.createElement('div'); ind.className = 'tl-drop'; host.appendChild(ind); }
    if (!active) return;
    const its = items();
    drop = its.length;
    for (let k = 0; k < its.length; k++) { const r = its[k].getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) { drop = k; break; } }
    const hr = host.getBoundingClientRect();
    const ref = its[Math.min(drop, its.length - 1)].getBoundingClientRect();
    ind.style.left = (drop >= its.length ? ref.right : ref.left) - hr.left + host.scrollLeft - 1 + 'px';
  };
  const up = () => {
    removeEventListener('pointermove', move);
    ind?.remove();
    el.style.opacity = '';
    if (active) { tlDragged = true; setTimeout(() => { tlDragged = false; }, 50); moveFeature(i, drop); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up, { once: true });
}

/** Small floating text input used for renaming. */
function inlineEdit(anchor, value, cb) {
  document.querySelectorAll('.inline-edit').forEach((x) => x.remove());
  const r = anchor.getBoundingClientRect();
  const inp = document.createElement('input');
  inp.className = 'inline-edit'; inp.value = value;
  inp.style.left = r.left + 'px'; inp.style.top = r.top + 'px'; inp.style.minWidth = Math.max(140, r.width) + 'px';
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; const v = inp.value.trim(); inp.remove(); if (ok && v && v !== value) cb(v); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
function renameFeature(id, anchor) {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return;
  inlineEdit(anchor, f.name, (v) => mutate(() => { doc.features = doc.features.map((x) => (x.id === id ? { ...x, name: v } : x)); }));
}
const timelineAnchor = (id) => [...document.querySelectorAll('.tl-item')][featureIndex(id)] || $('#timeline');

function featureMenu(ev, i) {
  const f = doc.features[i];
  const multi = selSet.size > 1 && selSet.has(f.id);
  const ids = multi ? [...selSet] : [f.id];
  const anySupp = ids.some((id) => doc.features.find((x) => x.id === id)?.suppressed);
  showMenu(ev.clientX, ev.clientY - 160, [
    ...(multi ? [] : [
      { label: f.type === 'sketch' ? 'Edit Sketch' : 'Edit Feature', run: () => editFeature(i) },
      { label: 'Rename', hint: 'F2', run: () => renameFeature(f.id, timelineAnchor(f.id)) },
      { label: 'Roll Back Here', run: () => { doc.marker = i + 1; refresh(); } },
    ]),
    { label: anySupp ? 'Unsuppress' : 'Suppress', run: () => setSuppressed(ids, !anySupp) },
    { sep: true },
    { label: multi ? `Delete ${ids.length} features` : 'Delete', hint: 'Del', run: () => deleteFeatures(ids) },
  ]);
}

// ---- browser context menu (bodies, sketches, joints)
const SWATCHES = ['#c3c7cd', '#e8b04a', '#d9534f', '#5cb85c', '#4a90d9', '#8e6bbf', '#2b2f36', '#f5f5f5'];
function treeMenu(ev, c) {
  const bodies = result.bodies;
  if (c.kind === 'canvas') {
    const cv = (doc.canvases || []).find((x) => x.id === c.id);
    if (!cv) return;
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Edit…', run: () => showCanvasDialog(cv) },
      { label: canvasHidden.has(cv.id) ? 'Show' : 'Hide', run: () => { canvasHidden.has(cv.id) ? canvasHidden.delete(cv.id) : canvasHidden.add(cv.id); refresh(); } },
      { sep: true },
      { label: 'Delete', run: () => mutate(() => { doc.canvases = doc.canvases.filter((x) => x.id !== cv.id); }) },
    ]);
    return;
  }
  if (c.kind === 'component') {
    const comp = (doc.components || []).find((x) => x.id === c.id);
    if (!comp) return;
    const mine = bodies.filter((b) => doc.bodyComp?.[b.id] === comp.id);
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Rename', run: () => renameComponent(comp.id) },
      { label: 'Add selected bodies', disabled: !vp.selected.size, run: () => moveToComponent([...vp.selected], comp.id) },
      { label: 'Select bodies', disabled: !mine.length, run: () => { vp.selected.clear(); mine.forEach((b) => vp.selected.add(b.id)); vp.refreshMaterials(); renderTree(); } },
      { sep: true },
      { label: 'Delete component (keep bodies)', run: () => mutate(() => { doc.components = doc.components.filter((x) => x.id !== comp.id); const bc = { ...doc.bodyComp }; mine.forEach((b) => delete bc[b.id]); doc.bodyComp = bc; }) },
    ]);
    return;
  }
  if (c.kind === 'body') {
    const b = bodies.find((x) => x.id === c.id);
    if (!b) return;
    const hidden = hiddenBodies.has(c.id);
    const isolated = bodies.length > 1 && bodies.every((x) => x.id === c.id || hiddenBodies.has(x.id));
    selectBody(c.id, false);
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Rename', hint: 'F2', run: () => renameBodyOrFeature(c.id) },
      { label: hidden ? 'Show' : 'Hide', uicon: hidden ? 'eye' : 'eyeOff', run: () => { hidden ? hiddenBodies.delete(c.id) : hiddenBodies.add(c.id); refresh(); } },
      { label: isolated ? 'Unisolate' : 'Isolate', run: () => { if (isolated) hiddenBodies.clear(); else bodies.forEach((x) => (x.id === c.id ? hiddenBodies.delete(x.id) : hiddenBodies.add(x.id))); refresh(); } },
      ...((doc.components || []).length || true ? [{ sep: true }, { head: 'COMPONENT' }, ...(doc.components || []).map((cp) => ({ label: cp.name, check: doc.bodyComp?.[c.id] === cp.id, run: () => moveToComponent(vp.selected.size > 1 ? [...vp.selected] : [c.id], cp.id) })), { label: 'New component with this body', run: () => newComponent() }, ...(doc.bodyComp?.[c.id] ? [{ label: 'Remove from component', run: () => moveToComponent([c.id], null) }] : [])] : []),
      { sep: true },
      { head: 'APPEARANCE' },
      ...SWATCHES.map((hex, k) => ({ label: ['Steel', 'Gold', 'Red', 'Green', 'Blue', 'Purple', 'Black', 'White'][k], swatch: hex, run: () => mutate(() => { doc.appearance = { ...(doc.appearance || {}), [c.id]: k === 0 ? undefined : hex }; if (k === 0) delete doc.appearance[c.id]; }) })),
      { sep: true },
      { label: 'Properties', uicon: 'help', run: showInfo },
      { label: 'Delete', hint: 'Del', run: deleteSelection },
    ]);
  } else {
    const f = doc.features.find((x) => x.id === c.id);
    if (!f) return;
    selectFeature(c.id);
    const vis = sketchVis[f.id] ?? !result.sketchUsed.has(f.id);
    showMenu(ev.clientX, ev.clientY, [
      { label: f.type === 'sketch' ? 'Edit Sketch' : 'Edit Feature', run: () => editFeature(featureIndex(f.id)) },
      { label: 'Rename', hint: 'F2', run: () => renameFeature(f.id, timelineAnchor(f.id)) },
      ...(f.type === 'sketch' ? [{ label: vis ? 'Hide' : 'Show', run: () => { sketchVis[f.id] = !vis; drawSketches(); renderTree(); } }] : []),
      { label: f.suppressed ? 'Unsuppress' : 'Suppress', run: () => setSuppressed([f.id], !f.suppressed) },
      { sep: true },
      { label: 'Delete', run: () => deleteFeatures([f.id]) },
    ]);
  }
}
function renameBodyOrFeature(bodyId) {
  // a body is named after the feature that created it
  const row = [...document.querySelectorAll('#tree .tree-row')].find((r) => r.textContent.includes(result.bodies.find((b) => b.id === bodyId)?.name || '\u0000'));
  renameFeature(String(bodyId).split('~')[0], row || $('#tree')); // pieces made by Separate share their feature's name
}

function mutate(fn) { pushUndo(snapshot()); fn(); refresh(); }

// ---- canvas: a reference image placed on a plane, for tracing
function pickCanvasImage() {
  if (dialog || sketch) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const url = URL.createObjectURL(file), img = new Image();
      await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('That file is not an image the browser can read')); img.src = url; });
      const k = Math.min(1, 1280 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      const png = /png|gif|webp|svg/i.test(file.type);
      const image = cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85);
      if (image.length > 3e6) return toast('That image is too large even after shrinking. Try a smaller one.', true);
      showCanvasDialog({ id: null, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Canvas', plane: 'XY', offset: 0, x: 0, y: 0, width: 100, opacity: 0.5, image, aspect: cv.height / cv.width });
    } catch (e) { toast(e.message, true); }
  };
  inp.click();
}
function showCanvasDialog(c) {
  const isNew = !c.id;
  const m = modal(`<div class="modal-title">${isNew ? 'Insert Canvas' : 'Edit Canvas'}</div><div class="modal-body">
    <label>Name<input id="cv-name" value="${esc(c.name)}"></label>
    <label>Plane<select id="cv-plane">${['XY', 'XZ', 'YZ'].map((p) => `<option ${p === c.plane ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Width (${getUnits()})<input id="cv-w" type="number" min="1" step="any" value="${dispStr(c.width)}"></label>
    <label>Offset from plane (${getUnits()})<input id="cv-off" type="number" step="any" value="${dispStr(c.offset)}"></label>
    <label>Position X / Y (${getUnits()})<span class="two"><input id="cv-x" type="number" step="any" value="${dispStr(c.x)}"><input id="cv-y" type="number" step="any" value="${dispStr(c.y)}"></span></label>
    <label>Opacity <output id="cv-op-o">${Math.round(c.opacity * 100)}%</output><input id="cv-op" type="range" min="5" max="100" value="${Math.round(c.opacity * 100)}"></label>
    <div class="modal-foot"><button class="btn" id="cv-cancel" type="button">Cancel</button><button class="btn primary" id="cv-ok" type="button">${isNew ? 'Insert' : 'Apply'}</button></div></div>`);
  const $m = (s) => m.el.querySelector(s);
  $m('#cv-op').oninput = (e) => { $m('#cv-op-o').textContent = e.target.value + '%'; };
  $m('#cv-cancel').onclick = m.close;
  $m('#cv-ok').onclick = () => {
    const next = { ...c, name: $m('#cv-name').value.trim() || 'Canvas', plane: $m('#cv-plane').value, width: Math.max(1, +$m('#cv-w').value * lenF()), offset: +$m('#cv-off').value * lenF(), x: +$m('#cv-x').value * lenF(), y: +$m('#cv-y').value * lenF(), opacity: +$m('#cv-op').value / 100 };
    mutate(() => { next.id ||= 'v' + doc.nextId++; doc.canvases = isNew ? [...(doc.canvases || []), next] : doc.canvases.map((x) => (x.id === next.id ? next : x)); });
    m.close(); vp.fitted = vp.fitted && !isNew;
    toast(isNew ? 'Canvas inserted. Hide or delete it from the Browser.' : 'Canvas updated');
  };
}

// ---- configurations: named sets of parameter values; the active one overrides the defaults
function showConfigMenu(anchor) {
  const r = anchor?.getBoundingClientRect?.() || { left: 200, bottom: 100 };
  const cfgs = doc.configs || [];
  showMenu(r.left, r.bottom + 2, [
    { head: 'ACTIVE CONFIGURATION' },
    { label: 'Default values', check: !doc.activeConfig, run: () => mutate(() => { doc.activeConfig = null; }) },
    ...cfgs.map((c) => ({ label: c.name, check: doc.activeConfig === c.id, run: () => mutate(() => { doc.activeConfig = c.id; }) })),
    { sep: true },
    { label: 'Edit configurations…', run: showConfigurations },
  ]);
}
function showConfigurations() {
  if (dialog || sketch) return;
  if (!(doc.params || []).length) return toast('Add parameters first (MANAGE → Change Parameters), then configure their values.', true);
  const pre = snapshot();
  let changed = false;
  const m = modal(`<div class="modal-title">Configure Design</div><div class="modal-body"><div class="hint">Each column is a configuration: a set of parameter values for a variant of this design (for example <b>Small</b>, <b>Large</b>). Leave a cell blank to use the default. Pick the active configuration in <b>Configure Settings</b>.</div><div class="cfg-wrap" id="cfg-table"></div><div class="modal-foot"><button class="btn" id="cfg-add" type="button">Add configuration</button></div></div>`, () => { if (changed) { pushUndo(pre); refresh(); } });
  m.el.classList.add('wide');
  const host = m.el.querySelector('#cfg-table');
  const commit = () => { changed = true; refresh(); };
  const draw = () => {
    const cfgs = doc.configs || [];
    host.innerHTML = '';
    const tbl = document.createElement('table'); tbl.className = 'cfg';
    tbl.innerHTML = `<thead><tr><th>Parameter</th><th>Default</th>${cfgs.map((c) => `<th><input class="cfg-name" data-c="${esc(c.id)}" value="${esc(c.name)}" aria-label="Configuration name"><button type="button" class="cfg-del" data-c="${esc(c.id)}" title="Delete configuration" aria-label="Delete ${esc(c.name)}">×</button></th>`).join('')}</tr></thead><tbody>${doc.params.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.expr)}</td>${cfgs.map((c) => `<td><input class="cfg-val" data-c="${esc(c.id)}" data-p="${esc(p.name)}" value="${esc(c.values?.[p.name] ?? '')}" placeholder="${esc(p.expr)}" aria-label="${esc(p.name)} in ${esc(c.name)}"></td>`).join('')}</tr>`).join('')}</tbody>`;
    host.appendChild(tbl);
    tbl.querySelectorAll('.cfg-name').forEach((i) => (i.onchange = () => { doc.configs = doc.configs.map((c) => (c.id === i.dataset.c ? { ...c, name: i.value.trim() || c.name } : c)); commit(); }));
    tbl.querySelectorAll('.cfg-val').forEach((i) => (i.onchange = () => { doc.configs = doc.configs.map((c) => (c.id === i.dataset.c ? { ...c, values: { ...c.values, [i.dataset.p]: i.value.trim() } } : c)); commit(); }));
    tbl.querySelectorAll('.cfg-del').forEach((b) => (b.onclick = () => { doc.configs = doc.configs.filter((c) => c.id !== b.dataset.c); if (doc.activeConfig === b.dataset.c) doc.activeConfig = null; commit(); draw(); }));
  };
  m.el.querySelector('#cfg-add').onclick = () => { doc.configs = [...(doc.configs || []), { id: 'k' + doc.nextId++, name: `Configuration${(doc.configs || []).length + 1}`, values: {} }]; commit(); draw(); };
  draw();
}

// ---- insert another design: its bodies are copied in as meshes (a snapshot at this moment), optionally in one of its configurations
async function showInsertDesign(withConfig) {
  if (dialog || sketch) return;
  const here = tabs.find((t) => t.id === activeTab);
  const sources = [];
  for (const t of tabs) if (t.id !== activeTab && t.state.doc.features.length) sources.push({ label: `${t.state.doc.name} (open tab)`, get: async () => t.state.doc });
  if (acct.server && acct.user) {
    const r = await call('GET', '/projects');
    if (r.ok) for (const pr of r.data) if (!(doc.rev && pr.name === doc.name)) sources.push({ label: pr.name, get: async () => { const d = await call('GET', '/projects/' + encodeURIComponent(pr.name)); const o = typeof d.data === 'string' ? JSON.parse(d.data) : d.data; return { name: o.name || pr.name, features: o.features || [], params: o.params || [], configs: o.configs || [], activeConfig: o.activeConfig || null, units: o.units || 'mm' }; } });
  }
  void here;
  if (!sources.length) return toast(acct.server ? 'There are no other designs to insert yet. Save or open another design first.' : 'Open another design in a tab first, then insert it from here.', true);
  const m = modal(`<div class="modal-title">${withConfig ? 'Insert Configured Design' : 'Insert Derive'}</div><div class="modal-body"><label>Design<select id="ins-src">${sources.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select></label>${withConfig ? '<label>Configuration<select id="ins-cfg"></select></label>' : ''}<div class="hint">Copies the design's bodies into this one as meshes. It is a snapshot: later changes to the other design are not carried over.</div><div class="form-err" id="ins-err"></div><div class="modal-foot"><button class="btn primary" id="ins-ok" type="button">Insert</button></div></div>`);
  const sel = m.el.querySelector('#ins-src'), cfgSel = m.el.querySelector('#ins-cfg'), err = m.el.querySelector('#ins-err');
  let cur = null;
  const load = async () => {
    cur = await sources[+sel.value].get();
    if (cfgSel) cfgSel.innerHTML = `<option value="">Default values</option>` + (cur.configs || []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  };
  sel.onchange = load; await load();
  m.el.querySelector('#ins-ok').onclick = () => {
    try {
      const d2 = { ...cur, features: cur.features.map((f) => ({ ...f })), activeConfig: cfgSel ? cfgSel.value || null : cur.activeConfig };
      const { result } = evaluateDoc(d2);
      if (!result.bodies.length) { err.textContent = 'That design has no bodies to insert.'; return; }
      const pre = snapshot();
      let n = 0;
      for (const b of result.bodies) {
        const soup = new Float32Array(b.tris.length * 3);
        for (let i = 0; i < b.tris.length; i++) for (let k = 0; k < 3; k++) soup[i * 3 + k] = b.verts[b.tris[i] * 3 + k];
        const f = { id: 'f' + doc.nextId++, type: 'import', name: `${cur.name} · ${b.name}`.slice(0, 60), params: { data: encodeFloats(soup), tris: soup.length / 9 } };
        doc.features.splice(doc.marker, 0, f); doc.marker++; n++;
      }
      pushUndo(pre); m.close(); vp.fitted = false; refresh();
      toast(`Inserted ${n} ${n > 1 ? 'bodies' : 'body'} from ${cur.name}`);
    } catch (e) { err.textContent = 'Could not insert: ' + e.message; }
  };
}

// ---- components: named groups of bodies in the Browser (visibility and organisation; the geometry is unchanged)
function newComponent() {
  const sel = [...vp.selected];
  mutate(() => {
    const n = (doc.components || []).length + 1;
    const c = { id: 'c' + doc.nextId++, name: `Component${n}` };
    doc.components = [...(doc.components || []), c];
    doc.bodyComp = { ...(doc.bodyComp || {}) };
    sel.forEach((id) => (doc.bodyComp[id] = c.id));
  });
  toast(sel.length ? `Created a component with ${sel.length} ${sel.length > 1 ? 'bodies' : 'body'}` : 'Created an empty component. Right-click a body to move it in.');
}
async function renameComponent(id) {
  const c = (doc.components || []).find((x) => x.id === id);
  const n = c && await askName({ title: 'Rename component', label: 'Component name', value: c.name, ok: 'Rename', raw: true });
  if (n && n.trim()) mutate(() => { doc.components = doc.components.map((x) => (x.id === id ? { ...x, name: n.trim().slice(0, 60) } : x)); });
}
function moveToComponent(bodyIds, compId) {
  mutate(() => { doc.bodyComp = { ...(doc.bodyComp || {}) }; bodyIds.forEach((b) => (compId ? (doc.bodyComp[b] = compId) : delete doc.bodyComp[b])); });
}

// ------------------------------------------------------------------ menus
function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
    if (it.head) { m.insertAdjacentHTML('beforeend', `<div class="mh">${esc(it.head)}</div>`); continue; }
    const e = document.createElement('div');
    e.className = 'mi' + (it.disabled ? ' disabled' : '') + (it.check !== undefined ? ' check' + (it.check ? ' on' : '') : '');
    if (it.disabled) e.setAttribute('aria-disabled', 'true');
    e.setAttribute('role', 'menuitem'); e.tabIndex = -1;
    if (it.dim) e.style.opacity = '.55';
    const ic = it.swatch ? `<span class="swatch" style="background:${it.swatch}"></span>` : it.ficon ? ficon(it.ficon, 22) : it.uicon ? uicon(it.uicon, 16) : it.icon ? icon(it.icon, 16) : it.check === undefined ? '<span class="ph"></span>' : '';
    e.innerHTML = ic + `<span>${esc(it.label)}</span>` + (it.hint ? `<small>${it.hint}</small>` : '');
    e.onclick = () => { m.hidden = true; it.run(); };
    m.appendChild(e);
  }
  m.setAttribute('role', 'menu');
  if (!m.dataset.kb) { // keyboard: arrows move, Enter/Space choose, Esc closes and returns focus
    m.dataset.kb = '1';
    m.addEventListener('keydown', (e) => {
      const its = [...m.querySelectorAll('.mi:not(.disabled)')], i = its.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); its[(i + 1) % its.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); its[(i - 1 + its.length) % its.length]?.focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement?.click?.(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.hidden = true; m.opener?.focus?.(); }
    });
  }
  m.opener = document.activeElement;
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 10)) + 'px';
  m.querySelector('.mi:not(.disabled)')?.focus({ preventScroll: true });
}
addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('[data-menu]')) $('#menu').hidden = true; }, true);



// ------------------------------------------------------------------ selection
function selectBody(id, additive = false) {
  if (!additive) vp.selected.clear();
  if (id) (additive && vp.selected.has(id) ? vp.selected.delete(id) : vp.selected.add(id));
  vp.refreshMaterials(); renderTree(); renderRibbon();
}

// ------------------------------------------------------------------ features: create / edit
const ctx = () => {
  const sks = sketchesBefore(doc.marker);
  const sel = [...vp.selected][0] || selFace?.id || result.bodies[0]?.id || '';
  const selB = result.bodies.find((b) => b.id === sel) || result.bodies[0];
  const otherB = result.bodies.find((b) => b.id !== selB?.id);
  const ctr = (b) => (b ? b.bbox.min.map((v, k) => +((v + b.bbox.max[k]) / 2).toFixed(3)) : [0, 0, 0]);
  return {
    lastSketch: sks.length ? sks[sks.length - 1].id : '',
    surfaces: (result.surfaces || []).map((q) => q.id),
    lastPlane: doc.features.slice(0, doc.marker).filter((f) => f.type === 'plane').at(-1)?.id || 'XY',
    selSketch: profSel.size ? [...profSel][0].split('|')[0] : '',
    selProfiles: profSel.size ? [...profSel].filter((k) => k.startsWith([...profSel][0].split('|')[0] + '|')).map((k) => k.split('|')[1]) : null,
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
  if (['extrude', 'revolve', 'rib', 'emboss', 'sextrude', 'srevolve', 'pipe'].includes(key) && !c.lastSketch) return toast('Create a sketch first.', true);
  if (['sweep', 'loft', 'ssweep', 'sloft'].includes(key) && c.sketches.length < 2) return toast(`${def.label} needs two sketches (a profile and ${key.endsWith('sweep') ? 'a path' : 'a second profile'}).`, true);
  if (['sstitch', 'sthicken'].includes(key) && !(result.surfaces || []).length) return toast('There are no surfaces yet. Create one with Extrude, Revolve, Sweep or Loft on the Surface tab.', true);
  if (['move', 'combine', 'mirror', 'pattern', 'remove', 'fillet', 'chamfer'].includes(key) || def.needsBody) { if (!result.bodies.length) return toast('There are no bodies yet — create one first.', true); }
  if (def.needsBodies && result.bodies.length < def.needsBodies) return toast(`${def.label} needs at least ${def.needsBodies} bodies.`, true);
  const pre = snapshot();
  const params = def.make(c);
  if (['extrude', 'revolve', 'emboss', 'sextrude', 'srevolve'].includes(key) && c.selSketch) { params.sketch = c.selSketch; params.profiles = c.selProfiles; profSel.clear(); }
  if (key === 'combine') params.tool = result.bodies.find((b) => b.id !== params.target)?.id || '';
  if ((key === 'fillet' || key === 'chamfer') && (selEdges.length || selFace)) {
    params.edges = selEdges.length ? selEdges.map((e) => ({ ...e })) : edgesOfFace(selFace);
    if (!params.edges.length) toast('That face has no edges to round.', true);
    selEdges = []; edgeHover = null; selFace = null; vp.showFaces([], null); updateEdgeView();
  }
  if (selFace) {
    const fc = { point: selFace.point, normal: selFace.normal };
    if (key === 'presspull') { params.face = fc; params.body = selFace.id; }
    else if (key === 'hole') { params.pos = [...selFace.point]; params.dir = [...selFace.normal]; }
    else if (key === 'shell') { params.body = selFace.id; params.open = [fc]; }
    else if (key === 'draft') { params.body = selFace.id; params.faces = [fc]; }
    selFace = null; vp.showFaces([], null);
  }
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
  const ff = defOf(doc.features[index]).fields.find((x) => x.type === 'face' || x.type === 'faces' || x.type === 'profiles');
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
  const key = path.split('.')[0];
  const isLen = fieldKind(f, key) === 'len';
  let val, expr = null;
  if (isPlainNumber(text)) {
    val = parseFloat(text) * (isLen ? lenF() : 1);
    if (fld.min !== undefined) val = Math.max(fld.min, val);
    if (fld.max !== undefined) val = Math.min(fld.max, val);
  } else {
    try { val = evalExpr(text, (n) => paramState.values[n], isLen ? 'len' : 'num'); expr = text.trim(); }
    catch (e) { return { ok: false, err: e.message }; }
  }
  const [k2, idx] = path.split('.');
  const params = { ...f.params };
  if (idx !== undefined) { const arr = [...params[k2]]; arr[+idx] = val; params[k2] = arr; } else params[k2] = val;
  const exprs = { ...(f.exprs || {}) };
  if (expr) exprs[path] = expr; else delete exprs[path];
  doc.features[i] = { ...f, params, exprs: Object.keys(exprs).length ? exprs : undefined };
  refresh();
  return { ok: true, value: val, expr, isLen };
}
/** Replace several params at once (viewport picking, gizmo); drops expressions for those keys. */
function patchParams(i, patch) {
  const f = doc.features[i];
  const exprs = Object.fromEntries(Object.entries(f.exprs || {}).filter(([path]) => !(path.split('.')[0] in patch)));
  doc.features[i] = { ...f, params: { ...f.params, ...patch }, exprs: Object.keys(exprs).length ? exprs : undefined };
  refresh();
}

const DLG_ICON = {
  start: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3.5v17" stroke="#16304f" stroke-width="2.4"/><path d="M8.5 12H20M16.5 8.2L20.3 12l-3.8 3.8" fill="none" stroke="#16304f" stroke-width="1.8"/></svg>',
  dir: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 7l9-3.5 4 4.5-9 3.5z" fill="#f2a67e" stroke="#c9672f"/><path d="M4 20.5l7.5-8M4 20.5h5M4 20.5v-5" stroke="#555" stroke-width="1.6" fill="none"/></svg>',
  ext: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 4.5v15M20 4.5v15M6.5 12h11M6.5 12l3-2.6M6.5 12l3 2.6M17.5 12l-3-2.6M17.5 12l-3 2.6" stroke="#16304f" fill="none" stroke-width="1.6"/></svg>',
};
/** Dropdown: icon + label + caret, popup list below with an icon per option. */
function iconSelect(opts, val, onPick, iconFor, { disabled = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'isel' + (disabled ? ' off' : '');
  const cur = opts.find(([v]) => String(v) === String(val)) || opts[0];
  wrap.innerHTML = `<button type="button" class="isel-btn"><span class="ico">${iconFor(cur[0])}</span><span class="lbl">${esc(cur[1])}</span><i class="caret"></i></button>`;
  if (disabled) return wrap;
  const btn = wrap.firstChild;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('.isel-pop').forEach((q) => q.remove());
    const r = btn.getBoundingClientRect(), pop = document.createElement('div');
    pop.className = 'isel-pop';
    pop.style.cssText = `left:${r.left}px;top:${r.bottom + 2}px;min-width:${r.width}px`;
    pop.innerHTML = opts.map(([v, l]) => `<div class="it${String(v) === String(cur[0]) ? ' on' : ''}" data-v="${esc(String(v))}"><span class="ico">${iconFor(v)}</span><span>${esc(l)}</span></div>`).join('');
    pop.onclick = (e) => { const it = e.target.closest('.it'); if (!it) return; pop.remove(); onPick(opts.find(([v]) => String(v) === it.dataset.v)[0]); };
    document.body.appendChild(pop);
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); removeEventListener('pointerdown', off, true); } };
    addEventListener('pointerdown', off, true);
  };
  return wrap;
}
const OP_ORDER = ['join', 'cut', 'intersect', 'new', 'auto'];

function renderDialog() {
  if (!dialog) return;
  const f = doc.features[dialog.index];
  const def = defOf(f);
  const wrap = $('#props-wrap');
  const hint = def.fields.some((x) => x.type === 'profiles') ? 'Click inside a shaded region in the canvas to add or remove profiles. Hold Shift to modify the selection.' : def.label;
  wrap.innerHTML = `<div class="props"><div class="title"><button class="tmin" title="Collapse">−</button><span>${esc((def.label || f.name).toUpperCase())}</span></div><div class="body"></div>
    <div class="foot"><span class="info" title="${esc(hint)}">i</span><button class="btn primary" id="d-ok">OK</button><button class="btn" id="d-cancel">Cancel</button></div></div>`;
  wrap.querySelector('.tmin').onclick = () => wrap.querySelector('.props').classList.toggle('collapsed');
  const body = wrap.querySelector('.body');
  const adv = []; // rows tucked under More options
  if (def.gizmo) {
    body.insertAdjacentHTML('beforeend', `<div class="row"><label>Gizmo</label><select id="d-mode"><option value="translate">Translate</option><option value="rotate">Rotate</option></select></div><div class="sep"></div>`);
    const s = body.querySelector('#d-mode'); s.value = dialog.mode;
    s.onchange = () => { dialog.mode = s.value; setupGizmo(); };
  }
  const idx = dialog.index;
  const rerender = () => { renderDialog(); setupGizmo(); };
  for (const fld of def.fields) {
    if (fld.show && !fld.show(f.params)) continue;
    if (fld.key === 'sketch' && 'profiles' in f.params && sketchesBefore(idx).length < 2) continue; // no sketch row: the profile pick chooses it
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
      const isLen = fieldKind(f, path.split('.')[0]) === 'len';
      const show = (x) => (isLen ? `${dispStr(x)} ${getUnits()}` : String(+(+x).toFixed(4)));
      n.setAttribute('aria-label', fld.label);
      n.value = expr ?? (isLen ? `${dispStr(v)} ${getUnits()}` : fld.unit ? `${(+v).toFixed(1)} ${fld.unit}` : String(+(+v).toFixed(4)));
      n.onfocus = () => n.select();
      const calc = document.createElement('small');
      calc.className = 'calc';
      if (expr) { const rv = resolvedAt(f, path); calc.textContent = typeof rv === 'number' ? `= ${show(rv)}` : ''; }
      n.oninput = () => {
        const txt = n.value.trim();
        if (!txt) return;
        const r = commitNumber(idx, path, txt, fld);
        n.classList.toggle('bad', !r.ok);
        n.title = r.ok ? '' : r.err;
        calc.textContent = r.ok && r.expr ? `= ${show(r.value)}` : r.ok ? '' : r.err;
        if (r.ok && (fld.key === 'kind' || def.gizmo)) setupGizmo();
      };
      n.onkeydown = (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const cur = parseFloat(n.value);
        if (isNaN(cur) || !isPlainNumber(n.value)) return;
        e.preventDefault();
        n.value = String(+(cur + (e.key === 'ArrowUp' ? 1 : -1) * (isLen ? niceStep(fld.step ?? 1) : fld.step ?? 1)).toFixed(6));
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
      ctl.innerHTML = `<span>${val.length} selected</span> <button class="btn" id="d-edgeclear" style="margin-left:8px">Clear</button><div style="color:var(--muted);font-size:var(--fs-xs);margin-top:4px">Click edges in the viewport to add or remove them.</div>`;
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
    } else if (fld.type === 'soltype') {
      ctl.innerHTML = `<div class="typebtns"><button type="button" class="tb ${f.params.thin ? '' : 'on'}" data-thin="0" title="Solid" aria-label="Solid" aria-pressed="${!f.params.thin}">${ficon('extrude', 26)}</button><button type="button" class="tb ${f.params.thin ? 'on' : ''}" data-thin="1" title="Thin extrude: a wall around each profile" aria-label="Thin extrude" aria-pressed="${!!f.params.thin}">${ficon('shell', 26)}</button></div>`;
      ctl.querySelectorAll('button[data-thin]').forEach((bt) => (bt.onclick = () => { set(bt.dataset.thin === '1'); rerender(); }));
    } else if (fld.type === 'static') {
      ctl.appendChild(iconSelect([[fld.text, fld.text]], fld.text, () => {}, () => DLG_ICON[fld.icon], { disabled: true }));
    } else if (fld.type === 'ops') {
      const ico = { join: 'opjoin', cut: 'opcut', intersect: 'opintersect', new: 'opnew', auto: 'opauto' };
      const opts = [...fld.options].sort((x, y) => OP_ORDER.indexOf(x[0]) - OP_ORDER.indexOf(y[0]));
      ctl.appendChild(iconSelect(opts, val, (v) => { set(v); rerender(); }, (v) => ficon(ico[v] || 'opnew', 22)));
    } else if (fld.type === 'profiles') {
      const sk = doc.features.find((k) => k.id === f.params.sketch);
      const items = sk ? profilesFor(sk) : [];
      const chosen = sk ? effectiveProfiles(f, sk).size : 0;
      ctl.innerHTML = `<div class="profrow"><div class="selbtn on"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 3l12 11.5-5.2.7 3 5.6-2.6 1.4-3-5.7-4.2 3.2z" fill="#fff" stroke="#333" stroke-width="1.4" stroke-linejoin="round"/></svg><span>${items.length ? `${chosen} selected` : 'No closed profiles'}</span></div><button type="button" class="xclear" title="Reset to the default selection">×</button></div>`;
      ctl.querySelector('.xclear').onclick = () => { patchParams(idx, { profiles: null }); renderDialog(); };
    } else if (fld.type === 'bodies') {
      const avail = bodiesBefore(idx);
      ctl.innerHTML = avail.length ? avail.map((q) => `<label class="chk" style="font-weight:400"><input type="checkbox" data-s="${esc(q.id)}" ${val.includes(q.id) ? 'checked' : ''}> ${esc(q.name)}</label>`).join('') + '<div class="note">…or click bodies in the viewport.</div>' : '<div class="note">No bodies yet.</div>';
      ctl.querySelectorAll('input[data-s]').forEach((c) => (c.onchange = () => { set([...ctl.querySelectorAll('input[data-s]:checked')].map((x) => x.dataset.s)); }));
    } else if (fld.type === 'surfaces') {
      const avail = result.surfSnaps?.[idx] || result.surfaces.map((q) => ({ id: q.id, name: q.name }));
      ctl.innerHTML = avail.length ? avail.map((q) => `<label class="chk" style="font-weight:400"><input type="checkbox" data-s="${esc(q.id)}" ${val.includes(q.id) ? 'checked' : ''}> ${esc(q.name)}</label>`).join('') + '<div class="note">…or click surfaces in the viewport.</div>' : '<div class="note">No surfaces yet.</div>';
      ctl.querySelectorAll('input[data-s]').forEach((c) => (c.onchange = () => { set([...ctl.querySelectorAll('input[data-s]:checked')].map((x) => x.dataset.s)); }));
    } else if (fld.type === 'face' || fld.type === 'faces') {
      const list = fld.type === 'face' ? (val ? [val] : []) : val || [];
      ctl.innerHTML = `<span>${list.length ? `${list.length} face${list.length > 1 ? 's' : ''} selected` : 'None selected'}</span> <button class="btn sm" style="margin-left:6px">Clear</button><div class="note">${fld.type === 'face' ? 'Click a flat face, then drag it in the viewport or type a distance.' : (fld.note || 'Click flat faces in the viewport. Click again to deselect.')}</div>`;
      ctl.querySelector('button').onclick = () => { patchParams(idx, { [fld.key]: fld.type === 'face' ? null : [] }); renderDialog(); };
    } else if (fld.type === 'bool') {
      const c = document.createElement('input'); c.type = 'checkbox'; c.setAttribute('aria-label', fld.label); c.checked = !!val; c.onchange = () => { set(c.checked); if (['thread', 'through', 'internal'].includes(fld.key)) rerender(); }; ctl.appendChild(c);
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
      const s = document.createElement('select'); s.setAttribute('aria-label', fld.label);
      let opts;
      if (fld.type === 'select') opts = fld.options;
      else if (fld.type === 'planeref') opts = [['XY', 'XY (Top)'], ['XZ', 'XZ (Front)'], ['YZ', 'YZ (Right)'], ...doc.features.slice(0, idx).filter((q) => q.type === 'plane').map((q) => [q.id, q.name])];
      else if (fld.type === 'surface') opts = [['', 'Select surface…'], ...(result.surfSnaps?.[idx] || result.surfaces).map((q) => [q.id, q.name])];
      else if (fld.type === 'body') opts = [['', fld.optional || 'Select body…'], ...bodiesBefore(idx).map((b) => [b.id, b.name])];
      else opts = [['', 'Select sketch…'], ...sketchesBefore(idx).map((k) => [k.id, k.name])];
      s.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      if (fld.icon && fld.type === 'select') {
        ctl.appendChild(iconSelect(opts, val, (v) => { if (fld.boolSelect) { set(v === true || v === 'true'); return; } set(v); if (['op', 'kind', 'extent', 'by', 'mode', 'jtype'].includes(fld.key)) rerender(); }, () => DLG_ICON[fld.icon]));
        body.appendChild(row); continue;
      }
      s.value = String(val ?? '');
      s.onfocus = () => { dialog.focusKey = fld.key; };
      s.onchange = () => { if (fld.boolSelect) { set(s.value === 'true'); return; } if (fld.key === 'sketch' && 'profiles' in f.params) { patchParams(idx, { sketch: s.value, profiles: null }); rerender(); return; } set(s.value); if (['op', 'kind', 'extent', 'by', 'mode', 'jtype'].includes(fld.key)) rerender(); else if (def.gizmo) setupGizmo(); };
      ctl.appendChild(s);
      if (fld.type === 'body') ctl.insertAdjacentHTML('beforeend', '<div class="note">…or click a body in the viewport.</div>');
    }
    if (fld.adv) adv.push(row); else body.appendChild(row);
  }
  if (adv.length) { const d = document.createElement('details'); d.className = 'more'; d.innerHTML = '<summary>More options</summary>'; adv.forEach((r) => d.appendChild(r)); body.appendChild(d); }
  if (Object.keys(paramState.values).length) body.insertAdjacentHTML('beforeend', `<div class="note">Fields accept expressions, e.g. <b>${esc(Object.keys(paramState.values)[0])} / 2 + 1 mm</b></div>`);
  body.insertAdjacentHTML('beforeend', '<div id="d-err"></div>');
  $('#d-ok').onclick = () => closeDialog(true);
  $('#d-cancel').onclick = () => closeDialog(false);
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
  if (pk.kind === 'profiles') {
    const id = vp.pickProfile(e);
    const sk = doc.features.find((k) => k.id === f.params.sketch);
    if (!id || !sk) return;
    const cur = effectiveProfiles(f, sk);
    cur.has(id) ? cur.delete(id) : cur.add(id);
    patchParams(i, { profiles: [...cur] });
    renderDialog();
    return;
  }
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
  const h = vp.pickBody(e);
  const sflds = defOf(f).fields.filter((x) => x.type === 'surface' || x.type === 'surfaces');
  if (sflds.length && h && (result.surfaces || []).some((q) => q.id === h.id)) {
    const sf = sflds[0];
    if (sf.type === 'surface') updateParam(dialog.index, sf.key, h.id);
    else { const cur = f.params[sf.key] || []; updateParam(dialog.index, sf.key, cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id]); }
    renderDialog(); return;
  }
  const bfld = defOf(f).fields.find((x) => x.type === 'bodies');
  if (bfld && h) { const cur = f.params[bfld.key] || []; updateParam(dialog.index, bfld.key, cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id]); renderDialog(); return; }
  const flds = defOf(f).fields.filter((x) => x.type === 'body' && (!x.show || x.show(f.params)));
  if (!flds.length) return;
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
function printerMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom, [
    ...Object.keys(PRINTERS).map((n) => ({ label: n, check: n === bedName, run: () => setBed(n, PRINTERS[n]) })),
    { sep: true },
    { label: 'Custom…', run: async () => {
      const s = await askName({ title: 'Custom build volume', label: 'Size X, Y, Z in mm', value: '200,200,200', ok: 'Set', raw: true, validate: (t) => { const v = t.split(',').map(Number); return v.length === 3 && v.every((n) => n > 0) ? '' : 'Enter three positive numbers separated by commas, for example 200,200,200.'; } });
      if (s) setBed('Custom', s.split(',').map(Number));
    } },
  ]);
}
function setBed(name, size) { bedName = name; try { localStorage.setItem('sketchy.bed', name); } catch { /* storage unavailable */ } vp.opts.bedSize = size; vp.opts.bed = true; vp.buildBed(); vp.refreshMaterials(); renderRibbon(); toast(`Build volume: ${name}`); }
function closeDialog(ok, force = false) {
  if (!dialog) return;
  if (ok && !force && result.errors[doc.features[dialog.index].id]) { // keep a feature that has an error? ask in-app
    confirmBox({ title: 'This feature has an error', message: `${result.errors[doc.features[dialog.index].id]}\n\nKeep it anyway?`, ok: 'Keep it' }).then((keep) => { if (keep && dialog) closeDialog(true, true); });
    return;
  }
  const { pre } = dialog;
  vp.hideGizmo();
  vp.showFaces([], null);
  profileHover = null;
  if (ok) {
    const f = doc.features[dialog.index];
    if (f.type === 'extrude' && f.params.extent === 'distance') LAST.extrude = Math.abs((resolvedMap[f.id] || f.params).distance) || undefined;
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
  sketch = { index, isNew, pre, savedMarker: isNew ? doc.marker : wasMarker, tool: isNew ? 'rect' : 'select', sel: -1, hover: -1, pts: null, snap: 'auto', snapOn: true, sides: 6, grid: null };
  applyNavMode();
  doc.marker = Math.max(doc.marker, index + 1);
  selFeature = doc.features[index].id;
  vp.planeHandles.visible = false;
  vp.hideGround = true; vp.grid.visible = false;
  $('#props-wrap').classList.add('open', 'sketch');
  const p = doc.features[index].params;
  vp.lookAtPlane(p);
  buildSketchGrid();
  renderSketchPanel(); setSketchTool(sketch.tool); refresh();
}
const curSketch = () => doc.features[sketch.index];
function setSketchCons(cons) {
  const f = curSketch();
  const nf = { ...f, params: { ...f.params, cons } };
  doc.features[sketch.index] = nf;
  resolvedMap[nf.id] = resolveSketch(nf, (n) => paramState.values[n]).params;
  refresh(); SU?.redraw(); renderSketchPanel(); drawSketches();
}
function setSketchShapes(shapes, push = true) {
  const f = curSketch();
  const nf = { ...f, params: { ...f.params, shapes } };
  doc.features[sketch.index] = nf;
  resolvedMap[nf.id] = resolveSketch(nf, (n) => paramState.values[n]).params;
  refresh();
  SU?.redraw();
}
function buildSketchGrid(step = SU?.stepNow() ?? 1) {
  if (sketch.grid) { vp.scene.remove(sketch.grid); }
  const p = curSketch().params;
  const g = new THREE.Group();
  const mkGrid = (div, c1, c2, op) => { const gr = new THREE.GridHelper(400 * step, div, c1, c2); gr.rotation.x = Math.PI / 2; gr.material.transparent = true; gr.material.opacity = op; gr.renderOrder = -1; return gr; }; // depth-tested: solids hide the grid behind them instead of having grid lines drawn across their faces
  // quiet lines so the drawing stays easy to see. A mid grey at low opacity reads as a faint line on a dark background, on white and
  // on the pale face of a body when you sketch on it (a fixed light or dark colour would look heavy on one of them).
  g.add(mkGrid(400, 0x8a93a0, 0x8a93a0, 0.2), mkGrid(80, 0x8a93a0, 0x8a93a0, 0.36));
  g.matrixAutoUpdate = false;
  g.matrix.copy(vp.planeMatrix(p)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.03)); // a hair above the plane so a face lying in it doesn't flicker
  g.visible = sketch.gridVisible !== false;
  sketch.grid = g;
  vp.scene.add(g);
}
function setSketchTool(t) {
  if (sketch.tool === 'project' && t !== 'project') { edgeHover = null; updateEdgeView(); }
  sketch.tool = t; sketch.mir = null; sketch.trimPrev = null; sketch.pts = null; sketch.sel = t === 'select' ? sketch.sel : -1; sketch.hover = -1;
  SU.activate();
  const hints = { mirror: 'Mirror: click the shapes to copy (click again to unselect), press Enter, then click a line to mirror across, or press X / Y for a sketch axis', trim: 'Trim: hover a curve to see the part that will be removed (red), then click it', spline: 'Spline: click points the curve passes through · click the first point to close · Enter or double-click to finish', project: 'Include: click a model edge to copy it onto this sketch · Shift-click copies every edge of that body', offset: 'Offset: click a closed shape, type a distance (negative = inward), press Enter', sfillet: 'Fillet: click a corner of a rectangle or path, type a radius, press Enter', dim: 'Click a shape, then type a value or an expression like width/2', con_coin: 'Coincident: click the point to move, then the point to meet', con_h: 'Horizontal: click a line segment', con_v: 'Vertical: click a line segment', con_conc: 'Concentric: click two shapes', con_equal: 'Equal: click two segments or two circles', con_par: 'Parallel: click the segment to adjust, then the reference', con_perp: 'Perpendicular: click the segment to adjust, then the reference', select: 'Click a shape to select it · drag to move · drag handles to resize · click a dimension to type a value', arc: 'Click the start point, the end point, then a point on the arc · type a radius', rect: 'Click the first corner, then the opposite corner · type a width/height and press Tab / Enter', crect: 'Click the centre, then a corner · type a width/height', rrect: 'Click two corners · type W, H and a corner radius R', slot: 'Click the first centre, then the second · type a length and width', ellipse: 'Click the centre, then drag the radii · type A and B', circle: 'Click the centre, then drag out the radius · type a diameter and press Enter', ngon: 'Click the centre, then a vertex · type a radius and press Enter', path: 'Click points of an open path · press A for a tangent arc · Enter or double-click to finish', line: 'Click points · press A for a tangent arc · type a length and angle · click the first point, press Enter or double-click to close' };
  $('#hud').innerHTML = `<b>Sketch · ${curSketch().name}</b> — ${hints[t]} · Esc to ${t === 'select' ? 'deselect' : 'stop drawing'}`;
  drawSketches();
  renderRibbon(); renderSketchPanel();
}
function renderSketchPanel() {
  if (!sketch || sketch.picking) return;
  const p = curSketch().params;
  const wrap = $('#props-wrap');
  const sh = p.shapes;
  const fieldsFor = (s) => ({ rect: ['x', 'y', 'w', 'h'], circle: ['cx', 'cy', 'r'], ngon: ['cx', 'cy', 'r', 'n', 'rot'], rrect: ['x', 'y', 'w', 'h', 'r'], slot: ['x1', 'y1', 'x2', 'y2', 'w'], ellipse: ['cx', 'cy', 'rx', 'ry'], path: [] }[s.t]);
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('sketch', 20)}SKETCH PALETTE</div><div class="body">
    <div class="mh" style="font-weight:700;margin:0 0 4px">Options</div>
    <div class="row"><label>Sketch plane</label><select id="sp-plane">${[...['XY', 'XZ', 'YZ'].map((k) => [k, k]), ...doc.features.filter((q, qi) => q.type === 'plane' && qi < sketch.index).map((q) => ['ref:' + q.id, q.name]), ...(p.plane === 'custom' && !p.planeRef ? [['custom', 'custom']] : [])].map(([k, l]) => `<option value="${esc(k)}" ${(k === p.plane && !p.planeRef) || k === 'ref:' + p.planeRef ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="row"><label>Plane offset</label><input id="sp-off" type="text" inputmode="decimal" value="${dispStr(p.offset)}"></div>
    <div class="row"><label>Snap (${getUnits()})</label><select id="sp-snap">${['auto', ...UNIT_TABLE[getUnits()].steps.slice(2, 9)].map((v) => { const mmv = v === 'auto' ? 'auto' : v * lenF(); const sel = v === 'auto' ? sketch.snap === 'auto' : typeof sketch.snap === 'number' && Math.abs(sketch.snap - mmv) < 1e-9; return `<option value="${mmv}" ${sel ? 'selected' : ''}>${v}</option>`; }).join('')}</select></div>
    <div class="row"><label>Polygon sides</label><input id="sp-sides" type="number" min="3" max="64" value="${sketch.sides}"></div>
    <label class="chk"><input type="checkbox" id="sp-grid" ${sketch.grid?.visible === false ? '' : 'checked'}> Sketch Grid</label>
    <label class="chk"><input type="checkbox" id="sp-showprof" ${sketch.showProfile === false ? '' : 'checked'}> Show Profile</label>
    <label class="chk"><input type="checkbox" id="sp-snapon" ${sketch.snapOn === false ? '' : 'checked'}> Snap</label>
    <div style="margin:6px 0"><button class="btn" id="sp-lookat">Look At</button></div>
    <div class="sep"></div>${(p.cons || []).length ? `<div class="mh" style="font-weight:700;margin-bottom:4px">Constraints (${p.cons.length})</div><div id="sp-cons"></div><div class="sep"></div>` : ''}<div class="mh" style="font-weight:700;margin-bottom:4px">Shapes (${sh.length})</div><div id="sp-list"></div>
    <div class="note">Nested shapes become holes. To sketch on a body, start a new sketch and click one of its flat faces.</div></div>
    <div class="foot"><button class="btn" id="sp-cancel">Cancel</button><button class="btn primary" id="sp-ok">Finish Sketch</button></div></div>`;
  const consHost = $('#sp-cons');
  if (consHost) (p.cons || []).forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'shape-item';
    row.innerHTML = `<b style="width:18px;text-align:center;color:#d84a3a">${CON_GLYPH[c.t]}</b><span>${CON_LABEL[c.t]}</span><button class="x" title="Delete">✕</button>`;
    row.querySelector('.x').onclick = () => setSketchCons(p.cons.filter((_, k) => k !== i));
    consHost.appendChild(row);
  });
  const list = $('#sp-list');
  sh.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'shape-item' + (i === sketch.sel ? ' sel' : '');
    item.innerHTML = `${ficon({ rect: 'rect', circle: 'circle', ngon: 'ngon', rrect: 'rrect', slot: 'slot', ellipse: 'ellipse', path: s.open ? 'path' : 'line' }[s.t], 18)}<span>${s.open ? 'Path' : { rect: 'Rectangle', circle: 'Circle', ngon: 'Polygon', rrect: 'Rounded Rect', slot: 'Slot', ellipse: 'Ellipse', path: 'Polyline' }[s.t]} ${i + 1}</span><button class="x" title="Delete">✕</button>`;
    item.onclick = () => { sketch.sel = i; if (sketch.tool !== 'select') setSketchTool('select'); renderSketchPanel(); drawSketches(); SU.redraw(); renderRibbon(); };
    item.querySelector('.x').onclick = (e) => { e.stopPropagation(); setSketchShapes(sh.filter((_, k) => k !== i)); sketch.sel = -1; renderSketchPanel(); };
    list.appendChild(item);
    if (i === sketch.sel && fieldsFor(s).length) {
      const g = document.createElement('div');
      g.className = 'shape-fields';
      for (const k of fieldsFor(s)) {
        const l = document.createElement('label');
        const lenKey = !['n', 'rot'].includes(k);
        l.innerHTML = `${k}<input type="text" inputmode="decimal" value="${lenKey ? dispStr(s[k]) : +s[k].toFixed(3)}">`;
        l.querySelector('input').oninput = (e) => { const v = parseFloat(e.target.value); if (isNaN(v)) return; setSketchShapes(sh.map((o, j) => (j === i ? { ...o, [k]: lenKey ? v * lenF() : v } : o))); };
        g.appendChild(l);
      }
      list.appendChild(g);
    }
  });
  $('#sp-plane').onchange = (e) => {
    const v = e.target.value;
    if (v === 'custom') return;
    if (v.startsWith('ref:')) { const g = resolvedMap[v.slice(4)]; if (!g) return; setSketchParam({ planeRef: v.slice(4), plane: 'custom', origin: g.origin, normal: g.normal, xdir: g.xdir }); }
    else setSketchParam({ plane: v, planeRef: undefined, origin: undefined, normal: undefined, xdir: undefined });
    vp.lookAtPlane(curSketch().params); renderSketchPanel();
  };
  $('#sp-off').oninput = (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setSketchParam({ offset: v * lenF() }); };
  $('#sp-snap').onchange = (e) => { sketch.snap = e.target.value === 'auto' ? 'auto' : +e.target.value; sketch.gridStep = null; };
  $('#sp-sides').oninput = (e) => { sketch.sides = Math.max(3, Math.min(64, Math.round(+e.target.value) || 6)); };
  $('#sp-grid').onchange = (e) => { sketch.gridVisible = e.target.checked; if (sketch.grid) sketch.grid.visible = e.target.checked; };
  $('#sp-showprof').onchange = (e) => { sketch.showProfile = e.target.checked; updateProfileView(); };
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
/** After a shape was replaced by `delta + 1` shapes (trim), drop its constraints and shift the later shape indices. */
function remapSketchCons(si, delta) {
  const cons = (curSketch().params.cons || []).filter((c) => c.a?.s !== si && c.b?.s !== si).map((c) => {
    const sh = (r) => (r && r.s > si ? { ...r, s: r.s + delta } : r);
    return { ...c, a: sh(c.a), ...(c.b ? { b: sh(c.b) } : {}) };
  });
  if (cons.length !== (curSketch().params.cons || []).length || delta) setSketchCons(cons);
}
// ---- project / include: copy model edges onto the sketch plane
function projectHover(e) {
  const en = vp.pickEdge(e, edgeEntries());
  if ((en?.chain || null) !== (edgeHover?.chain || null)) { edgeHover = en; updateEdgeView(); }
  return !!en;
}
function projectPick(e, all) {
  const en = vp.pickEdge(e, edgeEntries());
  if (!en) return [];
  const fr = planeFrame(resolvedMap[curSketch().id] || curSketch().params);
  const chains = all ? edgeEntries().filter((x) => x.body === en.body).map((x) => x.chain) : [en.chain];
  const out = [], seen = new Set();
  const keyOf = (pts) => pts.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';');
  for (const sh of curSketch().params.shapes) if (sh.t === 'path') { seen.add(keyOf(sh.pts)); seen.add(keyOf([...sh.pts].reverse())); } // already included
  for (const ch of chains) {
    const pts = ch.pts.map((q) => { const d = [q[0] - fr.o[0], q[1] - fr.o[1], q[2] - fr.o[2]]; return [+(d[0] * fr.x[0] + d[1] * fr.x[1] + d[2] * fr.x[2]).toFixed(4), +(d[0] * fr.y[0] + d[1] * fr.y[1] + d[2] * fr.y[2]).toFixed(4)]; });
    const dedup = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
    if (dedup.length < 2) continue;
    const key = keyOf(dedup);
    if (seen.has(key)) continue; seen.add(key); seen.add(keyOf([...dedup].reverse()));
    out.push({ t: 'path', open: !ch.closed, pts: dedup });
  }
  return out;
}
function sketchDeleteSelected() { if (sketch.sel >= 0) { setSketchShapes(curSketch().params.shapes.filter((_, i) => i !== sketch.sel)); sketch.sel = -1; renderSketchPanel(); } }
function leaveSketch() {
  SU?.deactivate();
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

function sketchPointer(ev, kind) { SU.pointer(ev, kind); }
function closePath() { SU.finishPath(); }

const fatMat = (color, width) => new LineMaterial({ color, linewidth: width });
const sketchMat = fatMat(0x2b6cb0, 2.8);         // a finished sketch
const sketchMatActive = fatMat(0x0b6bcb, 3.2);   // the sketch you are editing
const sketchMatSel = fatMat(0xf08c00, 3.6);
const sketchMatHover = fatMat(0x00a2ff, 3.6);
function drawSketches() {
  if (!vp) return;
  vp.sketchGroup.clear();
  doc.features.forEach((f, i) => {
    if (f.type !== 'sketch' || f.suppressed) return;
    const active = sketch && sketch.index === i;
    if (!active && (i >= limit() || !(sketchVis[f.id] ?? !result.sketchUsed.has(f.id)))) return;
    const rp = resolvedMap[f.id] || f.params;
    rp.shapes.forEach((s, k) => {
      const poly = shapeToPolygon(s);
      if (poly.length < 2) return;
      const nrm = planeFrame(rp).n; // lift the lines a hair off the plane so a face lying in it can't break them up
      const pts = poly.map((q) => vp.planeTo3D(rp, q).addScaledVector(new THREE.Vector3(...nrm), 0.06));
      const m = active ? (k === sketch.sel ? sketchMatSel : k === sketch.hover ? sketchMatHover : sketchMatActive) : sketchMat;
      vp.sketchGroup.add(vp.fatLine(pts, m, !s.open));
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
    <div class="hint">Name a dimension once, then type the name (or any expression such as <b>width/2 + 3 mm</b>) into feature fields. Plain numbers use the document units (${getUnits()}); <code>sin cos tan sqrt min max pi</code> and the unit suffixes <code>mm cm m in ft</code> work. Choose <b>Number</b> or <b>Angle</b> for values that aren't lengths.</div>
    <div class="ptable" id="pt"></div><div><button class="btn" id="p-add">+ Add parameter</button></div></div>
    <div class="modal-foot"><button class="btn primary" data-x>Done</button></div>`, () => { if (changed) { pushUndo(pre); refresh(); } });
  m.el.classList.add('wide');
  m.el.querySelector('[data-x]').onclick = m.close;
  const host = m.el.querySelector('#pt');
  const apply = (list) => { doc.params = list; changed = true; markDirty(); refresh(); };
  const draw = () => {
    host.innerHTML = '<div class="h">Name</div><div class="h">Expression</div><div class="h">Type</div><div class="h">Value</div><div class="h">Comment</div><div></div>';
    const list = doc.params || [];
    list.forEach((p, i) => {
      const name = document.createElement('input'); name.value = p.name; name.spellcheck = false;
      const ex = document.createElement('input'); ex.value = p.expr; ex.spellcheck = false;
      const ut = document.createElement('select');
      ut.innerHTML = '<option value="length">Length</option><option value="number">Number</option><option value="angle">Angle</option>';
      ut.value = p.unit || 'length';
      ut.onchange = () => { apply(doc.params.map((q, j) => (j === i ? { ...q, unit: ut.value } : q))); showVal(); };
      const val = document.createElement('div'); val.className = 'val';
      const cm = document.createElement('input'); cm.value = p.comment || ''; cm.placeholder = 'optional';
      const del = document.createElement('button'); del.className = 'icon-btn danger'; del.innerHTML = icon('remove', 16); del.title = 'Delete';
      const showVal = () => {
        const r = resolveParams(doc.params || []);
        const err = r.errors[(doc.params[i] || {}).name];
        val.className = 'val' + (err ? ' err' : '');
        val.textContent = err ? err : paramShow(doc.params[i], r.values[doc.params[i].name]);
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
      host.append(name, ex, ut, val, cm, del);
      showVal();
    });
    if (!list.length) host.insertAdjacentHTML('beforeend', '<div class="hint" style="grid-column:1/-1">No parameters yet.</div>');
  };
  m.el.querySelector('#p-add').onclick = () => {
    let n = 1; const used = new Set((doc.params || []).map((q) => q.name));
    while (used.has('d' + n)) n++;
    apply([...(doc.params || []), { name: 'd' + n, expr: '10', unit: 'length', comment: '' }]);
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
  const fmt = (v) => dispStr(v);
  const un = getUnits();
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
        logMeasure('Distance', `${fmt(dist3(a, b))} ${un}`, `ΔX ${fmt(b[0] - a[0])}  ΔY ${fmt(b[1] - a[1])}  ΔZ ${fmt(b[2] - a[2])}`);
      } else {
        const [a, v, c] = M.pts;
        const u = [a[0] - v[0], a[1] - v[1], a[2] - v[2]], w = [c[0] - v[0], c[1] - v[1], c[2] - v[2]];
        const lu = Math.hypot(...u), lw = Math.hypot(...w);
        if (!lu || !lw) return toast('The points must be distinct.', true);
        const ang = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw)))) * 180) / Math.PI;
        logMeasure('Angle', `${ang.toFixed(2)}°`, `Supplement ${(180 - ang).toFixed(2)}°  ·  legs ${fmt(lu)} / ${fmt(lw)} ${un}`);
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
    if (closed && rm > 0 && Math.max(...rs.map((r) => Math.abs(r - rm))) / rm < 0.02) detail = `Circle · Ø ${fmt(rm * 2)} ${un} · R ${fmt(rm)} ${un}`;
    logMeasure('Edge length', `${fmt(L)} ${un}`, detail);
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
      if (ang < 0.05) logMeasure('Distance between parallel faces', `${fmt(dd)} ${un}`, 'Faces are parallel');
      else logMeasure('Angle between faces', `${ang.toFixed(2)}°`, `Supplement ${(180 - ang).toFixed(2)}°`);
    }
  }
}

// ------------------------------------------------------------------ inspect / print
function showInterference() {
  if (dialog || sketch) return;
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id));
  const hits = bodies.length > 1 ? interference(bodies) : [];
  const wrap = $('#props-wrap');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('combine', 20)}INTERFERENCE</div><div class="body">${
    bodies.length < 2 ? 'Needs at least two visible bodies.' : hits.length ? `<div class="stat"><span>Interfering pairs</span><b class="warn">${hits.length}</b></div>` + hits.map((h) => `<div class="sep"></div><b>${esc(h.a.name)} ∩ ${esc(h.b.name)}</b><div class="stat"><span>Overlap volume</span><b>${fmtVolume(h.volume)}</b></div>`).join('') : '<div class="stat"><span>Result</span><b class="ok">No interference</b></div>'
  }</div><div class="foot"><button class="btn primary" id="i-close">Close</button></div></div>`;
  wrap.classList.add('open');
  vp.selected.clear(); hits.forEach((h) => { vp.selected.add(h.a.id); vp.selected.add(h.b.id); }); vp.refreshMaterials();
  $('#i-close').onclick = () => { wrap.classList.remove('open'); };
}
function showDriveJoints() {
  if (dialog || sketch) return;
  const joints = doc.features.map((f, i) => [f, i]).filter(([f]) => f.type === 'joint' && ['revolute', 'slider', 'cylindrical', 'planar'].includes(f.params.jtype));
  const wrap = $('#props-wrap');
  if (!joints.length) return toast('No movable joints yet. Add a Revolute, Slider, Cylindrical or Planar joint first.', true);
  const rng = (f) => (['revolute', 'cylindrical'].includes(f.params.jtype) ? [-180, 180, 1, '°'] : (() => { const m = Math.max(50, Math.abs(f.params.value) * 2); return [-m, m, m / 200, ' mm']; })());
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('joint', 20)}DRIVE JOINTS</div><div class="body">${joints.map(([f, i]) => { const [lo, hi, st, u] = rng(f); return `<div class="stat"><span>${esc(f.name)} (${f.params.jtype})</span><b id="dj-v${i}">${+f.params.value.toFixed(2)}${u}</b></div><input type="range" data-i="${i}" min="${lo}" max="${hi}" step="${st}" value="${f.params.value}" style="width:100%">`; }).join('')}</div><div class="foot"><button class="btn primary" id="i-close">Done</button></div></div>`;
  wrap.classList.add('open');
  wrap.querySelectorAll('input[type=range]').forEach((r) => {
    let pushed = false;
    r.oninput = () => {
      const i = +r.dataset.i;
      if (!pushed) { pushUndo(snapshot()); pushed = true; }
      doc.features[i] = { ...doc.features[i], params: { ...doc.features[i].params, value: +r.value } };
      refresh();
      const u = rng(doc.features[i])[3];
      const el = $('#dj-v' + i); if (el) el.textContent = `${+(+r.value).toFixed(2)}${u}`;
    };
    r.onchange = () => { pushed = false; };
  });
  $('#i-close').onclick = () => { wrap.classList.remove('open'); };
}
function showSection() {
  if (dialog || sketch) return;
  if (!result.bodies.length) return toast('Nothing to section yet.', true);
  const wrap = $('#props-wrap'), st = { axis: 'Z', offset: 0, flip: false };
  const range = () => { const b = vp.bounds(), k = 'xyz'['XYZ'.indexOf(st.axis)]; return [b.min[k], b.max[k]]; };
  const apply = () => vp.setSection({ ...st });
  const render = () => {
    const [lo, hi] = range(), u = getUnits();
    st.offset = Math.min(hi, Math.max(lo, st.offset));
    wrap.innerHTML = `<div class="props"><div class="title">${ficon('sectionan', 20)}SECTION ANALYSIS</div><div class="body">
      <div class="row"><label>Plane</label><select id="sa-ax"><option value="X"${st.axis === 'X' ? ' selected' : ''}>YZ (normal X)</option><option value="Y"${st.axis === 'Y' ? ' selected' : ''}>XZ (normal Y)</option><option value="Z"${st.axis === 'Z' ? ' selected' : ''}>XY (normal Z)</option></select></div>
      <div class="row"><label>Offset (${u})</label><input id="sa-off" type="number" step="any" value="${+(st.offset / lenF()).toFixed(4)}"></div>
      <input id="sa-sl" type="range" min="${lo}" max="${hi}" step="${Math.max((hi - lo) / 400, 0.01)}" value="${st.offset}" style="width:100%">
      <div class="row"><label>Flip side</label><input id="sa-fl" type="checkbox"${st.flip ? ' checked' : ''}></div>
      <div class="note">Hides everything beyond the plane and caps the cut. Nothing is added to the timeline.</div></div>
      <div class="foot"><button class="btn primary" id="i-close">Done</button></div></div>`;
    $('#sa-ax').onchange = (e) => { st.axis = e.target.value; const [l, h] = range(); st.offset = (l + h) / 2; render(); apply(); };
    $('#sa-off').oninput = (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { st.offset = v * lenF(); $('#sa-sl').value = st.offset; apply(); } };
    $('#sa-sl').oninput = (e) => { st.offset = +e.target.value; $('#sa-off').value = +(st.offset / lenF()).toFixed(4); apply(); };
    $('#sa-fl').onchange = (e) => { st.flip = e.target.checked; apply(); };
    $('#i-close').onclick = () => { wrap.classList.remove('open'); vp.setSection(null); };
  };
  { const [l, h] = range(); st.offset = (l + h) / 2; }
  render(); wrap.classList.add('open'); apply();
}
function pick2D(accept) { const i = $('#file-2d'); i.accept = accept; i.click(); }
/** Add imported 2D shapes to the open sketch, or start a new one on the XY plane first. */
function addImportedShapes(shapes, label) {
  if (!shapes.length) return toast(`No usable outlines found in ${label}.`, true);
  if (dialog) return toast('Finish the open command first.', true);
  if (!sketch) { enterSketch(doc.marker, true, 'XY'); }
  setSketchShapes([...curSketch().params.shapes, ...shapes]);
  sketch.sel = -1; renderSketchPanel(); drawSketches();
  toast(`Inserted ${shapes.length} outline${shapes.length > 1 ? 's' : ''} from ${label}`);
}
async function import2D(file) {
  try {
    const text = await file.text();
    const svg = /\.svg$/i.test(file.name);
    addImportedShapes(svg ? parseSVG(text) : parseDXF(text), file.name);
  } catch (e) { toast('Import failed: ' + e.message, true); }
}
function showTextDialog() {
  if (dialog) return;
  const m = modal(`<div class="modal-title">Text</div><div class="modal-body"><label>Text<textarea id="tx-s" rows="2" style="font:inherit">Sketchy</textarea></label><label>Height (${getUnits()})<input id="tx-h" type="number" value="${+(10 / lenF()).toFixed(3)}" step="any"></label><label style="flex-direction:row;align-items:center;gap:6px"><input id="tx-b" type="checkbox"> Bold</label></div><div class="foot" style="padding:10px 16px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="tx-c">Cancel</button><button class="btn primary" id="tx-ok">Insert</button></div>`);
  $('#tx-c').onclick = m.close;
  $('#tx-ok').onclick = async () => {
    const s = $('#tx-s').value, h = +$('#tx-h').value * lenF();
    if (!s.trim() || !(h > 0)) return toast('Enter some text and a height.', true);
    try { const shapes = await textShapes(s, h, $('#tx-b').checked); m.close(); addImportedShapes(shapes, 'text'); } catch (e) { toast('Text failed: ' + e.message, true); }
  };
  $('#tx-s').focus();
}
function startAsBuilt() {
  startFeature('joint');
  if (!dialog) return;
  const i = dialog.index, f = doc.features[i];
  // As-built: both bodies stay where they are, so the joint origin sits on the moving body's current point.
  doc.features[i] = { ...f, name: uniqueName('As-built Joint'), params: { ...f.params, pointB: [...f.params.pointA] } };
  renderDialog(); refresh();
  toast('As-built joint: bodies stay in place; set the joint type and axis.');
}
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
      <div class="stat"><span>Size (${getUnits()})</span><b>${s.map((v) => dispStr(v, 3)).join(' × ')}</b></div>
      <div class="stat"><span>Volume</span><b>${fmtVolume(b.volume)}</b></div>
      <div class="stat"><span>Surface area</span><b>${fmtArea(b.area)}</b></div>
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
const EXPORT_FORMATS = [
  ['stl', 'STL', ''],
  ['3mf', '3MF', ''],
  ['obj', 'OBJ', ''],
  ['step', 'STEP', 'For other CAD programs. Flat faces are exact; curved surfaces are written as small flat facets.'],
  ['sketchy', 'Sketchy project', 'The whole design with its feature timeline. Reopens fully editable in Sketchy.'],
];
function exportFile(fmt, name, selectedOnly) {
  if (fmt === 'sketchy') { download(new Blob([projectJSON(name)], { type: 'application/json' }), `${name}.sketchy.json`); toast(`Exported "${name}" as a Sketchy project`); return; }
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!selectedOnly || vp.selected.has(b.id))).map((b) => ({ ...b, color: (doc.appearance || {})[b.id] }));
  if (!bodies.length) return toast('Nothing to export.', true);
  const w = { stl: writeSTL, '3mf': write3MF, obj: writeOBJ, step: writeSTEP }[fmt];
  download(w(bodies, name), `${name}.${fmt}`);
  toast(`Exported ${bodies.length} body${bodies.length > 1 ? 's' : ''} as ${fmt.toUpperCase()}`);
}
function exportDialog() {
  if (dialog || sketch) return;
  let last = 'stl'; try { last = localStorage.getItem('sketchy.exportFormat') || 'stl'; } catch { /* storage unavailable */ }
  if (!EXPORT_FORMATS.some((f) => f[0] === last)) last = 'stl';
  const hasSel = vp.selected.size > 0, nm = (doc.name === 'Untitled' ? 'design' : doc.name);
  const m = modal(`<div class="modal-title">Export</div>
    <form class="modal-body ex">
      <label>File name<input id="ex-name" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(nm)}"></label>
      <label>Format<select id="ex-fmt" name="fmt">${EXPORT_FORMATS.map(([v, l]) => `<option value="${v}" ${v === last ? 'selected' : ''}>${esc(l)} (${v === 'sketchy' ? '.sketchy.json' : '.' + v})</option>`).join('')}</select></label>
      <div class="ex-desc" id="ex-desc" aria-live="polite" hidden></div>
      <label class="ex-chk" id="ex-scope"><input type="checkbox" id="ex-sel" ${hasSel ? 'checked' : 'disabled'}><span>Selected bodies only${hasSel ? '' : ' <small>(select bodies first)</small>'}</span></label>
      <div class="note" id="ex-err" role="alert" style="color:var(--danger);min-height:1.2em"></div>
      <div class="modal-foot" style="padding:0"><button type="button" class="btn" id="ex-c">Cancel</button><button type="submit" class="btn primary">Export</button></div>
    </form>`);
  const form = m.el.querySelector('form'), fmtSel = m.el.querySelector('#ex-fmt');
  const sync = () => {
    const f = fmtSel.value, proj = f === 'sketchy';
    const d = (EXPORT_FORMATS.find((x) => x[0] === f) || [])[2] || '', de = m.el.querySelector('#ex-desc');
    de.textContent = d; de.hidden = !d;
    m.el.querySelector('#ex-sel').disabled = proj || !hasSel; m.el.querySelector('#ex-scope').style.opacity = proj || !hasSel ? '.55' : '';
  };
  fmtSel.onchange = sync; sync();
  m.el.querySelector('#ex-c').onclick = () => m.close();
  setTimeout(() => { const n = m.el.querySelector('#ex-name'); n.focus(); n.select(); }, 0);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = fileSafeName(m.el.querySelector('#ex-name').value);
    if (!name) { m.el.querySelector('#ex-err').textContent = 'Enter a file name.'; return; }
    const fmt = fmtSel.value;
    try { localStorage.setItem('sketchy.exportFormat', fmt); } catch { /* storage unavailable */ }
    m.close();
    exportFile(fmt, name, m.el.querySelector('#ex-sel').checked && fmt !== 'sketchy');
  };
}
async function importSTL(file) {
  try {
    let soup = parseSTL(await file.arrayBuffer());
    const name = file.name.replace(/\.stl$/i, '');
    const attempt = (data) => {
      const pre = snapshot();
      const f = { id: 'f' + doc.nextId++, type: 'import', name, params: { data: encodeFloats(data), tris: data.length / 9 } };
      doc.features.splice(doc.marker, 0, f); doc.marker++;
      pushUndo(pre);
      result = rebuild(doc.features, doc.marker);
      if (result.errors[f.id]) { restore(pre); undoStack.pop(); return result.errors[f.id]; }
      return null;
    };
    let err = attempt(soup), note = '';
    if (err) {
      const fixed = repairSoup(soup);
      err = attempt(fixed.soup);
      if (err) { refresh(); return toast(`Import failed: ${err}. Mesh repair could not make it a closed solid (${fixed.report.skippedHoles} unfillable holes).`, true); }
      soup = fixed.soup; note = ` - repaired: ${describeRepair(fixed.report)}`;
    }
    vp.fitted = false; refresh();
    toast(`Imported ${name} (${(soup.length / 9).toLocaleString()} triangles)${note}`);
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
const projectJSON = (name = doc.name, withThumb = false) => { const { rev, ...rest } = doc; return JSON.stringify({ format: 'sketchy', version: 1, ...rest, name, ...(withThumb ? { thumb: captureThumb() } : {}) }); };
function loadProject(txt, rev = 0, seq = rev) {
  const d = JSON.parse(txt);
  if (d.format !== 'sketchy') throw new Error('Not a Sketchy project');
  doc = { name: d.name, features: d.features, marker: d.marker, nextId: d.nextId, params: d.params || [], saves: d.saves || 0, appearance: d.appearance || {}, units: UNIT_TABLE[d.units] ? d.units : 'mm', components: d.components || [], bodyComp: d.bodyComp || {}, configs: d.configs || [], activeConfig: d.activeConfig || null, canvases: d.canvases || [], rev, seq };
  setUnits(doc.units);
  undoStack = []; redoStack = []; vp.selected.clear(); hiddenBodies.clear();
  dirty = false; $('#doc-dirty').classList.remove('on'); $('#doc-name').textContent = doc.name;
  vp.fitted = false; refresh();
}
const safeName = (n) => n.replace(/[^\w .()-]/g, '_').slice(0, 80) || 'Untitled';
const putDesign = (name, ifMatch, folder, auto = false) => call('PUT', '/projects/' + encodeURIComponent(name), projectJSON(name, true), { 'if-match': String(ifMatch), ...(folder === undefined ? {} : { 'x-folder': encodeURIComponent(folder) }), ...(auto ? { 'x-autosave': '1' } : {}) });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Ask what to do when the saved design changed elsewhere. Resolves 'overwrite' | 'copy' | 'theirs' | null. */
function conflictDialog(info, name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(`<div class="modal-title">"${esc(name)}" changed on the server</div><div class="modal-body">
      <p style="margin:0">It was saved${info.device ? ` from <b>${esc(info.device)}</b>` : ''}${info.modified ? ` ${ago(info.modified)}` : ''} (revision ${info.rev}) after you opened it. Saving now would replace those changes.</p>
      <div class="conflict-actions">
        <button class="btn primary" data-c="copy">Save mine as a copy…</button>
        <button class="btn" data-c="theirs">Discard mine, open theirs</button>
        <button class="btn danger" data-c="overwrite">Overwrite with mine</button>
      </div></div><div class="modal-foot"><button class="btn" data-c="">Cancel</button></div>`, () => finish(null));
    m.el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { finish(b.dataset.c || null); m.close(); }));
  });
}

async function openDesign(name, quiet = false) {
  const d = await call('GET', '/projects/' + encodeURIComponent(name));
  if (!d.ok) return toast(d.data?.error || 'Could not open design.', true);
  const mt = await call('GET', '/projects/' + encodeURIComponent(name) + '/meta'); const dFolder = mt.ok ? mt.data.folder || '' : '';
  try { loadProject(typeof d.data === 'string' ? d.data : JSON.stringify(d.data), d.rev, d.seq || d.rev); doc.folder = dFolder; doc.name = name; $('#doc-name').textContent = name; bannerRev = doc.seq; rememberLast(name); hideBanner(); refresh(); if (!quiet) toast(`Opened "${name}"`); }
  catch (x) { toast(x.message, true); }
}

async function save(as) {
  let name = doc.name, folder = doc.folder || '';
  if (acct.server && !(await requireLogin())) return;
  if (acct.server && (as || name === 'Untitled')) { // in-app Save dialog: name + folder
    const pick = await saveDialog({ name: name === 'Untitled' ? 'My design' : name, folder, title: as ? 'Save design as' : 'Save design' });
    if (!pick) return;
    name = pick.name; folder = pick.folder;
  } else if (!acct.server && (as || name === 'Untitled')) {
    const n = await askName({ title: 'Save design', label: 'File name', value: name === 'Untitled' ? 'My design' : name, ok: 'Download', hint: 'There is no Sketchy server here, so the design is downloaded as a file.' });
    if (!n) return; name = n;
  }
  if (acct.server) {
    doc.saves = (doc.saves || 0) + 1;
    const expect = name === doc.name ? doc.seq || 0 : 0; // a new name should not already exist
    let r = await putDesign(name, expect, folder);
    if (r.status === 409) {
      const choice = await conflictDialog(r.data, name);
      if (choice === 'overwrite') r = await putDesign(name, '*', folder);
      else if (choice === 'copy') {
        const pick = await saveDialog({ name: `${name} (copy)`, folder, title: 'Save a copy', okLabel: 'Save copy' });
        if (!pick || pick.name === 'Untitled') return;
        r = await putDesign(pick.name, 0, pick.folder);
        if (r.status === 409) return toast(`"${pick.name}" already exists — choose another name.`, true);
        name = pick.name; folder = pick.folder;
      } else if (choice === 'theirs') return openDesign(name);
      else return;
    }
    if (!r.ok) return toast('Save failed: ' + (r.data?.error || r.status), true);
    doc.rev = r.data.rev; doc.seq = r.data.seq; doc.conflict = false; bannerRev = doc.seq; hideBanner(); doc.folder = folder; rememberLast(name);
    toast(`Saved "${name}"${folder ? ` in ${folder}` : ''}`);
    if ($('#data-panel').classList.contains('open')) renderDataPanel();
  } else download(new Blob([projectJSON(name)], { type: 'application/json' }), `${name}.sketchy.json`);
  doc.name = name; $('#doc-name').textContent = name;
  dirty = false; $('#doc-dirty').classList.remove('on');
}

// ---- cross-device: drafts, remote-change banner
let draftT = null, bannerRev = 0;
const draftKey = () => (doc.name === 'Untitled' ? '__untitled' : safeName(doc.name));
function scheduleServerDraft() {
  if (!acct.user || doc.name !== 'Untitled') return; // named designs autosave to the server itself
  clearTimeout(draftT);
  draftT = setTimeout(async () => { if (acct.user && dirty) await call('PUT', '/drafts/' + encodeURIComponent(draftKey()), projectJSON(doc.name), { 'x-base-rev': String(doc.rev || 0) }); }, 4000);
}
async function checkDrafts() {
  if (!acct.user) return;
  const r = await call('GET', '/drafts');
  if (!r.ok || !r.data.length) return;
  const localT = +localStorage.getItem('sketchy.autosave.t') || 0;
  const d = r.data.find((x) => x.modified > localT + 2000);
  if (!d) return;
  const title = d.key === '__untitled' ? 'an unsaved design' : `"${d.key}"`;
  const choice = await new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(`<div class="modal-title">Resume where you left off?</div><div class="modal-body"><p style="margin:0">There is an autosaved draft of ${esc(title)} from <b>${esc(d.device || 'another device')}</b>, ${ago(d.modified)}.</p></div>
      <div class="modal-foot"><button class="btn" data-c="discard">Discard draft</button><button class="btn" data-c="">Not now</button><button class="btn primary" data-c="resume">Resume</button></div>`, () => finish(''));
    m.el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { finish(b.dataset.c); m.close(); }));
  });
  if (choice === 'resume') {
    const g = await call('GET', '/drafts/' + encodeURIComponent(d.key));
    if (g.ok) { loadProject(typeof g.data === 'string' ? g.data : JSON.stringify(g.data), d.base ?? 0); doc.name = d.key === '__untitled' ? 'Untitled' : d.key; $('#doc-name').textContent = doc.name; dirty = true; $('#doc-dirty').classList.add('on'); refresh(); toast('Draft restored'); }
  } else if (choice === 'discard') await call('DELETE', '/drafts/' + encodeURIComponent(d.key));
}
function showBanner(info) {
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = `<span>${uicon('warn', 15, 1.6)} "${esc(doc.name)}" was updated${info.device ? ` from <b>${esc(info.device)}</b>` : ''} (revision ${info.rev}).${dirty ? ' You have unsaved changes — saving will ask what to do.' : ''}</span><button class="btn sm" id="bn-reload">${dirty ? 'Discard mine & reload' : 'Reload'}</button><button class="btn sm" id="bn-x">Dismiss</button>`;
  $('#bn-reload').onclick = async () => { if (dirty && !(await confirmBox({ title: 'Discard your changes?', message: 'Load the latest version and discard your unsaved changes?', ok: 'Discard and load', danger: true }))) return; openDesign(doc.name); };
  $('#bn-x').onclick = hideBanner;
}
const hideBanner = () => { const b = $('#banner'); if (b) b.hidden = true; };
function startRemotePolling() {
  setInterval(async () => {
    if (document.hidden || !acct.user || !doc.rev || doc.name === 'Untitled' || asBusy) return;
    const r = await call('GET', '/projects/' + encodeURIComponent(doc.name) + '/meta');
    if (r.ok && r.data.seq > doc.seq && r.data.seq !== bannerRev) { bannerRev = r.data.seq; showBanner(r.data); }
  }, 20000);
  addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('pagehide', () => { if (dirty) { try { localStorage.setItem('sketchy.autosave', projectJSON()); localStorage.setItem('sketchy.autosave.t', String(Date.now())); } catch { /* too large */ } } }); // keep a change made just before closing; the next start restores it
}
function openFromServer() { toggleDataPanel(true); }
// ------------------------------------------------------------------ document tabs
// The live design always sits in the module globals (doc, undoStack, ...). Inactive tabs keep a saved copy of that
// state in tab.state; switching saves the active one and loads the other.
let tabs = [{ id: 1, state: null }], activeTab = 1, nextTabId = 2;
const tabName = (t) => (t.id === activeTab ? doc.name : t.state.doc.name);
const tabDirty = (t) => (t.id === activeTab ? dirty : t.state.dirty);
function captureTabState() {
  return {
    doc, undoStack, redoStack, dirty, hidden: [...hiddenBodies], sketchVis: { ...sketchVis }, originVis, selFeature, selSet: new Set(selSet),
    cam: vp ? { pos: vp.camera.position.toArray(), target: vp.controls.target.toArray(), up: vp.camera.up.toArray() } : null,
  };
}
function applyTabState(st) {
  doc = st.doc; undoStack = st.undoStack; redoStack = st.redoStack; dirty = st.dirty;
  hiddenBodies.clear(); st.hidden.forEach((h) => hiddenBodies.add(h));
  for (const k of Object.keys(sketchVis)) delete sketchVis[k];
  Object.assign(sketchVis, st.sketchVis);
  originVis = st.originVis; vp.setOriginVisible(originVis);
  selFeature = st.selFeature; selSet = new Set(st.selSet);
  selEdges = []; selFace = null; edgeHover = null; profSel = new Set(); profHover = null; vp.showFaces([], null);
  vp.selected.clear(); setUnits(doc.units || 'mm'); hideBanner();
  $('#doc-dirty').classList.toggle('on', dirty);
  if (st.cam) { vp.camera.position.fromArray(st.cam.pos); vp.controls.target.fromArray(st.cam.target); vp.camera.up.fromArray(st.cam.up); vp.controls.update(); vp.fitted = true; } else vp.fitted = false;
}
const blankState = () => ({ doc: blankDoc(), undoStack: [], redoStack: [], dirty: false, hidden: [], sketchVis: {}, originVis: false, selFeature: null, selSet: new Set(), cam: null });
const isPristine = () => !dirty && !doc.features.length && doc.name === 'Untitled' && !doc.rev;
function busy() { if (dialog || sketch || measure) { toast('Finish the current command first.', true); return true; } return false; }
function switchToState(st) { applyTabState(st); renderDocTabs(); refresh(); }
/** Open a blank design in a new tab. With reuseBlank, an untouched blank tab is reused instead. */
function newTab({ reuseBlank = false } = {}) {
  if (busy()) return false;
  if (reuseBlank && isPristine()) return true;
  const cur = tabs.find((t) => t.id === activeTab);
  cur.state = captureTabState();
  const t = { id: nextTabId++, state: null };
  tabs.push(t); activeTab = t.id;
  cur.state = cur.state; switchToState(blankState());
  return true;
}
function activateTab(id) {
  if (id === activeTab || busy()) return;
  const cur = tabs.find((t) => t.id === activeTab), next = tabs.find((t) => t.id === id);
  if (!next) return;
  cur.state = captureTabState();
  activeTab = id;
  const st = next.state; next.state = null;
  switchToState(st);
  if (dirty && canAutosave()) scheduleServerSave();
}
async function closeTab(id) {
  if (busy()) return;
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.id === activeTab && dirty && canAutosave()) await serverAutosave(); // let a pending autosave land first
  if (tabDirty(t) && !(await confirmBox({ title: 'Close without saving?', message: `"${tabName(t)}" has unsaved changes. Close it anyway?`, ok: 'Close tab', danger: true }))) return;
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (!tabs.length) { // closing the last tab leaves a fresh blank design
    const nt = { id: nextTabId++, state: null }; tabs.push(nt); activeTab = nt.id; switchToState(blankState()); return;
  }
  if (id === activeTab) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    activeTab = next.id; const st = next.state; next.state = null; switchToState(st);
  } else renderDocTabs();
}
/** Focus the tab that already has this saved design open. */
function focusOpenDesign(name) {
  const t = tabs.find((x) => tabName(x) === name && (x.id === activeTab ? doc.rev : x.state.doc.rev));
  if (!t) return false;
  activateTab(t.id); return true;
}
const lastKey = () => 'sketchy.last.' + (acct.user || '');  // per person, so signing in as someone else doesn't look for the wrong design
const rememberLast = (name) => { try { localStorage.setItem(lastKey(), name); } catch { /* storage unavailable */ } };
let namingNow = false;
/** Ask for a name and folder, make sure the name is free, and return { name, folder } (or null if cancelled). */
async function askNewDesign(title, okLabel) {
  let last = ''; try { last = localStorage.getItem('sketchy.lastFolder') || ''; } catch { /* storage unavailable */ }
  let name = '';
  for (;;) {
    const pick = await saveDialog({ name, folder: doc.folder || last, title, okLabel });
    if (!pick) return null;
    const exists = await call('GET', '/projects/' + encodeURIComponent(pick.name) + '/meta');
    if (!exists.ok) { try { localStorage.setItem('sketchy.lastFolder', pick.folder); } catch { /* storage unavailable */ } return pick; }
    await alertBox({ title: 'Name already used', message: `You already have a design called "${pick.name}". Choose another name.` });
    name = pick.name;
  }
}
/** Store the design in the current tab under a new name (its first saved version). */
async function createOnServer(pick) {
  const d = doc, r = await putDesign(pick.name, 0, pick.folder);
  if (!r.ok) { toast(r.status === 409 ? `"${pick.name}" already exists.` : 'Could not create the design: ' + (r.data?.error || r.status), true); return false; }
  d.name = pick.name; d.folder = pick.folder; d.rev = r.data.rev; d.seq = r.data.seq; d.conflict = false; d.nameAsked = true;
  if (doc === d) { dirty = false; bannerRev = d.seq; renderDocTabs(); setSaveState('saved'); }
  rememberLast(pick.name);
  if ($('#data-panel').classList.contains('open')) renderDataPanel();
  return true;
}
/** New design: ask for its name first (in a new tab, or in the current blank one), so every design is stored from the start. */
async function newDoc(inPlace = false) {
  if (!acct.server || !acct.user) { if (!inPlace) newTab(); return; }
  if (busy() || namingNow) return;
  namingNow = true;
  try {
    const pick = await askNewDesign('New design', 'Create');
    if (!pick) return;
    if (!inPlace && !newTab()) return;
    await createOnServer(pick);
  } finally { namingNow = false; }
}
/** A design that was started without a name (the dialog was dismissed): ask once it has something in it. */
async function nameUntitled() {
  if (!acct.server || !acct.user || doc.name !== 'Untitled' || doc.nameAsked || namingNow) return;
  const d = doc; d.nameAsked = true; namingNow = true;
  try {
    const pick = await askNewDesign('Name your design', 'Create');
    if (pick && doc === d) await createOnServer(pick);
  } finally { namingNow = false; }
}

// ---- autosave: a named design is written to the server a moment after each change (no new version; Save adds one)
let asT = null, asBusy = false, asAgain = false, changeSeq = 0;
function setSaveState(kind) {
  const el = $('#doc-dirty'); if (!el) return;
  el.dataset.state = kind;
  el.title = { pending: 'Unsaved changes', saving: 'Saving…', saved: 'All changes saved', conflict: 'Not saved: this design was changed elsewhere', error: 'Could not save. Retrying…' }[kind] || '';
  el.classList.toggle('on', kind !== 'saved');
}
const canAutosave = () => !!(acct.server && acct.user && doc.name !== 'Untitled' && doc.rev && !doc.conflict);
function scheduleServerSave() {
  changeSeq++;
  if (!canAutosave()) return;
  clearTimeout(asT); asT = setTimeout(serverAutosave, 2500); setSaveState('pending');
}
async function serverAutosave() {
  clearTimeout(asT);
  if (!dirty || !canAutosave()) return;
  if (asBusy) { asAgain = true; return; }
  asBusy = true; setSaveState('saving');
  const d = doc, sent = changeSeq;
  let r;
  try { r = await putDesign(d.name, d.seq || 0, d.folder || '', true); } finally { asBusy = false; }
  if (r.ok) {
    d.rev = r.data.rev; d.seq = r.data.seq; bannerRev = d.seq;
    if (doc === d && changeSeq === sent) { dirty = false; setSaveState('saved'); } else if (doc === d) asAgain = true; // edited while saving
  } else if (r.status === 409) {
    d.conflict = true;
    if (doc === d) { setSaveState('conflict'); showBanner(r.data); }
  } else { if (doc === d) setSaveState('error'); asAgain = true; }
  if (asAgain) { asAgain = false; asT = setTimeout(serverAutosave, r.ok ? 800 : 8000); }
}
function renderDocTabs() {
  const host = $('#doc-tabs');
  if (!host) return;
  const plus = $('#btn-newtab');
  host.innerHTML = '';
  for (const t of tabs) {
    const active = t.id === activeTab, el = document.createElement('div');
    el.className = 'doc-tab' + (active ? ' active' : '');
    el.innerHTML = `<button class="doc-sel"${active ? ' aria-current="true"' : ''}><span class="doc-ic"></span><span class="doc-name"${active ? ' id="doc-name"' : ''}></span><span class="doc-dirty${tabDirty(t) ? ' on' : ''}"${active ? ' id="doc-dirty"' : ''}></span></button><button class="doc-x" title="Close design" aria-label="Close ${esc(tabName(t))}"></button>`;
    el.querySelector('.doc-name').textContent = tabName(t);
    el.querySelector('.doc-ic').innerHTML = LOGO_MARK;
    el.querySelector('.doc-x').innerHTML = uicon('close', 12, 2);
    el.title = tabName(t);
    el.onclick = (e) => { if (e.target.closest('.doc-x')) closeTab(t.id); else activateTab(t.id); };
    el.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (t.id !== activeTab) activateTab(t.id);
      showMenu(e.clientX, e.clientY, [
        { label: acct.server ? 'Save version' : 'Save (download)', uicon: 'save', hint: 'Ctrl+S', run: () => save(false) },
        { label: 'Save As…', uicon: 'save', hint: 'Ctrl+Shift+S', run: () => save(true) },
        { label: 'Export…', uicon: 'upload', run: exportDialog },
        { sep: true },
        { label: 'Close', uicon: 'close', run: () => closeTab(t.id) },
      ]);
    };
    host.appendChild(el);
  }
  host.appendChild(plus); // the + sits right after the last tab
}
let autosaveT;
function scheduleAutosave() {
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => { try { localStorage.setItem('sketchy.autosave', projectJSON()); localStorage.setItem('sketchy.autosave.t', String(Date.now())); } catch { /* too large */ } }, 800);
  scheduleServerDraft();
}

// ------------------------------------------------------------------ undo / redo
function undo() { if (dialog || sketch || !undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); markDirty(); refresh(); }
function redo() { if (dialog || sketch || !redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); markDirty(); refresh(); }

// ------------------------------------------------------------------ viewport events
function bindViewport() {
  const cv = $('#gl');
  let down = null, rdown = null;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  // Navigation: middle = pan, Shift + middle = orbit, double-click middle = fit
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    if (e.detail === 2) { vp.fit(true); return; }
    vp.controls.mouseButtons.MIDDLE = e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  }, true);
  cv.addEventListener('pointerdown', (e) => { if (e.button === 2) rdown = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerup', (e) => { if (e.button === 2 && rdown && Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) < 5 && !sketch?.pts) openMarking(e.clientX, e.clientY); rdown = null; });
  cv.addEventListener('pointerdown', (e) => { if (sketch && !sketch.picking && e.button === 0) { SU.pointer(e, 'down'); return; } down = { x: e.clientX, y: e.clientY, b: e.button }; });
  cv.addEventListener('pointerup', (e) => {
    if (sketch && !sketch.picking) { if (e.button === 0) SU.pointer(e, 'up'); return; }
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || vp.gizmo.dragging) { down = null; return; }
    down = null;
    if (sketch?.picking) {
      const tg = vp.pickSketchTarget(e);
      if (tg?.ref) enterSketch(sketch.index, true, { planeRef: tg.ref, plane: 'custom', origin: tg.geo.origin, normal: tg.geo.normal, xdir: tg.geo.xdir });
      else if (tg?.plane) enterSketch(sketch.index, true, tg.plane);
      else if (tg?.face) { vp.highlightFace(null); enterSketch(sketch.index, true, tg.face); }
      else if (tg?.curved) toast('Pick a flat (planar) face.', true);
      return;
    }
    if (measure) { measureClick(e); return; }
    if (dialog) {
      if (defOf(doc.features[dialog.index])?.pickEdges) { const en = vp.pickEdge(e); if (en) toggleEdge(en); }
      else if (dialog.pick) dialogPick(e);
      else bodyFieldPick(e);
      return;
    }
    const eh = vp.pickEdge(e, edgeEntries());
    if (eh) { toggleSelEdge(eh, e.shiftKey || e.ctrlKey || e.metaKey); return; }
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const pf = vp.pickProfileAt(e);
    if (pf) { // a sketch region under the cursor (unless a body surface is in front of it)
      const bh = vp.pickBody(e);
      if (!bh || pf.distance <= bh.distance + 0.01) {
        const was = profSel.has(pf.key);
        if (!add) profSel.clear();
        was && add ? profSel.delete(pf.key) : profSel.add(pf.key);
        selFace = null; vp.showFaces([], null); vp.selected.clear(); vp.refreshMaterials();
        updateProfileView(); renderTree(); renderRibbon();
        return;
      }
    }
    if (profSel.size && !add) { profSel.clear(); updateProfileView(); }
    if (selEdges.length && !(e.shiftKey || e.ctrlKey || e.metaKey)) { selEdges = []; updateEdgeView(); }
    if (selPriority === 'face') {
      const tg = vp.pickPlanarFace(e);
      vp.selected.clear(); vp.refreshMaterials();
      selFace = tg?.face ? { id: tg.id, point: tg.point, normal: tg.normal } : null;
      if (tg?.curved) { vp.selected.add(tg.id); vp.refreshMaterials(); toast('Curved face: selected the whole body. Flat faces select on their own.'); } // something is always selectable
      vp.showFaces(selFace ? [selFace] : [], null);
      renderTree(); renderRibbon();
      return;
    }
    const hit = vp.pickBody(e);
    selectBody(hit?.id, e.shiftKey || e.ctrlKey || e.metaKey);
  });
  cv.addEventListener('dblclick', (e) => { // double-click: the whole body, whatever the click priority is
    if (e.button !== 0 || sketch || dialog || measure || selMode !== 'click') return;
    const hit = vp.pickBody(e);
    if (!hit) return;
    selFace = null; vp.showFaces([], null);
    selectBody(hit.id, e.shiftKey || e.ctrlKey || e.metaKey);
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
    const r = vp.rect();
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
      commitNumber(dialog.index, 'distance', dispStr(d, 6), fld);
      const inp = $('#props-wrap input.num'); if (inp) inp.value = dispStr(d);
    };
    const up = () => { removeEventListener('pointermove', move); vp.controls.enabled = true; renderDialog(); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }, true);
  cv.addEventListener('dblclick', () => { if (sketch && !sketch.picking) SU.dblclick(); });
  let hoverRaf = false;
  cv.addEventListener('pointermove', (e) => {
    if (sketch && !sketch.picking) return sketchPointer(e, 'move');
    if (e.buttons || hoverRaf) return;
    if (measure) { measureHover(e); return; }
    if (dialog) {
      if (!defOf(doc.features[dialog.index])?.pickEdges) {
        if (dialog.pick?.kind === 'profiles') {
          const id = vp.pickProfile(e);
          if (id !== profileHover) { profileHover = id; updateProfileView(); }
          $('#gl').style.cursor = id ? 'pointer' : '';
          return;
        }
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
      if (sketch || measure) return;
      const en = vp.pickEdge(e, edgeEntries());
      if ((en?.chain || null) !== (edgeHover?.chain || null)) { edgeHover = en; updateEdgeView(); }
      if (en) { $('#gl').style.cursor = 'pointer'; if (vp.hover) { vp.hover = null; vp.refreshMaterials(); } vp.showFaces(selFace ? [selFace] : [], null); return; }
      const pf = vp.pickProfileAt(e);
      const pk = pf ? pf.key : null;
      if (pk !== profHover) { profHover = pk; vp.setProfileState(profSel, profHover); }
      if (pf) { $('#gl').style.cursor = 'pointer'; return; }
      $('#gl').style.cursor = '';
      if (selPriority === 'face') {
        const tg = vp.pickPlanarFace(e);
        vp.showFaces(selFace ? [selFace] : [], tg?.face ? tg : null);
        if (vp.hover) { vp.hover = null; vp.refreshMaterials(); }
        return;
      }
      const h = vp.pickBody(e)?.id || null;
      if (h !== vp.hover) { vp.hover = h; vp.refreshMaterials(); }
    });
  });
}

function applyNavMode() {
  if (!vp) return;
  const B = THREE.MOUSE;
  vp.eachPane(() => { vp.controls.mouseButtons.LEFT = sketch && !sketch.picking ? -1 : { orbit: B.ROTATE, pan: B.PAN, zoom: B.DOLLY, zwin: -1 }[navMode]; });
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
  vp.lookAlong(v, k === 2 ? [0, 1, 0] : [0, 0, 1], true);
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
      { label: 'Fit', uicon: 'fit', hint: '', run: () => vp.fit(true) },
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
    ]);
  }, { caret: true });
  b('grid2', 'Grid and Snaps', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left - 20, r.top - 100, [
      { label: 'Show Grid', check: vp.opts.grid, run: () => { vp.opts.grid = !vp.opts.grid; vp.refreshMaterials(); } },
      { label: 'Build volume', check: vp.opts.bed, run: () => { vp.opts.bed = !vp.opts.bed; vp.refreshMaterials(); renderRibbon(); } },
      { label: 'Snap to Grid', check: !sketch || sketch.snapOn !== false, run: () => { if (sketch) sketch.snapOn = sketch.snapOn === false; } },
    ]);
  }, { caret: true });
  b('viewports', 'Viewports', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pick = (m) => () => { vp.setLayout(m); if (m !== 'single') toast('Two views: the one under the pointer is active. The ViewCube and view tools act on it.'); };
    showMenu(r.left - 20, r.top - 120, [
      { label: 'Single View', check: vp.layoutWanted === 'single', run: pick('single') },
      { label: 'Two Views: Horizontal', check: vp.layoutWanted === 'h', run: pick('h') },
      { label: 'Two Views: Vertical', check: vp.layoutWanted === 'v', run: pick('v') },
    ]);
  }, { caret: true });
}

/** Drag-selection tools (window, freeform, paint) for whole bodies. Active only when selMode is not 'click'. */
function bindSelectTool() {
  const vpEl = $('#viewport'), cv = $('#gl');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;display:none';
  const shape = document.createElementNS(NS, 'polyline');
  shape.setAttribute('fill', 'rgba(60,140,230,.15)'); shape.setAttribute('stroke', '#0b6bcb'); shape.setAttribute('stroke-width', '1.5'); shape.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(shape); vpEl.appendChild(svg);
  const inPoly = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  /** Screen positions (client px) of a sample of a body's vertices. */
  const screenPts = (mesh, rc) => {
    const src = mesh.userData.src, n = src.verts.length / 3, step = Math.max(1, Math.ceil(n / 20000)), v = new THREE.Vector3(), out = [];
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < n; i += step) {
      v.set(src.verts[i * 3], src.verts[i * 3 + 1], src.verts[i * 3 + 2]).applyMatrix4(mesh.matrixWorld).project(vp.camera);
      if (v.z > 1 || v.z < -1) continue;
      out.push([rc.left + ((v.x + 1) / 2) * rc.width, rc.top + ((1 - v.y) / 2) * rc.height]);
    }
    return out;
  };
  const meshes = () => vp.bodyGroup.children.filter((m) => m.visible && m.userData.src);
  const apply = (ids, add) => {
    if (!add) vp.selected.clear();
    ids.forEach((id) => vp.selected.add(id));
    vp.refreshMaterials(); renderTree(); renderRibbon();
  };
  vpEl.addEventListener('pointerdown', (e) => {
    if (selMode === 'click' || e.button !== 0 || e.target !== cv || sketch || dialog || measure || navMode !== 'orbit' || vp.gizmo.dragging) return;
    if (selPriority !== 'body') return;
    e.stopPropagation();
    vp.activateAt(e.clientX, e.clientY);
    const host = vpEl.getBoundingClientRect(), rc = vp.rect(), add = e.shiftKey || e.ctrlKey || e.metaKey, mode = selMode;
    const start = [e.clientX, e.clientY];
    let path = [start], hits = new Set(), last = start;
    if (!add && mode === 'paint') vp.selected.clear();
    const draw = (cur) => {
      svg.style.display = 'block';
      if (mode === 'window') shape.setAttribute('points', [start, [cur[0], start[1]], cur, [start[0], cur[1]]].map((q) => `${q[0] - host.left},${q[1] - host.top}`).join(' '));
      else shape.setAttribute('points', path.map((q) => `${q[0] - host.left},${q[1] - host.top}`).join(' '));
      shape.setAttribute('fill', mode === 'paint' ? 'none' : 'rgba(60,140,230,.15)');
      shape.setAttribute('stroke-width', mode === 'paint' ? '8' : '1.5'); shape.setAttribute('stroke-opacity', mode === 'paint' ? '.45' : '1');
    };
    const paintAt = (x, y) => { const h = vp.pickBody({ clientX: x, clientY: y }); if (h && !hits.has(h.id)) { hits.add(h.id); vp.selected.add(h.id); vp.refreshMaterials(); } };
    if (mode === 'paint') paintAt(...start);
    const move = (ev) => {
      const cur = [ev.clientX, ev.clientY];
      if (mode !== 'window') path.push(cur);
      if (mode === 'paint') {
        const d = Math.hypot(cur[0] - last[0], cur[1] - last[1]), k = Math.max(1, Math.ceil(d / 4));
        for (let i = 1; i <= k; i++) paintAt(last[0] + ((cur[0] - last[0]) * i) / k, last[1] + ((cur[1] - last[1]) * i) / k);
        last = cur;
      }
      draw(cur);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      svg.style.display = 'none';
      const end = [ev.clientX, ev.clientY];
      if (mode === 'paint') { renderTree(); renderRibbon(); return; }
      if (mode === 'window' && Math.abs(end[0] - start[0]) < 4 && Math.abs(end[1] - start[1]) < 4) { // a plain click still picks
        const h = vp.pickBody(ev); selectBody(h?.id, add); return;
      }
      const pp = mode === 'window' ? [start, end] : path; // a lasso's extent is its whole path, not just its two ends
      const x0 = Math.min(...pp.map((q) => q[0])), x1 = Math.max(...pp.map((q) => q[0])), y0 = Math.min(...pp.map((q) => q[1])), y1 = Math.max(...pp.map((q) => q[1]));
      const enclosed = end[0] >= start[0]; // left-to-right: whole body must be inside
      const ids = [];
      for (const m of meshes()) {
        const pts = screenPts(m, rc);
        if (!pts.length) continue;
        const inside = mode === 'window' ? (q) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1 : (q) => inPoly(q, path);
        const hit = mode === 'window' && enclosed ? pts.every(inside) : pts.some(inside);
        if (hit) ids.push(m.userData.id);
      }
      if (!(mode === 'window' && enclosed)) { // crossing and freeform also take any body visible anywhere inside the shape, not only bodies with a corner inside it
        const gx = Math.max(10, (x1 - x0) / 20), gy = Math.max(10, (y1 - y0) / 20);
        for (let yy = y0; yy <= y1; yy += gy) for (let xx = x0; xx <= x1; xx += gx) {
          if (mode !== 'window' && !inPoly([xx, yy], path)) continue;
          const h = vp.pickBody({ clientX: xx, clientY: yy });
          if (h && !ids.includes(h.id)) ids.push(h.id);
        }
      }
      apply(ids, add);
      if (!ids.length && !add) toast('Nothing selected');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
  }, true);
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
      const cr = vp.rect();
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
  if (!dialog && !sketch && !measure) {
    const rect = $('#gl').getBoundingClientRect();
    const en = vp.pickEdge({ clientX: x, clientY: y }, edgeEntries());
    if (en && !selEdges.some((e) => e.body === en.body && matchChain([en.chain], e.pts))) toggleSelEdge(en, false);
  }
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
  if (selEdges.length || selFace) items.push({ ficon: 'fillet', label: selEdges.length ? `Fillet ${selEdges.length} edge${selEdges.length > 1 ? 's' : ''}` : 'Fillet face edges', key: 'F', run: () => runCommand('fillet') }, { ficon: 'chamfer', label: selEdges.length ? 'Chamfer edges' : 'Chamfer face edges', run: () => runCommand('chamfer') }, { sep: true });
  items.push({ uicon: 'zoomwin', label: 'Fit', run: () => vp.fit(true) }, { uicon: 'camera', label: 'Look At', run: lookAtNearest }, { uicon: 'home', label: 'Home View', run: () => vp.home(true) },
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
function closeQuickSearch() { document.querySelector('.qs-inline')?.remove(); $('#btn-ext')?.setAttribute('aria-expanded', 'false'); $('#btn-ext')?.classList.remove('on'); }
/** Command search: a field that opens inline, to the left of the search button, with the matches in a list below it. */
function openQuickSearch() {
  if (document.querySelector('.qs-inline')) { closeQuickSearch(); return; }
  closeMarking();
  const btn = $('#btn-ext');
  const box = document.createElement('div');
  box.className = 'qs-inline';
  box.innerHTML = `<input type="text" role="combobox" aria-label="Search" aria-expanded="true" aria-controls="qs-list" aria-autocomplete="list" placeholder="Search…" autocomplete="off" spellcheck="false"><div class="qs-list" id="qs-list" role="listbox"></div>`;
  btn.parentElement.insertBefore(box, btn);
  btn.setAttribute('aria-expanded', 'true'); btn.classList.add('on');
  const input = box.querySelector('input'), list = box.querySelector('.qs-list');
  let hot = 0, shown = [], designs = [];
  if (acct.user) call('GET', '/projects').then((r) => { if (r.ok) { designs = r.data; if (document.body.contains(input)) draw(); } }); // your saved designs, searched along with the commands
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const cmds = Object.entries(CMD).filter(([id, c]) => !id.startsWith('sk_') && id !== 'cancelpick' && id !== 'finishsketch' && (!q || c.label.toLowerCase().includes(q))).slice(0, q ? 30 : 5).map(([id, c]) => ({ kind: 'cmd', id, c })); // just five suggestions until you type
    const files = (q ? designs.filter((d) => d.name.toLowerCase().includes(q) || (d.folder || '').toLowerCase().includes(q)) : []).slice(0, 8).map((d) => ({ kind: 'design', d }));
    shown = [...files, ...cmds]; // matching designs first: a typed name is more likely a file than a command
    hot = Math.min(hot, Math.max(shown.length - 1, 0));
    list.innerHTML = '';
    let lastKind = '';
    shown.forEach((it, i) => {
      if (it.kind !== lastKind && files.length) { list.insertAdjacentHTML('beforeend', `<div class="qs-head" role="presentation">${it.kind === 'design' ? 'DESIGNS' : 'COMMANDS'}</div>`); }
      lastKind = it.kind;
      const e = document.createElement('div');
      e.className = 'mi' + (i === hot ? ' hot' : '');
      e.id = 'qs-o' + i; e.setAttribute('role', 'option'); e.setAttribute('aria-selected', String(i === hot));
      if (it.kind === 'design') {
        e.innerHTML = uicon('file', 20) + `<span>${esc(it.d.name)}</span>` + (it.d.folder ? `<small>${esc(it.d.folder)}</small>` : '');
        e.onclick = () => { closeQuickSearch(); openSavedDesign(it.d); };
      } else {
        const { id, c } = it;
        e.innerHTML = ficon(c.icon, 22) + `<span>${esc(c.label)}</span>` + (c.key ? `<small>${c.key}</small>` : c.off ? '<small>soon</small>' : '');
        e.onclick = () => { closeQuickSearch(); runCommand(id); };
      }
      list.appendChild(e);
    });
    if (!shown.length) list.innerHTML = '<div class="qs-none">No matching commands or designs</div>';
    input.setAttribute('aria-activedescendant', shown.length ? 'qs-o' + hot : '');
    list.querySelector('.hot')?.scrollIntoView({ block: 'nearest' });
  };
  list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the field while clicking a result
  input.oninput = () => { hot = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { hot = Math.min(hot + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hot = Math.max(hot - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { const t = shown[hot]; closeQuickSearch(); if (t) (t.kind === 'design' ? openSavedDesign(t.d) : runCommand(t.id)); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Escape') { closeQuickSearch(); btn.focus(); e.stopPropagation(); }
  };
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input && document.activeElement !== btn) closeQuickSearch(); }, 120));
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
async function showVersions(pr) {
  const r = await call('GET', '/projects/' + encodeURIComponent(pr.name) + '/versions');
  if (!r.ok) return toast(r.data?.error || 'Could not load versions.', true);
  const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = [{ rev: pr.ver, modified: pr.modified, device: pr.device, cur: true }, ...r.data];
  const m = modal(`<div class="modal-title">Versions of ${esc(pr.name)}</div><div class="modal-body">${rows.map((v) => `<div class="ver-row" data-rev="${v.rev}"><div><b>V${v.rev}</b>${v.cur ? ' <span class="ver-cur">latest</span>' : ''}<div class="ver-sub">${when(v.modified)}${v.device ? ' · ' + esc(v.device) : ''}</div></div>${v.cur ? '' : '<div class="ver-btns"><button class="btn" data-a="open">Open</button><button class="btn" data-a="restore">Restore</button></div>'}</div>`).join('')}${r.data.length ? '' : '<div class="ver-sub">No earlier versions yet. Each save keeps the previous one.</div>'}<div class="ver-sub">The server keeps the most recent earlier versions of each design.</div></div>`);
  m.el.querySelectorAll('.ver-row button').forEach((b) => {
    b.onclick = async () => {
      const rev = +b.closest('.ver-row').dataset.rev;
      const g = await call('GET', `/projects/${encodeURIComponent(pr.name)}/versions/${rev}`);
      if (!g.ok) return toast(g.data?.error || 'Could not load that version.', true);
      const txt = typeof g.data === 'string' ? g.data : JSON.stringify(g.data);
      if (b.dataset.a === 'open') {
        if (!newTab({ reuseBlank: true })) return;
        m.close();
        loadProject(txt, pr.ver, pr.seq || pr.ver); doc.name = pr.name; $('#doc-name').textContent = pr.name; dirty = true; $('#doc-dirty').classList.add('on'); refresh();
        toast(`Opened V${rev} of "${pr.name}". Save to make it the latest version.`);
      } else {
        if (!(await confirmBox({ title: `Restore V${rev}?`, message: 'It becomes the new latest version; the current one is kept in the history.', ok: 'Restore' }))) return;
        const p = await call('PUT', '/projects/' + encodeURIComponent(pr.name), txt, { 'if-match': String(pr.ver) });
        if (!p.ok) return toast(p.status === 409 ? 'The design changed on another device. Reload the list and try again.' : (p.data?.error || 'Restore failed.'), true);
        m.close(); renderDataPanel(); toast(`Restored V${rev} as V${p.data.rev}`);
        if (doc.name === pr.name) openDesign(pr.name, true);
      }
    };
  });
}
async function openSavedDesign(pr) {
  if (focusOpenDesign(pr.name)) return;
  if (!newTab({ reuseBlank: true })) return;
  const dr = await call('GET', '/drafts');
  const draft = dr.ok && dr.data.find((x) => x.key === pr.name && x.modified > pr.modified + 2000);
  if (draft && await confirmBox({ title: 'Resume the autosaved draft?', message: `A newer autosaved draft of "${pr.name}" exists (${draft.device || 'another device'}, ${ago(draft.modified)}). Resume it, or open the saved version?`, ok: 'Resume draft' })) {
    const g = await call('GET', '/drafts/' + encodeURIComponent(pr.name));
    if (g.ok) { loadProject(typeof g.data === 'string' ? g.data : JSON.stringify(g.data), draft.base ?? 0); doc.folder = pr.folder || ''; doc.name = pr.name; $('#doc-name').textContent = pr.name; dirty = true; $('#doc-dirty').classList.add('on'); refresh(); return; }
  }
  openDesign(pr.name);
}
async function renderDataPanel() {
  const host = $('#data-panel');
  host.innerHTML = `<div class="dp-top"><span class="count" id="dp-count"></span><button id="dp-openfile" title="Open a project file from your computer" aria-label="Open a project file from your computer">${uicon('upload', 16)}</button><button id="dp-refresh" title="Refresh">${uicon('refresh', 16)}</button><button id="dp-close" title="Close">${uicon('close', 16)}</button></div>
    <div class="dp-tabs"><span class="dp-searchicon">${uicon('search', 16, 1.8)}</span><input id="dp-q" class="dp-search" type="search" placeholder="Search designs" autocomplete="off" spellcheck="false"></div>
    <div class="dp-grid" id="dp-grid"><div class="dp-empty">Loading…</div></div>
    <div class="dp-actions"><button class="btn primary" id="dp-new">New Design</button><button class="btn" id="dp-newfolder">${uicon('folder', 15)} New Folder</button></div>`;
  $('#dp-close').onclick = () => toggleDataPanel(false);
  $('#dp-refresh').onclick = renderDataPanel;
  $('#dp-openfile').onclick = () => $('#file-proj').click();
  $('#dp-new').onclick = () => { newDoc(); };
  const grid = $('#dp-grid');
  const card = (name, o = {}) => {
    const el = document.createElement('div');
    el.className = 'dp-card' + (name === doc.name ? ' current' : '');
    const when = o.modified ? new Date(o.modified) : new Date();
    const fmt = 'Edited ' + when.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="dp-thumb">${o.thumb ? `<img alt="" src="/api/projects/${encodeURIComponent(name)}/thumb?${o.modified | 0}">` : ficon('box', 40)}</div>
      <div class="dp-info"><div class="dp-name"><span>${esc(name)}</span>${o.del ? `<button type="button" class="dp-rename" title="Rename" aria-label="Rename ${esc(name)}">${uicon('pencil', 14)}</button>` : ''}</div>
      <div class="dp-date">${fmt}</div><div class="dp-bottom"><button type="button" class="dp-ver" title="Versions" aria-haspopup="menu">V${o.ver || 1} ▾</button></div></div>`;
    return el;
  };
  if (acct.server && acct.user) {
    const [r, fr] = await Promise.all([call('GET', '/projects'), call('GET', '/folders')]);
    if (!r.ok) { grid.innerHTML = `<div class="dp-empty">${esc(r.data?.error || 'Could not load designs.')}</div>`; return; }
    const folders = fr.ok ? fr.data.folders : [];
    $('#dp-count').textContent = `${r.data.length} design${r.data.length === 1 ? '' : 's'}`;
    $('#dp-newfolder').onclick = () => newFolder('');
    const collapsed = new Set(JSON.parse(localStorage.getItem('sketchy.folders.collapsed') || '[]'));
    const saveCollapsed = () => { try { localStorage.setItem('sketchy.folders.collapsed', JSON.stringify([...collapsed])); } catch { /* storage unavailable */ } };
    const newFolder = async (parent) => {
      const nm = await askName({ title: parent ? `New folder in ${parent}` : 'New folder', label: 'Folder name', ok: 'Create' });
      if (!nm) return;
      const rr = await call('POST', '/folders', { path: (parent ? parent + '/' : '') + nm });
      if (!rr.ok) return toast(rr.data?.error || 'Could not create the folder.', true);
      collapsed.delete(parent); saveCollapsed(); renderDataPanel();
    };
    const moveDesign = async (name, folder) => {
      const rr = await call('POST', '/projects/' + encodeURIComponent(name) + '/move', { folder });
      if (!rr.ok) return toast(rr.data?.error || 'Could not move the design.', true);
      if (name === doc.name) doc.folder = folder;
      renderDataPanel();
    };
    const q = $('#dp-q'), draw = () => {
      grid.innerHTML = '';
      const term = q.value.trim().toLowerCase();
      if (!r.data.length && !folders.length) { grid.innerHTML = '<div class="dp-empty">No designs yet. Use <b>Save</b> (Ctrl+S) to store the current model in your profile.</div>'; return; }
      const designCard = (pr, showPath) => {
        const el = card(pr.name, { modified: pr.modified, thumb: pr.thumb, ver: pr.ver, del: true });
        if (showPath && pr.folder) el.querySelector('.dp-date').insertAdjacentHTML('afterend', `<div class="dp-where">${uicon('folder', 13)} ${esc(pr.folder)}</div>`);
        el.draggable = true;
        el.ondragstart = (e) => { e.dataTransfer.setData('text/x-sketchy-design', pr.name); e.dataTransfer.effectAllowed = 'move'; };
        el.onclick = (e) => { if (!e.target.closest('.dp-rename,.dp-more,.dp-ver')) openSavedDesign(pr); };
        el.querySelector('.dp-ver').onclick = (e) => {
          e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect();
          showMenu(b.left, b.bottom + 2, [{ head: `CURRENT: V${pr.ver || 1}` }, { label: 'Version history…', uicon: 'refresh', run: () => showVersions(pr) }]);
        };
        const rename = async () => {
          const nm = await askName({ title: 'Rename design', label: 'Name', value: pr.name, ok: 'Rename' });
          if (!nm || nm === pr.name) return;
          const rr = await call('POST', '/projects/' + encodeURIComponent(pr.name) + '/rename', { to: nm });
          if (!rr.ok) return toast(rr.data?.error || 'Could not rename the design.', true);
          if (pr.name === doc.name) { doc.name = nm; $('#doc-name').textContent = nm; }
          renderDataPanel();
        };
        el.querySelector('.dp-rename').onclick = (e) => { e.stopPropagation(); rename(); };
        const more = document.createElement('button'); more.type = 'button'; more.className = 'dp-more'; more.title = 'More actions'; more.setAttribute('aria-label', `More actions for ${pr.name}`); more.setAttribute('aria-haspopup', 'menu'); more.innerHTML = uicon('more', 16);
        const menu = (x, y) => showMenu(x, y, [
          { label: 'Move to folder…', uicon: 'folder', run: async () => { const f = await chooseFolder({ title: `Move "${pr.name}" to`, current: pr.folder || '' }); if (f !== null) moveDesign(pr.name, f); } },
          { label: 'Delete', uicon: 'trash', run: async () => {
            if (!(await confirmBox({ title: 'Delete design', message: `Delete "${pr.name}" permanently? Its version history goes with it.`, ok: 'Delete', danger: true }))) return;
            await call('DELETE', '/projects/' + encodeURIComponent(pr.name));
            renderDataPanel();
          } },
        ]);
        more.onclick = (e) => { e.stopPropagation(); const b = more.getBoundingClientRect(); menu(b.left, b.bottom + 2); };
        el.oncontextmenu = (e) => { e.preventDefault(); menu(e.clientX, e.clientY); };
        el.appendChild(more);
        return el;
      };
      if (term) { // searching: a flat list across all folders
        const items = r.data.filter((x) => x.name.toLowerCase().includes(term)).sort((a, b) => b.modified - a.modified);
        if (!items.length) grid.innerHTML = '<div class="dp-empty">No designs match your search.</div>';
        for (const pr of items) grid.appendChild(designCard(pr, true));
        return;
      }
      const drop = (el, path) => {
        el.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/x-sketchy-design')) { e.preventDefault(); el.classList.add('dropping'); } };
        el.ondragleave = () => el.classList.remove('dropping');
        el.ondrop = (e) => { e.preventDefault(); el.classList.remove('dropping'); const n = e.dataTransfer.getData('text/x-sketchy-design'); if (n) moveDesign(n, path); };
      };
      const hidden = (path) => { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) if (collapsed.has(parts.slice(0, i).join('/'))) return true; return false; };
      for (const path of [...folders].sort((a, b) => a.localeCompare(b))) {
        if (hidden(path)) continue;
        const depth = path.split('/').length - 1, isClosed = collapsed.has(path);
        const inside = r.data.filter((x) => x.folder === path);
        const total = r.data.filter((x) => x.folder === path || (x.folder || '').startsWith(path + '/')).length;
        const row = document.createElement('div');
        row.className = 'dp-folder'; row.style.marginLeft = depth * 14 + 'px';
        row.innerHTML = `<button type="button" class="dp-ftoggle" aria-expanded="${!isClosed}" aria-label="${isClosed ? 'Expand' : 'Collapse'} folder ${esc(path.split('/').pop())}"><span class="dp-chev${isClosed ? ' closed' : ''}">${uicon('caret', 12)}</span>${uicon('folder', 16)}<span class="dp-fname">${esc(path.split('/').pop())}</span><small>${total}</small></button>
          <button type="button" class="dp-more" title="Folder actions" aria-haspopup="menu" aria-label="Actions for folder ${esc(path.split('/').pop())}">${uicon('more', 16)}</button>`;
        row.querySelector('.dp-ftoggle').onclick = () => { isClosed ? collapsed.delete(path) : collapsed.add(path); saveCollapsed(); draw(); };
        const fmenu = (x, y) => showMenu(x, y, [
          { label: 'New subfolder…', uicon: 'plus', run: () => newFolder(path) },
          { label: 'Rename…', uicon: 'file', run: async () => {
            const nm = await askName({ title: 'Rename folder', label: 'Folder name', value: path.split('/').pop(), ok: 'Rename' });
            if (!nm) return;
            const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
            const rr = await call('PATCH', '/folders', { from: path, to: parent + nm });
            if (!rr.ok) return toast(rr.data?.error || 'Could not rename the folder.', true);
            if ((doc.folder || '') === path || (doc.folder || '').startsWith(path + '/')) doc.folder = parent + nm + (doc.folder || '').slice(path.length);
            renderDataPanel();
          } },
          { label: 'Move to folder…', uicon: 'folder', run: async () => {
            const dest = await chooseFolder({ title: `Move folder "${path.split('/').pop()}" to`, current: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', exclude: path });
            if (dest === null) return;
            const rr = await call('PATCH', '/folders', { from: path, to: (dest ? dest + '/' : '') + path.split('/').pop() });
            if (!rr.ok) return toast(rr.data?.error || 'Could not move the folder.', true);
            renderDataPanel();
          } },
          { label: 'Delete folder', uicon: 'trash', run: async () => {
            if (!(await confirmBox({ title: 'Delete folder', message: `Delete the folder "${path}"? It must be empty of designs.`, ok: 'Delete', danger: true }))) return;
            const rr = await call('DELETE', '/folders?path=' + encodeURIComponent(path));
            if (!rr.ok) return toast(rr.data?.error || 'Could not delete the folder.', true);
            renderDataPanel();
          } },
        ]);
        row.querySelector('.dp-more').onclick = (e) => { const b = e.currentTarget.getBoundingClientRect(); fmenu(b.left, b.bottom + 2); };
        row.oncontextmenu = (e) => { e.preventDefault(); fmenu(e.clientX, e.clientY); };
        drop(row, path);
        grid.appendChild(row);
        if (!isClosed) {
          if (!inside.length && !folders.some((f) => f.startsWith(path + '/'))) grid.insertAdjacentHTML('beforeend', `<div class="dp-empty dp-fempty" style="margin-left:${depth * 14 + 22}px">Empty folder. Drag designs here, or choose Save and pick it.</div>`);
          for (const pr of inside.sort((a, b) => b.modified - a.modified)) { const c = designCard(pr, false); c.style.marginLeft = depth * 14 + 14 + 'px'; grid.appendChild(c); }
        }
      }
      const loose = r.data.filter((x) => !x.folder).sort((a, b) => b.modified - a.modified);
      if (folders.length && loose.length) { const h = document.createElement('div'); h.className = 'dp-folder dp-root'; h.innerHTML = `<span class="dp-fname">${uicon('folder', 16)} Not in a folder</span>`; drop(h, ''); grid.appendChild(h); }
      for (const pr of loose) grid.appendChild(designCard(pr, false));
      if (folders.length && !loose.length) { const h = document.createElement('div'); h.className = 'dp-empty'; h.textContent = 'Drag a design here to take it out of its folder.'; drop(h, ''); grid.appendChild(h); }
    };
    q.oninput = draw; draw();
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

// ------------------------------------------------------------------ tooltips (rich tips)
function bindTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tip'; tip.hidden = true;
  document.body.appendChild(tip);
  let timer = null, cur = null;
  const hide = () => { clearTimeout(timer); timer = null; tip.hidden = true; cur = null; };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || el === cur) return;
    hide(); cur = el;
    timer = setTimeout(() => {
      let d; try { d = JSON.parse(el.dataset.tip); } catch { return; }
      tip.innerHTML = `<b>${esc(d.t)}</b>${d.k ? `<span class="k">${esc(d.k)}</span>` : ''}${d.d ? `<p>${esc(d.d)}</p>` : ''}`;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      tip.style.left = Math.max(6, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = r.bottom + 6 + 'px';
    }, 450);
  });
  document.addEventListener('pointerout', (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); });
  document.addEventListener('pointerdown', hide, true);
}

function bindKeys() {
  addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (!$('#marking').hidden) { if (e.key === 'Escape') closeMarking(); return; }
    if (mod && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
    if (mod && key === 'n') { e.preventDefault(); newDoc(); return; }
    if (typing) {
      if (e.key === 'Enter' && !document.activeElement.closest('.modal')) {
        const inDialog = !!document.activeElement.closest('#props-wrap');
        document.activeElement.blur();
        if (inDialog && dialog && !sketch) closeDialog(true);
      }
      return;
    }
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') {
      if (navMode !== 'orbit') { setNavMode('orbit'); return; }
      if (selMode !== 'click' && !sketch && !dialog && !measure) { selMode = 'click'; toast('Click selection'); return; }
      if (sketch && !sketch.picking) { SU.key(e); return; }
      if (!dialog && !measure && (selEdges.length || selFace || profSel.size)) { profSel.clear(); updateProfileView(); selEdges = []; selFace = null; vp.showFaces([], null); updateEdgeView(); renderRibbon(); return; }
      if (measure) { endMeasure(); return; }
      if (sketch?.pts) { sketch.pts = null; vp.overlay.clear(); } else if (sketch) cancelSketch(); else if (dialog) closeDialog(false);
      return;
    }
    if (sketch && !sketch.picking) {
      if (SU.key(e)) { e.preventDefault(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sketch.sel >= 0) sketchDeleteSelected();
      const t = { l: 'sk_line', r: 'sk_rect', c: 'sk_circle' }[key];
      if (t && !mod) runCommand(t);
      return;
    }
    if (dialog) { if (e.key === 'Enter' && !sketch) closeDialog(true); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (vp.selected.size) deleteSelection(); else if (selSet.size) deleteFeatures([...selSet]); return; }
    if (mod) return;
    if (e.key === 'F2') { e.preventDefault(); if (vp.selected.size) renameBodyOrFeature([...vp.selected][0]); else if (selFeature) renameFeature(selFeature, timelineAnchor(selFeature)); return; }
    const map = { e: 'extrude', q: 'presspull', f: 'fillet', m: 'move', h: 'hole', j: 'joint', i: 'measure' };
    if (map[key]) runCommand(map[key]);
    else if (key === 's') { e.preventDefault(); openQuickSearch(); }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const caret = uicon('caret', 7, 0).replace('class="ui"', 'class="ui caret"');
  const set = (id, html) => { $('#' + id).innerHTML = html; };
  set('btn-data', uicon('library', 18, 1.5));
  set('btn-undo', uicon('undo', 18, 1.5) + caret); set('btn-redo', uicon('redo', 18, 1.5) + caret);
  set('btn-newtab', uicon('plus', 18, 1.8)); set('btn-ext', uicon('search', 18, 1.8));
 
  set('pt-collapse', uicon('collapse', 12, 1.6)); set('pt-min', uicon('minus', 12, 2));
  set('cube-home', uicon('home', 14, 1.6)); set('cube-menu', uicon('caret', 10, 0));
  $('#viewport').insertAdjacentHTML('beforeend', '<div id="loading" style="position:absolute;inset:0;display:grid;place-items:center;color:#667">Loading CAD kernel…</div>');
  await initKernel({ locateFile: () => wasmUrl });
  vp = new Viewport($('#gl'), $('#cube'));
  vp.opts.bedSize = PRINTERS[bedName] || vp.opts.bedSize;
  vp.buildBed();
  vp.home();
  vp.fitted = true; // only opening a design re-frames the view; making the first body must not move the camera
  $('#loading')?.remove();
  SU = createSketchUI({
    vp, THREE, sketch: () => sketch, params: () => resolvedMap[curSketch().id] || curSketch().params,
    setShapes: (sh) => setSketchShapes(sh), remapCons: (si, delta) => remapSketchCons(si, delta), projectHover: (e) => projectHover(e), projectPick: (e, all) => projectPick(e, all), renderPanel: () => renderSketchPanel(), redrawSketch: () => drawSketches(),
    cons: () => curSketch().params.cons || [], setCons: (c) => setSketchCons(c),
    toast: (m) => toast(m), evalExpr: (t, kind = 'len') => evalExpr(t, (n) => paramState.values[n], kind), setTool: (t) => setSketchTool(t), rebuildGrid: (st) => buildSketchGrid(st),
  });
  buildNavBar(); bindViewport(); bindZoomWindow(); bindSelectTool(); bindKeys(); bindManip();
  bindTooltips();
  $('#btn-undo').onclick = undo; $('#btn-redo').onclick = redo;
  $('#btn-data').onclick = () => toggleDataPanel();
  $('#btn-newtab').onclick = () => newDoc();
  renderDocTabs();
  $('#btn-ext').onclick = openQuickSearch;
  $('#pt-min').onclick = $('#pt-collapse').onclick = () => $('#browser').classList.toggle('min');
  $('#cube-home').onclick = () => vp.home(true);
  document.querySelectorAll('.vc-arrow').forEach((b) => { const [ax, d] = b.dataset.t.split(','); b.onclick = () => vp.turnView(ax, +d); });
  { // roll arrows: two outlined arcs around the cube's top-right corner
    const R = 76, pt = (deg, r = R) => [r * Math.cos((deg * Math.PI) / 180), -r * Math.sin((deg * Math.PI) / 180)];
    const arrow = (from, to, dirSign, title, turn) => {
      const [x0, y0] = pt(from), [x1, y1] = pt(to), sweep = to > from ? 0 : 1;
      const end = pt(to), tan = pt(to + dirSign * 90, 1), nrm = pt(to, 1), L = 8, Wd = 8; // head points along the travel direction
      const tip = [end[0] + tan[0] * L, end[1] + tan[1] * L], a = [end[0] + nrm[0] * Wd, end[1] + nrm[1] * Wd], b = [end[0] - nrm[0] * Wd, end[1] - nrm[1] * Wd];
      const d = `M${x0} ${y0}A${R} ${R} 0 0 ${sweep} ${x1} ${y1}`;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'ra'); g.innerHTML = `<title>${title}</title><path class="o" d="${d}"/><path class="i" d="${d}"/><polygon class="h" points="${tip} ${a} ${b}"/>`;
      g.onclick = () => vp.turnView('z', turn);
      return g;
    };
    const host = $('#vc-rolls');
    host.append(arrow(49, 72, 1, 'Roll counter-clockwise', -90), arrow(41, 18, -1, 'Roll clockwise', 90));
  }
  $('#cube-menu').dataset.menu = 1;
  $('#cube-menu').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left - 140, r.bottom + 4, [{ label: 'Go Home', uicon: 'home', run: () => vp.home(true) }, { sep: true }, { label: 'Orthographic', check: vp.opts.ortho, run: () => vp.setOrtho(true) }, { label: 'Perspective', check: !vp.opts.ortho, run: () => vp.setOrtho(false) }]); };
  $('#file-2d').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) import2D(f); };
  $('#file-stl').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSTL(f); };
  $('#file-proj').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) try { const txt = await f.text(); if (!newTab({ reuseBlank: true })) return; loadProject(txt); renderDocTabs(); } catch (x) { toast(x.message, true); } };
  $('#viewport').addEventListener('dragover', (e) => e.preventDefault());
  $('#viewport').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && /\.stl$/i.test(f.name)) importSTL(f); else if (f && /\.(svg|dxf)$/i.test(f.name)) import2D(f); });
  initA11y();
  const paint = (t) => { const d = t === 'dark'; vp.applyTheme(d); sketchMat.color.setHex(d ? 0x3d94ff : 0x1f5fa8); sketchMatActive.color.setHex(d ? 0x2f8cff : 0x0b6bcb); };
  paint(getTheme()); onTheme(paint);
  await refreshAccount();
  await ensureSignedIn(); // server mode: sign-up on first visit, login afterwards
  setAccountMenuHandler((anchor) => openUserMenu(anchor, {
    onAccount: () => showAccount(), onSettings: showAdmin,
    isDark: () => getTheme() === 'dark', onTheme: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'),
    onLogout: async () => { await signOut(); try { localStorage.removeItem('sketchy.autosave'); } catch { /* ignore */ } location.reload(); },
  }));
  if (localStorage.getItem('sketchy.data') === '1') toggleDataPanel(true);
  setAccountChangeHandler(() => { if (dataOpen) renderDataPanel(); });
  startRemotePolling();
  refresh();
  window.__sketchy = { moveFeature, setSuppressed, dependentsOf, renameFeature, treeMenu, profilesOf, profilesFor, get doc() { return doc; }, get result() { return result; }, vp, startFeature, rebuild, refresh, runCommand, openMarking };
  openLastOrCreate().then(checkDrafts); // not awaited: the New design dialog must not hold up the rest of start-up
}
/** On start: reopen the design you were last in; otherwise restore unsaved work, or ask for a name for a new design. */
async function openLastOrCreate() {
  if (!acct.server || !acct.user) { // no server: the old behaviour, restore the last session from this browser
    try { const a = localStorage.getItem('sketchy.autosave'); if (a) { const d = JSON.parse(a); if (d.features?.length) { loadProject(a); toast('Restored your last session'); } } } catch { /* ignore */ }
    return;
  }
  let last = ''; try { last = localStorage.getItem(lastKey()) || ''; } catch { /* storage unavailable */ }
  if (last && !(await call('GET', '/projects/' + encodeURIComponent(last) + '/meta')).ok) last = ''; // deleted or renamed since
  if (!last) { // a new browser or device: pick up where you left off, i.e. your most recently changed design
    const all = await call('GET', '/projects');
    if (all.ok && all.data.length) last = [...all.data].sort((a, b) => b.modified - a.modified)[0].name;
  }
  if (last) {
    await openDesign(last, true);
    if (doc.name === last && doc.rev) {
      try { // work saved only in this browser (the tab closed before the autosave landed) wins if it is newer
        const a = JSON.parse(localStorage.getItem('sketchy.autosave') || 'null'), t = +localStorage.getItem('sketchy.autosave.t') || 0;
        const mt = await call('GET', '/projects/' + encodeURIComponent(last) + '/meta');
        if (a && a.name === last && mt.ok && t > mt.data.modified + 2000 && JSON.stringify(a.features) !== JSON.stringify(doc.features)) {
          const rev = doc.rev, seq = doc.seq, folder = doc.folder;
          loadProject(JSON.stringify(a), rev, seq); doc.folder = folder; markDirty(); toast('Restored changes that had not reached the server');
        }
      } catch { /* ignore */ }
      return;
    }
  }
  try { const a = localStorage.getItem('sketchy.autosave'); if (a) { const d = JSON.parse(a); if (d.features?.length && (d.name === 'Untitled' || !d.name)) { loadProject(a); toast('Restored your unsaved design'); await nameUntitled(); return; } } } catch { /* ignore */ }
  await newDoc(true);
}
boot();
