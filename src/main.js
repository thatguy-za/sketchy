import './style.css';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { icon } from './icons.js';
import { initKernel, kernelModule, rebuild, clearKernelCache, resolvePlanes, shapeToPolygon, encodeFloats, profilesOf, planeFrame, findFaceTri, interference, compareBodies } from './kernel.js';
import { FEATURES, defOf, LAST, fieldKind } from './features.js';
import { writeSTL } from './stl.js';
import { readModelFile } from './importers.js';
import runtimeSource from './addin-runtime.js?raw';
import { createAddinManager } from './addins-ui.js';
import { buildTree } from './csg-service.js';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluate as evaluateDoc } from './headless.js';
import { initA11y } from './a11y.js';
import { initTheme, getTheme, setTheme, onTheme } from './theme.js';
initTheme();
const LOGO_MARK = '<svg viewBox="0 0 64 64" width="16" height="16"><rect x="4" y="4" width="56" height="56" rx="14" fill="#169b62"/><path d="M40 22C36 17 24 18 24 26C24 34 40 30 40 39C40 47 27 48 22 42" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>';
import { parseSVG, parseDXF, textShapes } from './import2d.js';
import { repairSoup, describeRepair } from './meshrepair.js';
import { writeOBJ, write3MF, writeSTEP, writeGLB } from './exporters.js';
import { readEmbeddedDesign } from './importers.js';
import { Viewport } from './viewport.js';
import { findEdgeChains, matchChain, roundPts, edgeRef, planarFace, norm as vnorm } from './edges.js';
import { acct, call, refreshAccount, ensureSignedIn, oauthConsent, requireLogin, showAuth, signOut, setAccountMenuHandler, setAccountChangeHandler, modal, showAccount, openUserMenu, showAdmin } from './account.js';
import { evalExpr, resolveParams, applyConfig, resolveFeature, isPlainNumber, NAME_RE, RESERVED } from './params.js';
import { saveDialog, askName, confirmBox, alertBox, chooseFolder, safeName as fileSafeName } from './files.js';
import { UNIT_TABLE, UNIT_NAMES, setUnits, getUnits, lenF, dispStr, fmtLen, fmtArea, fmtVolume, niceStep } from './units.js';
import { findEdgeChains as chainsOf } from './edges.js';
import { ficon, uicon } from './ficons.js';
import { createSketchUI } from './sketchui.js';
import { smoothPath } from './solids.js';
import { bedFit, overhangs, wallThickness } from './printcheck.js';
import { orientations, placement, findings, verdict, minWallFor, weightEstimate } from './printprofile.js';
import { createBeginner, designProfile } from './beginner.js';
import { createAssistant, toolPast } from './assistant.js';
import { withoutSkins } from './skins.js';
import { MATERIALS, TEXTURES, textureById, look, appearanceOf, densityOf, materialNameOf } from './materials.js';
import { resolveSketch } from './sketchdims.js';
import { CON_GLYPH, CON_LABEL, definedState } from './sketchcons.js';
import { CMD, WORKSPACE_TABS, TOOLBAR, SKETCH_TOOLBAR } from './commands.js';

const $ = (s) => document.querySelector(s);
let addins = null; // the add-in manager (src/addins-ui.js)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PRINTERS = {
  'Bambu Lab X1 / P1 (256³)': [256, 256, 256], 'Prusa MK4 (250×210×220)': [250, 210, 220], 'Prusa MINI (180³)': [180, 180, 180],
  'Creality Ender-3 (220×220×250)': [220, 220, 250], 'Voron 2.4 (350³)': [350, 350, 350],
};

// ------------------------------------------------------------------ state
/** The unit new designs start in: a personal setting kept in this browser (Settings, Units). */
const defaultUnits = () => { try { const u = localStorage.getItem('sketchy.units'); return UNIT_TABLE[u] ? u : 'mm'; } catch { return 'mm'; } };
const blankDoc = () => ({ name: 'Untitled', features: [], marker: 0, nextId: 1, params: [], appearance: {}, faceAppearance: [], units: defaultUnits(), components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [] });
/** Printers the person added themselves (a name and a build volume), kept in this browser. */
const customPrinters = () => { try { const l = JSON.parse(localStorage.getItem('sketchy.printers') || '[]'); return Array.isArray(l) ? l.filter((x) => x && typeof x.name === 'string' && Array.isArray(x.size) && x.size.length === 3 && x.size.every((v) => v > 0)) : []; } catch { return []; } };
const saveCustomPrinters = (l) => { try { localStorage.setItem('sketchy.printers', JSON.stringify(l)); } catch { /* storage unavailable */ } };
const printerSize = (name) => PRINTERS[name] || customPrinters().find((x) => x.name === name)?.size || null;
let bedName = localStorage.getItem('sketchy.bed') || Object.keys(PRINTERS)[0];
let doc = blankDoc();
let aiFlash = new Set(); // features the assistant just changed (pulsed in the timeline for a few seconds)
let assistant = null;
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
let paintMode = null; // Appearance picked with nothing selected: { val, target: 'faces' | 'bodies' }; each click applies it, Esc finishes
let viewBodies = [], skinCount = 0, skinWarned = false; // what the viewport draws, and how many triangles of zero-thickness walls were left out of it
let selFaceB = null; // a second flat face (Shift or Ctrl-click) to measure against; only valid while selFace is still the face it was added to
const faceB = () => (selFace && selFaceB && selFaceB.base === selFace ? selFaceB : null);
const shownFaces = () => [selFace, faceB()].filter(Boolean);
let selEdges = [];
let profSel = new Set(), profHover = null; // idle sketch-region selection: keys "sketchId|profileId"
let edgeHover = null;
const chainCache = new Map(); // edge chains by the body's mesh key: a body that did not change keeps its chains across rebuilds
let playTimer = null;
let dialog = null;               // {index, isNew, pre, mode}
let sketch = null;               // active sketch session
const hiddenBodies = new Set();
const sketchVis = {};
const collapsed = { views: true, origin: true };

let vp;
const snapshot = () => ({ features: [...doc.features], marker: doc.marker, nextId: doc.nextId, params: [...(doc.params || [])], appearance: { ...(doc.appearance || {}) }, faceAppearance: (doc.faceAppearance || []).map((f) => ({ ...f })), components: (doc.components || []).map((c) => ({ ...c })), bodyComp: { ...(doc.bodyComp || {}) }, configs: JSON.parse(JSON.stringify(doc.configs || [])), activeConfig: doc.activeConfig || null, canvases: (doc.canvases || []).map((c) => ({ ...c })) });
const restore = (s) => { doc.features = [...s.features]; doc.marker = s.marker; doc.nextId = s.nextId; doc.params = [...(s.params || [])]; doc.appearance = { ...(s.appearance || {}) }; doc.faceAppearance = (s.faceAppearance || []).map((f) => ({ ...f })); doc.components = (s.components || []).map((c) => ({ ...c })); doc.bodyComp = { ...(s.bodyComp || {}) }; doc.configs = JSON.parse(JSON.stringify(s.configs || [])); doc.activeConfig = s.activeConfig || null; doc.canvases = (s.canvases || []).map((c) => ({ ...c })); };
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
const sketchesBefore = (i, withPaths = false) => doc.features.slice(0, i).filter((f) => f.type === 'sketch' || (withPaths && f.type === 'sketch3d'));
const limit = () => (sketch ? sketch.index : doc.marker);

// ------------------------------------------------------------------ rebuild / refresh
let pending = false;
// ------------------------------------------------------------------ rebuilding off the main thread
// A design that takes a while to rebuild is rebuilt in a Web Worker instead (kernel-worker.js), so orbiting, menus and typing stay
// responsive. Small designs keep rebuilding on the page itself: no round trip, and the result is there straight away.
const HEAVY_MS = 150; // a rebuild slower than this moves the kernel to the worker
const canWorker = typeof Worker !== 'undefined';
let kernelHeavy = false, lastRebuildMs = 0, quickRuns = 0;
const kw = { worker: null, ready: false, seq: 0, running: null, pending: null, meshes: new Map(), idle: [], busyTimer: 0 };
function ensureKernelWorker() {
  if (kw.worker || !canWorker) return;
  try {
    kw.worker = new Worker(new URL('./kernel-worker.js', import.meta.url), { type: 'module' });
    kw.worker.onmessage = onKernelMessage;
    kw.worker.onerror = (e) => { console.error(e); stopKernelWorker(); kernelHeavy = false; toast('The background rebuild failed, so Sketchy went back to rebuilding on the page.', true); refresh(); };
    kw.worker.postMessage({ type: 'init', wasmUrl });
  } catch (e) { console.error(e); kw.worker = null; kernelHeavy = false; }
}
function stopKernelWorker() {
  kw.worker?.terminate(); kw.worker = null; kw.running = null; kw.pending = null; kw.meshes = new Map();
  showBusy(false); for (const f of kw.idle.splice(0)) f();
}
const kernelBusy = () => !!(kw.running || kw.pending);
const kernelIdle = () => new Promise((res) => (kernelBusy() ? kw.idle.push(res) : res()));
function rebuildInWorker(req, done) {
  ensureKernelWorker();
  if (!kw.worker) { kernelHeavy = false; refresh(); return; }
  req.done = done;
  if (kw.running) { kw.pending = req; return; } // only the newest change waits its turn; the ones in between are skipped
  sendRebuild(req);
}
function sendRebuild(req, resend = false) {
  kw.running = { id: ++kw.seq, req, t0: performance.now() };
  kw.worker.postMessage({ type: 'rebuild', id: kw.running.id, features: req.features, count: req.count, opts: req.opts, resend });
  clearTimeout(kw.busyTimer); kw.busyTimer = setTimeout(() => showBusy(true), 400);
}
function onKernelMessage(e) {
  const m = e.data;
  if (m.type === 'ready') { kw.ready = true; return; }
  const run = kw.running;
  if (!run || m.id !== run.id) return; // an answer for a request that was stopped
  kw.running = null;
  if (m.type === 'error') { console.error(m.message); toast('Kernel error: ' + m.message, true); } else {
    const res = m.result;
    const missing = res.bodies.some((b) => !b.verts && !kw.meshes.has(b.key));
    if (missing) { sendRebuild(run.req, true); return; } // the page lost a mesh the worker thought it had: ask for everything again
    for (const b of res.bodies) { if (b.verts) kw.meshes.set(b.key, { verts: b.verts, tris: b.tris }); else Object.assign(b, kw.meshes.get(b.key)); }
    const keep = new Set(res.bodies.map((b) => b.key)); for (const k of [...kw.meshes.keys()]) if (!keep.has(k)) kw.meshes.delete(k);
    lastRebuildMs = m.ms;
    quickRuns = m.ms < 40 ? quickRuns + 1 : 0;
    if (quickRuns >= 6 && !kw.pending) { kernelHeavy = false; quickRuns = 0; kw.worker.postMessage({ type: 'clear' }); kw.meshes = new Map(); } // cheap again: go back to rebuilding on the page
    run.req.done(res);
  }
  if (kw.pending) { const next = kw.pending; kw.pending = null; sendRebuild(next); }
  else { showBusy(false); for (const f of kw.idle.splice(0)) f(); }
}
function showBusy(on) {
  clearTimeout(kw.busyTimer);
  let el = $('#busybar');
  if (!on) { el && (el.hidden = true); clearInterval(kw.busyTick); return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'busybar'; el.setAttribute('role', 'status');
    el.innerHTML = '<span class="spin"></span><span id="busy-text">Rebuilding the design…</span><button type="button" class="btn small" id="busy-stop">Stop</button>';
    $('#viewport').appendChild(el);
    el.querySelector('#busy-stop').onclick = () => { stopKernelWorker(); toast('Stopped. What you see may be out of date. Change something to rebuild.'); };
  }
  el.hidden = false;
  const t0 = kw.running?.t0 || performance.now();
  clearInterval(kw.busyTick);
  kw.busyTick = setInterval(() => { const t = $('#busy-text'); if (t) t.textContent = `Rebuilding the design… ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 200);
}

function refresh() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; refreshNow(); }); } }
const paramScope = Object.assign((n) => paramState.values[n], { names: () => Object.keys(paramState?.values || {}) });
function refreshParamsNow() { paramState = resolveParams(applyConfig(doc.params || [], doc.configs, doc.activeConfig)); }
function refreshNow() {
  if (vp?.compareGroup && !/COMPARE/.test($('#props-wrap .title')?.textContent || '')) vp.setCompare(null); // a compare view never outlives its panel
  const pickF = dialog && defOf(doc.features[dialog.index])?.pickEdges;
  paramState = resolveParams(applyConfig(doc.params || [], doc.configs, doc.activeConfig));
  const evalErr = {};
  let feats = doc.features.map((f) => {
    const r = resolveFeature(f, paramScope, (ff, path) => (fieldKind(ff, path.split('.')[0]) === 'len' ? 'len' : 'num'));
    if (r.error) evalErr[f.id] = r.error;
    let ff = r.params === f.params ? f : { ...f, params: r.params };
    if (f.type === 'sketch') {
      const rs = resolveSketch(ff, paramScope);
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
  vp.setConstructionLines(feats.filter((f, i) => (f.type === 'axis' || f.type === 'cpoint') && !f.suppressed && !f.params.error && i < limit()).map((f) => (f.type === 'axis' ? { id: f.id, kind: 'axis', origin: f.params.origin, dir: f.params.dir, hidden: planeHidden.has(f.id) } : { id: f.id, kind: 'point', origin: (f.params.pos || [0, 0, 0]).map(Number), hidden: planeHidden.has(f.id) })));
  vp.setConstructionPlanes(feats.filter((f, i) => f.type === 'plane' && !f.suppressed && i < limit()).map((f) => ({ id: f.id, name: f.name, origin: f.params.origin, normal: f.params.normal, xdir: f.params.xdir, hidden: planeHidden.has(f.id) })));
  const req = { features: feats, count: limit(), opts: { bodyComp: doc.bodyComp, capture: pickF ? dialog.index : -1, previewId: dialog ? doc.features[dialog.index]?.id : null } };
  if (kernelHeavy && canWorker) { rebuildInWorker(req, (res) => { result = res; applyResult(evalErr); }); return; } // a big design: the page stays usable while it rebuilds
  const t0 = performance.now();
  try { result = rebuild(req.features, req.count, req.opts); }
  catch (e) { console.error(e); toast('Kernel error: ' + e.message, true); return; }
  lastRebuildMs = performance.now() - t0;
  if (lastRebuildMs > HEAVY_MS && canWorker) { kernelHeavy = true; clearKernelCache(); ensureKernelWorker(); } // from the next change on, rebuild off the main thread
  applyResult(evalErr);
}
/** Everything that follows a rebuild: colours, meshes, selection, panels. */
function applyResult(evalErr) {
  for (const [id, m] of Object.entries(evalErr)) result.errors[id] ||= m;
  for (const [id, origin] of Object.entries(result.shifted || {})) if (resolvedMap[id]) resolvedMap[id] = { ...resolvedMap[id], origin }; // sketches that followed their face
  vp.bodyColors = doc.appearance || {};
  { const live = new Set(result.bodies.map((b) => b.key || b)); for (const k of [...chainCache.keys()]) if (!live.has(k)) chainCache.delete(k); }
  viewBodies = result.bodies.map((b) => withoutSkins(b)); // zero-thickness walls are not drawn: they hold no material and would not print
  skinCount = viewBodies.reduce((a, b) => a + (b.skinned || 0), 0);
  if (skinCount && !skinWarned) { skinWarned = true; toast('Some walls have no thickness, so they are hidden: they hold no material and would not print.'); } else if (!skinCount) skinWarned = false;
  vp.facePaint = doc.faceAppearance || [];
  vp.setBodies([...viewBodies, ...(result.surfaces || [])].filter((b) => !hiddenBodies.has(b.id)));
  for (const id of [...vp.selected]) if (!result.bodies.some((b) => b.id === id)) vp.selected.delete(id);
  vp.refreshMaterials();
  drawSketches();
  updateProfileView();
  vp.setPreview(dialog ? result.preview : null);
  updateManip();
  updatePickEdges();
  if (selFace && !result.bodies.some((b) => b.id === selFace.id)) selFace = null;
  updateEdgeView();
  if (dialog) updateFaceHL(); else if (!sketch && !measure) vp.showFaces(shownFaces(), null);
  renderTree(); renderTimeline(); renderRibbon(); renderStatus();
  if (pcReopen) { pcReopen = false; setTimeout(() => showPrintCheck(), 0); }
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
  const k = b.key || b;
  let c = chainCache.get(k);
  if (!c) { c = chainsOf(b.verts, 3, b.tris); chainCache.set(k, c); }
  return c;
}
let entriesMemo = { result: null, hidden: '', list: [] };
function edgeEntries() { // asked for on every mouse move, so the list is kept until the result or the hidden bodies change
  const hidden = [...hiddenBodies].sort().join('|');
  if (entriesMemo.result === result && entriesMemo.hidden === hidden) return entriesMemo.list;
  const out = [];
  for (const b of result.bodies) if (!hiddenBodies.has(b.id)) for (const chain of chainsFor(b)) out.push({ body: b.id, chain });
  entriesMemo = { result, hidden, list: out };
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
  if (dialog || sketch || measure) { vp.showEdges(dialog ? LOSTCHAINS() : [], null); return; }
  const chains = resolveSelEdges();
  vp.showEdges(chains, edgeHover?.chain || null);
  if (/edges? selected/.test($('#hud').textContent)) $('#hud').innerHTML = ''; // older builds wrote the selection here; it now lives in the status line
  renderStatus();
}
/** Length of an edge chain in millimetres (a closed one includes the closing segment). */
function chainLength(ch) {
  const P = ch.pts; let len = 0;
  for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]);
  if (ch.closed && P.length > 2) len += Math.hypot(P[0][0] - P.at(-1)[0], P[0][1] - P.at(-1)[1], P[0][2] - P.at(-1)[2]);
  return len;
}
function toggleSelEdge(en, additive) {
  const ref = edgeRef(en.body, en.chain);
  const same = (e) => e.body === en.body && matchChain([en.chain], e.pts);
  const has = selEdges.some(same);
  if (!additive) { selEdges = has && selEdges.length === 1 ? [] : [ref]; }
  else selEdges = has ? selEdges.filter((e) => !same(e)) : [...selEdges, ref];
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
    .map((ch) => edgeRef(b.id, ch));
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
  vp.setManip(base, fr.n, (rp.direction ? rp.direction === 'symmetric' : rp.symmetric) ? dist / 2 : dist);
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
    const sym = (rpx => (rpx.direction ? rpx.direction === 'symmetric' : !!rpx.symmetric))(resolvedMap[df.id] || df.params);
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
  const has = f.params.edges.some((e) => e.body === entry.body && matchChain([entry.chain], e.pts));
  const edges = has ? f.params.edges.filter((e) => !(e.body === entry.body && matchChain([entry.chain], e.pts))) : [...f.params.edges, edgeRef(entry.body, entry.chain)];
  updateParam(dialog.index, 'edges', edges);
  renderDialog();
}

const paramShow = (p, v) => (v === undefined ? '' : p.unit === 'number' ? String(+v.toFixed(4)) : p.unit === 'angle' ? `${+v.toFixed(4)}°` : fmtLen(v));
/** Settings (user menu → Settings): personal preferences. Units is the first one. */
function showSettings() {
  const unitOpts = (sel) => Object.keys(UNIT_TABLE).map((u) => `<option value="${u}"${u === sel ? ' selected' : ''}>${esc(UNIT_NAMES[u])} (${u})</option>`).join('');
  const m = modal(`<div class="modal-title">Settings</div>
    <div class="modal-body set-body">
      <h3 class="set-h">Units</h3>
      <label class="set-row"><span>This design</span><select id="st-doc" aria-label="Units of this design">${unitOpts(getUnits())}</select></label>
      <label class="set-row"><span>New designs</span><select id="st-new" aria-label="Units for new designs">${unitOpts(defaultUnits())}</select></label>
      <div class="hint-sm">Lengths are shown and typed in these units. Everything is stored in millimetres, so changing units never changes the geometry. The choice for new designs is kept in this browser.</div>
      <h3 class="set-h">3D printing</h3>
      <div class="set-row"><span>Printer, nozzle and fit</span><button class="btn" id="st-print" type="button">Print setup…</button></div>
    </div>`);
  m.el.querySelector('#st-print').onclick = () => { m.close(); BG.printSetup(); };
  m.el.querySelector('#st-doc').onchange = (e) => setDocUnits(e.target.value);
  m.el.querySelector('#st-new').onchange = (e) => { try { localStorage.setItem('sketchy.units', e.target.value); } catch { /* storage unavailable */ } toast(`New designs will start in ${UNIT_NAMES[e.target.value]}.`); };
}
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
/** How far apart two flat faces are (parallel faces), or the angle between them. */
function faceGap(a, b) {
  const dt = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
  const ang = (Math.acos(Math.min(1, Math.abs(dt))) * 180) / Math.PI;
  if (ang < 0.05) return { parallel: true, d: Math.abs((b.point[0] - a.point[0]) * a.normal[0] + (b.point[1] - a.point[1]) * a.normal[1] + (b.point[2] - a.point[2]) * a.normal[2]) };
  return { parallel: false, ang };
}
function renderStatus() {
  if (paintMode) { $('#statusbar').textContent = `Appearance: click ${paintMode.target === 'faces' ? 'a face' : 'a body'} to apply it · Esc to finish`; return; }
  const fb = faceB();
  if (fb) {
    const g = faceGap(selFace, fb);
    $('#statusbar').textContent = g.parallel ? `Distance between faces: ${dispStr(g.d, 3)} ${getUnits()}` : `Angle between faces: ${g.ang.toFixed(2)}°`;
    return;
  }
  if (selEdges.length && !dialog && !sketch && !measure) {
    const chains = resolveSelEdges();
    if (chains.length) {
      const total = chains.reduce((a, c) => a + chainLength(c), 0), u = getUnits();
      $('#statusbar').textContent = chains.length === 1 ? `1 edge selected · length ${dispStr(total, 2)} ${u}` : `${chains.length} edges selected · total length ${dispStr(total, 2)} ${u}`;
      return;
    }
  }
  const n = result.bodies.length;
  const tris = result.bodies.reduce((a, b) => a + b.tris.length / 3, 0);
  $('#statusbar').textContent = `${n} ${n === 1 ? 'body' : 'bodies'} · ${tris.toLocaleString()} triangles · ${getUnits()}${skinCount ? ' · zero-thickness walls hidden' : ''}${lastRebuildMs > 300 ? ` · rebuilt in ${(lastRebuildMs / 1000).toFixed(1)} s${result.stats && result.stats.from > 0 ? `, from step ${result.stats.from + 1} of ${result.stats.total}` : ''}` : ''}`;
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
  addins: () => (addins ? addins.showDialog() : toast('Add-ins are still loading. Try again in a moment.', true)),
  importstl: () => $('#file-stl').click(),
  repairimport: () => $('#file-repair').click(),
  measure: () => startMeasure('dist'), angle: () => startMeasure('angle'), edgelen: () => startMeasure('edge'), faces: () => startMeasure('faces'),
  properties: () => showInfo(),
  printcheck: () => showPrintCheck(),
  interference: () => showInterference(),
  section: () => showSection(),
  appearance: () => openAppearance(),
  render: () => toggleRender(),
  saveimage: () => saveImageDialog(),
  drivejoints: () => showDriveJoints(),
  svg: () => pick2D('.svg,image/svg+xml'), dxf: () => pick2D('.dxf'), sk_text: () => showTextDialog(),
  asbuilt: () => startAsBuilt(),
  export: () => exportDialog(),
  printer: () => printerMenu($('#ribbon')),
  printsetup: () => BG.printSetup(), tour: () => BG.startTour(), connectai: () => connectAssistant(),
  buildvol: () => { vp.opts.bed = !vp.opts.bed; vp.refreshMaterials(); renderRibbon(); },
  select: (ev) => selectionMenu(ev?.currentTarget), finishsketch: () => finishSketch(), cancelpick: () => cancelSketch(),
};
function runCommand(id, ev) {
  const c = CMD[id];
  if (!c) return;
  if (paintMode && id !== 'appearance') endPaint(); // starting anything else ends the painting
  if (c.sk) { if (sketch && !sketch.picking) setSketchTool(c.sk); return; }
  if (c.skAction === 'delete') return sketchDeleteSelected();
  if (sketch && !['select', 'finishsketch', 'cancelpick', 'svg', 'dxf', 'sk_text'].includes(id)) return toast('Finish the sketch first.');
  if (id === 'remove') { lastCmd = id; return deleteSelection(); }
  if (selFace?.curved && (id === 'extrude' || id === 'sketch')) return toast('A sketch or Press/Pull needs a flat face. Pick a flat face, or use a plane.', true);
  if (selFace && id === 'extrude') { lastCmd = id; return startFeature('presspull'); }
  if (selFace && id === 'sketch') { lastCmd = id; return sketchOnSelectedFace(); }
  if (c.addinCommand) { lastCmd = id; return runAddinCommand(c); }
  if (c.feature) { lastCmd = id; return startFeature(c.feature, c.preset); }
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
  apPanel?.sync();
  queueLive();
  renderStatus(); // the status line follows the selection (two faces show the distance between them)
  vp.hold('sketch', !!sketch);
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
      const active = (c.sk && sketch?.tool === c.sk) || (MEASURE_MODE[id] && measure?.mode === MEASURE_MODE[id]) || (id === 'buildvol' && vp.opts.bed) || (id === 'render' && vp.opts.render);
      b.className = 'fbtn' + (active ? ' active' : '') + (g.big ? ' sel-big' : '') + (g.finish ? ' finish' : '');
      b.dataset.tip = JSON.stringify({ t: c.label, k: c.key || '', d: c.desc || '' });
      b.innerHTML = ficon(c.icon, g.big ? 40 : 30) + (g.finish ? '<span>FINISH SKETCH</span>' : '');
      b.disabled = !!dialog && !sketch;
      b.onclick = (ev) => runCommand(id, ev);
      b.setAttribute('aria-label', c.label);
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
  BG.update();
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
    folder(1, 'docset', 'Document Settings', 'gear', {}, () => { R(2, `Units: ${getUnits()}, g`, { kind: 'file', click: (ev) => unitsMenu(ev.currentTarget) }); R(2, 'Part Design', { kind: 'body', dim: true }); R(2, 'Print setup…', { kind: 'file', click: () => BG.printSetup() }); });
    folder(1, 'views', 'Named Views', 'folder', {}, () => R(2, 'Home', { kind: 'camera', click: () => vp.home(true) }));
    folder(1, 'origin', 'Origin', 'folder', { eye: originVis, onEye: () => { originVis = !originVis; vp.setOriginVisible(originVis); renderTree(); } }, () => {
      for (const n of ['XY', 'XZ', 'YZ']) R(2, n, { kind: 'plane', dim: true });
      for (const n of ['X', 'Y', 'Z']) R(2, n, { kind: 'axis', dim: true });
      R(2, 'Origin', { kind: 'point', dim: true });
    });
    const planes = doc.features.map((f, i) => [f, i]).filter(([f, i]) => (f.type === 'plane' || f.type === 'axis' || f.type === 'cpoint') && i < limit());
    if (planes.length) folder(1, 'construction', 'Construction', 'folder', {}, () => planes.forEach(([f]) => R(2, f.name, { kind: f.type === 'plane' ? 'plane' : f.type === 'axis' ? 'axis' : 'point', eye: !planeHidden.has(f.id), sel: selSet.has(f.id), onEye: () => { planeHidden.has(f.id) ? planeHidden.delete(f.id) : planeHidden.add(f.id); refresh(); }, click: (ev) => selectFeature(f.id, ev), dbl: () => editFeature(featureIndex(f.id)) })));
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
    const sk = doc.features.map((f, i) => [f, i]).filter(([f, i]) => (f.type === 'sketch' || f.type === 'sketch3d') && i < limit() + (sketch ? 1 : 0));
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
    if (r.ctx?.kind === 'body' || r.ctx?.kind === 'component') { // an appearance dragged from the Appearance panel lands on a body (or on every body of a component)
      const ids = () => (r.ctx.kind === 'body' ? [r.ctx.id] : result.bodies.filter((b) => doc.bodyComp?.[b.id] === r.ctx.id).map((b) => b.id));
      const ours = (e) => [...(e.dataTransfer?.types || [])].includes(AP_MIME) && apPanel;
      el.addEventListener('dragover', (e) => { if (!ours(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drop'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { if (!ours(e)) return; e.preventDefault(); el.classList.remove('drop'); let val; try { val = JSON.parse(e.dataTransfer.getData(AP_MIME)); } catch { val = apDrag; } const list = ids(); if (!list.length || !val) return; setBodyAppearance(list, val); toast(`Appearance applied to ${list.length} ${list.length > 1 ? 'bodies' : 'body'}`); });
    }
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
let markerDrag = false; // the marker is being dragged: the timeline keeps its elements until the drag ends, or the one being held would vanish after the first step
function renderTimeline() {
  if (markerDrag) return;
  const host = $('#timeline');
  host.innerHTML = '';
  const shownMarker = sketch ? sketch.index : doc.marker;
  const mk = () => {
    const m = document.createElement('div');
    m.className = 'tl-marker'; m.title = 'Drag to roll back the timeline';
    m.onpointerdown = (e) => {
      if (sketch || dialog) return;
      stopPlay();
      e.preventDefault();
      markerDrag = true; m.classList.add('drag');
      let frame = 0;
      // listen on the document, not on the marker: moving the marker in the timeline (remove and insert) makes the browser drop its pointer capture
      const move = (ev) => {
        const items = [...host.querySelectorAll('.tl-item')];
        let pos = 0;
        items.forEach((it, i) => { const r = it.getBoundingClientRect(); if (ev.clientX > r.left + r.width / 2) pos = i + 1; });
        if (pos === doc.marker) return;
        doc.marker = pos; // move the marker and dim the steps after it right away; the model catches up once per frame
        items.forEach((it, i) => it.classList.toggle('off', i >= pos));
        host.insertBefore(m, items[pos] || null);
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); });
      };
      const end = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        m.classList.remove('drag'); markerDrag = false; refresh();
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    };
    return m;
  };
  if (!doc.features.length) host.innerHTML = '<span class="tl-empty">Every operation you perform appears here. Drag the marker to roll back; double-click an item to edit.</span>';
  doc.features.forEach((f, i) => {
    if (i === shownMarker && !sketch) host.appendChild(mk());
    const el = document.createElement('div');
    el.className = 'tl-item' + (i >= shownMarker ? ' off' : '') + (result.errors[f.id] ? ' err' : result.warnings?.[f.id] ? ' warn' : '') + (selSet.has(f.id) ? ' sel' : '') + (f.suppressed ? ' supp' : '') + (f.by === 'assistant' ? ' ai' : '') + (aiFlash.has(f.id) ? ' ai-new' : '');
    el.title = (f.by === 'assistant' ? 'Added or changed by the assistant · ' : '') + f.name + (result.errors[f.id] ? ` — ${result.errors[f.id]}` : '') + (result.warnings?.[f.id] ? ` — ${result.warnings[f.id].map((w) => w.text).join(' ')}` : '') + (result.notes?.[f.id] && !result.errors[f.id] ? ` — ${result.notes[f.id].text}` : '');
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
  const old = result.errors; // the design as it stands now was just built; only the moved order needs a trial rebuild
  const res = rebuild(feats, newMarker, { cache: false }).errors;
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
      { label: hidden ? 'Show' : 'Hide', run: () => { hidden ? hiddenBodies.delete(c.id) : hiddenBodies.add(c.id); refresh(); } },
      { label: 'Move / Copy…', hint: 'M', run: () => runCommand('move') },
      { label: isolated ? 'Unisolate' : 'Isolate', run: () => { if (isolated) hiddenBodies.clear(); else bodies.forEach((x) => (x.id === c.id ? hiddenBodies.delete(x.id) : hiddenBodies.add(x.id))); refresh(); } },
      ...((doc.components || []).length || true ? [{ sep: true }, { head: 'COMPONENT' }, ...(doc.components || []).map((cp) => ({ label: cp.name, check: doc.bodyComp?.[c.id] === cp.id, run: () => moveToComponent(vp.selected.size > 1 ? [...vp.selected] : [c.id], cp.id) })), { label: 'New component with this body', run: () => newComponent() }, ...(doc.bodyComp?.[c.id] ? [{ label: 'Remove from component', run: () => moveToComponent([c.id], null) }] : [])] : []),
      { sep: true },
      { label: 'Appearance…', run: () => { if (!vp.selected.has(c.id)) { selFace = null; vp.showFaces([], null); vp.selected.clear(); vp.selected.add(c.id); vp.refreshMaterials(); renderTree(); } openAppearance(); } },
      { sep: true },
      { label: 'Properties', run: showInfo },
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
      ...(f.type === 'sketch' || f.type === 'sketch3d' ? [{ label: vis ? 'Hide' : 'Show', run: () => { sketchVis[f.id] = !vis; drawSketches(); renderTree(); } }] : []),
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
  const m = modal(`<div class="modal-title">${withConfig ? 'Insert Configured Design' : 'Insert Design'}</div><div class="modal-body"><label>Design<select id="ins-src">${sources.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select></label>${withConfig ? '<label>Configuration<select id="ins-cfg"></select></label>' : ''}<div class="hint">Copies the design's bodies into this one as meshes. It is a snapshot: later changes to the other design are not carried over.</div><div class="form-err" id="ins-err"></div><div class="modal-foot"><button class="btn primary" id="ins-ok" type="button">Insert</button></div></div>`);
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
  const anyCheck = items.some((x) => x.check !== undefined); // text only: the one thing that lines up the labels is the tick column
  for (const it of items) {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
    if (it.head) { m.insertAdjacentHTML('beforeend', `<div class="mh">${esc(it.head)}</div>`); continue; }
    const e = document.createElement('div');
    e.className = 'mi' + (it.disabled ? ' disabled' : '') + (it.check !== undefined ? ' check' + (it.check ? ' on' : '') : '');
    if (it.disabled) e.setAttribute('aria-disabled', 'true');
    e.setAttribute('role', 'menuitem'); e.tabIndex = -1;
    if (it.dim) e.style.opacity = '.55';
    const ic = it.swatch ? '<span class="swatch"></span>' : it.check === undefined && anyCheck ? '<span class="ph"></span>' : '';
    e.innerHTML = ic + `<span>${esc(it.label)}</span>` + (it.hint ? `<small>${it.hint}</small>` : '');
    if (it.swatch) e.querySelector('.swatch').style.background = it.swatch;
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

function startFeature(key, overrides = {}) {
  if (dialog || sketch) return;
  apPanel?.close();
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
  const params = { ...def.make(c), ...overrides };
  if (['extrude', 'revolve', 'emboss', 'sextrude', 'srevolve'].includes(key) && c.selSketch) { params.sketch = c.selSketch; params.profiles = c.selProfiles; profSel.clear(); }
  if (key === 'combine') { // bodies already selected: the first is the target and the rest are the tools; otherwise the next body is offered as the tool
    const picked = [...vp.selected].filter((id) => result.bodies.some((b) => b.id === id));
    if (picked.length >= 2) { params.target = picked[0]; params.tool = picked.slice(1); }
    else { const o = result.bodies.find((b) => b.id !== params.target)?.id; params.tool = o ? [o] : []; }
  }
  if (selFace?.curved && !selEdges.length && ['fillet', 'chamfer', 'presspull', 'hole', 'shell', 'draft'].includes(key)) return toast('That tool needs a flat face (or edges). A curved face can be given an appearance.', true);
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
  focusFirstNumber();
}
/** A feature dialog opens with its first number selected, so typing replaces it (Tab moves to the next). Not on touch screens, where it would raise the keyboard. */
function focusFirstNumber() {
  if (document.body.classList.contains('touch')) return;
  setTimeout(() => { const n = document.querySelector('#props-wrap input.num'); if (n && dialog && !sketch) { n.focus(); n.select(); } }, 80); // after the dialog has finished drawing itself
}
// Any number box selects its whole value when it gets focus, by click or Tab, so typing a number replaces it.
const isNumberBox = (el) => el?.tagName === 'INPUT' && (el.type === 'number' || el.classList.contains('num') || /^(decimal|numeric)$/.test(el.inputMode));
document.addEventListener('focusin', (e) => { const t = e.target; if (isNumberBox(t)) { t.select(); t._fresh = true; } });
document.addEventListener('mouseup', (e) => { if (e.target._fresh) { e.preventDefault(); e.target._fresh = false; } }, true); // the click that focused it must not drop the selection
document.addEventListener('keydown', (e) => { if (e.target._fresh) e.target._fresh = false; }, true);

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
    try { val = evalExpr(text, paramScope, isLen ? 'len' : 'num'); expr = text.trim(); }
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
  wrap.innerHTML = `<div class="props"><div class="title"><button class="tmin" title="Minimise" aria-label="Minimise">${uicon('minus', 14, 2)}</button><span>${esc((def.label || f.name).toUpperCase())}</span></div><div class="body"></div>
    <div class="foot"><span class="info" title="${esc(hint)}">i</span><button class="btn primary" id="d-ok">OK</button><button class="btn" id="d-cancel">Cancel</button></div></div>`;
  wrap.querySelector('.tmin').onclick = (e) => { const min = wrap.querySelector('.props').classList.toggle('collapsed'); e.currentTarget.innerHTML = uicon(min ? 'expand' : 'minus', 14, 2); e.currentTarget.title = min ? 'Expand' : 'Minimise'; e.currentTarget.setAttribute('aria-label', min ? 'Expand' : 'Minimise'); };
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
    if ((fld.type === 'vec3' || fld.type === 'point') && !body.querySelector('.axhead')) body.insertAdjacentHTML('beforeend', '<div class="row axhead" aria-hidden="true"><label></label><div class="v3"><span>X</span><span>Y</span><span>Z</span></div></div>'); // one X Y Z heading over the rows of three boxes
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
      n.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: 'Make this a parameter…', run: async () => {
          const cur = n.value.trim();
          const used = new Set((doc.params || []).map((q) => q.name));
          let k = 1; while (used.has('d' + k)) k++;
          const unit = isLen ? 'length' : (fld.unit === 'deg' || /angle|deg/i.test(fld.label)) ? 'angle' : 'number';
          const name = await askName({ title: 'Make a parameter', label: 'Parameter name', value: 'd' + k, ok: 'Create', raw: true, hint: `It starts at ${cur}. Change it later under Manage, Change Parameters, and every field that uses it follows.`,
            validate: (t) => (!NAME_RE.test(t) ? 'Use letters, digits and _, starting with a letter.' : RESERVED.has(t) ? 'That name is already used for a function or unit.' : used.has(t) ? 'A parameter with that name exists.' : '') });
          if (!name) return;
          const plain = isPlainNumber(cur) ? cur : String(+((resolvedAt(f, path) ?? 0) / (isLen ? lenF() : 1)).toFixed(6));
          doc.params = [...(doc.params || []), { name, expr: plain, unit, comment: '' }];
          markDirty(); refreshParamsNow();
          n.value = name; n.oninput();
          toast(`Created parameter ${name} = ${plain}`);
        } }]);
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
      [0, 1, 2].forEach((k) => { const inp = numIn(`${fld.key}.${k}`, val[k]); inp.querySelector('input')?.setAttribute('aria-label', `${fld.label} ${'XYZ'[k]}`); g.appendChild(inp); });
      return g;
    };
    if (fld.type === 'edges') {
      ctl.innerHTML = `<span>${val.length} selected</span> <button class="btn ml8" id="d-edgeclear">Clear</button><div class="hint-sm">Click edges in the viewport to add or remove them.</div>`;
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
      const avail = bodiesBefore(idx), chosen = [].concat(val || []);
      ctl.innerHTML = avail.length ? avail.map((q) => `<label class="chk plain"><input type="checkbox" data-s="${esc(q.id)}" ${chosen.includes(q.id) ? 'checked' : ''}> ${esc(q.name)}</label>`).join('') + '<div class="note">…or click bodies in the viewport.</div>' : '<div class="note">No bodies yet.</div>';
      ctl.querySelectorAll('input[data-s]').forEach((c) => (c.onchange = () => { set([...ctl.querySelectorAll('input[data-s]:checked')].map((x) => x.dataset.s)); }));
    } else if (fld.type === 'surfaces') {
      const avail = result.surfSnaps?.[idx] || result.surfaces.map((q) => ({ id: q.id, name: q.name }));
      ctl.innerHTML = avail.length ? avail.map((q) => `<label class="chk plain"><input type="checkbox" data-s="${esc(q.id)}" ${val.includes(q.id) ? 'checked' : ''}> ${esc(q.name)}</label>`).join('') + '<div class="note">…or click surfaces in the viewport.</div>' : '<div class="note">No surfaces yet.</div>';
      ctl.querySelectorAll('input[data-s]').forEach((c) => (c.onchange = () => { set([...ctl.querySelectorAll('input[data-s]:checked')].map((x) => x.dataset.s)); }));
    } else if (fld.type === 'face' || fld.type === 'faces') {
      const list = fld.type === 'face' ? (val ? [val] : []) : val || [];
      ctl.innerHTML = `<span>${list.length ? `${list.length} face${list.length > 1 ? 's' : ''} selected` : 'None selected'}</span> <button class="btn sm ml6">Clear</button><div class="note">${fld.type === 'face' ? 'Click a flat face, then drag it in the viewport or type a distance.' : (fld.note || 'Click flat faces in the viewport. Click again to deselect.')}</div>`;
      ctl.querySelector('button').onclick = () => { patchParams(idx, { [fld.key]: fld.type === 'face' ? null : [] }); renderDialog(); };
    } else if (fld.type === 'points3d') {
      const f2 = lenF(), pts = (val || []).map((q) => [...q]);
      const active = dialog.pick?.kind === 'points3d';
      ctl.innerHTML = `<div class="p3-bar"><button type="button" class="btn sm${active ? ' on' : ''}" id="p3-pick">${active ? 'Done picking' : 'Pick in viewport'}</button><button type="button" class="btn sm" id="p3-add">Add point</button><button type="button" class="btn sm" id="p3-clear" ${pts.length ? '' : 'disabled'}>Clear</button></div>
        <div class="p3-rows">${pts.map((q, k) => `<div class="p3-row"><span class="p3-n">${k + 1}</span>${[0, 1, 2].map((a) => `<input type="number" step="any" inputmode="decimal" data-k="${k}" data-a="${a}" value="${+(q[a] / f2).toFixed(3)}" aria-label="Point ${k + 1} ${'XYZ'[a]} (${getUnits()})">`).join('')}<button type="button" class="p3-del" data-k="${k}" aria-label="Delete point ${k + 1}" title="Delete point">${uicon('close', 12, 2)}</button></div>`).join('')}</div>
        <div class="note">${active ? 'Click the model to add a point on its surface, or in empty space to add one level with the last point. Click Done when finished.' : pts.length ? `${pts.length} point${pts.length > 1 ? 's' : ''} (${getUnits()}). Edit the numbers, or pick more.` : 'No points yet. Pick them in the viewport or add them by number.'}</div>`;
      ctl.querySelector('#p3-pick').onclick = () => { dialog.pick = active ? null : { kind: 'points3d', key: fld.key }; renderDialog(); };
      ctl.querySelector('#p3-add').onclick = () => { const last = pts[pts.length - 1] || [0, 0, 0]; set([...pts, [last[0] + 10, last[1], last[2]]]); renderDialog(); };
      ctl.querySelector('#p3-clear').onclick = () => { set([]); renderDialog(); };
      ctl.querySelectorAll('input[data-k]').forEach((inp) => (inp.onchange = () => { const k = +inp.dataset.k, a = +inp.dataset.a, n = [...pts]; n[k] = [...n[k]]; n[k][a] = (+inp.value || 0) * f2; set(n); }));
      ctl.querySelectorAll('.p3-del').forEach((b2) => (b2.onclick = () => { set(pts.filter((_, k) => k !== +b2.dataset.k)); renderDialog(); }));
    } else if (fld.type === 'text') {
      const i = document.createElement('input'); i.type = 'text'; i.setAttribute('aria-label', fld.label); i.autocomplete = 'off'; i.spellcheck = false; i.value = val ?? ''; i.onchange = () => set(i.value); ctl.appendChild(i);
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
      else if (fld.type === 'axisref') opts = [...(fld.base || []), ...doc.features.slice(0, idx).filter((q) => q.type === 'axis').map((q) => [q.id, q.name])];
      else if (fld.type === 'planeref') opts = [['XY', 'XY (Top)'], ['XZ', 'XZ (Front)'], ['YZ', 'YZ (Right)'], ...doc.features.slice(0, idx).filter((q) => q.type === 'plane').map((q) => [q.id, q.name])];
      else if (fld.type === 'surface') opts = [['', 'Select surface…'], ...(result.surfSnaps?.[idx] || result.surfaces).map((q) => [q.id, q.name])];
      else if (fld.type === 'body') opts = [['', fld.optional || 'Select body…'], ...bodiesBefore(idx).map((b) => [b.id, b.name])];
      else opts = [['', 'Select sketch…'], ...sketchesBefore(idx, fld.paths).map((k) => [k.id, k.name])];
      s.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      if (fld.icon && fld.type === 'select') {
        ctl.appendChild(iconSelect(opts, val, (v) => { if (fld.boolSelect) { set(v === true || v === 'true'); return; } set(v); if (['op', 'kind', 'extent', 'by', 'mode', 'jtype', 'direction', 'start', 'extent2'].includes(fld.key)) rerender(); }, () => DLG_ICON[fld.icon]));
        body.appendChild(row); continue;
      }
      s.value = String(val ?? '');
      s.onfocus = () => { dialog.focusKey = fld.key; };
      s.onchange = () => { if (fld.boolSelect) { set(s.value === 'true'); return; } if (fld.key === 'sketch' && 'profiles' in f.params) { patchParams(idx, { sketch: s.value, profiles: null }); rerender(); return; } set(s.value); if (['op', 'kind', 'extent', 'by', 'mode', 'jtype', 'direction', 'start', 'extent2'].includes(fld.key)) rerender(); else if (def.gizmo) setupGizmo(); };
      ctl.appendChild(s);
      if (fld.type === 'body' && !fld.noPick) ctl.insertAdjacentHTML('beforeend', '<div class="note">…or click a body in the viewport.</div>');
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
  if (pk.kind === 'points3d') { // each click adds a point: on the model if there is one under the cursor, otherwise level with the last point
    const cur = f.params[pk.key] || [];
    const sn = vp.snapAt(e, edgeEntries());
    const pt = sn ? sn.point : vp.pickHorizontal(e, cur.length ? cur[cur.length - 1][2] : 0);
    if (!pt) return;
    patchParams(i, { [pk.key]: [...cur, pt.map((v) => +v.toFixed(3))] });
    renderDialog();
    return;
  }
  if (pk.kind === 'point') {
    const sn = vp.snapAt(e, edgeEntries()); // corners and edges snap, then the face under the cursor
    if (!sn) return;
    const patch = { [pk.key]: sn.point.map((v) => +v.toFixed(3)) };
    if (pk.dirKey) {
      let tg = vp.pickPlanarFace(e), nrm = tg?.normal, fid = tg?.id;
      if ((!nrm || sn.kind !== 'face') && sn.normals?.length) { // on a corner or edge: use the adjoining face that faces the camera most
        const view = new THREE.Vector3(); vp.camera.getWorldDirection(view);
        const up = sn.normals.find((n) => n[2] > 0.99); // a top face is the usual place for a hole
        nrm = up || [...sn.normals].sort((a, b) => view.dot(new THREE.Vector3(...a)) - view.dot(new THREE.Vector3(...b)))[0]; fid = sn.id;
      }
      if (nrm) { patch[pk.dirKey] = nrm.map((v) => +v.toFixed(4)); if (f.type === 'hole') patch.face = { id: fid, point: sn.point.map((v) => +v.toFixed(3)), normal: nrm.map((v) => +v.toFixed(4)) }; } // the hole remembers its face so it follows it when the model changes
    }
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
  if (bfld && h) { const cur = [].concat(f.params[bfld.key] || []); updateParam(dialog.index, bfld.key, cur.includes(h.id) ? cur.filter((x) => x !== h.id) : [...cur, h.id]); renderDialog(); return; }
  const flds = defOf(f).fields.filter((x) => x.type === 'body' && !x.noPick && (!x.show || x.show(f.params)));
  if (!flds.length) return;
  if (!h) return;
  const key = (flds.find((x) => x.key === dialog.focusKey) || flds.find((x) => !f.params[x.key]) || flds[0]).key;
  updateParam(dialog.index, key, h.id);
  renderDialog(); setupGizmo();
}

/** A short "what to do next" for the failures people hit most. */
function errorHelp(msg) {
  const rules = [
    [/no closed profile/i, 'Close the shape in the sketch, or draw a rectangle or circle, then try again.'],
    [/too large for this edge|size too large/i, 'Use a smaller radius or distance. It cannot be bigger than the faces next to the edge.'],
    [/too thick|too large for this body/i, 'Use a thinner wall so it fits inside the shape.'],
    [/behind the profile/i, 'Switch the direction with the flip option.'],
    [/Taper/i, 'Turn off the other option, or use a smaller taper angle.'],
    [/no longer exists|pick (them|it) again|reselect/i, 'Something this feature used was changed by an earlier step. Pick it again.'],
  ];
  return (rules.find(([re]) => re.test(msg)) || [])[1] || '';
}
const LOSTCHAINS = () => {
  const f = dialog && doc.features[dialog.index], l = f && result.lost?.[f.id];
  return l?.length ? l.map((i) => f.params.edges?.[i]).filter(Boolean).map((e) => ({ pts: e.pts, closed: false })) : [];
};
function renderDialogErrors() {
  const host = $('#d-err');
  if (!host || !dialog) return;
  const f = doc.features[dialog.index];
  const e = result.errors[f?.id], note = result.notes?.[f?.id], warns = result.warnings?.[f?.id] || [];
  const help = e ? errorHelp(e) : '';
  host.innerHTML = (e ? `<div class="row err-row">${icon('warn', 14)} <div>${esc(e)}${help ? `<div class="err-help">${esc(help)}</div>` : ''}</div></div>` : '')
    + warns.map((w) => `<div class="row warn-row">${icon('warn', 14)} <div>${esc(w.text)}${w.action === 'repick' ? ' <button type="button" class="btn small" data-act="repick">Remove them and pick again</button>' : ''}</div></div>`).join('')
    + (note && !e ? `<div class="row note-row"><div>${esc(note.text)}</div></div>` : '');
  host.querySelector('[data-act=repick]')?.addEventListener('click', () => {
    const lost = new Set(result.lost?.[f.id] || []);
    updateParam(dialog.index, 'edges', f.params.edges.filter((_, i) => !lost.has(i)));
    renderDialog();
    toast('Missing edges removed. Click the edges you want in the viewport.');
  });
  vp.showEdges(LOSTCHAINS(), null);
  vp.setNoteBodies?.(note?.bodies || []);
}
function printerMenu(anchor) {
  const r = anchor.getBoundingClientRect(), mine = customPrinters();
  showMenu(r.left, r.bottom, [
    ...Object.keys(PRINTERS).map((n) => ({ label: n, check: n === bedName, run: () => setBed(n, PRINTERS[n]) })),
    ...(mine.length ? [{ sep: true }, { head: 'MY PRINTERS' }, ...mine.map((x) => ({ label: `${x.name} (${x.size.join('×')})`, check: x.name === bedName, run: () => setBed(x.name, x.size) }))] : []),
    { sep: true },
    { label: 'Add a printer…', run: () => customPrinterDialog() },
    ...mine.map((x) => ({ label: `Remove "${x.name}"`, run: () => { saveCustomPrinters(customPrinters().filter((y) => y.name !== x.name)); if (bedName === x.name) setBed(Object.keys(PRINTERS)[0], Object.values(PRINTERS)[0]); toast(`Removed ${x.name}.`); } })),
  ]);
}
/** A printer of your own: a name, and the size of its build volume in millimetres. */
function customPrinterDialog() {
  const m = modal(`<div class="modal-title">Add a printer</div>
    <form class="modal-body sv-form" autocomplete="off">
      <label class="sv-row"><span>Name</span><input name="pname" maxlength="40" placeholder="e.g. Workshop Ender" aria-label="Printer name"></label>
      <div class="sv-row"><span>Build volume (mm)</span><div class="pr-size"><input name="x" type="number" min="1" step="any" value="200" aria-label="X"><input name="y" type="number" min="1" step="any" value="200" aria-label="Y"><input name="z" type="number" min="1" step="any" value="200" aria-label="Z"></div></div>
      <div class="note err-note" id="pr-err" role="alert"></div>
      <div class="modal-foot flush"><button type="submit" class="btn primary">Add</button><button type="button" class="btn" id="pr-cancel">Cancel</button></div>
    </form>`);
  const form = m.el.querySelector('form'), err = m.el.querySelector('#pr-err');
  m.el.querySelector('#pr-cancel').onclick = () => m.close();
  setTimeout(() => form.pname.focus(), 80);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = form.pname.value.trim().replace(/\s+/g, ' '), size = [form.x.value, form.y.value, form.z.value].map(Number);
    if (!name) { err.textContent = 'Give the printer a name.'; form.pname.focus(); return; }
    if (PRINTERS[name]) { err.textContent = 'That name is already one of the listed printers.'; return; }
    if (!size.every((v) => v > 0 && v <= 100000)) { err.textContent = 'Enter the three sizes in millimetres.'; return; }
    saveCustomPrinters([...customPrinters().filter((x) => x.name !== name), { name, size }]);
    m.close(); setBed(name, size);
  };
}
function setBed(name, size) { bedName = name; try { localStorage.setItem('sketchy.bed', name); } catch { /* storage unavailable */ } vp.opts.bedSize = size; vp.opts.bed = true; vp.buildBed(); vp.refreshMaterials(); renderRibbon(); toast(`Build volume: ${name}`); }
function closeDialog(ok, force = false) {
  if (!dialog) return;
  if (kernelBusy()) { kernelIdle().then(() => closeDialog(ok, force)); return; } // the error check below needs the result of the last change
  if (ok && !force && result.errors[doc.features[dialog.index].id]) { // keep a feature that has an error? ask in-app
    confirmBox({ title: 'This feature has an error', message: `${result.errors[doc.features[dialog.index].id]}\n\nKeep it anyway?`, ok: 'Keep it' }).then((keep) => { if (keep && dialog) closeDialog(true, true); });
    return;
  }
  const { pre } = dialog;
  vp.hideGizmo(); vp.setNoteBodies([]);
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
  vp.hideGizmo(); vp.setNoteBodies([]);
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
  apPanel?.close();
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
  resolvedMap[nf.id] = resolveSketch(nf, paramScope).params;
  refresh(); SU?.redraw(); renderSketchPanel(); drawSketches();
}
function setSketchShapes(shapes, push = true) {
  const f = curSketch();
  const nf = { ...f, params: { ...f.params, shapes } };
  doc.features[sketch.index] = nf;
  resolvedMap[nf.id] = resolveSketch(nf, paramScope).params;
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
  sketch.tool = t; sketch.mir = null; sketch.trimPrev = null; sketch.extPrev = null; sketch.brkPrev = null; sketch.cham = null; sketch.conPicks = null; sketch.pts = null; sketch.tan = null; sketch.sel = t === 'select' ? sketch.sel : -1; sketch.hover = -1;
  SU.activate();
  const hints = { mirror: 'Mirror: click the shapes to copy (click again to unselect), press Enter, then click a line to mirror across, or press X / Y for a sketch axis', trim: 'Trim: hover a curve to see the part that will be removed (red), then click it', spline: 'Spline: click points the curve passes through · click the first point to close · Enter or double-click to finish', project: 'Include: click a model edge to copy it onto this sketch · Shift-click copies every edge of that body', offset: 'Offset: click a closed shape, type a distance (negative = inward), press Enter', sfillet: 'Fillet: click a corner of a rectangle or path, type a radius, press Enter', dim: 'Click a shape, then type a value or an expression like width/2', con_coin: 'Coincident: click the point to move, then the point to meet', con_h: 'Horizontal: click a line segment', con_v: 'Vertical: click a line segment', con_conc: 'Concentric: click two shapes', con_equal: 'Equal: click two segments or two circles', con_par: 'Parallel: click the segment to adjust, then the reference', con_perp: 'Perpendicular: click the segment to adjust, then the reference', con_coll: 'Collinear: click the segment to move, then the one to line up with', con_mid: 'Midpoint: click the point to move, then the segment', con_tan: 'Tangent: click a line or circle to adjust, then the circle, arc or line to touch', con_sym: 'Symmetry: click the point to move, the point to mirror, then the line to mirror across', con_fix: 'Fix: click a shape or a corner to lock it; click it again to unlock', select: 'Click a shape to select it · drag to move · drag handles to resize · click a dimension to type a value', arc: 'Click the start point, the end point, then a point on the arc · type a radius', extend: 'Extend: hover near the end of an open line or arc to see where it will grow to (green), then click', break: 'Break: hover a curve to see where it will split (red squares), then click', schamfer: 'Chamfer: click a corner of a rectangle or path, type a distance (D2 for a different second side), press Enter', rect3: 'Click two corners of one side, then a point for the other side', circle2: 'Click two points on opposite sides of the circle · type a diameter', circle3: 'Click three points on the circle', arcc: 'Click the centre, the start of the arc, then the end', tarc: 'Click the end of an open line or arc, then the end of the new arc', slotO: 'Click one end, then the other end · type the overall length and width', slotM: 'Click the centre of the slot, then the centre of one end · type a length and width', point: 'Click to place a point', rect: 'Click the first corner, then the opposite corner · type a width/height and press Tab / Enter', crect: 'Click the centre, then a corner · type a width/height', rrect: 'Click two corners · type W, H and a corner radius R', slot: 'Click the first centre, then the second · type a length and width', ellipse: 'Click the centre, then drag the radii · type A and B', circle: 'Click the centre, then drag out the radius · type a diameter and press Enter', ngon: 'Click the centre, then a vertex · type a radius and press Enter', path: 'Click points of an open path · press A for a tangent arc · Enter or double-click to finish', line: 'Click points · press A for a tangent arc · type a length and angle · click the first point, press Enter or double-click to close' };
  $('#hud').innerHTML = `<b>Sketch · ${curSketch().name}</b> — ${hints[t]} · Esc to ${t === 'select' ? 'deselect' : 'stop drawing'}`;
  drawSketches();
  renderRibbon(); renderSketchPanel();
}
/** A small status line: how many of the sketch's sizes and directions are locked, with the unlocked ones in the tooltip. */
function sketchStateChip(shapes, cons) {
  const d = definedState(shapes, cons);
  if (d.state === 'empty') return '';
  const label = { defined: 'Fully defined', partial: 'Partly defined', free: 'Not defined yet' }[d.state];
  const tip = d.state === 'defined' ? 'Every size and direction is locked by a dimension expression or a constraint.' : `Not locked yet: ${d.free.slice(0, 12).join(', ')}${d.free.length > 12 ? '…' : ''}. Lock a size by typing a parameter in its dimension, or add a constraint. The sketch's position is not counted.`;
  return `<div class="sk-state sk-${d.state}" title="${esc(tip)}"><span class="dot"></span>${label} <small>${d.locked} of ${d.total} locked</small></div>`;
}
function renderSketchPanel() {
  if (!sketch || sketch.picking) return;
  const p = curSketch().params;
  const wrap = $('#props-wrap');
  const sh = p.shapes;
  const fieldsFor = (s) => ({ rect: ['x', 'y', 'w', 'h'], circle: ['cx', 'cy', 'r'], ngon: ['cx', 'cy', 'r', 'n', 'rot'], rrect: ['x', 'y', 'w', 'h', 'r'], slot: ['x1', 'y1', 'x2', 'y2', 'w'], ellipse: ['cx', 'cy', 'rx', 'ry'], point: ['x', 'y'], path: [] }[s.t]);
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('sketch', 20)}SKETCH PALETTE</div><div class="body">
    <div class="mh strong mb4">Options</div>
    <div class="row"><label>Sketch plane</label><select id="sp-plane">${[...['XY', 'XZ', 'YZ'].map((k) => [k, k]), ...doc.features.filter((q, qi) => q.type === 'plane' && qi < sketch.index).map((q) => ['ref:' + q.id, q.name]), ...(p.plane === 'custom' && !p.planeRef ? [['custom', 'custom']] : [])].map(([k, l]) => `<option value="${esc(k)}" ${(k === p.plane && !p.planeRef) || k === 'ref:' + p.planeRef ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="row"><label>Plane offset</label><input id="sp-off" type="text" inputmode="decimal" value="${dispStr(p.offset)}"></div>
    <div class="row"><label>Snap (${getUnits()})</label><select id="sp-snap">${['auto', ...UNIT_TABLE[getUnits()].steps.slice(2, 9)].map((v) => { const mmv = v === 'auto' ? 'auto' : v * lenF(); const sel = v === 'auto' ? sketch.snap === 'auto' : typeof sketch.snap === 'number' && Math.abs(sketch.snap - mmv) < 1e-9; return `<option value="${mmv}" ${sel ? 'selected' : ''}>${v}</option>`; }).join('')}</select></div>
    <div class="row"><label>Polygon sides</label><input id="sp-sides" type="number" min="3" max="64" value="${sketch.sides}"></div>
    <label class="chk"><input type="checkbox" id="sp-grid" ${sketch.grid?.visible === false ? '' : 'checked'}> Sketch Grid</label>
    <label class="chk"><input type="checkbox" id="sp-showprof" ${sketch.showProfile === false ? '' : 'checked'}> Show Profile</label>
    <label class="chk"><input type="checkbox" id="sp-snapon" ${sketch.snapOn === false ? '' : 'checked'}> Snap</label>
    <div class="row lt-row"><label>Line type</label><div class="seg" id="sp-lt" role="group" aria-label="Line type">${[['', 'Normal'], ['construction', 'Construction'], ['centerline', 'Centerline']].map(([v, l]) => `<button type="button" class="btn sm${(sketch.sel >= 0 ? (sh[sketch.sel]?.lt || '') : (sketch.lineType || '')) === v ? ' on' : ''}" data-lt="${v}">${l}</button>`).join('')}</div></div>
    <label class="chk"><input type="checkbox" id="sp-slice" ${sketch.slice ? 'checked' : ''}> Slice</label>
    <label class="chk"><input type="checkbox" id="sp-showdim" ${sketch.showDims === false ? '' : 'checked'}> Show Dimensions</label>
    <label class="chk"><input type="checkbox" id="sp-showcons" ${sketch.showCons === false ? '' : 'checked'}> Show Constraints</label>
    <label class="chk"><input type="checkbox" id="sp-showconstr" ${sketch.showConstr === false ? '' : 'checked'}> Show Construction Geometries</label>
    <label class="chk"><input type="checkbox" id="sp-showpts" ${sketch.showPoints === false ? '' : 'checked'}> Show Points</label>
    <div class="my6"><button class="btn" id="sp-lookat">Look At</button></div>
    <div class="sep"></div>${(p.cons || []).length ? `<div class="mh strong mb4">Constraints (${p.cons.length})</div><div id="sp-cons"></div><div class="sep"></div>` : ''}<div class="mh strong mb4">Shapes (${sh.length})</div>${sketchStateChip(sh, p.cons)}<div id="sp-list"></div>
    <div class="note">Nested shapes become holes. To sketch on a body, start a new sketch and click one of its flat faces.</div></div>
    <div class="foot"><button class="btn" id="sp-cancel">Cancel</button><button class="btn primary" id="sp-ok">Finish Sketch</button></div></div>`;
  const consHost = $('#sp-cons');
  if (consHost) (p.cons || []).forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'shape-item';
    row.innerHTML = `<b class="con-glyph">${CON_GLYPH[c.t]}</b><span>${CON_LABEL[c.t]}</span><button class="x" title="Delete">✕</button>`;
    row.querySelector('.x').onclick = () => setSketchCons(p.cons.filter((_, k) => k !== i));
    consHost.appendChild(row);
  });
  const list = $('#sp-list');
  sh.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'shape-item' + (i === sketch.sel ? ' sel' : '');
    item.innerHTML = `${ficon({ rect: 'rect', circle: 'circle', ngon: 'ngon', rrect: 'rrect', slot: 'slot', ellipse: 'ellipse', point: 'point', path: s.open ? 'path' : 'line' }[s.t], 18)}<span>${s.open ? 'Path' : { rect: 'Rectangle', circle: 'Circle', ngon: 'Polygon', rrect: 'Rounded Rect', slot: 'Slot', ellipse: 'Ellipse', point: 'Point', path: 'Polyline' }[s.t]} ${i + 1}${s.lt ? ` <small class="muted">(${s.lt})</small>` : ''}</span><button class="x" title="Delete">✕</button>`;
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
    if (v.startsWith('ref:')) { const g = resolvedMap[v.slice(4)]; if (!g) return; setSketchParam({ planeRef: v.slice(4), faceRef: undefined, plane: 'custom', origin: g.origin, normal: g.normal, xdir: g.xdir }); }
    else setSketchParam({ plane: v, planeRef: undefined, faceRef: undefined, origin: undefined, normal: undefined, xdir: undefined });
    vp.lookAtPlane(curSketch().params); renderSketchPanel();
  };
  $('#sp-off').oninput = (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setSketchParam({ offset: v * lenF() }); };
  $('#sp-snap').onchange = (e) => { sketch.snap = e.target.value === 'auto' ? 'auto' : +e.target.value; sketch.gridStep = null; };
  $('#sp-sides').oninput = (e) => { sketch.sides = Math.max(3, Math.min(64, Math.round(+e.target.value) || 6)); };
  $('#sp-grid').onchange = (e) => { sketch.gridVisible = e.target.checked; if (sketch.grid) sketch.grid.visible = e.target.checked; };
  $('#sp-showprof').onchange = (e) => { sketch.showProfile = e.target.checked; updateProfileView(); };
  $('#sp-snapon').onchange = (e) => { sketch.snapOn = e.target.checked; };
  $('#sp-lt').querySelectorAll('button').forEach((b) => (b.onclick = () => { // the line type of the selected shape; with nothing selected, of the shapes drawn next
    const lt = b.dataset.lt || null;
    if (sketch.sel >= 0 && sh[sketch.sel]) setSketchShapes(sh.map((o, j) => { if (j !== sketch.sel) return o; const n = { ...o }; if (lt) n.lt = lt; else delete n.lt; return n; }));
    else sketch.lineType = lt;
    renderSketchPanel(); drawSketches(); SU.redraw();
  }));
  $('#sp-slice').onchange = (e) => { sketch.slice = e.target.checked; drawSketches(); };
  $('#sp-showdim').onchange = (e) => { sketch.showDims = e.target.checked; };
  $('#sp-showcons').onchange = (e) => { sketch.showCons = e.target.checked; };
  $('#sp-showconstr').onchange = (e) => { sketch.showConstr = e.target.checked; drawSketches(); };
  $('#sp-showpts').onchange = (e) => { sketch.showPoints = e.target.checked; drawSketches(); };
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
  const cons = (curSketch().params.cons || []).filter((c) => c.a?.s !== si && c.b?.s !== si && c.c?.s !== si).map((c) => {
    const sh = (r) => (r && r.s > si ? { ...r, s: r.s + delta } : r);
    return { ...c, a: sh(c.a), ...(c.b ? { b: sh(c.b) } : {}), ...(c.c ? { c: sh(c.c) } : {}) };
  });
  if (cons.length !== (curSketch().params.cons || []).length || delta) setSketchCons(cons);
}
// ---- project / include: copy model edges onto the sketch plane
/**
 * What the model offers to snap to while sketching: the edges of bodies that lie in the sketch plane (the outline of the face being
 * drawn on, the holes in it, arcs). Corners, the middle of each side, the centre of a circle or arc and its quadrant points are
 * points; the edges themselves are lines to snap onto. Kept until the result, the plane or the hidden bodies change.
 */
let refMemo = { result: null, key: '', val: { points: [], lines: [] } };
function sketchReference() {
  if (!sketch) return refMemo.val;
  const fr = planeFrame(resolvedMap[curSketch().id] || curSketch().params);
  const key = JSON.stringify([fr.o, fr.x, fr.y]) + '|' + [...hiddenBodies].sort().join('|');
  if (refMemo.result === result && refMemo.key === key) return refMemo.val;
  const points = [], lines = [], seen = new Set(), tol = 0.02;
  const add = (p, kind) => { const k = kind + p[0].toFixed(3) + ',' + p[1].toFixed(3); if (!seen.has(k)) { seen.add(k); points.push({ p, kind }); } };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const { chain } of edgeEntries()) {
    const P = chain.pts;
    if (!P || P.length < 2) continue;
    const uv = [];
    let flat = true;
    for (const q of P) { const d = [q[0] - fr.o[0], q[1] - fr.o[1], q[2] - fr.o[2]]; if (Math.abs(dot3(d, fr.n)) > tol) { flat = false; break; } uv.push([dot3(d, fr.x), dot3(d, fr.y)]); }
    if (!flat) continue;
    lines.push({ uv, closed: !!chain.closed });
    const n = uv.length, first = uv[0], last = uv[n - 1];
    // a circle (closed) or an arc (open): the centre and, for a full circle, the four quadrant points
    const fit = (a, b, c) => { // circumcentre of three points, or null when they are in a line
      const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      if (Math.abs(d) < 1e-9) return null;
      const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
      const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
      return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
    };
    const cf = n >= 5 ? fit(first, uv[n >> 1], uv[Math.floor(n * 0.75)] || last) : null;
    const round = cf && cf.r > 1e-6 && uv.every((q) => Math.abs(Math.hypot(q[0] - cf.c[0], q[1] - cf.c[1]) - cf.r) < 0.01 * cf.r + 1e-3);
    if (round) {
      add(cf.c, 'Center');
      if (chain.closed) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) add([cf.c[0] + dx * cf.r, cf.c[1] + dy * cf.r], 'Quadrant');
    }
    if (!chain.closed) {
      add(first, 'Endpoint'); add(last, 'Endpoint');
      let total = 0; const cum = [0];
      for (let i = 1; i < n; i++) { total += Math.hypot(uv[i][0] - uv[i - 1][0], uv[i][1] - uv[i - 1][1]); cum.push(total); }
      let k = 1; while (k < n - 1 && cum[k] < total / 2) k++;
      const t = cum[k] > cum[k - 1] ? (total / 2 - cum[k - 1]) / (cum[k] - cum[k - 1]) : 0;
      add([uv[k - 1][0] + (uv[k][0] - uv[k - 1][0]) * t, uv[k - 1][1] + (uv[k][1] - uv[k - 1][1]) * t], 'Midpoint');
    } else if (!round) add(first, 'Endpoint');
  }
  refMemo = { result, key, val: { points, lines } };
  return refMemo.val;
}
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
const dashed = (m, dash, gap) => { m.dashed = true; m.dashSize = dash; m.gapSize = gap; m.needsUpdate = true; return m; };
const constrMat = dashed(fatMat(0x8a94a6, 2.2), 3, 2);    // construction geometry: reference only
const centerMat = dashed(fatMat(0xb06ad4, 2.4), 8, 2.5); // a centerline: the axis of a revolve
function drawSketches() {
  if (!vp) return;
  vp.sketchGroup.clear();
  if (sketch && !sketch.picking && sketch.slice) { const fr = planeFrame(resolvedMap[curSketch().id] || curSketch().params); vp.setSlice(fr); } else vp.setSlice(null); // Slice: cut the bodies at the sketch plane so the inside shows
  doc.features.forEach((f, i) => {
    if (f.type === 'sketch3d' && !f.suppressed && (i < limit() || (dialog && dialog.index === i)) && (sketchVis[f.id] ?? !result.sketchUsed.has(f.id) ?? true)) { // a 3D sketch: a line through points in space
      const raw = (resolvedMap[f.id] || f.params).points || [];
      let pts = raw.map((q) => new THREE.Vector3(+q[0] || 0, +q[1] || 0, +q[2] || 0));
      if (pts.length >= 2) {
        const path = f.params.smooth && !f.params.closed ? smoothPath(pts.map((q) => q.toArray()), 3).map((q) => new THREE.Vector3(...q)) : pts;
        vp.sketchGroup.add(vp.fatLine(path, dialog && dialog.index === i ? sketchMatActive : sketchMat, !!f.params.closed && pts.length > 2));
      }
      if (pts.length) { const g = new THREE.BufferGeometry().setFromPoints(pts); const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x1d63b8, size: 7, sizeAttenuation: false, depthTest: false })); dots.renderOrder = 5; vp.sketchGroup.add(dots); }
      return;
    }
    if (f.type !== 'sketch' || f.suppressed) return;
    const active = sketch && sketch.index === i;
    if (!active && (i >= limit() || !(sketchVis[f.id] ?? !result.sketchUsed.has(f.id)))) return;
    const rp = resolvedMap[f.id] || f.params;
    rp.shapes.forEach((s, k) => {
      if (s.t === 'point') { // a sketch point: a dot
        if (active && sketch.showPoints === false) return;
        const q = vp.planeTo3D(rp, [s.x, s.y]).addScaledVector(new THREE.Vector3(...planeFrame(rp).n), 0.06);
        const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([q]), new THREE.PointsMaterial({ color: active && k === sketch.sel ? 0xf08c00 : 0x2b6cb0, size: active && k === sketch.sel ? 9 : 7, sizeAttenuation: false, depthTest: false }));
        dot.renderOrder = 20; dot.raycast = () => {}; vp.sketchGroup.add(dot);
        return;
      }
      if (s.lt === 'construction' && !active) return; // construction geometry is reference only: shown while editing the sketch
      if (s.lt && active && sketch.showConstr === false) return;
      const poly = shapeToPolygon(s);
      if (poly.length < 2) return;
      const nrm = planeFrame(rp).n; // lift the lines a hair off the plane so a face lying in it can't break them up
      const pts = poly.map((q) => vp.planeTo3D(rp, q).addScaledVector(new THREE.Vector3(...nrm), 0.06));
      const m = s.lt ? (k === sketch?.sel && active ? sketchMatSel : s.lt === 'centerline' ? centerMat : constrMat) : active ? (k === sketch.sel ? sketchMatSel : k === sketch.hover ? sketchMatHover : sketchMatActive) : sketchMat;
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
    if (!list.length) host.insertAdjacentHTML('beforeend', '<div class="hint span-all">No parameters yet.</div>');
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
    const sn = vp.snapAt(e, edgeEntries());
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
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('joint', 20)}DRIVE JOINTS</div><div class="body">${joints.map(([f, i]) => { const [lo, hi, st, u] = rng(f); return `<div class="stat"><span>${esc(f.name)} (${f.params.jtype})</span><b id="dj-v${i}">${+f.params.value.toFixed(2)}${u}</b></div><input type="range" data-i="${i}" min="${lo}" max="${hi}" step="${st}" value="${f.params.value}" class="w100">`; }).join('')}</div><div class="foot"><button class="btn primary" id="i-close">Done</button></div></div>`;
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
/** The stored appearance of a face (doc.faceAppearance), matched by body and plane. */
const faceEntryIdx = (f) => (doc.faceAppearance || []).findIndex((e) => e.body === f.id && (f.curved ? e.curved && Math.hypot(e.point[0] - f.point[0], e.point[1] - f.point[1], e.point[2] - f.point[2]) < 0.05 : !e.curved) && e.normal[0] * f.normal[0] + e.normal[1] * f.normal[1] + e.normal[2] * f.normal[2] > 0.999 && Math.abs((e.point[0] - f.point[0]) * f.normal[0] + (e.point[1] - f.point[1]) * f.normal[1] + (e.point[2] - f.point[2]) * f.normal[2]) < 0.05);
const texPreview = (t) => { try { const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d'); const big = document.createElement('canvas'); big.width = big.height = 256; t.draw(big.getContext('2d'), 256); x.fillStyle = x.createPattern(big, 'repeat'); x.scale(48 / 128, 48 / 128); x.fillRect(0, 0, 128, 128); return c.toDataURL(); } catch { return ''; } };
function setFaceAppearance(face, val) {
  const any = !!(val.material || val.color || val.texture);
  mutate(() => {
    const list = (doc.faceAppearance || []).map((x) => ({ ...x })), i = faceEntryIdx(face);
    if (!any) { if (i >= 0) list.splice(i, 1); } else { const ent = { body: face.id, point: [...face.point], normal: [...face.normal], ...(face.curved ? { curved: true } : {}), ...val }; if (i >= 0) list[i] = ent; else list.push(ent); }
    doc.faceAppearance = list;
  });
}
function setBodyAppearance(ids, val) {
  const any = !!(val.material || val.color || val.texture);
  mutate(() => { const ap = { ...(doc.appearance || {}) }; for (const id of ids) { if (any) ap[id] = val; else delete ap[id]; } doc.appearance = ap; });
}
const endPaint = () => { paintMode = null; vp.showFaces([], null); renderStatus(); };
/** One click while an appearance is being painted on: the face (or body) under the cursor takes it. */
function paintClick(e) {
  if (paintMode.target === 'faces') {
    const tg = vp.pickFace(e);
    if (!tg?.face) return;
    setFaceAppearance({ id: tg.id, point: tg.point, normal: tg.normal, ...(tg.curved ? { curved: true } : {}) }, paintMode.val);
  } else {
    const hit = vp.pickBody(e);
    if (hit) setBodyAppearance([hit.id], paintMode.val);
  }
}
let apPanel = null; // the open Appearance panel: { el, close, sync, spec }
/** The looks being dragged from the Appearance panel (kept here because dragover cannot read dataTransfer values). */
let apDrag = null;
const AP_MIME = 'application/x-sketchy-appearance';
/** What a drop (or click) at a point applies it to: faces or bodies, whichever the panel is set to. */
function appearanceTargetsAt(e) {
  if (apPanel?.target() === 'faces') { const tg = vp.pickFace(e); return tg?.face ? { face: { id: tg.id, point: tg.point, normal: tg.normal, ...(tg.curved ? { curved: true } : {}) }, tg } : null; }
  const hit = vp.pickBody(e);
  return hit ? { bodies: [hit.id] } : null;
}
function applyLook(t, val) { if (t?.face) setFaceAppearance(t.face, val); else if (t?.bodies) setBodyAppearance(t.bodies, val); }
/**
 * Appearance, as a panel that stays open while you work (like Fusion's): choose a material, a custom colour and/or a texture,
 * set Apply to Bodies or Faces, then drag a swatch onto a face, a body or a body in the Browser, or press Apply to
 * change what is selected. Closing it with the X (or Esc) leaves the changes in place.
 */
function openAppearance() {
  if (apPanel) { apPanel.sync(); return; }
  if (dialog || sketch) return toast('Finish the open tool first.', true);
  const selBodies = () => (vp.selected.size ? [...vp.selected] : []);
  const first = selFace ? { face: selFace } : selBodies().length ? { bodies: selBodies() } : result.bodies.length === 1 ? { bodies: [result.bodies[0].id] } : {};
  const fi = first.face ? faceEntryIdx(first.face) : -1;
  const cur = appearanceOf(first.face ? (fi >= 0 ? doc.faceAppearance[fi] : {}) : first.bodies ? (doc.appearance || {})[first.bodies[0]] : {});
  let material = cur.material || '', customOn = !!cur.color, color = cur.color || '#c3c7cd', texture = cur.texture || '', target = first.face ? 'faces' : 'bodies';
  const texMm = cur.texSize || (textureById(texture)?.size ?? 20);
  const swatch = (m) => `background:radial-gradient(circle at 32% 28%, #fff 0, ${m.color} 32%, #000 140%);${m.opacity < 1 ? 'opacity:.7' : ''}`;
  const groups = ['Printing', 'Metal', 'Other'];
  const el = document.createElement('div');
  el.id = 'ap-panel'; el.className = 'props';
  el.innerHTML = `<div class="title"><span>APPEARANCE</span><span class="grow"></span><button type="button" class="tmin" id="ap-x" aria-label="Close Appearance" title="Close">×</button></div>
    <div class="body ap">
      <div class="ap-apply" role="radiogroup" aria-label="Apply to"><span>Apply to</span><button type="button" class="btn sm" role="radio" data-ap="bodies">Bodies</button><button type="button" class="btn sm" role="radio" data-ap="faces">Faces</button></div>
      <p class="rp-lead" id="ap-lead"></p>
      <div class="ap-hint">Drag a swatch onto a face, a body, or a body in the Browser.</div>
      <div role="radiogroup" aria-label="Material" class="ap-mats">
        <button type="button" draggable="true" class="ap-mat" role="radio" data-m=""><i class="sw-default"></i><span>Default</span></button>
        ${groups.map((g) => `<div class="ap-gh">${g}</div>` + MATERIALS.filter((m) => m.group === g).map((m) => `<button type="button" draggable="true" class="ap-mat" role="radio" data-m="${m.id}"><i data-mid="${m.id}"></i><span>${esc(m.name)}</span><small>${m.density} g/cm³</small></button>`).join('')).join('')}
      </div>
      <label class="ex-chk"><input type="checkbox" name="custom" ${customOn ? 'checked' : ''}><span>Custom colour</span><input type="color" name="color" value="${color}" aria-label="Colour"></label>
      <div class="ap-gh">Texture</div>
      <div role="radiogroup" aria-label="Texture" class="ap-texs">
        <button type="button" draggable="true" class="ap-tex" role="radio" data-t=""><i class="sw-default"></i><span>None</span></button>
        ${TEXTURES.map((t) => `<button type="button" draggable="true" class="ap-tex" role="radio" data-t="${t.id}"><i data-tid="${t.id}"></i><span>${esc(t.name)}</span></button>`).join('')}
      </div>
      <label class="sv-row ap-size"><span>Texture size (${getUnits()})</span><input name="tsize" type="number" min="0.1" step="any" value="${+(texMm / lenF()).toPrecision(4)}" aria-label="Width of one texture tile"></label>
    </div>
    <div class="foot"><button type="button" class="btn" id="ap-pick" title="Then click faces or bodies in the model; Esc finishes">Click to apply</button><button type="button" class="btn primary" id="ap-go">Apply</button></div>`;
  $('#viewport').appendChild(el);
  const $$ = (q) => el.querySelector(q), form = { color: $$('[name=color]'), custom: $$('[name=custom]'), tsize: $$('[name=tsize]') };
  const mats = [...el.querySelectorAll('.ap-mat')], texs = [...el.querySelectorAll('.ap-tex')];
  el.querySelectorAll('[data-mid]').forEach((i) => { const m = MATERIALS.find((x) => x.id === i.dataset.mid); if (m) i.style.cssText = swatch(m); });
  el.querySelectorAll('[data-tid]').forEach((i) => { const t = textureById(i.dataset.tid); if (t) i.style.cssText = `background:url(${texPreview(t)}) center/cover`; });
  /** The look as it is set now, optionally with one swatch swapped in (what dragging that swatch carries). */
  const spec = (over = {}) => {
    const m = 'm' in over ? over.m : material, t = 't' in over ? over.t : texture;
    const size = Math.max(0.1, +form.tsize.value || 0) * lenF();
    return { ...(m ? { material: m } : {}), ...(form.custom.checked ? { color: form.color.value } : {}), ...(t ? { texture: t, texSize: +(('t' in over ? (textureById(t)?.size ?? size) : size)).toPrecision(5) } : {}) };
  };
  const selSummary = () => {
    if (target === 'faces') return selFace ? `${selFace.curved ? 'A curved face' : 'A face'} of <b>${esc(result.bodies.find((b) => b.id === selFace.id)?.name || '')}</b> is selected` : 'No face selected';
    const ids = selBodies().length ? selBodies() : selFace ? [selFace.id] : [];
    return ids.length ? (ids.length === 1 ? `<b>${esc(result.bodies.find((b) => b.id === ids[0])?.name || '')}</b> is selected` : `<b>${ids.length} bodies</b> are selected`) : 'No body selected';
  };
  const sync = () => {
    $$('#ap-lead').innerHTML = selSummary();
    el.querySelectorAll('.ap-apply [data-ap]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ap === target)));
    mats.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.m === material)));
    texs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === texture)));
  };
  const pick = (id) => { material = id; sync(); };
  const pickTex = (id) => { texture = id; const t = textureById(id); if (t) form.tsize.value = +(t.size / lenF()).toPrecision(4); sync(); };
  const beginDrag = (e, val) => { apDrag = val; e.dataTransfer.setData(AP_MIME, JSON.stringify(val)); e.dataTransfer.setData('text/plain', 'Sketchy appearance'); e.dataTransfer.effectAllowed = 'copy'; };
  const endDrag = () => { apDrag = null; clearDropHover(); };
  mats.forEach((b) => { b.onclick = () => pick(b.dataset.m); b.ondragstart = (e) => beginDrag(e, spec({ m: b.dataset.m })); b.ondragend = endDrag; });
  texs.forEach((b) => { b.onclick = () => pickTex(b.dataset.t); b.ondragstart = (e) => beginDrag(e, spec({ t: b.dataset.t })); b.ondragend = endDrag; });
  el.querySelectorAll('.ap-apply [data-ap]').forEach((b) => (b.onclick = () => { target = b.dataset.ap; sync(); }));
  form.color.oninput = () => { form.custom.checked = true; };
  const close = () => { el.remove(); apPanel = null; if (paintMode) endPaint(); clearDropHover(); };
  $$('#ap-x').onclick = close;
  $$('#ap-go').onclick = () => {
    const val = spec(), any = !!(val.material || val.color || val.texture);
    if (target === 'faces' && selFace) { setFaceAppearance(selFace, val); toast(any ? 'Appearance applied to the face' : 'Face appearance reset'); }
    else if (target === 'bodies' && (selBodies().length || selFace)) { const ids = selBodies().length ? selBodies() : [selFace.id]; setBodyAppearance(ids, val); toast(any ? `Appearance applied to ${ids.length} ${ids.length > 1 ? 'bodies' : 'body'}` : 'Appearance reset'); }
    else toast(`Select ${target === 'faces' ? 'a face' : 'a body'} first, drag a swatch onto it, or use Click to apply.`, true);
  };
  $$('#ap-pick').onclick = () => { paintMode = { get val() { return spec(); }, get target() { return target; } }; selFace = null; vp.showFaces([], null); vp.selected.clear(); vp.refreshMaterials(); renderRibbon(); renderStatus(); toast(`Click ${target === 'faces' ? 'faces' : 'bodies'} to apply it. Esc to finish.`); };
  apPanel = { el, close, sync, spec, target: () => target };
  sync();
}
/** Dragging a swatch over the model or the Browser: show what would change. */
function clearDropHover() { vp.showFaces(shownFaces(), null); if (vp.hover) { vp.hover = null; vp.refreshMaterials(); } document.querySelectorAll('.tree-row.drop').forEach((r) => r.classList.remove('drop')); }
function bindAppearanceDrop() {
  const cv = $('#gl'), has = (e) => [...(e.dataTransfer?.types || [])].includes(AP_MIME);
  let raf = false;
  cv.addEventListener('dragover', (e) => {
    if (!has(e) || !apPanel) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    if (raf) return; raf = true;
    requestAnimationFrame(() => { raf = false; const t = appearanceTargetsAt(e); if (t?.face) { vp.showFaces(shownFaces(), t.tg); if (vp.hover) { vp.hover = null; vp.refreshMaterials(); } } else { vp.showFaces(shownFaces(), null); const h = t?.bodies?.[0] || null; if (h !== vp.hover) { vp.hover = h; vp.refreshMaterials(); } } });
  });
  cv.addEventListener('dragleave', () => { if (apPanel) clearDropHover(); });
  cv.addEventListener('drop', (e) => {
    if (!has(e) || !apPanel) return;
    e.preventDefault();
    let val; try { val = JSON.parse(e.dataTransfer.getData(AP_MIME)); } catch { val = apDrag; }
    const t = appearanceTargetsAt(e);
    clearDropHover();
    if (!t || !val) return toast(`Drop it on ${apPanel.target() === 'faces' ? 'a face' : 'a body'}. Change Apply to in the panel to switch.`, true);
    applyLook(t, val);
  });
}
/** Render view on or off (image-based lighting, soft shadows, tone mapping). */
function toggleRender() {
  vp.setRender(!vp.opts.render); renderRibbon();
  toast(vp.opts.render ? 'Render view on: shadows, reflections and no grid. Use Save Image to export it.' : 'Render view off');
}
/** Save the current view as a PNG at a chosen size, optionally with the render look and a transparent background. */
function saveImageDialog() {
  const rect = $('#gl').getBoundingClientRect();
  const sizes = [[Math.round(rect.width), Math.round(rect.height), 'Same size as the view'], [1280, 720, '1280 × 720'], [1920, 1080, '1920 × 1080 (full HD)'], [3840, 2160, '3840 × 2160 (4K)'], [2048, 2048, '2048 × 2048 (square)']];
  const nm = (doc.name === 'Untitled' ? 'design' : doc.name) + verSuffix();
  const md = modal(`<div class="modal-title">Save image</div>
    <form class="modal-body ex">
      <label>File name<input id="si-name" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(nm)}"></label>
      <label>Size<select name="size">${sizes.map(([w, h, l], i) => `<option value="${i}">${esc(l)}</option>`).join('')}</select></label>
      <label>Background<select name="bg"><option value="transparent">Transparent</option><option value="#ffffff">White</option><option value="#eef1f4">Light grey</option><option value="#16181c">Dark</option></select></label>
      <label class="ex-chk"><input type="checkbox" name="render" ${vp.opts.render ? 'checked' : 'checked'}><span>Render look (shadows and reflections)</span></label>
      <div class="note err-note" id="si-err" role="alert"></div>
      <div class="modal-foot flush"><button type="button" class="btn" id="si-c">Cancel</button><button type="submit" class="btn primary">Save PNG</button></div>
    </form>`);
  const form = md.el.querySelector('form');
  md.el.querySelector('#si-c').onclick = () => md.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = fileSafeName(md.el.querySelector('#si-name').value);
    if (!name) { md.el.querySelector('#si-err').textContent = 'Enter a file name.'; return; }
    const [w, h] = sizes[+form.size.value], wasRender = vp.opts.render, wantRender = form.render.checked;
    md.close();
    if (wantRender !== wasRender) vp.setRender(wantRender);
    try {
      const url = vp.snapshot({ width: w, height: h, background: form.bg.value === 'transparent' ? null : form.bg.value });
      fetch(url).then((r) => r.blob()).then((blob) => { download(blob, `${name}.png`); toast(`Saved ${name}.png (${w} × ${h})`); });
    } catch (x) { toast('Could not save the image: ' + x.message, true); }
    if (wantRender !== wasRender) vp.setRender(wasRender);
  };
  setTimeout(() => md.el.querySelector('#si-name').select(), 0);
}
/** The button that closes whatever panel is open on the right (Cancel, Done or Close), so every panel can be dismissed with the x or Esc. */
const PANEL_CLOSE = '#d-cancel, #sp-cancel, #i-close, #pc-close, #m-done';
const panelCloseButton = () => ($('#props-wrap').classList.contains('open') ? $('#props-wrap').querySelector(PANEL_CLOSE) : null);
new MutationObserver(() => {
  const t = $('#props-wrap .props .title');
  if (!t || t.querySelector('.tclose') || !t.closest('#props-wrap').querySelector(PANEL_CLOSE)) return;
  const b = document.createElement('button');
  b.className = 'tclose'; b.type = 'button'; b.title = 'Close (Esc)'; b.setAttribute('aria-label', 'Close'); b.textContent = '×';
  b.onclick = () => $('#props-wrap').querySelector(PANEL_CLOSE)?.click();
  t.appendChild(b);
}).observe($('#props-wrap'), { childList: true, subtree: true });
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
      <input id="sa-sl" type="range" min="${lo}" max="${hi}" step="${Math.max((hi - lo) / 400, 0.01)}" value="${st.offset}" class="w100">
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
/** Settings for a sketch pattern, with a live preview in the sketch. Resolves { kind, ... } in millimetres, or null if cancelled. */
function askPattern(kind, { count = 1, centre = [0, 0], preview = () => {} } = {}) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; preview(null); resolve(v); } };
    const u = getUnits(), f = lenF(), d = (v) => +(v / f).toFixed(4);
    const rect = kind === 'rect';
    const num = (name, label, val, extra = '') => `<label>${label}<input name="${name}" type="number" step="any" value="${val}" inputmode="decimal" ${extra}></label>`;
    const m = modal(`<div class="modal-title">${rect ? 'Rectangular pattern' : 'Circular pattern'}</div>
      <form class="modal-body pt">
        <p class="rp-lead">Repeats ${count} selected shape${count > 1 ? 's' : ''}. The copies are plain shapes: they don't follow later changes to the originals.</p>
        ${rect
          ? `<div class="pt-grid">${num('nx', 'Count along X', 3, 'min="1" max="200" step="1"')}${num('dx', `Spacing X (${u})`, d(20))}${num('ny', 'Count along Y', 2, 'min="1" max="200" step="1"')}${num('dy', `Spacing Y (${u})`, d(20))}</div>`
          : `<div class="pt-grid">${num('n', 'Count (with the original)', 6, 'min="2" max="500" step="1"')}${num('angle', 'Total angle (°)', 360)}${num('cx', `Centre X (${u})`, d(centre[0]))}${num('cy', `Centre Y (${u})`, d(centre[1]))}</div>
             <label class="ex-chk"><input type="checkbox" name="turn" checked><span>Turn each copy with the pattern</span></label>`}
        <div class="note err-note" id="pt-err" role="alert"></div>
        <div class="modal-foot flush"><button type="button" class="btn" id="pt-c">Cancel</button><button type="submit" class="btn primary">Add copies</button></div>
      </form>`, () => finish(null));
    const form = m.el.querySelector('form'), err = m.el.querySelector('#pt-err');
    const read = () => rect
      ? { kind: 'rect', nx: Math.max(1, Math.round(+form.nx.value) || 1), ny: Math.max(1, Math.round(+form.ny.value) || 1), dx: (+form.dx.value || 0) * f, dy: (+form.dy.value || 0) * f }
      : { kind: 'circ', n: Math.max(2, Math.round(+form.n.value) || 2), angle: +form.angle.value || 360, cx: (+form.cx.value || 0) * f, cy: (+form.cy.value || 0) * f, turn: form.turn.checked };
    form.oninput = () => { const o = read(); err.textContent = ''; preview(o.kind === 'rect' && o.nx * o.ny * count > 2000 ? null : o); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const o = read();
      if (o.kind === 'rect' && (o.nx * o.ny - 1) * count > 2000) { err.textContent = 'That is too many copies (the limit is 2000).'; return; }
      if (o.kind === 'rect' && o.nx === 1 && o.ny === 1) { err.textContent = 'Use a count above 1 in at least one direction.'; return; }
      finish(o); m.close();
    };
    m.el.querySelector('#pt-c').onclick = () => m.close();
    form.oninput();
    setTimeout(() => form.elements[0].focus(), 0);
  });
}
function showTextDialog() {
  if (dialog) return;
  const m = modal(`<div class="modal-title">Text</div><div class="modal-body"><label>Text<textarea id="tx-s" rows="2" class="font-inherit">Sketchy</textarea></label><label>Height (${getUnits()})<input id="tx-h" type="number" value="${+(10 / lenF()).toFixed(3)}" step="any"></label><label class="row-label"><input id="tx-b" type="checkbox"> Bold</label></div><div class="foot foot-end"><button class="btn" id="tx-c">Cancel</button><button class="btn primary" id="tx-ok">Insert</button></div>`);
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
      <div class="stat"><span>Mass (${esc(materialNameOf((doc.appearance || {})[b.id]))}, solid)</span><b>${(vol * densityOf((doc.appearance || {})[b.id])).toFixed(1)} g</b></div>
      <div class="stat"><span>Fits ${esc(bedName.split(' (')[0])}</span><b class="${fits ? 'ok' : 'warn'}">${fits ? 'Yes' : 'No — too large'}</b></div>`;
  }).join('');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('properties', 20)}PROPERTIES</div><div class="body">${bodies.length ? `<div class="stat"><span>Bodies</span><b>${bodies.length}</b></div>` + rows : 'No bodies to inspect.'}</div><div class="foot"><button class="btn primary" id="i-close">Close</button></div></div>`;
  wrap.classList.add('open');
  $('#i-close').onclick = () => { wrap.classList.remove('open'); };
}


// ------------------------------------------------------------------ print check
const checkGroup = new THREE.Group();
let pcancel = null;
const pcOpts = { angle: 45, minWall: 1.2, custom: false };
let pcReopen = false;
function clearCheck() { pcancel && (pcancel.stop = true); checkGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); checkGroup.clear(); }
function closePrintCheck() { clearCheck(); $('#props-wrap').classList.remove('open'); }

// ---- beginner help: print setup, the welcome card and the guided first model (src/beginner.js)
const BG = createBeginner({
  $, esc, modal, toast, doc: () => doc, snapshot: () => snapshot(), pushUndo: (s) => pushUndo(s), refresh: () => refresh(),
  designProfile: () => designProfile(doc),
  printers: () => [...Object.entries(PRINTERS).map(([name, size]) => ({ name, size })), ...customPrinters()],
  bedName: () => bedName, setPrinter: (name) => { const size = printerSize(name); if (size) setBed(name, size); }, addPrinter: () => customPrinterDialog(),
  isEmpty: () => !doc.features.length, state: () => ({ sketch: !!sketch, dialog: !!dialog }),
  tourState: () => {
    const sks = doc.features.filter((f) => f.type === 'sketch');
    return { sketch: !!sketch, picking: !!sketch?.picking, shapes: sketch && !sketch.picking ? (curSketch()?.params.shapes || []).length : 0, hasSketch: sks.length > 0, hasShapes: sks.some((f) => (f.params.shapes || []).length > 0), has: (t) => doc.features.some((f) => f.type === t && !result.errors[f.id]), dialog: !!dialog, exported: BG.exported() };
  },
  nameNow: () => nameNow(),
  canConnect: () => !!(acct.server && acct.user), connectAssistant: () => connectAssistant(),
  run: (id) => runCommand(id), renderRibbon: () => renderRibbon(), afterSetup: () => { renderRibbon(); },
});
/** The AI assistants page of the Account window: the server address, the connected assistants and a step-by-step guide for each assistant. */
function connectAssistant() {
  if (!acct.server || !acct.user) return toast('Sign in to a Sketchy server to connect an assistant.', true);
  if (!acct.mcp) return toast('The administrator has turned assistant access off on this server.', true);
  showAccount('ai');
}
/** Turn the bodies so they lie the way that needs the least support: one Move feature each. */
function layFlat(bodies, rot) {
  pushUndo(snapshot());
  for (const b of bodies) {
    const pl = placement(b, rot);
    doc.features.splice(doc.marker, 0, { id: 'f' + doc.nextId++, type: 'move', name: uniqueName('Lay flat'), params: { body: b.id, t: pl.t, r: pl.r, s: [1, 1, 1], copy: false, mode: 'free', from: [0, 0, 0], to: [0, 0, 0] } });
    doc.marker++;
  }
  pcReopen = true; refresh();
}
function showPrintCheck() {
  if (dialog || sketch) return;
  if (kernelBusy()) return toast('Still rebuilding the design. Try again in a moment.', true);
  if (!checkGroup.parent) vp.scene.add(checkGroup);
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id));
  const wrap = $('#props-wrap');
  const [bx, by, bz] = vp.opts.bedSize, u = getUnits(), prof = designProfile(doc), bedShort = bedName.split(' (')[0];
  if (!pcOpts.custom) pcOpts.minWall = minWallFor(prof);
  const fit = bedFit(bodies, vp.opts.bedSize);
  const vol = bodies.reduce((a, b) => a + b.volume, 0), area = bodies.reduce((a, b) => a + (b.area || 0), 0), wt = weightEstimate(vol, area, prof);
  const matName = materialNameOf({ material: prof.material });
  wrap.innerHTML = `<div class="props" id="pc-root"><div class="title">${ficon('properties', 20)}PRINT CHECK</div><div class="body">
    <div id="pc-verdict" class="pc-verdict"></div>
    <div id="pc-list"></div>
    <div class="sep"></div>
    <div class="stat"><span>Printer</span><b>${esc(bedShort)} · ${bx} × ${by} × ${bz}</b></div>
    <div class="stat"><span>Nozzle · layer · fit gap</span><b>${prof.nozzle} · ${prof.layer} · ${prof.tol} mm</b></div>
    ${bodies.length ? `<div class="stat"><span>Rough weight (${esc(matName)})</span><b>${wt.typical.toFixed(0)} g</b></div><div class="hint-sm">About ${wt.filamentM.toFixed(1)} m of filament with a typical 15% infill. Solid it would be ${wt.solid.toFixed(0)} g. A guess, not a slice.</div>` : ''}
    <button class="btn" id="pc-setup" type="button">Print setup…</button>
    <details class="pc-more"><summary>Settings for this check</summary>
      <label class="pc-row"><span>Overhang limit</span><input id="pc-angle" type="number" min="1" max="89" value="${pcOpts.angle}"><span>°</span></label>
      <div class="hint-sm" id="pc-over"></div>
      <label class="pc-row"><span>Minimum wall (${u})</span><input id="pc-wall" type="number" min="0.1" step="0.1" value="${dispStr(pcOpts.minWall)}"></label>
      <div class="hint-sm">Three times the nozzle size by default.</div>
    </details>
  </div><div class="foot"><button class="btn" id="pc-run" ${bodies.length ? '' : 'disabled'}>Check again</button><button class="btn primary" id="pc-close">Close</button></div></div>`;
  wrap.classList.add('open');
  $('#pc-close').onclick = closePrintCheck;
  $('#pc-setup').onclick = () => BG.printSetup();
  let over = overhangs(bodies, pcOpts.angle), turn = null, wall = null, progress = null;
  const render = () => {
    const list = findings({ fit, over, wall, turn, profile: prof, bedName: bedShort, count: bodies.length, fmtLen: (v) => `${dispStr(v, 2)} ${u}` });
    const v = verdict(list);
    $('#pc-verdict').className = `pc-verdict ${v}`;
    $('#pc-verdict').textContent = !bodies.length ? 'Nothing to check yet' : v === 'ok' ? 'Ready to print' : v === 'warn' ? 'Printable, with a few things to know' : 'Needs changes before you print';
    $('#pc-list').innerHTML = list.map((f, i) => `<div class="pc-item ${f.level}"><div class="pc-dot" aria-hidden="true">${f.level === 'ok' ? '✓' : f.level === 'warn' ? '!' : '×'}</div><div><b>${esc(f.title)}</b><div>${esc(f.detail)}</div>${f.fix ? `<button class="btn" data-fix="${i}" type="button">${esc(f.fix.label)}</button>` : ''}</div></div>`).join('')
      + (progress !== null ? `<div class="pc-item wait"><div class="pc-dot" aria-hidden="true">…</div><div><b>Checking wall thickness</b><div>${Math.round(progress * 100)}%</div></div></div>` : '');
    $('#pc-list').querySelectorAll('[data-fix]').forEach((btn) => (btn.onclick = () => {
      const fix = list[+btn.dataset.fix].fix;
      if (fix.id === 'lay-flat') layFlat(bodies, turn.best.r);
      else if (fix.id === 'scale') { closePrintCheck(); runCommand('scale'); }
    }));
  };
  const drawOver = () => {
    clearCheck();
    const a = Math.min(89, Math.max(1, +$('#pc-angle').value || 45)); pcOpts.angle = a;
    over = overhangs(bodies, a);
    turn = over.fraction > 0.15 && bodies.length ? orientations(bodies, a) : null;
    if (over.soup.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(over.soup, 3));
      const col = new Float32Array(over.grade.length * 9);
      over.grade.forEach((k, i) => { for (let v = 0; v < 3; v++) col.set([1, 0.75 - 0.6 * k, 0.1], i * 9 + v * 3); });
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      checkGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide })));
    }
    $('#pc-over').textContent = over.area ? `${(over.fraction * 100).toFixed(1)}% of the surface overhangs (${fmtArea(over.area)}), steepest ${over.worst.toFixed(0)}°. Shown in orange and red; flat on the plate is ignored.` : 'No overhangs past this angle.';
    render();
  };
  drawOver();
  $('#pc-angle').onchange = drawOver;
  $('#pc-wall').onchange = () => { pcOpts.custom = true; };
  $('#pc-run').onclick = async () => {
    const typed = +$('#pc-wall').value;
    if (pcOpts.custom && typed > 0) pcOpts.minWall = Math.max(0.05, typed * lenF());
    drawOver();
    const btn = $('#pc-run'); btn.disabled = true;
    pcancel = { stop: false }; progress = 0; render();
    const r = await wallThickness(bodies, { minWall: pcOpts.minWall, cancel: pcancel, onProgress: (p) => { progress = p; if ($('#pc-list')) render(); } });
    progress = null; if ($('#pc-run')) $('#pc-run').disabled = false;
    if (!r) return;
    wall = r;
    if (r.thin.length) {
      const pos = new Float32Array(r.thin.length * 3); r.thin.forEach((s2, i) => pos.set(s2.p, i * 3));
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      checkGroup.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xe0453a, size: 7, sizeAttenuation: false, depthTest: false })));
    }
    if ($('#pc-list')) render();
  };
  if (bodies.length) $('#pc-run').click(); // the wall check runs on its own: a beginner should not have to know to ask for it
}

// ------------------------------------------------------------------ files
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const EXPORT_FORMATS = [
  ['3mf', '3MF', 'Recommended for 3D printing. Keeps units and colours, and opens in every slicer. Can carry the editable design inside, so one file is all you need to keep.'],
  ['stl', 'STL', 'Works everywhere, but has no units or colours.'],
  ['obj', 'OBJ', ''],
  ['glb', 'glTF (binary)', 'For 3D viewers, web pages, game engines and Blender. Keeps colours; sizes are in metres, with Y up.'],
  ['step', 'STEP', 'For other CAD programs. Flat faces are exact; curved surfaces are written as small flat facets.'],
  ['sketchy', 'Sketchy project', 'The whole design with its feature timeline. Reopens fully editable in Sketchy.'],
];
function exportFormats() { return [...EXPORT_FORMATS, ...(addins ? addins.exporters().map((e) => [e.value, e.label, e.description, e.extension]) : [])]; }
async function exportViaAddin(fmt, name, selectedOnly) {
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!selectedOnly || vp.selected.has(b.id)));
  if (!bodies.length) return toast('Nothing to export.', true);
  try {
    const out = await addins.runExporter(fmt, { name, units: getUnits(), parameters: (doc.params || []).map((p) => ({ name: p.name, expr: p.expr })), bodies: bodies.map((b) => ({ id: b.id, name: b.name, color: look((doc.appearance || {})[b.id]).color, verts: b.verts, tris: b.tris })) });
    const ext = (out.name.match(/\.[A-Za-z0-9]+$/) || [''])[0];
    download(new Blob([out.text !== undefined ? out.text : out.bytes], { type: out.mime || 'application/octet-stream' }), `${name}${ext}`);
    toast(`Exported "${name}${ext}"`);
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
}
function exportFile(fmt, name, selectedOnly, split = false, embed = false) {
  if (fmt.startsWith('addin:')) return exportViaAddin(fmt, name, selectedOnly);
  if (fmt === 'sketchy') { download(new Blob([projectJSON(name)], { type: 'application/json' }), `${name}.sketchy.json`); toast(`Exported "${name}" as a Sketchy project`); return; }
  const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!selectedOnly || vp.selected.has(b.id))).map((b) => ({ ...b, color: look((doc.appearance || {})[b.id]).color }));
  if (!bodies.length) return toast('Nothing to export.', true);
  const w = { stl: writeSTL, '3mf': write3MF, obj: writeOBJ, step: writeSTEP, glb: writeGLB }[fmt];
  if (split && bodies.length > 1) { // one file per body: "Name_v3_Lid.stl", numbered if two bodies share a name
    const used = new Map();
    bodies.forEach((b, i) => {
      const base = fileSafeName(b.name) || `body${i + 1}`, k = (used.get(base) || 0) + 1; used.set(base, k);
      const file = `${name}_${k > 1 ? base + '_' + k : base}`;
      setTimeout(() => download(w([b], file), `${file}.${fmt}`), i * 300); // browsers handle a short queue of downloads better than a burst
    });
    toast(`Exporting ${bodies.length} ${fmt.toUpperCase()} files, one per body`);
    return;
  }
  const withDesign = fmt === '3mf' && embed && !selectedOnly;
  download(withDesign ? write3MF(bodies, name, projectJSON(name)) : w(bodies, name), `${name}.${fmt}`);
  toast(`Exported ${bodies.length} body${bodies.length > 1 ? 's' : ''} as ${fmt.toUpperCase()}${withDesign ? ', with the editable design inside' : ''}`);
}
/** "_v3" for a saved design, so an exported file says which version it came from. */
const verSuffix = () => (doc.rev ? `_v${doc.rev}` : '');
/** Every edge of the mesh is shared by exactly two triangles: the body is a closed solid. */
function isWatertight(b) {
  const edges = new Map(), t = b.tris;
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const a = t[i + k], c = t[i + (k + 1) % 3], key = a < c ? a * 4294967296 + c : c * 4294967296 + a; edges.set(key, (edges.get(key) || 0) + 1); }
  for (const n of edges.values()) if (n !== 2) return false;
  return true;
}
function exportDialog() {
  if (dialog || sketch) return;
  BG.noteExport();
  if (kernelBusy()) return toast('Still rebuilding the design. Try again in a moment.', true);
  let last = '3mf'; try { last = localStorage.getItem('sketchy.exportFormat') || '3mf'; } catch { /* storage unavailable */ }
  if (!exportFormats().some((f) => f[0] === last)) last = '3mf';
  const hasSel = vp.selected.size > 0;
  /** The design's name, then the body's name when only one body of several is exported, then the version: "Bracket_Lid_v3". */
  const nameFor = (selectedOnly, split = false) => {
    const ids = [...vp.selected], one = !split && selectedOnly && ids.length === 1 && result.bodies.length > 1 ? result.bodies.find((b) => b.id === ids[0]) : null;
    return (doc.name === 'Untitled' ? 'design' : doc.name) + (one ? '_' + one.name : '') + verSuffix();
  };
  const nm = nameFor(hasSel);
  const m = modal(`<div class="modal-title">Export</div>
    <form class="modal-body ex">
      <label>File name<input id="ex-name" maxlength="80" autocomplete="off" spellcheck="false" value="${esc(nm)}"></label>
      <label>Format<select id="ex-fmt" name="fmt">${exportFormats().map(([v, l, , ext]) => `<option value="${v}" ${v === last ? 'selected' : ''}>${esc(l)} (${v === 'sketchy' ? '.sketchy.json' : '.' + (ext || v)})</option>`).join('')}</select></label>
      <div class="ex-desc" id="ex-desc" aria-live="polite" hidden></div>
      <div class="ex-check" id="ex-check" aria-live="polite" hidden></div>
      <label class="ex-chk" id="ex-scope"><input type="checkbox" id="ex-sel" ${hasSel ? 'checked' : 'disabled'}><span>Selected bodies only${hasSel ? '' : ' <small>(select bodies first)</small>'}</span></label>
      <label class="ex-chk" id="ex-embedrow"><input type="checkbox" id="ex-embed" checked><span>Include the editable design <small>(reopen this file in Sketchy to keep editing)</small></span></label>
      <label class="ex-chk" id="ex-splitrow"><input type="checkbox" id="ex-split"><span>Each body as its own file <small id="ex-splitn"></small></span></label>
      <div class="note err-note" id="ex-err" role="alert"></div>
      <div class="modal-foot flush"><button type="button" class="btn" id="ex-c">Cancel</button><button type="submit" class="btn primary">Export</button></div>
    </form>`);
  const form = m.el.querySelector('form'), fmtSel = m.el.querySelector('#ex-fmt');
  const sync = () => {
    const f = fmtSel.value, proj = f === 'sketchy';
    const d = (exportFormats().find((x) => x[0] === f) || [])[2] || '', de = m.el.querySelector('#ex-desc');
    de.textContent = d; de.hidden = !d;
    m.el.querySelector('#ex-sel').disabled = proj || !hasSel; m.el.querySelector('#ex-scope').style.opacity = proj || !hasSel ? '.55' : '';
    syncEmbed();
    runChecks();
  };
  const syncEmbed = () => { // the design rides along only in a 3MF of the whole design
    const row = m.el.querySelector('#ex-embedrow'), box = m.el.querySelector('#ex-embed'), is3 = fmtSel.value === '3mf';
    const off = m.el.querySelector('#ex-sel').checked || m.el.querySelector('#ex-split').checked;
    row.hidden = !is3; box.disabled = off; row.style.opacity = off ? '.55' : '';
  };
  let checkRun = 0, cancelCheck = { stop: false };
  const runChecks = async () => {
    const host = m.el.querySelector('#ex-check'), proj = ['sketchy', 'step', 'glb'].includes(fmtSel.value) || fmtSel.value.startsWith('addin:');
    cancelCheck.stop = true; const mine = ++checkRun; cancelCheck = { stop: false };
    host.hidden = proj;
    if (proj) return;
    const sel = m.el.querySelector('#ex-sel').checked;
    const bodies = result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!sel || vp.selected.has(b.id)));
    if (!bodies.length) { host.innerHTML = '<div class="ex-row bad">Nothing to export. Show or select a body first.</div>'; return; }
    const rows = [];
    const open = bodies.filter((b) => !isWatertight(b));
    rows.push(open.length ? ['warn', `Not watertight: ${open.map((b) => esc(b.name)).join(', ')}. Slicers may refuse it. Use MESH, Clean Mesh to repair.`] : ['ok', 'Watertight: every body is a closed solid']);
    const fit = bedFit(bodies, vp.opts.bedSize);
    rows.push(fit.fitsAll ? ['ok', `Fits the ${esc(bedName.split(' (')[0])} bed`] : fit.tooBig.length ? ['warn', `Too large for the bed: ${fit.tooBig.map((t) => esc(t.name)).join(', ')}`] : ['warn', `Needs ${fit.plates} plates for the ${esc(bedName.split(' (')[0])} bed`]);
    const o = overhangs(bodies, pcOpts.angle);
    rows.push(o.fraction > 0.15 ? ['warn', `${(o.fraction * 100).toFixed(0)}% of the surface overhangs more than ${pcOpts.angle}°, so it needs supports`] : ['ok', 'Few overhangs']);
    const draw = (wall) => { if (mine === checkRun) host.innerHTML = [...rows, wall].map(([k, t]) => `<div class="ex-row ${k}">${k === 'ok' ? '✓' : k === 'warn' ? '!' : '…'} ${t}</div>`).join('') + '<div class="ex-foot">You can still export. <button type="button" class="linkbtn" id="ex-open-check">Open the full print check</button></div>'; host.querySelector('#ex-open-check')?.addEventListener('click', () => { m.close(); showPrintCheck(); }); };
    draw(['wait', 'Checking wall thickness…']);
    const w = await wallThickness(bodies, { minWall: pcOpts.minWall, maxSamples: 500, cancel: cancelCheck });
    if (!w || mine !== checkRun) return;
    draw(w.thin.length ? ['warn', `Thin walls: the thinnest is ${dispStr(w.min, 2)} ${getUnits()} (${w.thin.length} thin spots)`] : ['ok', `Walls are at least ${dispStr(pcOpts.minWall, 1)} ${getUnits()} thick`]);
  };
  m.el.querySelector('.modal-x, .close')?.addEventListener('click', () => { cancelCheck.stop = true; });
  const nameBox = m.el.querySelector('#ex-name'); let typed = false; // keep the suggested name in step with the options until the person types their own
  nameBox.addEventListener('input', () => { typed = true; });
  const splitBox = m.el.querySelector('#ex-split');
  const inScope = () => result.bodies.filter((b) => !hiddenBodies.has(b.id) && (!(m.el.querySelector('#ex-sel').checked && fmtSel.value !== 'sketchy') || vp.selected.has(b.id)));
  const syncSplit = () => { // only meaningful when more than one body would be exported
    syncEmbed();
    const k = inScope().length, off = fmtSel.value === 'sketchy' || fmtSel.value.startsWith('addin:') || k < 2;
    splitBox.disabled = off; if (off) splitBox.checked = false;
    m.el.querySelector('#ex-splitrow').style.opacity = off ? '.55' : '';
    m.el.querySelector('#ex-splitn').textContent = off ? '' : `(${k} files)`;
  };
  const suggest = () => { syncSplit(); if (!typed) nameBox.value = nameFor(m.el.querySelector('#ex-sel').checked && fmtSel.value !== 'sketchy', splitBox.checked); };
  splitBox.onchange = suggest;
  fmtSel.onchange = () => { sync(); suggest(); }; m.el.querySelector('#ex-sel').onchange = () => { runChecks(); suggest(); }; sync(); syncSplit();
  m.el.querySelector('#ex-c').onclick = () => m.close();
  setTimeout(() => { const n = m.el.querySelector('#ex-name'); n.focus(); n.select(); }, 0);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = fileSafeName(m.el.querySelector('#ex-name').value);
    if (!name) { m.el.querySelector('#ex-err').textContent = 'Enter a file name.'; return; }
    const fmt = fmtSel.value;
    try { localStorage.setItem('sketchy.exportFormat', fmt); } catch { /* storage unavailable */ }
    m.close();
    exportFile(fmt, name, m.el.querySelector('#ex-sel').checked && fmt !== 'sketchy', m.el.querySelector('#ex-split').checked && fmt !== 'sketchy', m.el.querySelector('#ex-embed').checked);
  };
}
/** Add one imported piece as a body: try it as it is, and repair it (weld, flip, fill holes) if that doesn't make a solid. */
/** Open a design from a file: a Sketchy project (.sketchy.json) or a 3MF that carries its design inside. */
async function openDesignFile(f) {
  try {
    let txt;
    if (/\.3mf$/i.test(f.name)) {
      txt = await readEmbeddedDesign(await f.arrayBuffer());
      if (!txt) throw new Error('This 3MF has no Sketchy design inside, so it cannot be edited. Use Insert Model to bring its shapes into a design.');
    } else txt = await f.text();
    if (!newTab({ reuseBlank: true })) return;
    loadProject(txt); renderDocTabs();
  } catch (x) { toast(x.message, true); }
}
/** Rebuild the design now, and wait for it (the page rebuilds in place; a big design rebuilds in the worker). */
async function rebuildNow() { refreshNow(); if (kernelHeavy && canWorker) await kernelIdle(); }
async function importPart(part) {
  let soup = part.soup;
  const attempt = async (data) => {
    const pre = snapshot();
    const f = { id: 'f' + doc.nextId++, type: 'import', name: part.name, params: { data: encodeFloats(data), tris: data.length / 9 } };
    doc.features.splice(doc.marker, 0, f); doc.marker++;
    pushUndo(pre);
    await rebuildNow();
    if (result.errors[f.id]) { restore(pre); undoStack.pop(); return { err: result.errors[f.id] }; }
    if (part.color) doc.appearance = { ...(doc.appearance || {}), [f.id]: part.color };
    return { id: f.id };
  };
  let r = await attempt(soup), note = '';
  if (r.err) {
    const fixed = repairSoup(soup);
    r = await attempt(fixed.soup);
    if (r.err) return { err: `${r.err}. Mesh repair could not make it a closed solid (${fixed.report.skippedHoles} unfillable holes)` };
    soup = fixed.soup; note = describeRepair(fixed.report);
  }
  return { tris: soup.length / 9, note, id: r.id };
}
/**
 * Mesh repair dialog: shows what is wrong with a mesh and lets you choose how hard to repair it (weld distance, which holes to
 * fill, stray pieces to drop) before it becomes a body. Resolves the repaired triangle soup, or null if cancelled.
 */
function repairDialog(part, why = '') {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const raw = repairSoup(part.soup, { fillHoles: false }).report;
    const m = modal(`<div class="modal-title">Repair mesh</div>
      <form class="modal-body rp">
        <p class="rp-lead">${why ? `<b>${esc(part.name)}</b> isn't a closed solid yet (${esc(why)}).` : `Choose how to repair <b>${esc(part.name)}</b>.`}</p>
        <dl class="rp-dl"><dt>Triangles</dt><dd>${raw.triangles.toLocaleString()}</dd><dt>Separate pieces</dt><dd>${raw.shells.toLocaleString()}</dd><dt>Open edges</dt><dd>${raw.openEdges.toLocaleString()}</dd><dt>Degenerate or duplicate</dt><dd>${(raw.degenerate + raw.duplicates).toLocaleString()}</dd><dt>Shared by 3+ faces</dt><dd>${raw.nonManifold.toLocaleString()}</dd></dl>
        <label>Join vertices closer than<span class="rp-row"><input name="tol" type="number" min="0" step="any" value="0" inputmode="decimal"><span>mm (0 = automatic)</span></span></label>
        <label class="ex-chk"><input type="checkbox" name="fill" checked><span>Fill holes</span></label>
        <label>Only holes with a rim shorter than<span class="rp-row"><input name="maxhole" type="number" min="0" step="any" value="0" inputmode="decimal"><span>mm (0 = any size)</span></span></label>
        <label>Remove pieces smaller than<span class="rp-row"><input name="shell" type="number" min="0" max="100" step="any" value="0" inputmode="decimal"><span>% of the largest piece (0 = keep all)</span></span></label>
        <div class="rp-result" id="rp-res" aria-live="polite"></div>
        <div class="modal-foot flush"><button type="button" class="btn" id="rp-c">Cancel</button><button type="submit" class="btn primary">Import repaired mesh</button></div>
      </form>`, () => finish(null));
    const form = m.el.querySelector('form'), res = m.el.querySelector('#rp-res');
    let last = null;
    const run = () => {
      const o = { tolerance: +form.tol.value || 0, fillHoles: form.fill.checked, maxHolePerimeter: +form.maxhole.value || 0, minShell: +form.shell.value || 0 };
      last = repairSoup(part.soup, o);
      const r = last.report;
      res.innerHTML = `<b>Result:</b> ${(last.soup.length / 9).toLocaleString()} triangles, ${r.holes} hole${r.holes === 1 ? '' : 's'} filled${r.skippedHoles ? `, <span class="warn">${r.skippedHoles} left open</span>` : ''}${r.removedShells ? `, ${r.removedShells} piece${r.removedShells > 1 ? 's' : ''} removed` : ''}${r.flipped ? `, ${r.flipped} faces turned` : ''}${r.openEdges && !o.fillHoles ? `, <span class="warn">${r.openEdges} open edges</span>` : ''}.`;
    };
    form.oninput = run; run();
    m.el.querySelector('#rp-c').onclick = () => m.close();
    form.onsubmit = (e) => { e.preventDefault(); finish(last.soup); m.close(); };
    setTimeout(() => form.tol.focus(), 0);
  });
}
// ---- importing big models: say what is happening, offer to cancel, and offer to reduce a very dense mesh
const IMPORT_WARN = 300000; // triangles: above this a model makes editing noticeably slower
const IMPORT_TARGET = 250000;
const tick = () => new Promise((r) => setTimeout(r, 30)); // let the page paint between steps
function importProgress(name) {
  const el = document.createElement('div');
  el.id = 'importbar'; el.setAttribute('role', 'status');
  el.innerHTML = '<span class="spin"></span><span id="imp-text"></span><button type="button" class="btn small" id="imp-cancel">Cancel</button>';
  $('#viewport').appendChild(el);
  const ctl = { cancelled: false, set: (t) => { el.querySelector('#imp-text').textContent = t; }, close: () => el.remove() };
  el.querySelector('#imp-cancel').onclick = () => { ctl.cancelled = true; ctl.set('Cancelling after this step…'); };
  ctl.set(`Reading ${name}…`);
  return ctl;
}
/** A very dense model: import as it is, or import and add a Reduce step that brings it near IMPORT_TARGET triangles. */
function askLargeImport(name, tris) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const keep = Math.max(1, Math.min(99, Math.round((IMPORT_TARGET / tris) * 100)));
    const m = modal(`<div class="modal-title">Large model</div>
      <div class="modal-body"><p class="p0"><b>${esc(name)}</b> has ${tris.toLocaleString()} triangles. Editing and rebuilding get slower the denser a model is, and most designs do not need more than about ${IMPORT_TARGET.toLocaleString()}.</p>
      <p class="p0">Importing with a <b>Reduce</b> step keeps about ${keep}% of the triangles. It is a step in the timeline, so you can change the amount or turn it off later.</p>
      <div class="modal-foot flush stack"><button type="button" class="btn primary" id="li-reduce">Import and reduce to ~${keep}%</button><button type="button" class="btn" id="li-asis">Import as it is</button><button type="button" class="btn" id="li-cancel">Cancel</button></div></div>`);
    m.el.querySelector('#li-reduce').onclick = () => { m.close(); finish({ keep }); };
    m.el.querySelector('#li-asis').onclick = () => { m.close(); finish({ keep: 0 }); };
    m.el.querySelector('#li-cancel').onclick = () => { m.close(); finish(null); };
    m.el.querySelector('.modal-x')?.addEventListener('click', () => finish(null));
  });
}
async function importModel(file, { always = false } = {}) {
  const prog = importProgress(file.name);
  try {
    await tick();
    const parts = await readImport(file);
    if (prog.cancelled) return toast('Import cancelled.');
    const big = parts.reduce((a, p) => a + p.soup.length / 9, 0);
    let keep = 0; // percent of triangles a Reduce step keeps after a very dense model (0: import as it is)
    if (big > IMPORT_WARN) {
      prog.set('Waiting for your choice…');
      const choice = await askLargeImport(parts.length > 1 ? `${file.name} (${parts.length} parts)` : parts[0].name, big);
      if (!choice) return toast('Import cancelled.');
      keep = choice.keep;
    }
    let tris = 0, made = 0; const notes = new Set(), errs = [];
    for (const part of parts) {
      if (prog.cancelled) { errs.push(`${part.name}: cancelled`); continue; }
      prog.set(`Checking ${part.name} (${(part.soup.length / 9).toLocaleString()} triangles)…`); await tick();
      let r = always ? { err: '' } : await importPart(part);
      if (r.err !== undefined && (always || r.err)) { // won't make a solid by itself: let the user steer the repair
        const fixed = await repairDialog(part, r.err);
        if (!fixed) { errs.push(`${part.name}: cancelled`); continue; }
        prog.set(`Building ${part.name}…`); await tick();
        r = await importPart({ ...part, soup: fixed });
      }
      if (r.err) errs.push(`${part.name}: ${r.err}`); else {
        made++; tris += r.tris; if (r.note) notes.add(`repaired: ${r.note}`);
        if (keep && r.id && r.tris > IMPORT_TARGET) { // the dense part gets a Reduce step after it
          const pre = snapshot(), n = Math.max(1, Math.min(99, Math.round((IMPORT_TARGET / r.tris) * 100)));
          doc.features.splice(doc.marker, 0, { id: 'f' + doc.nextId++, type: 'mreduce', name: `Reduce ${part.name}`.slice(0, 60), params: { body: r.id, keep: n, tolerance: Math.max(0.05, +(boundsDiag(part.soup) * 0.002).toFixed(3)) } });
          doc.marker++; pushUndo(pre);
          prog.set(`Reducing ${part.name}…`); await tick(); await rebuildNow();
        }
      }
      part.notes?.forEach((n) => notes.add(n));
    }
    vp.fitted = false; refresh();
    if (!made) return toast(`Import failed: ${errs[0]}`, true);
    const what = made > 1 ? `${made} bodies from ${file.name}` : parts[0].name;
    toast(`Imported ${what} (${tris.toLocaleString()} triangles)${notes.size ? ' - ' + [...notes].join('; ') : ''}${errs.length ? `. Skipped: ${errs.join('; ')}` : ''}`, !!errs.length);
  } catch (e) { toast('Import failed: ' + e.message, true); }
  finally { prog.close(); }
}
/** Length of the diagonal of a triangle soup's bounding box. */
function boundsDiag(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) { const v = soup[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
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
const projectJSON = (name = doc.name, withThumb = false) => { const { rev, viewingRev, ...rest } = doc; return JSON.stringify({ format: 'sketchy', version: 1, ...rest, name, ...(withThumb ? { thumb: captureThumb() } : {}) }); };
function loadProject(txt, rev = 0, seq = rev) {
  const d = JSON.parse(txt);
  if (d.format !== 'sketchy') throw new Error('Not a Sketchy project');
  doc = { name: d.name, features: d.features, marker: d.marker, nextId: d.nextId, params: d.params || [], saves: d.saves || 0, appearance: d.appearance || {}, faceAppearance: Array.isArray(d.faceAppearance) ? d.faceAppearance : [], units: UNIT_TABLE[d.units] ? d.units : 'mm', components: d.components || [], bodyComp: d.bodyComp || {}, configs: d.configs || [], activeConfig: d.activeConfig || null, canvases: d.canvases || [], lastEdit: d.lastEdit && typeof d.lastEdit === 'object' ? d.lastEdit : undefined, rev, seq };
  setUnits(doc.units);
  undoStack = []; redoStack = []; vp.selected.clear(); hiddenBodies.clear();
  dirty = false; $('#doc-dirty').classList.remove('on'); $('#doc-name').textContent = doc.name;
  vp.fitted = false; refresh();
}
const safeName = (n) => n.replace(/[^\w .()-]/g, '_').slice(0, 80) || 'Untitled';
const putDesign = (name, ifMatch, folder, auto = false, note = '', milestone = '') => call('PUT', '/projects/' + encodeURIComponent(name), projectJSON(name, true), { 'if-match': String(ifMatch), ...(folder === undefined ? {} : { 'x-folder': encodeURIComponent(folder) }), ...(auto ? { 'x-autosave': '1' } : {}), ...(note ? { 'x-note': encodeURIComponent(note) } : {}), ...(milestone ? { 'x-milestone': encodeURIComponent(milestone) } : {}) });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Ask what to do when the saved design changed elsewhere. Resolves 'overwrite' | 'copy' | 'theirs' | null. */
function conflictDialog(info, name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal(`<div class="modal-title">"${esc(name)}" changed on the server</div><div class="modal-body">
      <p class="p0">It was saved${info.device ? ` from <b>${esc(info.device)}</b>` : ''}${info.modified ? ` ${ago(info.modified)}` : ''} (revision ${info.rev}) after you opened it. Saving now would replace those changes.</p>
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

/** The Save button: asks what changed, then saves a new version with that description (shown in the version history). */
async function saveVersion() {
  const named = acct.server && doc.name !== 'Untitled';
  const m = modal(`<div class="modal-title">Save</div>
    <form class="modal-body sv-form" autocomplete="off">
      ${named ? '' : '<p class="p0">Choose a name next, then this becomes the first version.</p>'}
      <label class="sv-row"><span>Notes</span><input name="note" maxlength="200" value="User saved" aria-label="Notes for this version" spellcheck="true"></label>
      <div class="sv-row"><span>${named && doc.rev ? 'Make a version' : 'Version'}</span><span class="sv-mk">${named && doc.rev ? '<input type="checkbox" name="mk" checked aria-label="Make a version: untick to save without a new version number">' : ''}<input class="sv-ver" value="V${(named ? doc.rev || 0 : 0) + 1}" readonly tabindex="-1" aria-label="The number this version will get"></span></div>
      <div class="modal-foot flush"><button type="submit" class="btn primary">OK</button><button type="button" class="btn" id="sv-cancel">Cancel</button></div>
    </form>`);
  const form = m.el.querySelector('form');
  m.el.querySelector('#sv-cancel').onclick = () => m.close();
  setTimeout(() => { form.note.focus(); form.note.select(); }, 80);
  if (form.mk) form.mk.onchange = () => { form.note.disabled = !form.mk.checked; form.querySelector('.sv-ver').style.visibility = form.mk.checked ? '' : 'hidden'; };
  form.onsubmit = async (e) => { e.preventDefault(); const note = form.note.value.trim(), ver = !form.mk || form.mk.checked; m.close(); await save(false, note, '', ver); };
}
async function save(as, note = '', milestone = '', asVersion = true) {
  let name = doc.name, folder = doc.folder || '';
  if (acct.server && !(await requireLogin())) return;
  if (as || name === 'Untitled' || !doc.rev) asVersion = true; // a first save, or a save under a new name, always starts a version
  for (let i = 0; asBusy && i < 100; i++) await new Promise((r) => setTimeout(r, 50)); // an autosave still in flight would advance the design's revision under us and look like another browser's edit
  if (acct.server && (as || name === 'Untitled')) { // in-app Save dialog: name + folder
    const pick = await saveDialog({ name: name === 'Untitled' ? 'My design' : name, folder, title: as ? 'Save design as' : 'Save design' });
    if (!pick) return;
    name = pick.name; folder = pick.folder;
  } else if (!acct.server && (as || name === 'Untitled')) {
    const n = await askName({ title: 'Save design', label: 'File name', value: name === 'Untitled' ? 'My design' : name, ok: 'Download', hint: 'There is no Sketchy server here, so the design is downloaded as a file.' });
    if (!n) return; name = n;
  }
  if (acct.server) {
    if (asVersion) doc.saves = (doc.saves || 0) + 1;
    const expect = name === doc.name ? doc.seq || 0 : 0; // a new name should not already exist
    let r = await putDesign(name, expect, folder, !asVersion, note, milestone);
    if (r.status === 409) {
      const choice = await conflictDialog(r.data, name);
      if (choice === 'overwrite') r = await putDesign(name, '*', folder, !asVersion, note, milestone);
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
    ownSeq.set(name, r.data.seq); doc.rev = r.data.rev; doc.seq = r.data.seq; doc.conflict = false; delete doc.viewingRev; renderDocTabs(); bannerRev = doc.seq; hideBanner(); doc.folder = folder; rememberLast(name);
    toast(`Saved "${name}"${asVersion ? ` as V${doc.rev}` : ''}${folder ? ` in ${folder}` : ''}`);
    if ($('#data-panel').classList.contains('open')) renderDataPanel();
  } else download(new Blob([projectJSON(name)], { type: 'application/json' }), `${name}.sketchy.json`);
  doc.name = name; $('#doc-name').textContent = name;
  dirty = false; $('#doc-dirty').classList.remove('on');
}

// ---- cross-device: drafts, remote-change banner
let draftT = null, bannerRev = 0, ownSeq = new Map(); // ownSeq: the newest revision this tab wrote itself, per design, so the poll never mistakes it for someone else's
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
    const m = modal(`<div class="modal-title">Resume where you left off?</div><div class="modal-body"><p class="p0">There is an autosaved draft of ${esc(title)} from <b>${esc(d.device || 'another device')}</b>, ${ago(d.modified)}.</p></div>
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
const hideBanner = () => { const b = $('#banner'); if (b) { b.hidden = true; delete b.dataset.view; } };
/** Shown while an older version is open: the way back to the latest one, or to make this one the latest. */
function showViewBanner() {
  const b = $('#banner'), v = doc.viewingRev;
  b.hidden = false; b.dataset.view = '1';
  b.innerHTML = `<span>${uicon('clock', 15, 1.6)} You are viewing <b>V${esc(String(v))}</b> of "${esc(doc.name)}", an older version. Changes here are not saved automatically.</span><button class="btn sm" id="bn-latest">Back to latest</button><button class="btn sm" id="bn-restore">Restore V${esc(String(v))}</button>`;
  $('#bn-latest').onclick = async () => {
    if (dirty && !(await confirmBox({ title: 'Discard your changes?', message: `Go back to the latest version and discard the changes you made to V${v}?`, ok: 'Discard and go back', danger: true }))) return;
    openDesign(doc.name, true);
  };
  $('#bn-restore').onclick = async () => {
    if (!(await confirmBox({ title: `Restore V${v}?`, message: `This adds a new version on top called "Restored from V${v}". The current latest stays in the history, so nothing is lost.`, ok: 'Restore' }))) return;
    const p = await call('PUT', '/projects/' + encodeURIComponent(doc.name), projectJSON(doc.name, true), { 'if-match': String(doc.seq || doc.rev), 'x-note': encodeURIComponent(`Restored from V${v}`) });
    if (!p.ok) return toast(p.status === 409 ? 'The design changed on another device. Go back to the latest version and try again.' : (p.data?.error || 'Restore failed.'), true);
    toast(`Restored V${v} as V${p.data.rev}`); openDesign(doc.name, true);
  };
}
const syncViewBanner = () => { if (doc.viewingRev) showViewBanner(); else if ($('#banner')?.dataset.view) hideBanner(); };
function startRemotePolling() {
  setInterval(async () => {
    if (document.hidden || !acct.user || !doc.rev || doc.name === 'Untitled' || asBusy) return;
    const r = await call('GET', '/projects/' + encodeURIComponent(doc.name) + '/meta');
    if (asBusy || !r.ok) return; // an autosave started while we asked: the answer may already include it
    if (r.data.seq > doc.seq && r.data.seq > (ownSeq.get(doc.name) || 0) && r.data.seq !== bannerRev) { bannerRev = r.data.seq; showBanner(r.data); }
  }, 20000);
  addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('pagehide', () => { if (dirty) { try { localStorage.setItem('sketchy.autosave', projectJSON()); localStorage.setItem('sketchy.autosave.t', String(Date.now())); } catch { /* too large */ } } }); // keep a change made just before closing; the next start restores it
}
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
function switchToState(st) { applyTabState(st); syncViewBanner(); if (doc.name && doc.rev) rememberLast(doc.name); renderDocTabs(); refresh(); } // the design you switch to is the one reopened next time
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
async function askNewDesign(title, okLabel, suggest = '') {
  let last = ''; try { last = localStorage.getItem('sketchy.lastFolder') || ''; } catch { /* storage unavailable */ }
  let name = suggest;
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
/** Ask for the design's name now (the New design window) unless it already has one. Resolves true when the design is named and stored. */
async function nameNow() {
  if (!acct.server || !acct.user || doc.rev) return true;
  if (busy() || namingNow) return false;
  namingNow = true;
  try {
    const pick = await askNewDesign('New design', 'Create');
    return pick ? await createOnServer(pick) : false;
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
const canAutosave = () => !!(acct.server && acct.user && doc.name !== 'Untitled' && doc.rev && !doc.conflict && !doc.viewingRev); // an older version being viewed must never overwrite the latest
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
    ownSeq.set(d.name, r.data.seq); d.rev = r.data.rev; d.seq = r.data.seq; bannerRev = d.seq;
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
    el.querySelector('.doc-name').textContent = tabName(t) + ((t.id === activeTab ? doc.viewingRev : t.state.doc.viewingRev) ? ` (V${t.id === activeTab ? doc.viewingRev : t.state.doc.viewingRev})` : '');
    el.querySelector('.doc-ic').innerHTML = LOGO_MARK;
    el.querySelector('.doc-x').innerHTML = uicon('close', 12, 2);
    el.title = tabName(t);
    el.onclick = (e) => { if (e.target.closest('.doc-x')) closeTab(t.id); else activateTab(t.id); };
    el.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (t.id !== activeTab) activateTab(t.id);
      showMenu(e.clientX, e.clientY, [
        { label: acct.server ? 'Save version…' : 'Save (download)', uicon: 'save', run: () => (acct.server ? saveVersion() : save(false)) },
        ...(acct.server ? [{ label: 'Save without a description', uicon: 'save', hint: 'Ctrl+S', run: () => save(false) }] : []),
        { label: 'Save as…', uicon: 'save', hint: 'Ctrl+Shift+S', run: () => save(true) },
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
/** What one change did, in words, from the design before and after it. */
function stepLabel(before, after) {
  const bf = new Map(before.features.map((f) => [f.id, f])), af = new Map(after.features.map((f) => [f.id, f]));
  const added = after.features.filter((f) => !bf.has(f.id)), gone = before.features.filter((f) => !af.has(f.id));
  const edited = after.features.filter((f) => bf.has(f.id) && bf.get(f.id) !== f && JSON.stringify(bf.get(f.id)) !== JSON.stringify(f));
  const nm = (f) => f.name || defOf(f)?.label || f.type;
  if (added.length === 1 && !gone.length) return `Added ${nm(added[0])}`;
  if (gone.length === 1 && !added.length) return `Deleted ${nm(gone[0])}`;
  if (edited.length === 1 && !added.length && !gone.length) return `Changed ${nm(edited[0])}`;
  if (added.length || gone.length || edited.length) return `${added.length + gone.length + edited.length} features changed`;
  if (JSON.stringify(before.params) !== JSON.stringify(after.params)) return 'Changed parameters';
  if (before.marker !== after.marker) return 'Moved the rollback marker';
  return 'Changed the appearance';
}
/** Every step you can go back to, newest first, so one click returns to how the design was before something went wrong. */
function historyMenu(anchor) {
  if (dialog || sketch || !undoStack.length) return;
  const states = [...undoStack, snapshot()], n = undoStack.length, items = [{ head: 'GO BACK TO BEFORE…' }];
  for (let i = n - 1; i >= 0 && items.length <= 20; i--) items.push({ label: `${stepLabel(states[i], states[i + 1])}${i === n - 1 ? ' (last change)' : ''}`, run: () => undoTo(n - i) });
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, items);
}
function undoTo(count) { if (dialog || sketch) return; for (let i = 0; i < count && undoStack.length; i++) { redoStack.push(snapshot()); restore(undoStack.pop()); } markDirty(); refresh(); toast(count === 1 ? 'Undone.' : `Went back ${count} steps. Redo brings them back.`); }
function undo() { if (dialog || sketch || !undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); markDirty(); refresh(); }
function redo() { if (dialog || sketch || !redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); markDirty(); refresh(); }

// ------------------------------------------------------------------ touch helpers
let touchMulti = false;
/** Shift/Ctrl/Cmd on a keyboard, or the Multi-select toggle on the touch bar, adds to the selection instead of replacing it. */
const multiSel = (e) => touchMulti || !!(e && (e.shiftKey || e.ctrlKey || e.metaKey));
/** Floating buttons for what touch screens lack a keyboard for: undo, cancel, finish and multi-select. */
function buildTouchBar() {
  const bar = document.createElement('div');
  bar.id = 'touchbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Touch controls');
  const key = (k) => () => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const items = [
    ['multi', 'Multi-select', null, () => { touchMulti = !touchMulti; syncBar(); }],
    ['undo', 'Undo', 'undo', () => undo()],
    ['esc', 'Cancel', 'close', key('Escape')],
    ['enter', 'Done', 'check', key('Enter')],
  ];
  bar.innerHTML = items.map(([id, label, ic]) => `<button class="btn" id="tb-${id}" type="button">${ic ? uicon(ic, 18, 1.6) : ''}<span>${label}</span></button>`).join('');
  items.forEach(([id, , , run]) => { bar.querySelector('#tb-' + id).onclick = run; });
  $('#viewport').appendChild(bar);
  function syncBar() {
    const busy = !!sketch || !!measure;
    bar.classList.toggle('on', document.body.classList.contains('touch'));
    $('#tb-multi').classList.toggle('active', touchMulti); $('#tb-multi').setAttribute('aria-pressed', String(touchMulti));
    for (const id of ['esc', 'enter']) $('#tb-' + id).hidden = !busy;
  }
  setInterval(syncBar, 400);
  syncBar();
}

// ------------------------------------------------------------------ viewport events
function bindViewport() {
  const cv = $('#gl');
  let down = null, rdown = null;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  // Touch: fingers on the canvas. A second finger means navigation (pinch / two-finger pan), so taps and sketch input ignore it;
  // a long press opens the context menu and a quick second tap acts as a double-click.
  const fingers = new Set(); let multi = false, press = null, lastTap = null, tapDbl = 0;
  const endPress = () => { clearTimeout(press?.t); press = null; };
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    document.body.classList.add('touch');
    fingers.add(e.pointerId);
    if (fingers.size > 1) { multi = true; down = null; endPress(); return; }
    multi = false;
    const x = e.clientX, y = e.clientY;
    press = { x, y, t: setTimeout(() => { press = null; down = null; if (!sketch?.pts) openMarking(x, y); }, 550) };
  }, true);
  cv.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) endPress(); }, true);
  const lift = (e) => { if (e.pointerType !== 'touch') return; fingers.delete(e.pointerId); endPress(); if (!fingers.size) setTimeout(() => { if (!fingers.size) multi = false; }, 0); };
  cv.addEventListener('pointerup', lift, true); cv.addEventListener('pointercancel', lift, true);
  /** Taps close together in time and place count as a double-click. */
  const doubleTap = (e) => {
    const now = performance.now(), l = lastTap; lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (l && now - l.t < 350 && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 24) { lastTap = null; tapDbl = now; return true; }
    return false;
  };
  // Navigation: middle = pan, Shift + middle = orbit, double-click middle = fit
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    if (e.detail === 2) { vp.fit(true); return; }
    vp.controls.mouseButtons.MIDDLE = e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  }, true);
  cv.addEventListener('pointerdown', (e) => { if (e.button === 2) rdown = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerup', (e) => { if (e.button === 2 && rdown && Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) < 5 && !sketch?.pts) openContextAt(e.clientX, e.clientY); rdown = null; });
  cv.addEventListener('pointerdown', (e) => { if (multi) return; if (sketch && !sketch.picking && e.button === 0) { SU.pointer(e, 'down'); return; } down = { x: e.clientX, y: e.clientY, b: e.button }; });
  cv.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch' && (multi || fingers.size)) { down = null; return; }
    if (e.pointerType === 'touch' && e.button === 0 && !sketch?.picking && doubleTap(e)) { down = null; (sketch ? SU.dblclick() : dblPick(e)); return; }
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
    if (paintMode && !dialog) { paintClick(e); return; }
    if (dialog) {
      if (defOf(doc.features[dialog.index])?.pickEdges) { const en = vp.pickEdge(e); if (en) toggleEdge(en); }
      else if (dialog.pick) dialogPick(e);
      else bodyFieldPick(e);
      return;
    }
    const eh = vp.pickEdge(e, edgeEntries());
    if (eh) { toggleSelEdge(eh, multiSel(e)); return; }
    const add = multiSel(e);
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
    if (selEdges.length && !(multiSel(e))) { selEdges = []; updateEdgeView(); }
    if (selPriority === 'face') {
      const tg = vp.pickFace(e);
      vp.selected.clear(); vp.refreshMaterials();
      if (add && selFace && tg?.face && !tg.curved && !selFace.curved && !faceB()) selFaceB = { id: tg.id, point: tg.point, normal: tg.normal, base: selFace }; // a second flat face: measure between them
      else selFace = tg?.face ? { id: tg.id, point: tg.point, normal: tg.normal, ...(tg.curved ? { curved: true } : {}) } : null;
      vp.showFaces(shownFaces(), null);
      renderTree(); renderRibbon();
      return;
    }
    const hit = vp.pickBody(e);
    selectBody(hit?.id, multiSel(e));
  });
  const dblPick = (e) => { // double-click: the whole body, whatever the click priority is
    if (e.button !== 0 || sketch || dialog || measure || selMode !== 'click') return;
    const hit = vp.pickBody(e);
    if (!hit) return;
    selFace = null; vp.showFaces([], null);
    selectBody(hit.id, multiSel(e));
  };
  cv.addEventListener('dblclick', (e) => { if (performance.now() - tapDbl > 500) dblPick(e); });
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
  cv.addEventListener('dblclick', () => { if (sketch && !sketch.picking && performance.now() - tapDbl > 500) SU.dblclick(); });
  let hoverRaf = false;
  cv.addEventListener('pointermove', (e) => {
    if (sketch && !sketch.picking) return sketchPointer(e, 'move');
    if (e.buttons || hoverRaf) return;
    const snapping = (measure && (measure.mode === 'dist' || measure.mode === 'angle')) || (dialog && (dialog.pick?.kind === 'point' || dialog.pick?.kind === 'points3d'));
    if (snapping) { // show where a click would snap to (corner, edge or face)
      hoverRaf = true;
      requestAnimationFrame(() => { hoverRaf = false; if (measure || dialog) vp.setSnapMarker(vp.snapAt(e, edgeEntries())); });
      return;
    }
    vp.setSnapMarker(null);
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
      if (en) { $('#gl').style.cursor = 'pointer'; if (vp.hover) { vp.hover = null; vp.refreshMaterials(); } vp.showFaces(shownFaces(), null); return; }
      const pf = vp.pickProfileAt(e);
      const pk = pf ? pf.key : null;
      if (pk !== profHover) { profHover = pk; vp.setProfileState(profSel, profHover); }
      if (pf) { $('#gl').style.cursor = 'pointer'; return; }
      $('#gl').style.cursor = '';
      if (selPriority === 'face') {
        const tg = vp.pickFace(e);
        vp.showFaces(shownFaces(), tg?.face ? tg : null);
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
  vp.eachPane(() => { vp.controls.touches = { ONE: sketch && !sketch.picking ? -1 : { orbit: THREE.TOUCH.ROTATE, pan: THREE.TOUCH.PAN, zoom: THREE.TOUCH.DOLLY_PAN, zwin: -1 }[navMode], TWO: THREE.TOUCH.DOLLY_PAN }; vp.controls.mouseButtons.LEFT = sketch && !sketch.picking ? -1 : { orbit: B.ROTATE, pan: B.PAN, zoom: B.DOLLY, zwin: -1 }[navMode]; });
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
  b('orbit', 'Orbit (Shift + middle mouse)', () => setNavMode('orbit'));
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
      { label: 'Render view', check: vp.opts.render, run: toggleRender },
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
/** Right-click in the model: a menu for the edge or face under the pointer, otherwise the marking menu. */
function openContextAt(x, y) {
  if (dialog || sketch || measure) return openMarking(x, y);
  closeMarking();
  const at = { clientX: x, clientY: y }, u = getUnits();
  const item = (id, label, o = {}) => ({ ficon: CMD[id]?.icon, label, hint: CMD[id]?.key, run: () => runCommand(id), ...o });
  const en = vp.pickEdge(at, edgeEntries(), 12); // a little more forgiving than hovering: you are aiming for a thin line
  if (en) {
    if (!selEdges.some((e) => e.body === en.body && matchChain([en.chain], e.pts))) { selFace = null; vp.showFaces([], null); toggleSelEdge(en, false); }
    const chains = resolveSelEdges(), n = chains.length, total = chains.reduce((a, c) => a + chainLength(c), 0);
    showMenu(x, y, [
      { head: n === 1 ? `Edge · ${dispStr(total, 2)} ${u}` : `${n} edges · ${dispStr(total, 2)} ${u} in total` },
      item('fillet', n === 1 ? 'Fillet' : `Fillet ${n} edges`),
      item('chamfer', n === 1 ? 'Chamfer' : `Chamfer ${n} edges`),
      { sep: true },
      { uicon: 'close', label: 'Clear selection', hint: 'Esc', run: () => { selEdges = []; edgeHover = null; updateEdgeView(); renderRibbon(); } },
    ]);
    return;
  }
  const tg = vp.pickFace(at);
  if (tg?.face) {
    selEdges = []; updateEdgeView(); vp.selected.clear(); vp.refreshMaterials();
    selFace = { id: tg.id, point: tg.point, normal: tg.normal, ...(tg.curved ? { curved: true } : {}) };
    vp.showFaces(shownFaces(), null); renderTree(); renderRibbon();
    const flat = !tg.curved;
    showMenu(x, y, [
      { head: flat ? 'Flat face' : 'Curved face' },
      item('presspull', 'Press/Pull', { disabled: !flat }),
      item('sketch', 'Sketch on face', { disabled: !flat, hint: '' }),
      item('hole', 'Hole', { disabled: !flat }),
      item('shell', 'Shell', { disabled: !flat }),
      item('draft', 'Draft', { disabled: !flat }),
      item('fillet', 'Fillet the face\'s edges'),
      { sep: true },
      { ficon: CMD.appearance?.icon, label: 'Appearance…', run: () => openAppearance() },
      { uicon: 'close', label: 'Clear selection', hint: 'Esc', run: () => { selFace = null; vp.showFaces([], null); renderTree(); renderRibbon(); } },
    ]);
    return;
  }
  openMarking(x, y);
}
function openMarking(x, y) {
  closeMarking();
  if (!dialog && !sketch && !measure) {
    const rect = $('#gl').getBoundingClientRect();
    const en = vp.pickEdge({ clientX: x, clientY: y }, edgeEntries(), 12); // a little more forgiving than hovering: you are aiming for a thin line
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
  if (selFace?.curved && !selEdges.length) items.push({ ficon: 'insertmesh', label: 'Face appearance…', run: () => openAppearance() }, { sep: true });
  else if (selEdges.length || selFace) items.push({ ficon: 'fillet', label: selEdges.length ? `Fillet ${selEdges.length} edge${selEdges.length > 1 ? 's' : ''}` : 'Fillet face edges', key: 'F', run: () => runCommand('fillet') }, { ficon: 'chamfer', label: selEdges.length ? 'Chamfer edges' : 'Chamfer face edges', run: () => runCommand('chamfer') }, ...(selFace && !selEdges.length ? [{ ficon: 'insertmesh', label: 'Face appearance…', run: () => openAppearance() }] : []), { sep: true });
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
    { dx: 108, dy: -32, label: 'Press/Pull', f: 'presspull', run: () => runCommand('presspull') },
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
    b.innerHTML = `<span>${esc(pl.label)}</span>` + (pl.f ? ficon(pl.f, 20) : pl.u ? `<span class="pl-ic ${pl.red ? 'red' : ''}">${uicon(pl.u, 16, pl.red ? 2.4 : 1.6)}</span>` : '');
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
/** Overlay what changed between an older version and the latest: kept grey, added blue, removed red, plus a list of changed features. */
async function compareVersion(pr, rev, oldTxt) {
  const cur = await call('GET', '/projects/' + encodeURIComponent(pr.name));
  if (!cur.ok) return toast(cur.data?.error || 'Could not load the latest version.', true);
  let A, B;
  try { A = JSON.parse(oldTxt); B = typeof cur.data === 'string' ? JSON.parse(cur.data) : cur.data; } catch { return toast('Could not read those versions.', true); }
  let ra, rb, diff;
  try { ra = evaluateDoc({ ...A, params: A.params || [] }); rb = evaluateDoc({ ...B, params: B.params || [] }); diff = compareBodies(ra.result.bodies, rb.result.bodies); }
  catch (e) { return toast('Could not compare: ' + e.message, true); }
  const byId = (d) => new Map(d.features.map((f) => [f.id, f]));
  const ma = byId(A), mb = byId(B), lines = [];
  for (const [id, f] of mb) { const o = ma.get(id); if (!o) lines.push(['+', `${f.name} was added`]); else if (JSON.stringify([o.params, o.exprs, o.suppressed]) !== JSON.stringify([f.params, f.exprs, f.suppressed])) lines.push(['~', `${f.name} was changed`]); }
  for (const [id, f] of ma) if (!mb.has(id)) lines.push(['−', `${f.name} was removed`]);
  const vol = (p) => (p ? `${(p.volume / 1000).toFixed(2)} cm³` : 'none');
  vp.setCompare(diff);
  const wrap = $('#props-wrap');
  wrap.innerHTML = `<div class="props"><div class="title">${ficon('combine', 20)}COMPARE</div><div class="body">
    <div class="note">V${esc(String(rev))} compared with the latest version of "${esc(pr.name)}".</div>
    <div class="stat"><span><i class="cmp-sw cmp-add"></i>Added (blue)</span><b>${vol(diff.added)}</b></div>
    <div class="stat"><span><i class="cmp-sw cmp-rem"></i>Removed (red)</span><b>${vol(diff.removed)}</b></div>
    <div class="stat"><span><i class="cmp-sw cmp-keep"></i>Unchanged (grey)</span><b>${vol(diff.kept)}</b></div>
    <div class="mh strong mb4 mt10">Timeline changes</div>
    ${lines.length ? lines.map(([k, t]) => `<div class="stat"><span>${k} ${esc(t)}</span></div>`).join('') : '<div class="note">The timelines are the same. Any difference comes from parameters or settings.</div>'}</div>
    <div class="foot"><button class="btn primary" id="i-close">Close</button></div></div>`;
  wrap.classList.add('open');
  $('#i-close').onclick = () => { vp.setCompare(null); wrap.classList.remove('open'); };
}
async function showVersions(pr) {
  const r = await call('GET', '/projects/' + encodeURIComponent(pr.name) + '/versions');
  if (!r.ok) return toast(r.data?.error || 'Could not load versions.', true);
  const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = [{ rev: pr.ver, modified: pr.modified, device: pr.device, note: pr.note, milestone: pr.milestone, cur: true }, ...r.data];
  const m = modal(`<div class="modal-title">Versions of ${esc(pr.name)}</div><div class="modal-body">${rows.map((v) => `<div class="ver-row" data-rev="${v.rev}"><div><b>V${v.rev}</b>${v.cur ? ' <span class="ver-cur">latest</span>' : ''}${v.milestone ? ` <span class="ver-ms">★ ${esc(v.milestone)}</span>` : ''}<div class="ver-sub">${when(v.modified)}${v.device ? ' · ' + esc(v.device) : ''}</div>${v.note ? `<div class="ver-note">${esc(v.note)}</div>` : ''}</div>${v.cur ? '' : '<div class="ver-btns"><button class="btn" data-a="compare" title="Show what changed between this version and the latest">Compare</button><button class="btn" data-a="open">Open</button><button class="btn" data-a="restore">Restore</button></div>'}</div>`).join('')}${r.data.length ? '' : '<div class="ver-sub">No earlier versions yet. Each save keeps the previous one.</div>'}<div class="ver-sub">The server keeps the most recent earlier versions of each design.</div></div>`);
  m.el.querySelectorAll('.ver-row button').forEach((b) => {
    b.onclick = async () => {
      const rev = +b.closest('.ver-row').dataset.rev;
      const g = await call('GET', `/projects/${encodeURIComponent(pr.name)}/versions/${rev}`);
      if (!g.ok) return toast(g.data?.error || 'Could not load that version.', true);
      const txt = typeof g.data === 'string' ? g.data : JSON.stringify(g.data);
      if (b.dataset.a === 'compare') { m.close(); return compareVersion(pr, rev, txt); }
      if (b.dataset.a === 'open') {
        if (!newTab({ reuseBlank: true })) return;
        m.close();
        loadProject(txt, pr.ver, pr.seq || pr.ver); doc.name = pr.name; doc.viewingRev = rev; renderDocTabs(); showViewBanner(); refresh();
        toast(`Opened V${rev} of "${pr.name}". Use the bar at the top to go back to the latest version.`);
      } else {
        if (!(await confirmBox({ title: `Restore V${rev}?`, message: `This adds a new version on top called "Restored from V${rev}". The current version stays in the history, so nothing is lost.`, ok: 'Restore' }))) return;
        const p = await call('PUT', '/projects/' + encodeURIComponent(pr.name), txt, { 'if-match': String(pr.ver), 'x-note': encodeURIComponent(`Restored from V${rev}`) });
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
/** The recycle bin: deleted designs wait here (30 days by default), with their versions, until they are restored or deleted for good. */
async function renderBin() {
  const host = $('#data-panel');
  host.innerHTML = `<div class="dp-top"><button id="bin-back" title="Back to designs" aria-label="Back to designs">${uicon('prev', 14)}</button><span class="count">Recycle bin</span></div>
    <div class="dp-grid" id="bin-list"><div class="dp-empty">Loading…</div></div>
    <div class="dp-actions"><button class="btn" id="bin-empty" disabled>Empty the bin</button></div>
    <div class="dp-version" id="bin-note"></div>`;
  $('#bin-back').onclick = () => renderDataPanel();
  const r = await call('GET', '/bin');
  const list = $('#bin-list');
  if (!list) return; // the panel was closed meanwhile
  if (!r.ok) { list.innerHTML = '<div class="dp-empty">Could not load the recycle bin.</div>'; return; }
  const { items, days } = r.data;
  $('#bin-note').textContent = days ? `Deleted designs are kept for ${days} days, then removed for good. They count toward your storage, and make room first when it runs out.` : 'The recycle bin is off on this server: deleting a design is permanent.';
  if (!items.length) { list.innerHTML = '<div class="dp-empty">The recycle bin is empty.<br>Designs you delete wait here.</div>'; return; }
  list.innerHTML = '';
  const left = (t) => { const d = Math.ceil((t - Date.now()) / 864e5); return d <= 1 ? 'removed within a day' : `removed in ${d} days`; };
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'bin-row';
    row.innerHTML = `<div class="bin-thumb">${it.thumb ? `<img alt="" src="/api/bin/${it.id}/thumb">` : ficon('box', 24)}</div>
      <div class="bin-info"><b></b><span>Deleted ${esc(ago(it.deletedAt))}${it.expiresAt ? ` · ${esc(left(it.expiresAt))}` : ''}${it.folder ? ` · from ${esc(it.folder)}` : ''}</span></div>
      <div class="bin-btns"><button class="btn primary" data-a="restore" type="button">Restore</button><button class="btn" data-a="purge" type="button" title="Delete for good" aria-label="Delete ${esc(it.name)} for good">${uicon('trash', 15)}</button></div>`;
    row.querySelector('b').textContent = it.name;
    row.querySelector('[data-a=restore]').onclick = async () => {
      let rr = await call('POST', `/bin/${it.id}/restore`, {});
      if (rr.status === 409 && rr.data?.suggestion) {
        if (!(await confirmBox({ title: 'Name already used', message: `You already have a design called "${it.name}". Restore this one as "${rr.data.suggestion}"?`, ok: 'Restore as a copy' }))) return;
        rr = await call('POST', `/bin/${it.id}/restore`, { to: rr.data.suggestion });
      }
      if (!rr.ok) return toast(rr.data?.error || 'Could not restore the design.', true);
      toast(`"${rr.data.name}" is back in your designs.`);
      renderBin();
    };
    row.querySelector('[data-a=purge]').onclick = async () => {
      if (!(await confirmBox({ title: 'Delete for good', message: `Delete "${it.name}" for good? This cannot be undone.`, ok: 'Delete for good', danger: true }))) return;
      const rr = await call('DELETE', '/bin/' + it.id);
      if (!rr.ok) return toast(rr.data?.error || 'Could not delete it.', true);
      renderBin();
    };
    list.appendChild(row);
  }
  const empty = $('#bin-empty'); empty.disabled = false;
  empty.onclick = async () => {
    if (!(await confirmBox({ title: 'Empty the recycle bin', message: `Delete ${items.length} design${items.length === 1 ? '' : 's'} for good? This cannot be undone.`, ok: 'Empty the bin', danger: true }))) return;
    const rr = await call('DELETE', '/bin');
    if (!rr.ok) return toast(rr.data?.error || 'Could not empty the bin.', true);
    renderBin();
  };
}
async function renderDataPanel() {
  const host = $('#data-panel');
  host.innerHTML = `<div class="dp-top"><span class="count" id="dp-count"></span><button class="dp-binlink" id="dp-bin" type="button" title="Recycle bin: deleted designs wait here and can be restored" aria-label="Recycle bin">${uicon('trash', 16)}<em id="dp-bincount"></em></button></div>
    <div class="dp-tabs"><span class="dp-searchicon">${uicon('search', 16, 1.8)}</span><input id="dp-q" class="dp-search" type="search" placeholder="Search designs" autocomplete="off" spellcheck="false"></div>
    <nav class="dp-crumb" id="dp-crumb" aria-label="Folder path"></nav>
    <div class="dp-grid" id="dp-grid"><div class="dp-empty">Loading…</div></div>
    <div class="dp-actions"><button class="btn primary" id="dp-new">New design</button><button class="btn" id="dp-newfolder">${uicon('folder', 15)} New folder</button></div>
    <div class="dp-version">Sketchy v${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''}</div>`;
  $('#dp-new').onclick = () => { newDoc(); };
  $('#dp-bin').onclick = () => renderBin();
  call('GET', '/bin').then((b) => { const n = b.ok ? b.data.items.length : 0; const c = $('#dp-bincount'); if (c) c.textContent = n ? String(n) : ''; }); // how many are waiting
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
    let cwd = ''; // the folder being shown ('' = the top level)
    try { cwd = JSON.parse(localStorage.getItem('sketchy.folders.cwd') || '""'); } catch { cwd = ''; }
    if (typeof cwd !== 'string' || (cwd && !folders.includes(cwd))) cwd = '';
    const setCwd = (v) => { cwd = v; try { localStorage.setItem('sketchy.folders.cwd', JSON.stringify(v)); } catch { /* storage unavailable */ } draw(); };
    $('#dp-newfolder').onclick = () => newFolder(cwd);
    const drop = (el, path) => {
      el.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/x-sketchy-design')) { e.preventDefault(); el.classList.add('dropping'); } };
      el.ondragleave = () => el.classList.remove('dropping');
      el.ondrop = (e) => { e.preventDefault(); el.classList.remove('dropping'); const n = e.dataTransfer.getData('text/x-sketchy-design'); if (n) moveDesign(n, path); };
    };
    const folderMenu = (path, x, y) => showMenu(x, y, [
      { label: 'New subfolder…', uicon: 'plus', run: () => newFolder(path) },
      { label: 'Rename…', uicon: 'file', run: async () => {
        const nm = await askName({ title: 'Rename folder', label: 'Folder name', value: path.split('/').pop(), ok: 'Rename' });
        if (!nm) return;
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const rr = await call('PATCH', '/folders', { from: path, to: parent + nm });
        if (!rr.ok) return toast(rr.data?.error || 'Could not rename the folder.', true);
        if ((doc.folder || '') === path || (doc.folder || '').startsWith(path + '/')) doc.folder = parent + nm + (doc.folder || '').slice(path.length);
        if (cwd === path || cwd.startsWith(path + '/')) cwd = parent + nm + cwd.slice(path.length);
        renderDataPanel();
      } },
      { label: 'Move to folder…', uicon: 'folder', run: async () => {
        const dest = await chooseFolder({ title: `Move folder "${path.split('/').pop()}" to`, current: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', exclude: path });
        if (dest === null) return;
        const to = (dest ? dest + '/' : '') + path.split('/').pop();
        const rr = await call('PATCH', '/folders', { from: path, to });
        if (!rr.ok) return toast(rr.data?.error || 'Could not move the folder.', true);
        if (cwd === path || cwd.startsWith(path + '/')) cwd = to + cwd.slice(path.length);
        renderDataPanel();
      } },
      { label: 'Delete folder', uicon: 'trash', run: async () => {
        if (!(await confirmBox({ title: 'Delete folder', message: `Delete the folder "${path}"? It must be empty of designs.`, ok: 'Delete', danger: true }))) return;
        const rr = await call('DELETE', '/folders?path=' + encodeURIComponent(path));
        if (!rr.ok) return toast(rr.data?.error || 'Could not delete the folder.', true);
        if (cwd === path || cwd.startsWith(path + '/')) cwd = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        renderDataPanel();
      } },
    ]);
    const drawCrumb = () => {
      const bar = $('#dp-crumb'); bar.innerHTML = '';
      bar.hidden = !cwd; if (!cwd) return;
      const seg = (label, path, last, home) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-seg' + (last ? ' here' : '');
        b.innerHTML = home ? uicon('home', 18) : esc(label); b.title = home ? 'All designs' : path; b.setAttribute('aria-label', home ? 'All designs' : label);
        if (last) b.setAttribute('aria-current', 'page'); else b.onclick = () => setCwd(path);
        drop(b, path); bar.appendChild(b);
      };
      const parts = cwd ? cwd.split('/') : [];
      seg('', '', !parts.length, true);
      parts.forEach((nm, i) => { bar.insertAdjacentHTML('beforeend', `<span class="dp-sep" aria-hidden="true">${uicon('caret', 12)}</span>`); seg(nm, parts.slice(0, i + 1).join('/'), i === parts.length - 1); });
    };
    const q = $('#dp-q'), draw = () => {
      grid.innerHTML = '';
      drawCrumb();
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
            if (!(await confirmBox({ title: 'Delete design', message: `Move "${pr.name}" to the recycle bin? Its version history goes with it, and you can restore it from the bin for 30 days.`, ok: 'Move to bin', danger: true }))) return;
            const dr = await call('DELETE', '/projects/' + encodeURIComponent(pr.name));
            if (dr.ok) toast(dr.data?.binned ? `"${pr.name}" is in the recycle bin for ${dr.data.days} days.` : `"${pr.name}" was deleted.`);
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
      const kids = folders.filter((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === cwd).sort((a, b) => a.localeCompare(b));
      for (const path of kids) {
        const total = r.data.filter((x) => x.folder === path || (x.folder || '').startsWith(path + '/')).length, name = path.split('/').pop();
        const row = document.createElement('div'); row.className = 'dp-frow';
        row.innerHTML = `<button type="button" class="dp-fopen" aria-label="Open folder ${esc(name)}">${uicon('folder', 22, 1.5)}<span class="dp-fname">${esc(name)}</span><small>${total} design${total === 1 ? '' : 's'}</small></button>
          <button type="button" class="dp-more" title="Folder actions" aria-haspopup="menu" aria-label="Actions for folder ${esc(name)}">${uicon('more', 16)}</button>`;
        row.querySelector('.dp-fopen').onclick = () => setCwd(path);
        row.querySelector('.dp-more').onclick = (e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); folderMenu(path, b.left, b.bottom + 2); };
        row.oncontextmenu = (e) => { e.preventDefault(); folderMenu(path, e.clientX, e.clientY); };
        drop(row, path); grid.appendChild(row);
      }
      const items = r.data.filter((x) => (x.folder || '') === cwd).sort((a, b) => b.modified - a.modified);
      for (const pr of items) grid.appendChild(designCard(pr, false));
      if (!kids.length && !items.length) grid.insertAdjacentHTML('beforeend', `<div class="dp-empty">${cwd ? 'This folder is empty. Drag designs onto its name above, or choose Save and pick it.' : 'No designs yet.'}</div>`);
    };
    q.oninput = draw; draw();
  } else {
    $('#dp-count').textContent = acct.server ? 'Signed out' : 'Offline';
    grid.innerHTML = '';
    if (doc.features.length || doc.name !== 'Untitled') grid.appendChild(card(doc.name, { ver: (doc.saves || 0) + 1 }));
    grid.insertAdjacentHTML('beforeend', acct.server
      ? `<div class="dp-empty">Sign in to see the designs saved on this server.<br><button class="btn primary mt10" id="dp-signin">Sign in</button></div>`
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
    if (e.key === 'Escape' && !$('#menu').hidden) { e.preventDefault(); $('#menu').hidden = true; return; } // an open menu takes Esc first, before it cancels a sketch or dialog
    if (mod && key === 's') { e.preventDefault(); save(e.shiftKey, '', '', false); return; } // Ctrl/Cmd+S saves in place; the Save button (or Save as) makes a numbered version
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
      if (paintMode) { endPaint(); return; }
      if (apPanel && !dialog && !sketch) { apPanel.close(); return; }
      if (navMode !== 'orbit') { setNavMode('orbit'); return; }
      if (selMode !== 'click' && !sketch && !dialog && !measure) { selMode = 'click'; toast('Click selection'); return; }
      if (sketch && !sketch.picking) { SU.key(e); return; }
      if (!dialog && !measure && (selEdges.length || selFace || profSel.size)) { profSel.clear(); updateProfileView(); selEdges = []; selFace = null; vp.showFaces([], null); updateEdgeView(); renderRibbon(); return; }
      if (measure) { endMeasure(); return; }
      if (sketch?.pts) { sketch.pts = null; vp.overlay.clear(); } else if (sketch) cancelSketch(); else if (dialog) closeDialog(false); else panelCloseButton()?.click();
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
    const map = { e: 'extrude', q: 'presspull', f: 'fillet', m: 'move', h: 'hole', j: 'joint', i: 'measure', c: 'combine' };
    if (map[key]) runCommand(map[key]);
    else if (key === 's') { e.preventDefault(); openQuickSearch(); }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (location.pathname === '/oauth/authorize') { await refreshAccount(); await ensureSignedIn(); await oauthConsent(); return; } // an assistant is asking to connect: just the approval page
  const caret = uicon('caret', 7, 0).replace('class="ui"', 'class="ui caret"');
  const set = (id, html) => { $('#' + id).innerHTML = html; };
  set('btn-data', uicon('library', 18, 1.5));
  set('btn-undo', uicon('undo', 18, 1.5) + caret); set('btn-redo', uicon('redo', 18, 1.5) + caret);
  set('btn-save', uicon('save', 18, 1.5)); set('btn-newtab', uicon('plus', 18, 1.8)); set('btn-ext', uicon('search', 18, 1.8));
 
  set('pt-min', uicon('minus', 12, 2));
  set('cube-home', uicon('home', 14, 1.6)); set('cube-menu', uicon('caret', 10, 0));
  $('#viewport').insertAdjacentHTML('beforeend', '<div id="loading">Loading CAD kernel…</div>');
  await initKernel({ locateFile: () => wasmUrl });
  vp = new Viewport($('#gl'), $('#cube'));
  vp.opts.bedSize = printerSize(bedName) || vp.opts.bedSize;
  vp.buildBed();
  vp.home();
  vp.fitted = true; // only opening a design re-frames the view; making the first body must not move the camera
  $('#loading')?.remove();
  SU = createSketchUI({
    vp, THREE, sketch: () => sketch, params: () => resolvedMap[curSketch().id] || curSketch().params,
    setShapes: (sh) => setSketchShapes(sh), remapCons: (si, delta) => remapSketchCons(si, delta), reference: () => sketchReference(), projectHover: (e) => projectHover(e), projectPick: (e, all) => projectPick(e, all), renderPanel: () => renderSketchPanel(), redrawSketch: () => drawSketches(),
    cons: () => curSketch().params.cons || [], setCons: (c) => setSketchCons(c),
    toast: (m) => toast(m), askPattern: (k, o) => askPattern(k, o), evalExpr: (t, kind = 'len') => evalExpr(t, paramScope, kind), setTool: (t) => setSketchTool(t), rebuildGrid: (st) => buildSketchGrid(st),
  });
  if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
  buildTouchBar(); buildNavBar(); bindViewport(); bindZoomWindow(); bindSelectTool(); bindKeys(); bindManip(); bindAppearanceDrop();
  bindTooltips();
  $('#btn-undo').onclick = (ev) => { const r = ev.currentTarget.getBoundingClientRect(); if (ev.clientX > r.right - 14) historyMenu(ev.currentTarget); else undo(); };
  $('#btn-undo').oncontextmenu = (ev) => { ev.preventDefault(); historyMenu(ev.currentTarget); };
  $('#btn-undo').title = 'Undo (Ctrl+Z). Click the arrow beside it to go back several steps.';
  $('#btn-redo').onclick = redo;
  $('#btn-data').onclick = () => toggleDataPanel();
  $('#btn-save').onclick = saveVersion;
  $('#btn-newtab').onclick = () => newDoc();
  renderDocTabs();
  $('#btn-ext').onclick = openQuickSearch;
  $('#pt-min').onclick = () => { const min = $('#browser').classList.toggle('min'); $('#pt-min').innerHTML = uicon(min ? 'expand' : 'minus', 12, 2); $('#pt-min').title = min ? 'Expand' : 'Minimise'; };
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
  $('#file-repair').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importModel(f, { always: true }); };
  $('#file-stl').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importModel(f); };
  $('#file-proj').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openDesignFile(f); };
  $('#viewport').addEventListener('dragover', (e) => e.preventDefault());
  $('#viewport').addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && /\.3mf$/i.test(f.name)) f.arrayBuffer().then((b) => readEmbeddedDesign(b)).then((d) => (d ? openDesignFile(f) : importModel(f))); else if (f && isImportName(f.name)) importModel(f); else if (f && /\.(svg|dxf)$/i.test(f.name)) import2D(f); });
  initA11y();
  const paint = (t) => { const d = t === 'dark'; vp.applyTheme(d); sketchMat.color.setHex(d ? 0x3d94ff : 0x1f5fa8); sketchMatActive.color.setHex(d ? 0x2f8cff : 0x0b6bcb); };
  paint(getTheme()); onTheme(paint);
  await refreshAccount();
  await ensureSignedIn(); // server mode: sign-up on first visit, login afterwards
  setAccountMenuHandler((anchor) => openUserMenu(anchor, {
    onAccount: () => showAccount(), onPrefs: () => showSettings(), onSettings: showAdmin,
    isDark: () => getTheme() === 'dark', onTheme: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'),
    onLogout: async () => { assistant?.stop(); await signOut(); try { localStorage.removeItem('sketchy.autosave'); } catch { /* ignore */ } location.reload(); },
  }));
  if (localStorage.getItem('sketchy.data') === '1') toggleDataPanel(true);
  setAccountChangeHandler(() => { if (dataOpen) renderDataPanel(); });
  startRemotePolling();
  setupAddins();
  setupAssistant();
  refresh();
  window.__sketchy = { kernelState: () => ({ heavy: kernelHeavy, busy: kernelBusy(), lastMs: lastRebuildMs, worker: !!kw.worker }), setHeavy: (v) => { kernelHeavy = v; if (v) { clearKernelCache(); ensureKernelWorker(); } refresh(); }, moveFeature, setSuppressed, dependentsOf, renameFeature, treeMenu, profilesOf, profilesFor, get doc() { return doc; }, get result() { return result; }, vp, startFeature, rebuild, refresh, runCommand, openMarking };
  openLastOrCreate().then(checkDrafts); // not awaited: the New design dialog must not hold up the rest of start-up
}
// ------------------------------------------------------------------ add-ins (src/addins.js, src/addins-ui.js)
const BASE_IMPORT_EXT = ['stl', 'obj', '3mf', 'step', 'stp'];
const isImportName = (name) => { const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase(); return BASE_IMPORT_EXT.includes(ext) || !!addins?.importerFor(ext); };
/** Read a model file: with an add-in when one handles that file type, otherwise with the built-in readers. */
async function readImport(file) {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || '').toLowerCase();
  const ref = !BASE_IMPORT_EXT.includes(ext) && addins?.importerFor(ext);
  if (!ref) return readModelFile(file);
  try { return await addins.readFile(file, ref); }
  catch (e) { throw new Error(e.message === 'cancelled' ? 'Import cancelled.' : `${ref.addin.manifest.name}: ${e.message}`); }
}
async function runAddinCommand(c) {
  try { await addins.runCommand(c.addinCommand); } catch (e) { toast(`${c.label}: ${e.message}`, true); }
}
/** A form an add-in asked for: resolves the values, or null if cancelled. */
function addinForm(spec) {
  return new Promise((resolve) => {
    const rows = spec.fields.map((f) => `<label class="adf-row"><span>${esc(f.label)}</span>${f.type === 'bool' ? `<input type="checkbox" name="${esc(f.name)}" ${f.value ? 'checked' : ''}>` : f.type === 'select' ? `<select name="${esc(f.name)}">${(f.options || []).map(([v, l]) => `<option value="${esc(v)}" ${String(f.value) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : `<input name="${esc(f.name)}" type="${f.type === 'number' ? 'number' : 'text'}" ${f.type === 'number' ? 'step="any"' : 'maxlength="200"'} value="${esc(f.value)}">`}</label>`).join('');
    const m = modal(`<div class="modal-title">${esc(spec.title)}</div><form class="modal-body">${spec.intro ? `<p class="rp-lead">${esc(spec.intro)}</p>` : ''}<div class="adf-form">${rows}</div><div class="modal-foot flush"><button type="button" class="btn" id="ad-c">Cancel</button><button type="submit" class="btn primary">${esc(spec.ok)}</button></div></form>`, () => resolve(null));
    const form = m.el.querySelector('form');
    m.el.querySelector('#ad-c').onclick = () => m.close();
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of spec.fields) { const el = form.elements[f.name]; out[f.name] = f.type === 'bool' ? el.checked : f.type === 'number' ? (Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : f.value) : el.value; }
      resolve(out); m.closeSilently?.() ?? m.close();
    };
    setTimeout(() => form.querySelector('input,select')?.focus(), 0);
  });
}
function setupAddins() {
  addins = createAddinManager({
    runtime: runtimeSource,
    onChange: () => {
      // contributed commands appear in the ADD-INS group's menu
      const ids = [];
      for (const c of addins.commands()) { const id = `addin:${c.ref}`; CMD[id] = { label: c.label, icon: 'addin', desc: `${c.description ? c.description + ' ' : ''}(Add-in: ${c.addin})`, addinCommand: c.ref }; ids.push(id); }
      const g = TOOLBAR.UTILITIES.find((x) => x.label === 'ADD-INS'); if (g) g.menu = ids.length ? ['addins', '|', ...ids] : [];
      const accept = [...BASE_IMPORT_EXT, ...addins.importExtensions()].map((x) => '.' + x).join(',');
      $('#file-stl').accept = accept; $('#file-repair').accept = accept;
      if (!dialog && !sketch) renderRibbon();
    },
    hooks: {
      toast, menu: showMenu,
      confirm: (message, o = {}) => confirmBox({ title: o.title || 'Add-in', message, ok: o.ok || 'OK', danger: !!o.danger }),
      form: addinForm,
      pickFile: (o) => new Promise((resolve) => {
        const inp = document.createElement('input'); inp.type = 'file'; if (o.accept) inp.accept = o.accept;
        inp.onchange = async () => { const f = inp.files[0]; resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); };
        inp.oncancel = () => resolve(null); inp.click();
      }),
      readDocument: async (o) => ({ name: doc.name, units: getUnits(), parameters: (doc.params || []).map((p) => ({ name: p.name, expr: p.expr })), bodies: result.bodies.map((b) => ({ id: b.id, name: b.name, color: look((doc.appearance || {})[b.id]).color, ...(o.meshes ? { verts: b.verts, tris: b.tris } : {}) })) }),
      addBody: async ({ name, verts, tris }) => {
        const n = tris.length / 3, soup = new Float32Array(n * 9);
        for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) soup.set(verts.subarray(tris[t * 3 + k] * 3, tris[t * 3 + k] * 3 + 3), t * 9 + k * 3);
        const r = await importPart({ name, soup });
        if (r.err) throw new Error(r.err);
        return { id: r.id };
      },
      buildGeometry: async (tree) => { await tick(); return buildTree(kernelModule(), tree); },
      saveFile: async ({ name, bytes, mime }) => { download(new Blob([bytes], { type: mime }), name); return true; },
    },
  });
  addins.startup().catch(() => {});
}

/** The assistant as part of the app: live changes, the Stop chip and the request box (see assistant.js). */
const LIVE_VIEWS = { iso: [1, -1, 0.8], iso_back: [-1, 1, 0.8], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1] };
let liveT = null, liveLast = '';
/** Tell the server what you are looking at (open design, selection, view), so an assistant can work on the same thing (get_live_context). */
function queueLive(force = false) {
  if (!assistant) return;
  clearTimeout(liveT);
  liveT = setTimeout(() => {
    const sel = {};
    if (vp.selected.size) sel.bodies = [...vp.selected];
    if (selSet.size) sel.features = [...selSet];
    if (selEdges.length) sel.edges = selEdges.length;
    if (selFace) sel.face = { body: selFace.id, point: selFace.point, normal: selFace.normal, ...(selFace.curved ? { curved: true } : {}) };
    const cam = vp.camera.position.clone().sub(vp.controls.target).normalize();
    const state = { design: doc.name && doc.name !== 'Untitled' && doc.rev ? doc.name : '', dirty, openDesigns: tabs.map(tabName).filter((n) => n && n !== 'Untitled'), tool: sketch ? 'sketch' : dialog ? (doc.features[dialog.index]?.type || 'feature') : measure ? 'measure' : '', sketch: sketch && !sketch.picking ? doc.features[sketch.index]?.id || '' : '', selection: sel, view: [cam.x, cam.y, cam.z], units: getUnits(), appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '' };
    const key = JSON.stringify({ ...state, view: state.view.map((v) => +v.toFixed(1)) });
    if (!force && key === liveLast) return;
    liveLast = key;
    call('PUT', '/live', state);
  }, 700);
}
function setupAssistant() {
  const btn = $('#btn-ai');
  if (!acct.server || !acct.user) return;
  btn.hidden = false; btn.innerHTML = uicon('sparkle', 18, 1.6);
  assistant = createAssistant({
    toast,
    currentDesignName: () => (doc.name && doc.name !== 'Untitled' ? doc.name : ''),
    getSelection: () => {
      const parts = [], context = {};
      if (selFace) { const b = result.bodies.find((x) => x.id === selFace.id); parts.push(`a ${selFace.curved ? 'curved ' : ''}face of ${b?.name || selFace.id}`); context.face = { body: selFace.id, point: selFace.point, normal: selFace.normal, ...(selFace.curved ? { curved: true } : {}) }; }
      if (vp.selected.size) { const names = [...vp.selected].map((id) => result.bodies.find((x) => x.id === id)?.name || id); parts.push(names.length > 2 ? `${names.length} bodies` : names.join(', ')); context.bodies = [...vp.selected]; }
      if (selSet.size) { const fs = [...selSet].map((id) => doc.features.find((f) => f.id === id)).filter(Boolean); if (fs.length) { parts.push(fs.length > 2 ? `${fs.length} features` : fs.map((f) => f.name).join(', ')); context.features = fs.map((f) => f.id); } }
      if (selEdges.length) { parts.push(`${selEdges.length} edge${selEdges.length > 1 ? 's' : ''}`); context.edges = selEdges.slice(0, 20).map((e) => ({ body: e.body, pts: e.pts })); }
      return parts.length ? { summary: parts.join(', '), context: { ...context, summary: parts.join(', ') } } : null;
    },
    showInApp: (ev) => { // an assistant pointing at something: turn the view, select, say something. Never changes the design.
      if (ev.design && ev.design !== doc.name) { if (ev.message) toast(`Assistant, about "${ev.design}": ${ev.message}`); return; }
      if (dialog || sketch) { if (ev.message) toast(`Assistant: ${ev.message}`); return; }
      if (ev.view && LIVE_VIEWS[ev.view]) { const d = LIVE_VIEWS[ev.view]; vp.lookAlong(d, Math.abs(d[2]) > 0.9 * Math.hypot(...d) ? [0, 1, 0] : [0, 0, 1], true); }
      if (ev.bodies?.length) { const ids = ev.bodies.filter((id) => result.bodies.some((b) => b.id === id)); selFace = null; vp.showFaces([], null); vp.selected.clear(); ids.forEach((id) => vp.selected.add(id)); vp.refreshMaterials(); renderTree(); renderRibbon(); }
      if (ev.face?.point && ev.face?.normal && result.bodies.some((b) => b.id === ev.face.body)) { vp.selected.clear(); vp.refreshMaterials(); selFace = { id: ev.face.body, point: ev.face.point, normal: ev.face.normal, ...(ev.face.curved ? { curved: true } : {}) }; vp.showFaces(shownFaces(), null); renderTree(); renderRibbon(); }
      if (ev.message) toast(`Assistant: ${ev.message}`);
    },
    designChanged: async (ev) => {
      if (ev.name !== doc.name || !doc.rev) { toast(`The assistant changed "${ev.name}"`); if (dataOpen) renderDataPanel(); return; }
      if (ev.seq <= (doc.seq || 0) || doc.viewingRev) return;
      if (dirty || sketch || dialog || measure) { bannerRev = ev.seq; showBanner({ rev: ev.seq, device: 'the assistant' }); return; } // you are in the middle of something: ask first
      await openDesign(doc.name, true);
      const ids = doc.lastEdit?.by === 'assistant' ? doc.lastEdit.features || [] : [];
      aiFlash = new Set(ids); renderTimeline();
      setTimeout(() => { aiFlash = new Set(); renderTimeline(); }, 6000);
      const tool = doc.lastEdit?.tool;
      toast(`The assistant ${toolPast(tool)}.`);
    },
  });
  btn.onclick = () => assistant.togglePanel(true);
  assistant.start();
  setInterval(() => queueLive(true), 60e3); // the server forgets what you are looking at after 3 minutes of silence
  queueLive(true);
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
  if (!BG.welcomeWanted()) await newDoc(true); // a first visit starts at the welcome card; the design is named once a choice is made there
}
boot();
