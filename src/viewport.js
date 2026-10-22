// Three.js viewport: Z-up scene, orbit navigation, body meshes, ViewCube, picking, move gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildBVH, raycastBVH } from './bvh.js';
import { clusterMesh } from './lod.js';

const BVH_MIN = 20000;    // triangles: a body with more than this is picked through a tree, not by testing every triangle
const LOD_MIN = 60000;    // while the camera moves, bodies with more triangles than this are drawn from a coarse copy ...
const LOD_TOTAL = 250000; // ... once the whole model passes this many

/** Mesh.raycast for big bodies: nearest hit through the mesh's BVH, in the same shape three.js returns. */
function bvhRaycast(raycaster, intersects) {
  const src = this.userData.src;
  if (!src) return;
  const bvh = this.userData.bvh || (this.userData.bvh = buildBVH(src.verts, src.tris));
  const o = raycaster.ray.origin, d = raycaster.ray.direction, mat = Array.isArray(this.material) ? this.material[0] : this.material;
  const hit = raycastBVH(bvh, o.x, o.y, o.z, d.x, d.y, d.z, raycaster.far, mat?.side !== THREE.FrontSide);
  if (!hit || hit.t < raycaster.near) return;
  const T = src.tris, V = src.verts, i = hit.tri, a = T[i * 3], b = T[i * 3 + 1], c = T[i * 3 + 2];
  const n = new THREE.Vector3(V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]).cross(new THREE.Vector3(V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2])).normalize();
  intersects.push({ distance: hit.t, point: new THREE.Vector3(o.x + d.x * hit.t, o.y + d.y * hit.t, o.z + d.z * hit.t), object: this, faceIndex: i, face: { a, b, c, normal: n } });
}
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PLANES, planeFrame, findFaceTri } from './kernel.js';
import { look, textureById } from './materials.js';
import { planarFace, curvedFace, findCurvedTri, faceOf } from './edges.js';
import { matchBrepFace } from './brepface.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewport {
  constructor(canvas, cubeEl) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.camera = this.persp;
    this.persp.position.set(90, -120, 80);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('start', () => { this.anim = null; this.setMoving(true); });
    this.controls.addEventListener('end', () => this.setMoving(false));
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.screenSpacePanning = true;
    // Two-view layout: pane 0 is the main view; pane 1 is created on demand. this.camera / this.controls / this.persp / this.ortho
    // always refer to the ACTIVE pane (the one under the pointer), so all the picking and camera code works on whichever view you use.
    this.layoutWanted = 'single'; this.holds = new Set(); this.active = 0;
    this.panes = [{ persp: this.persp, ortho: this.ortho, camera: this.camera, controls: this.controls }, null];
    const host = canvas.parentElement;
    const track = (e) => { if (e.type === 'pointermove' && e.buttons) return; this.activateAt(e.clientX, e.clientY); };
    host.addEventListener('pointerdown', track, true); host.addEventListener('pointermove', track, true); host.addEventListener('wheel', track, true);
    this.paneMark = document.createElement('div');
    this.paneMark.style.cssText = 'position:absolute;pointer-events:none;border:2px solid var(--accent, #0b6bcb);box-sizing:border-box;display:none;z-index:2';
    host.appendChild(this.paneMark);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a0, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(0.5, -0.8, 1.2);
    this.camLight = sun;
    this.scene.add(sun, sun.target);

    this.bodyGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.overlay = new THREE.Group();
    this.faceHL = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.pickEntries = [];
    this.scene.add(this.bodyGroup, this.sketchGroup, this.overlay, this.faceHL, this.edgeGroup);
    this.profileGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.manipGroup = new THREE.Group();
    this.scene.add(this.profileGroup, this.previewGroup, this.manipGroup);
    this.edgeSelGroup = new THREE.Group();
    this.scene.add(this.edgeSelGroup);
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);
    this.buildGrid();
    this.buildOrigin();
    this.buildPlaneHandles();
    this.buildOriginPlanes();

    this.selected = new Set();
    this.hover = null;
    this.opts = { edges: true, wire: false, grid: true, bed: false, ortho: false, bedSize: [256, 256, 256] };
    this.mats = {
      surface: new THREE.MeshStandardMaterial({ color: 0x74b3de, metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      body: new THREE.MeshStandardMaterial({ color: 0xc3c7cd, metalness: 0.12, roughness: 0.5, side: THREE.DoubleSide }),
      sel: new THREE.MeshStandardMaterial({ color: 0x86bdf0, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide }),
      hover: new THREE.MeshStandardMaterial({ color: 0xd3dae3, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide }),
      edge: new THREE.LineBasicMaterial({ color: 0x3a3f46 }),
      edgeSel: new THREE.LineBasicMaterial({ color: 0x0b4f94 }),
    };
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.8);
    this.gizmoProxy = new THREE.Object3D();
    this.gizmoProxy.rotation.order = 'ZYX';
    this.scene.add(this.gizmoProxy, this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });
    this.gizmo.visible = false;

    this.cube = this.buildCube(cubeEl);
    this.ray = new THREE.Raycaster();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.fitted = false;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---- static scene furniture ----
  /** Rebuild the ground grid with tones that suit the theme (subtle lines on a dark canvas). */
  /** Thick lines (WebGL's own lines are always one pixel wide, too thin to follow a shape you are drawing). */
  trackFat(m) {
    if (!(this.fatMats ||= new Set()).has(m)) {
      m.alphaToCoverage = true; // smooth (multisampled) edges instead of stair-steps
      if (m.depthTest) { m.polygonOffset = true; m.polygonOffsetFactor = -4; m.polygonOffsetUnits = -4; } // sit just in front of a face the sketch lies on, so the line doesn't flicker or break into dashes
      this.fatMats.add(m);
    }
    return m;
  }
  fatMat(color, width = 2.5, depthTest = true) { return this.trackFat(new LineMaterial({ color, linewidth: width, depthTest })); }
  fatLine(pts, mat, closed = false) {
    const a = []; for (const p of pts) a.push(p.x, p.y, p.z);
    if (closed && pts.length) a.push(pts[0].x, pts[0].y, pts[0].z);
    const g = new LineGeometry(); g.setPositions(a);
    const l = new Line2(g, this.trackFat(mat)); l.computeLineDistances();
    return l;
  }
  applyTheme(dark) {
    this.dark = dark; // sketch previews read this to pick a line colour that shows on the background
    const vis = this.grid?.visible ?? true;
    if (this.grid) { this.scene.remove(this.grid); this.grid.traverse((o) => o.geometry?.dispose()); }
    this.buildGrid(dark); this.grid.visible = vis;
  }
  buildGrid(dark = false) {
    this.grid = new THREE.Group();
    const mk = (size, div, c1, c2) => { const g = new THREE.GridHelper(size, div, c1, c2); g.rotation.x = Math.PI / 2; g.material.transparent = true; g.material.opacity = 0.9; return g; };
    this.grid.add(...(dark ? [mk(1000, 100, 0x343a43, 0x2d333a), mk(1000, 1000, 0x242a30, 0x242a30)] : [mk(1000, 100, 0xe0e4e9, 0xe6e9ed), mk(1000, 1000, 0xf0f2f5, 0xf0f2f5)]));
    this.grid.children[1].material.opacity = 0.55;
    this.grid.position.z = -0.02;
    this.scene.add(this.grid);
  }

  buildOrigin() {
    const line = (a, b, c, o) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o }));
    // long X (red) and Y (green) axis lines through the grid; short Z stub
    this.originMarks = new THREE.Group();
    this.originMarks.add(line([-600, 0, 0], [600, 0, 0], 0xe27d78, 0.75), line([0, -600, 0], [0, 600, 0], 0x7fcf92, 0.75), line([0, 0, 0], [0, 0, 60], 0x6f9be8, 0.9));
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 28), new THREE.MeshBasicMaterial({ color: 0x8b9096, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.7, 12), new THREE.MeshBasicMaterial({ color: 0x8b9096, side: THREE.DoubleSide }));
    ring.position.z = dot.position.z = 0.03;
    this.originMarks.add(ring, dot);
    this.scene.add(this.originMarks);
  }

  buildOriginPlanes() {
    this.originGroup = new THREE.Group();
    const rots = { XY: [0, 0, 0], XZ: [Math.PI / 2, 0, 0], YZ: [Math.PI / 2, 0, Math.PI / 2] };
    for (const [k, r] of Object.entries(rots)) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({ color: 0x7fb3e8, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(70, 70)), new THREE.LineBasicMaterial({ color: 0x4f8fcf }));
      m.raycast = () => {}; e.raycast = () => {};
      g.add(m, e);
      g.rotation.set(...r, 'ZYX');
      g.userData.plane = k;
      this.originGroup.add(g);
    }
    this.originGroup.visible = false;
    this.scene.add(this.originGroup);
  }
  setOriginVisible(v) { this.originGroup.visible = v; this.originOn = v; if (this.originMarks) this.originMarks.visible = v && !this.opts.render; } // the planes and the axis lines go together
  /** Effective layout: 'single', 'h' (one above the other) or 'v' (side by side). Sketching and the move gizmo need one full view. */
  get layout() { return this.holds.size ? 'single' : this.layoutWanted; }
  hold(key, on) {
    if (this.holds.has(key) === on) return;
    on ? this.holds.add(key) : this.holds.delete(key);
    if (on) this.activate(0);
    this.layoutChanged();
  }
  setLayout(mode) {
    this.layoutWanted = mode;
    if (mode !== 'single' && !this.panes[1]) {
      const persp = this.persp.clone(), ortho = this.ortho.clone(), camera = this.opts.ortho ? ortho : persp;
      const controls = new OrbitControls(camera, this.canvas);
      controls.enableDamping = false; controls.screenSpacePanning = true; controls.enabled = false;
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      controls.target.copy(this.controls.target);
      camera.position.copy(this.camera.position); camera.up.copy(this.camera.up); camera.quaternion.copy(this.camera.quaternion);
      this.panes[1] = { persp, ortho, camera, controls };
    }
    if (mode === 'single') this.activate(0);
    this.layoutChanged();
  }
  layoutChanged() { this.resize(); this.updatePaneMark(); }
  /** Pane rectangles in canvas CSS pixels (top-left origin). */
  paneRects() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight, g = 2, l = this.layout;
    if (l === 'h') return [{ x: 0, y: 0, w: W, h: (H - g) / 2 }, { x: 0, y: (H + g) / 2, w: W, h: (H - g) / 2 }];
    if (l === 'v') return [{ x: 0, y: 0, w: (W - g) / 2, h: H }, { x: (W + g) / 2, y: 0, w: (W - g) / 2, h: H }];
    return [{ x: 0, y: 0, w: W, h: H }];
  }
  /** Client-space rectangle of the active pane (what the canvas rectangle is in a single view). */
  rect() {
    const r = this.canvas.getBoundingClientRect(), p = this.paneRects()[this.layout === 'single' ? 0 : this.active];
    return { left: r.left + p.x, top: r.top + p.y, width: p.w, height: p.h, right: r.left + p.x + p.w, bottom: r.top + p.y + p.h };
  }
  activateAt(cx, cy) {
    if (this.layout === 'single') return;
    const r = this.canvas.getBoundingClientRect(), rs = this.paneRects();
    const i = rs.findIndex((q) => cx >= r.left + q.x && cx <= r.left + q.x + q.w && cy >= r.top + q.y && cy <= r.top + q.y + q.h);
    if (i >= 0) this.activate(i);
  }
  activate(i) {
    if (i === this.active || !this.panes[i]) return;
    const cur = this.panes[this.active];
    cur.camera = this.camera; cur.controls.enabled = false;
    const nx = this.panes[i];
    this.active = i;
    this.persp = nx.persp; this.ortho = nx.ortho; this.camera = nx.camera; this.controls = nx.controls;
    this.controls.enabled = true; this.gizmo.camera = this.camera; this.anim = null;
    this.updatePaneMark();
  }
  updatePaneMark() {
    const split = this.layout !== 'single', m = this.paneMark;
    m.style.display = split ? 'block' : 'none';
    if (!split) return;
    const q = this.paneRects()[this.active];
    Object.assign(m.style, { left: q.x + 'px', top: q.y + 'px', width: q.w + 'px', height: q.h + 'px' });
  }
  /** Run fn once for every pane with that pane active, then restore the active one. */
  eachPane(fn) {
    const keep = this.active;
    this.panes.forEach((pn, i) => { if (pn) { this.activate(i); fn(i); } });
    this.activate(keep);
  }
  // Zoom so the pixel rectangle (canvas coords) fills the view.
  zoomToRect(x0, y0, x1, y1) {
    const r = this.rect();
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (w < 6 || h < 6) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const ndc = new THREE.Vector2((cx / r.width) * 2 - 1, -(cy / r.height) * 2 + 1);
    const cam = this.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane(dir.clone().negate(), dir.clone().negate().dot(this.controls.target));
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam);
    const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    const f = Math.max(w / r.width, h / r.height);
    const dist = cam.position.distanceTo(this.controls.target) * Math.max(f, 0.02);
    this.flyTo({ target: hit, q: this.anim ? this.anim.q1 : cam.quaternion.clone(), dist });
  }

  /** Reference images ("canvases") on a plane. items: [{id, plane, offset, x, y, width, opacity, image, aspect, hidden}] */
  setCanvases(items) {
    if (!this.canvasGroup) { this.canvasGroup = new THREE.Group(); this.scene.add(this.canvasGroup); this.texCache = new Map(); }
    for (const c of [...this.canvasGroup.children]) { c.geometry.dispose(); c.material.dispose(); this.canvasGroup.remove(c); }
    for (const it of items) {
      if (it.hidden || !it.image) continue;
      const key = it.image.length + ':' + it.image.slice(-48);
      let tex = this.texCache.get(key);
      if (!tex) { tex = new THREE.TextureLoader().load(it.image, () => { this.dirtyCanvas = true; }); tex.colorSpace = THREE.SRGBColorSpace; this.texCache.set(key, tex); }
      const w = it.width || 100, h = w * (it.aspect || 1);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: it.opacity ?? 0.5, side: THREE.DoubleSide, depthWrite: false }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(this.planeMatrix({ plane: it.plane, offset: it.offset || 0 })).multiply(new THREE.Matrix4().makeTranslation(it.x || 0, it.y || 0, 0));
      mesh.renderOrder = -3; mesh.raycast = () => {};
      this.canvasGroup.add(mesh);
    }
  }
  /** Offset-plane features drawn as translucent squares; clickable while picking a sketch plane. items: [{id,name,origin,normal,xdir,hidden}] */
  /** Slice (while sketching): hide the part of every body on the viewer's side of a plane, so the sketch sits on the cut. fr = { o, n } or null. */
  setSlice(fr) {
    let plane = null;
    if (fr) {
      const n = new THREE.Vector3(...fr.n).normalize(), o = new THREE.Vector3(...fr.o), toCam = this.camera.position.clone().sub(o);
      if (n.dot(toCam) > 0) n.negate(); // keep the side away from the camera
      plane = new THREE.Plane(n, -n.dot(o));
    }
    if (plane && this.slicePlane && plane.equals(this.slicePlane)) return; // nothing moved
    const was = !!this.slicePlane;
    this.slicePlane = plane;
    if (plane || was) this.refreshMaterials();
  }
  /** Construction axes (a long line through a point) and construction points (a small cross). */
  setConstructionLines(items) {
    if (!this.constructionLines) { this.constructionLines = new THREE.Group(); this.scene.add(this.constructionLines); }
    for (const c of [...this.constructionLines.children]) { c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.constructionLines.remove(c); }
    const size = Math.max(this.bounds().getSize(new THREE.Vector3()).length(), 60), half = size * 0.75;
    for (const it of items) {
      const o = new THREE.Vector3(...it.origin), g = new THREE.Group();
      if (it.kind === 'axis') {
        const d = new THREE.Vector3(...it.dir).normalize();
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o.clone().addScaledVector(d, -half), o.clone().addScaledVector(d, half)]), new THREE.LineDashedMaterial({ color: 0xd2691e, dashSize: size / 60, gapSize: size / 120 }));
        line.computeLineDistances(); line.raycast = () => {}; g.add(line);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(size / 90, size / 30, 10), new THREE.MeshBasicMaterial({ color: 0xd2691e }));
        tip.position.copy(o).addScaledVector(d, half); tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d); tip.raycast = () => {}; g.add(tip);
      } else {
        const r = size / 70, pts = [[-r, 0, 0], [r, 0, 0], [0, -r, 0], [0, r, 0], [0, 0, -r], [0, 0, r]].map((q) => new THREE.Vector3(...q).add(o));
        const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd2691e, depthTest: false }));
        cross.renderOrder = 12; cross.raycast = () => {}; g.add(cross);
      }
      g.userData.ref = it.id; g.visible = !it.hidden;
      this.constructionLines.add(g);
    }
  }
  setConstructionPlanes(items) {
    if (!this.constructionGroup) { this.constructionGroup = new THREE.Group(); this.scene.add(this.constructionGroup); }
    for (const c of [...this.constructionGroup.children]) { c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.constructionGroup.remove(c); }
    for (const it of items) {
      const n = new THREE.Vector3(...it.normal).normalize(), x = new THREE.Vector3(...it.xdir).normalize(), y = new THREE.Vector3().crossVectors(n, x);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial({ color: 0x2fa0c8, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(x, y, n).setPosition(new THREE.Vector3(...it.origin).addScaledVector(x, 25).addScaledVector(y, 25));
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(50, 50)), new THREE.LineBasicMaterial({ color: 0x1b7f9e }));
      m.add(e);
      m.userData.ref = it.id; m.userData.geo = { origin: it.origin, normal: it.normal, xdir: it.xdir };
      m.visible = !it.hidden;
      this.constructionGroup.add(m);
    }
  }
  buildPlaneHandles() {
    this.planeHandles = new THREE.Group();
    const cols = { XY: 0x3b78e0, XZ: 0x3aa655, YZ: 0xe0453a };
    for (const [k, p] of Object.entries(PLANES)) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial({ color: cols[k], transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      m.userData.plane = k;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rot.map((d) => (d * Math.PI) / 180), 'ZYX'));
      m.quaternion.copy(q);
      m.position.set(...[0, 0, 0]);
      m.translateX(25); m.translateY(25);
      this.planeHandles.add(m);
    }
    this.planeHandles.visible = false;
    this.scene.add(this.planeHandles);
  }

  buildBed() {
    this.bedObj?.removeFromParent();
    const [x, y, z] = this.opts.bedSize;
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(x, y), new THREE.MeshBasicMaterial({ color: 0x2f3640, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)), new THREE.LineBasicMaterial({ color: 0xf08c00, transparent: true, opacity: 0.8 }));
    box.position.z = z / 2;
    g.add(plate, box);
    g.visible = this.opts.bed;
    this.bedObj = g;
    this.scene.add(g);
  }

  // ---- bodies ----
  disposeMesh(m) { m.traverse((o) => { o.geometry?.dispose(); }); m.userData.lod?.dispose(); m.userData.full?.dispose(); }
  /** For a very big model: make a coarse copy of each heavy body in a quiet moment, to draw while the camera moves. */
  prepareLOD() {
    const meshes = this.bodyGroup.children, total = meshes.reduce((a, m) => a + m.userData.src.tris.length / 3, 0);
    this.lodOn = total >= LOD_TOTAL;
    if (!this.lodOn) return;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 50));
    for (const m of meshes) {
      if (m.userData.lod || m.userData.src.tris.length / 3 < LOD_MIN) continue;
      idle(() => {
        if (m.userData.lod || !m.parent) return;
        const c = clusterMesh(m.userData.src.verts, m.userData.src.tris);
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(c.verts, 3)); g.setIndex(new THREE.BufferAttribute(c.tris, 1)); g.computeVertexNormals();
        m.userData.lod = g;
      });
    }
  }
  /** Swap heavy bodies for their coarse copies while the camera is being moved, and back when it stops. */
  setMoving(on) {
    if (!this.lodOn && !this.lodSwapped) return;
    for (const m of this.bodyGroup.children) {
      const lod = m.userData.lod;
      if (!lod) continue;
      if (on && !m.userData.full) { m.userData.full = m.geometry; m.geometry = lod; for (const c of m.children) c.visible = false; }
      else if (!on && m.userData.full) { m.geometry = m.userData.full; m.userData.full = null; for (const c of m.children) c.visible = true; }
    }
    this.lodSwapped = on;
  }
  /**
   * A stand-in while the exact rebuild runs: the body's current mesh moved by `translate` and stretched by `scale` about `about` (world
   * coordinates), with no kernel involved. setBodies puts every body back as the kernel made it, so the exact result replaces the stand-in.
   */
  previewBody(id, { translate = [0, 0, 0], scale = [1, 1, 1], about = [0, 0, 0] } = {}) {
    const mesh = this.bodyGroup.children.find((c) => c.userData.id === id && !c.userData.surface);
    if (!mesh) return false;
    const m = new THREE.Matrix4().makeTranslation(...translate).multiply(new THREE.Matrix4().makeTranslation(...about)).multiply(new THREE.Matrix4().makeScale(...scale)).multiply(new THREE.Matrix4().makeTranslation(-about[0], -about[1], -about[2]));
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(m); mesh.matrixWorldNeedsUpdate = true; mesh.userData.previewed = true;
    return true;
  }
  clearBodyPreviews() {
    for (const c of this.bodyGroup.children) if (c.userData.previewed) { c.matrixAutoUpdate = true; c.matrix.identity(); c.position.set(0, 0, 0); c.scale.set(1, 1, 1); c.updateMatrix(); c.userData.previewed = false; }
  }
  /** The centre of a body's bounding box as drawn (what Scale and Move stretch about). */
  bodyCentre(id) {
    const mesh = this.bodyGroup.children.find((c) => c.userData.id === id && !c.userData.surface);
    const b = mesh?.userData.src; if (!b) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < b.verts.length; i += 3) for (let k = 0; k < 3; k++) { const v = b.verts[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    return lo.map((v, k) => (v + hi[k]) / 2);
  }
  setBodies(bodies) {
    this.clearBodyPreviews();
    // A body whose shape did not change keeps its mesh (same key from the kernel): building the smooth normals and the edge
    // lines of a big body is the slow part, and most edits change one body of many.
    const old = new Map();
    for (const c of [...this.bodyGroup.children]) { this.bodyGroup.remove(c); if (c.userData.key) old.set(c.userData.key, c); else this.disposeMesh(c); }
    const kept = new Set();
    for (const b of bodies) {
      let mesh = b.key ? old.get(b.key) : null;
      if (mesh && !!mesh.userData.surface === !!b.surface && mesh.userData.src.tris.length === b.tris.length) { mesh.userData.id = b.id; kept.add(b.key); this.bodyGroup.add(mesh); continue; }
      let geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.verts, 3));
      geo.setIndex(new THREE.BufferAttribute(b.tris, 1));
      geo = toCreasedNormals(geo, (35 * Math.PI) / 180);
      mesh = new THREE.Mesh(geo, this.mats.body);
      mesh.userData.id = b.id; mesh.userData.surface = !!b.surface; mesh.userData.key = b.key || null; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.src = { verts: b.verts, tris: b.tris, ...(b.faceOf && b.faceOf.length === b.tris.length / 3 ? { faceOf: b.faceOf, faces: b.faces } : {}) }; // an exact (B-rep) body also knows which of its faces each triangle is on
      if (b.tris.length / 3 >= BVH_MIN) mesh.raycast = bvhRaycast; // big body: pick through a tree (built on first use)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), this.mats.edge);
      edges.raycast = () => {};
      mesh.add(edges);
      if (b.key) kept.add(b.key);
      this.bodyGroup.add(mesh);
    }
    for (const [k, m] of old) if (!kept.has(k)) this.disposeMesh(m);
    this.prepareLOD();
    if (this.facePaint?.length || this.paintGroup?.children.length) this.rebuildFacePaint(); else this.refreshMaterials();
    this.rebuildSection();
    if (this.opts.render) this.fitRenderLights();
    if (!this.fitted && bodies.length) { this.fit(); this.fitted = true; }
  }

  // ---- section analysis: clip plane + stencil-capped cut face
  setSection(sec) { // {axis:'X'|'Y'|'Z', offset, flip} or null
    this.section = null;
    if (sec) {
      const n = new THREE.Vector3(); n['xyz'['XYZ'.indexOf(sec.axis)]] = sec.flip ? 1 : -1;
      this.section = { ...sec, plane: new THREE.Plane(n, -n.dot(this.sectionAxisVec(sec.axis).multiplyScalar(sec.offset))) };
    }
    this.refreshMaterials(); this.rebuildSection();
  }
  sectionAxisVec(a) { const v = new THREE.Vector3(); v['xyz'['XYZ'.indexOf(a)]] = 1; return v; }
  rebuildSection() {
    if (this.sectionGroup) { this.scene.remove(this.sectionGroup); this.sectionGroup.traverse((o) => o.material?.dispose?.()); this.sectionGroup = null; }
    if (!this.section) return;
    const g = new THREE.Group(), plane = this.section.plane;
    const stencil = (side, op) => new THREE.MeshBasicMaterial({ side, colorWrite: false, depthWrite: false, depthTest: false, clippingPlanes: [plane], stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op });
    for (const m of this.bodyGroup.children) {
      const back = new THREE.Mesh(m.geometry, stencil(THREE.BackSide, THREE.IncrementWrapStencilOp));
      const front = new THREE.Mesh(m.geometry, stencil(THREE.FrontSide, THREE.DecrementWrapStencilOp));
      for (const x of [back, front]) { x.renderOrder = 1; x.raycast = () => {}; g.add(x); }
    }
    const size = this.bounds().getSize(new THREE.Vector3()).length() * 4 + 100;
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: 0xe0584d, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp }));
    cap.renderOrder = 1.1; cap.raycast = () => {};
    const n = plane.normal.clone();
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    plane.coplanarPoint(cap.position);
    cap.onAfterRender = (r) => r.clearStencil();
    g.add(cap);
    this.sectionGroup = g; this.scene.add(g);
  }

  // Per-body appearance (doc.appearance): a material, a colour and/or a texture; falls back to the default grey material.
  bodyMat(id) {
    const lk = look(this.bodyColors?.[id]);
    return lk.custom ? this.matFor(lk) : this.mats.body;
  }
  /** One shared material per look. overlay: for a painted face, drawn just in front of the body's own surface. */
  matFor(lk, overlay = false) {
    this.colorMats ||= {};
    const key = `${overlay ? 'p' : 'b'}|${lk.color}|${lk.metalness}|${lk.roughness}|${lk.opacity}|${lk.texture || ''}|${lk.texSize || 0}`;
    if (!this.colorMats[key]) {
      const m = new THREE.MeshStandardMaterial({ color: lk.color, metalness: lk.metalness, roughness: lk.roughness, transparent: lk.opacity < 1, opacity: lk.opacity, side: THREE.DoubleSide, depthWrite: lk.opacity >= 1, ...(overlay ? { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } : {}) });
      if (lk.metalness > 0.2) { m.envMap = this.ensureEnv(); m.envMapIntensity = 0.9; }
      if (lk.texture) this.applyTexture(m, lk.texture, lk.texSize);
      this.colorMats[key] = m;
    }
    return this.colorMats[key];
  }
  /** The soft studio reflections used by render mode, also given to metals in the working view (a metal with nothing to reflect looks black). */
  ensureEnv() {
    if (!this.envTex) { const pm = new THREE.PMREMGenerator(this.renderer); this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); }
    return this.envTex;
  }
  /** Map a texture onto a material from where the surface is in space (a box projection), so no UV coordinates are needed. */
  applyTexture(m, id, size) {
    this.texCache ||= {};
    if (!this.texCache[id]) {
      const def = textureById(id), n = 256, cv = document.createElement('canvas');
      cv.width = cv.height = n; def.draw(cv.getContext('2d'), n);
      const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      this.texCache[id] = t;
    }
    const tex = this.texCache[id];
    m.onBeforeCompile = (sh) => {
      sh.uniforms.triTex = { value: tex }; sh.uniforms.triSize = { value: size };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nuniform sampler2D triTex;\nuniform float triSize;')
        .replace('#include <map_fragment>', `vec3 triN = abs(normalize(cross(dFdx(vTriPos), dFdy(vTriPos))));
          vec3 triW = pow(triN, vec3(16.0)); triW /= (triW.x + triW.y + triW.z);
          vec4 triC = texture2D(triTex, vTriPos.yz / triSize) * triW.x + texture2D(triTex, vTriPos.xz / triSize) * triW.y + texture2D(triTex, vTriPos.xy / triSize) * triW.z;
          diffuseColor *= triC;`);
    };
    m.customProgramCacheKey = () => 'tri' + id + size;
  }
  /** Painted faces: [{ body, point, normal, color?, material?, texture?, texSize? }], drawn over the body they belong to. */
  setFacePaint(list) { this.facePaint = list || []; this.rebuildFacePaint(); }
  rebuildFacePaint() {
    if (!this.paintGroup) { this.paintGroup = new THREE.Group(); this.scene.add(this.paintGroup); }
    for (const c of [...this.paintGroup.children]) { c.geometry.dispose(); this.paintGroup.remove(c); }
    for (const f of this.facePaint || []) {
      const lk = look(f), mesh = lk.custom && this.bodyGroup.children.find((c) => c.userData.id === f.body);
      if (!mesh || !mesh.userData.src) continue;
      const { verts, tris } = mesh.userData.src, ft = this.faceTris(mesh, f);
      if (!ft) continue;
      const pos = [];
      for (const t of ft) for (let k = 0; k < 3; k++) { const vi = tris[t * 3 + k]; pos.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]); }
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g = f.curved ? toCreasedNormals(g, (35 * Math.PI) / 180) : (g.computeVertexNormals(), g); // a curved face shades smoothly like the body does
      const m = new THREE.Mesh(g, this.matFor(lk, true));
      m.raycast = () => {}; m.renderOrder = 1;
      this.paintGroup.add(m);
    }
    this.refreshMaterials();
  }
  /**
   * Render mode: image-based lighting, a fixed sun with soft shadows on a ground plane, filmic tone mapping, and no grid,
   * edges or origin marks. Off is the normal working view.
   */
  setRender(on) {
    this.opts.render = !!on;
    if (on) this.ensureEnv();
    this.scene.environment = on ? this.envTex : null;
    this.renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !!on; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (!this.renderSun) {
      this.renderSun = new THREE.DirectionalLight(0xfff4e8, 2.4);
      this.renderSun.castShadow = true; this.renderSun.shadow.mapSize.set(2048, 2048); this.renderSun.shadow.bias = -0.0004; this.renderSun.shadow.radius = 4;
      this.scene.add(this.renderSun, this.renderSun.target);
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.ShadowMaterial({ opacity: 0.3 }));
      this.ground.receiveShadow = true; this.scene.add(this.ground);
    }
    this.renderSun.visible = !!on; this.ground.visible = !!on;
    this.camLight.intensity = on ? 0.35 : 1.7;
    this.fitRenderLights();
    this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    this.refreshMaterials();
  }
  /** Aim the shadow-casting sun at the model and size its shadow map to it. */
  fitRenderLights() {
    if (!this.renderSun) return;
    const b = this.bounds(), c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 10);
    this.renderSun.target.position.copy(c);
    this.renderSun.position.copy(c).add(new THREE.Vector3(0.55, -0.45, 0.85).normalize().multiplyScalar(r * 4));
    const sc = this.renderSun.shadow.camera; sc.left = -r * 1.5; sc.right = r * 1.5; sc.top = r * 1.5; sc.bottom = -r * 1.5; sc.near = r * 0.5; sc.far = r * 9; sc.updateProjectionMatrix();
    this.ground.position.set(c.x, c.y, b.isEmpty() ? 0 : b.min.z - 0.01);
  }
  /** A PNG data URL of the current view at the given size. background: a CSS colour, or null for transparent. */
  snapshot({ width = 1920, height = 1080, background = null, clean = true } = {}) {
    const r = this.renderer, size = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio(), cam = this.camera;
    const hide = clean ? [this.sketchGroup, this.overlay, this.planeHandles, this.originGroup, this.faceHL, this.edgeSelGroup, this.measureGroup, this.manipGroup, this.profileGroup, this.previewGroup, this.gizmo.getHelper(), ...(this.opts.render ? [this.grid, this.originMarks] : [])] : [];
    const was = hide.map((o) => o?.visible); hide.forEach((o) => o && (o.visible = false));
    const aspect0 = this.persp.aspect;
    r.setPixelRatio(1); r.setSize(width, height, false);
    this.persp.aspect = width / height; this.persp.updateProjectionMatrix(); this.updateOrtho();
    if (background) r.setClearColor(background, 1); else r.setClearColor(0x000000, 0);
    r.setScissorTest(false); r.setViewport(0, 0, width, height);
    cam.updateMatrixWorld(); r.render(this.scene, cam);
    const url = r.domElement.toDataURL('image/png');
    r.setClearColor(0x000000, 0);
    hide.forEach((o, i) => o && (o.visible = was[i]));
    r.setPixelRatio(pr); r.setSize(size.x, size.y, false);
    this.persp.aspect = aspect0; this.persp.updateProjectionMatrix(); this.updateOrtho();
    return url;
  }
  refreshMaterials() {
    for (const m of this.bodyGroup.children) {
      const sel = this.selected.has(m.userData.id);
      m.material = sel ? this.mats.sel : m.userData.id === this.hover ? this.mats.hover : m.userData.surface ? this.mats.surface : this.bodyMat(m.userData.id);
      const e = m.children[0];
      e.visible = this.opts.edges && !this.opts.render;
      e.material = sel ? this.mats.edgeSel : this.mats.edge;
    }
    const clip = this.section ? [this.section.plane] : this.slicePlane ? [this.slicePlane] : null;
    for (const mm of [this.mats.surface, this.mats.body, this.mats.sel, this.mats.hover, this.mats.edge, this.mats.edgeSel, ...Object.values(this.colorMats || {})]) {
      if ((mm.clippingPlanes === null) !== (clip === null)) mm.needsUpdate = true;
      mm.clippingPlanes = clip;
    }
    this.mats.body.wireframe = this.mats.sel.wireframe = this.mats.hover.wireframe = this.opts.wire;
    for (const mm of Object.values(this.colorMats || {})) mm.wireframe = this.opts.wire;
    this.grid.visible = this.opts.grid && !this.hideGround && !this.opts.render;
    if (this.originMarks) this.originMarks.visible = !!this.originOn && !this.opts.render;
    if (this.bedObj) this.bedObj.visible = this.opts.bed;
  }

  pickBody(ev) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    return hit ? { id: hit.object.userData.id, point: hit.point, normal: hit.face?.normal?.toArray(), distance: hit.distance } : null;
  }
  // Planar face under the cursor: {id, point, normal, tris, mesh, face:true} | {curved:true, ...} | null
  pickPlanarFace(ev) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    if (!hit) return null;
    const id = hit.object.userData.id;
    const src = hit.object.userData.src;
    const r4 = (v) => +v.toFixed(4);
    const face = planarFace(src.verts, src.tris, hit.faceIndex);
    if (!face) return { curved: true, id, point: hit.point.toArray().map(r4), normal: hit.face.normal.toArray().map(r4) };
    const n = face.normal.map((c) => +c.toFixed(6));
    const bf = src.faceOf && src.faces[src.faceOf[hit.faceIndex]]; // an exact body: remember which B-rep face this is
    return { face: true, id, point: hit.point.toArray().map(r4), normal: n, tris: face.tris, mesh: hit.object, ...(bf ? { brepFace: bf.key } : {}) };
  }
  /** Like pickPlanarFace, but a curved surface gives its whole curved face too ({face, curved: true, tris, mesh}). */
  pickFace(ev) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    if (!hit) return null;
    const id = hit.object.userData.id, src = hit.object.userData.src, r4 = (v) => +v.toFixed(4);
    if (src.faceOf) { // an exact body: the face is the B-rep face, flat or curved, with a key that survives a rebuild
      const gi = src.faceOf[hit.faceIndex], meta = src.faces[gi], tris = this.brepFaceTris(src, gi);
      if (meta && tris.length) {
        const curved = meta.type !== 'PLANE';
        return { face: true, ...(curved ? { curved: true, tangent: this.smoothNormalAt(hit) } : {}), brepFace: meta.key, id, point: hit.point.toArray().map(r4), normal: hit.face.normal.toArray().map((c) => +c.toFixed(6)), tris, mesh: hit.object };
      }
    }
    const face = faceOf(src.verts, src.tris, hit.faceIndex);
    if (!face) return null;
    if (face.curved) return { face: true, curved: true, id, point: face.point, normal: face.normal, tris: face.tris, mesh: hit.object };
    return { face: true, id, point: hit.point.toArray().map(r4), normal: face.normal.map((c) => +c.toFixed(6)), tris: face.tris, mesh: hit.object };
  }
  /** The surface normal at a ray hit, interpolated from the smoothed vertex normals of its triangle (the flat triangle normal is up to the tessellation angle off the true surface). */
  smoothNormalAt(hit) {
    const g = hit.object.geometry, nA = g.attributes.normal, pA = g.attributes.position, f = hit.face;
    if (!nA || !f) return hit.face.normal.toArray().map((c) => +c.toFixed(6));
    const a = new THREE.Vector3().fromBufferAttribute(pA, f.a), b = new THREE.Vector3().fromBufferAttribute(pA, f.b), c = new THREE.Vector3().fromBufferAttribute(pA, f.c);
    const bary = new THREE.Vector3(); THREE.Triangle.getBarycoord(hit.point, a, b, c, bary);
    const n = new THREE.Vector3().fromBufferAttribute(nA, f.a).multiplyScalar(bary.x).add(new THREE.Vector3().fromBufferAttribute(nA, f.b).multiplyScalar(bary.y)).add(new THREE.Vector3().fromBufferAttribute(nA, f.c).multiplyScalar(bary.z));
    return n.lengthSq() > 1e-12 ? n.normalize().toArray().map((q) => +q.toFixed(6)) : hit.face.normal.toArray().map((q) => +q.toFixed(6));
  }
  /** The triangles of B-rep face number `gi` of a body mesh. */
  brepFaceTris(src, gi) {
    const out = [];
    for (let t = 0; t < src.faceOf.length; t++) if (src.faceOf[t] === gi) out.push(t);
    return out;
  }
  /** The triangles of a stored face {point, normal, curved?, brepFace?} on a body mesh now, or null. */
  faceTris(mesh, f) {
    const { verts, tris, faces } = mesh.userData.src;
    if (f.brepFace && faces) { const gi = matchBrepFace(faces, f); if (gi >= 0) return this.brepFaceTris(mesh.userData.src, gi); } // an exact body: the face by its key
    if (f.curved) { const t = findCurvedTri(verts, tris, f.point, f.normal); const c = t >= 0 ? curvedFace(verts, tris, t) : null; return c ? c.tris : null; }
    const t = findFaceTri(verts, tris, f.point, f.normal), pf = t >= 0 ? planarFace(verts, tris, t) : null;
    return pf ? pf.tris : null;
  }
  // Closest mesh vertex to the cursor (within `px` pixels) or the surface hit: {point, vertex, id}
  /** Where the mouse ray meets the horizontal plane z = `z` (for picking in empty space): [x, y, z] or null. */
  pickHorizontal(ev, z = 0) {
    this.setRay(ev);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p) ? p.toArray() : null;
  }
  pickSnap(ev, px = 12) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    if (!hit) return null;
    const src = hit.object.userData.src;
    const r = this.rect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = px;
    for (let k = 0; k < 3; k++) {
      const vi = src.tris[hit.faceIndex * 3 + k];
      const v = new THREE.Vector3(src.verts[vi * 3], src.verts[vi * 3 + 1], src.verts[vi * 3 + 2]);
      const q = v.clone().project(this.camera);
      const d = Math.hypot((q.x + 1) / 2 * r.width - mx, (1 - q.y) / 2 * r.height - my);
      if (d < bd) { bd = d; best = v; }
    }
    return { id: hit.object.userData.id, point: (best || hit.point).toArray(), vertex: !!best };
  }
  /** Is this world point in view, not hidden behind a body? */
  _visible(pt) {
    const dir = pt.clone().sub(this.camera.position), dd = dir.length();
    if (!this.opts.ortho) { this.ray.set(this.camera.position, dir.normalize()); const h = this.ray.intersectObjects(this.bodyGroup.children, false)[0]; return !(h && h.distance < dd - 0.05); }
    const cd = new THREE.Vector3(); this.camera.getWorldDirection(cd);
    this.ray.set(pt.clone().addScaledVector(cd, -5000), cd);
    const h = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    return !(h && h.distance < 5000 - 0.05);
  }
  /**
   * Snap a point to the model near the cursor: first a corner (a vertex where edges meet), then anywhere along an edge, then the
   * point under the cursor on a face. `entries` are edge chains ({body, chain}). Returns { point, kind: 'corner'|'edge'|'face', id, normals }
   * where `normals` are the normals of the faces meeting there (to choose which face a hole goes on).
   */
  snapAt(ev, entries, px = 14) {
    const r = this.rect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const proj = (p) => { const v = p.clone().project(this.camera); return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, z: v.z }; };
    let corner = null, cd = px;
    for (const e of entries) {
      const ends = e.chain.closed ? e.chain.pts : e.chain.pts;
      for (let i = 0; i < ends.length; i++) {
        const P = new THREE.Vector3(...ends[i]), q = proj(P);
        if (q.z > 1) continue;
        const d = Math.hypot(q.x - mx, q.y - my);
        if (d < cd && this._visible(P)) { cd = d; corner = { point: ends[i], id: e.body, frame: e.chain.frames?.[i] }; }
      }
    }
    if (corner) return { point: [...corner.point], kind: 'corner', id: corner.id, normals: corner.frame ? [corner.frame.n1, corner.frame.n2] : [] };
    let edge = null, ed = px;
    for (const e of entries) {
      const P = e.chain.pts.map((p) => new THREE.Vector3(...p));
      if (e.chain.closed) P.push(P[0]);
      for (let i = 0; i < P.length - 1; i++) {
        const a = proj(P[i]), b = proj(P[i + 1]);
        if (a.z > 1 || b.z > 1) continue;
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / l2));
        const d = Math.hypot(a.x + dx * t - mx, a.y + dy * t - my);
        if (d < ed) { const pt = P[i].clone().lerp(P[i + 1], t); if (this._visible(pt)) { ed = d; edge = { point: pt.toArray(), id: e.body, frame: e.chain.frames?.[Math.min(i, e.chain.frames.length - 1)] }; } }
      }
    }
    if (edge) return { point: edge.point.map((v) => +v.toFixed(4)), kind: 'edge', id: edge.id, normals: edge.frame ? [edge.frame.n1, edge.frame.n2] : [] };
    const f = this.pickSnap(ev);
    return f ? { point: f.point, kind: 'face', id: f.id, normals: [] } : null;
  }
  /** A small marker showing where a snap would land (orange corner, blue edge, grey face); null hides it. */
  setSnapMarker(sn) {
    if (!this.snapMarker) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      this.snapMarker = new THREE.Points(g, new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, depthTest: false, transparent: true }));
      this.snapMarker.renderOrder = 10; this.snapMarker.frustumCulled = false; this.snapMarker.visible = false;
      this.scene.add(this.snapMarker);
    }
    if (!sn) { this.snapMarker.visible = false; return; }
    this.snapMarker.geometry.attributes.position.array.set(sn.point); this.snapMarker.geometry.attributes.position.needsUpdate = true;
    this.snapMarker.material.color.set(sn.kind === 'corner' ? 0xf08c00 : sn.kind === 'edge' ? 0x0b6bcb : 0x8a9099);
    this.snapMarker.visible = true;
  }
  // ---- sketch profile regions (shaded, pickable) ----
  // items: [{id, polys}] from kernel.profilesOf; params: sketch plane params.
  setProfiles(items, params, pickable = true) { this.setProfileGroups(items?.length ? [{ items, params, pickable }] : []); }
  /** groups: [{items, params, pickable, sk?}]. With `sk`, mesh ids are "sk|id" so several sketches can be shown and picked together. */
  setProfileGroups(groups) {
    for (const c of [...this.profileGroup.children]) { c.geometry.dispose(); c.material.dispose(); this.profileGroup.remove(c); }
    this.profileMeshes = [];
    for (const { items, params, pickable = true, sk } of groups) {
      if (!items?.length) continue;
      const M = this.planeMatrix(params);
      for (const it of items) {
        const area = (pl) => pl.reduce((a, [x1, y1], i) => { const [x2, y2] = pl[(i + 1) % pl.length]; return a + (x1 * y2 - x2 * y1); }, 0) / 2;
        const outers = it.polys.filter((pl) => area(pl) > 0), holes = it.polys.filter((pl) => area(pl) < 0);
        for (const o of outers) {
          const shape = new THREE.Shape(o.map(([x, y]) => new THREE.Vector2(x, y)));
          for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
          const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x5aa7ee, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, depthTest: !pickable, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
          mesh.matrixAutoUpdate = false;
          mesh.matrix.copy(M);
          mesh.userData.pid = sk ? `${sk}|${it.id}` : it.id;
          mesh.userData.rawId = it.id; mesh.userData.sk = sk || null;
          mesh.userData.pickable = pickable;
          mesh.renderOrder = 2;
          if (!pickable) mesh.raycast = () => {};
          this.profileGroup.add(mesh);
          this.profileMeshes.push(mesh);
        }
      }
    }
  }
  setProfileState(selected, hover) {
    for (const m of this.profileMeshes || []) {
      const id = m.userData.pid, sel = selected?.has(id), hov = id === hover;
      m.material.opacity = m.userData.pickable ? (sel ? 0.8 : hov ? 0.4 : 0.14) : sel ? 0.62 : hov ? 0.5 : 0.28;
      m.material.color.setHex(sel ? 0x2f7fe0 : hov ? 0x3c93f2 : 0x5aa7ee);
    }
  }
  /** Like pickProfile but returns {sk, id, key, distance} so callers can compare against body hits. */
  pickProfileAt(ev) {
    if (!this.profileMeshes?.length) return null;
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.profileMeshes.filter((m) => m.userData.pickable), false)[0];
    return hit ? { sk: hit.object.userData.sk, id: hit.object.userData.rawId, key: hit.object.userData.pid, distance: hit.distance } : null;
  }
  pickProfile(ev) {
    if (!this.profileMeshes?.length) return null;
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.profileMeshes.filter((m) => m.userData.pickable), false)[0];
    return hit ? hit.object.userData.pid : null;
  }

  /** Show what changed between two versions: kept volume grey, added blue, removed red. Pass null to go back to the design. */
  setCompare(c) {
    if (this.compareGroup) { this.scene.remove(this.compareGroup); this.compareGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); this.compareGroup = null; }
    this.bodyGroup.visible = !c;
    if (!c) return;
    const g = new THREE.Group();
    const add = (part, color, opacity, order) => {
      if (!part) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(part.verts, 3)); geo.setIndex(new THREE.BufferAttribute(part.tris, 1)); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, roughness: 0.7, depthWrite: opacity >= 1 }));
      m.renderOrder = order; m.raycast = () => {};
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: color === 0x2f7cf6 ? 0x1c4fb8 : color === 0xe0453a ? 0xa8281f : 0x555a62 })));
      g.add(m);
    };
    add(c.kept, 0x9aa0a8, 0.35, 3); add(c.added, 0x2f7cf6, 0.9, 4); add(c.removed, 0xe0453a, 0.9, 4);
    this.compareGroup = g; this.scene.add(g);
  }

  /** Outline the bodies an extrude or cut is acting on, so the dialog's "Cuts from Body 2" can be seen in the viewport. */
  setNoteBodies(ids) {
    if (this.noteGroup) { this.scene.remove(this.noteGroup); this.noteGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); this.noteGroup = null; }
    if (!ids?.length) return;
    const g = new THREE.Group();
    for (const m of this.bodyGroup.children) {
      if (!ids.includes(m.userData.id)) continue;
      const box = new THREE.Box3().setFromObject(m), h = new THREE.Box3Helper(box, 0xf2b01e);
      h.material.depthTest = false; h.renderOrder = 12; h.raycast = () => {};
      g.add(h);
    }
    this.noteGroup = g; this.scene.add(g);
  }

  // Selected (red) and hovered (orange) model edges outside of commands. chains: [{pts, closed}]
  showEdges(selected, hover) {
    for (const c of [...this.edgeSelGroup.children]) { c.geometry.dispose(); this.edgeSelGroup.remove(c); }
    const sz = this.bounds().getSize(new THREE.Vector3()).length();
    const draw = (chain, color, k) => {
      const pts = chain.pts.map((p) => new THREE.Vector3(...p));
      if (chain.closed) pts.push(pts[0].clone());
      if (pts.length < 2) return;
      const path = new THREE.CurvePath();
      for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(2, pts.length * 2), Math.max(sz * 0.004 * k, 0.15 * k), 6, false), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      tube.raycast = () => {}; tube.renderOrder = 11;
      this.edgeSelGroup.add(tube);
    };
    for (const c of selected || []) draw(c, 0xe0453a, 1.15);
    if (hover) draw(hover, 0x1d8cf8, 1);
  }

  // ---- feature preview (translucent tool solid) ----
  setPreview(pv) {
    for (const c of [...this.previewGroup.children]) { c.traverse((o) => o.geometry?.dispose()); this.previewGroup.remove(c); }
    if (!pv) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pv.verts, 3));
    g.setIndex(new THREE.BufferAttribute(pv.tris, 1));
    g.computeVertexNormals();
    const cut = pv.op === 'cut';
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: cut ? 0xe0453a : 0x2f7cf6, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, roughness: 0.7 }));
    m.raycast = () => {};
    m.renderOrder = 3;
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: cut ? 0xa8281f : 0x1c4fb8 }));
    e.raycast = () => {};
    m.add(e);
    this.previewGroup.add(m);
  }

  /**
   * Stretch the translucent tool solid by `k` along the unit vector `n` about the point `o` (a stand-in for a straight extrusion whose distance
   * changed). With `two` ({ k2, side1 }) the solid has two sides with their own distances: the side the distance points to (`side1` is 1 along
   * `n`, -1 against it) stretches by `k`, the other side by `k2`.
   */
  previewToolStretch(o, n, k, two) {
    const N = new THREE.Vector3(...n).normalize(), O = new THREE.Vector3(...o);
    for (const c of this.previewGroup.children) {
      const pos = c.geometry.getAttribute('position');
      if (!c.userData.base) c.userData.base = pos.array.slice();
      const base = c.userData.base, arr = pos.array, v = new THREE.Vector3();
      for (let i = 0; i < base.length; i += 3) {
        v.set(base[i], base[i + 1], base[i + 2]).sub(O);
        const t = v.dot(N), f = two && Math.sign(t || 1) !== two.side1 ? two.k2 : k;
        v.addScaledVector(N, t * (f - 1)).add(O);
        arr[i] = v.x; arr[i + 1] = v.y; arr[i + 2] = v.z;
      }
      pos.needsUpdate = true; c.geometry.computeBoundingSphere();
      const e = c.children[0]; if (e) { e.geometry.dispose(); e.geometry = new THREE.EdgesGeometry(c.geometry, 30); }
    }
  }

  /** A stand-in for a Fillet or Chamfer being rebuilt: a translucent tube of the radius (or distance) along each picked edge, until the kernel's result arrives. */
  previewEdgeSize(chains, r, kind) {
    for (const c of [...this.previewGroup.children]) { c.traverse((o) => o.geometry?.dispose()); this.previewGroup.remove(c); }
    for (const pts of chains) {
      const v = pts.map((p) => new THREE.Vector3(...p));
      if (v.length < 2) continue;
      const path = new THREE.CurvePath();
      for (let i = 0; i < v.length - 1; i++) path.add(new THREE.LineCurve3(v[i], v[i + 1]));
      const m = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(2, v.length * 2), r, kind === 'chamfer' ? 4 : 12, false), new THREE.MeshStandardMaterial({ color: 0x2f7cf6, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.7 }));
      m.raycast = () => {}; m.renderOrder = 3;
      this.previewGroup.add(m);
    }
  }

  // ---- on-canvas distance manipulator (arrow) ----
  setManip(base, dir, dist) {
    for (const c of [...this.manipGroup.children]) { c.traverse((o) => { o.geometry?.dispose(); }); this.manipGroup.remove(c); }
    this.manip = null;
    if (!base) return;
    const n = new THREE.Vector3(...dir).normalize(), p0 = new THREE.Vector3(...base);
    this.manipArgs = [base, dir, dist];
    const H = this.canvas.clientHeight || 600, cam = this.camera;
    const perPx = this.opts.ortho ? (cam.top - cam.bottom) / cam.zoom / H : (2 * cam.position.distanceTo(p0) * Math.tan((cam.fov * Math.PI) / 360)) / H;
    this.manipPx = perPx;
    const size = perPx * 11; // head about 8px wide, slim arrow
    const tip = p0.clone().addScaledVector(n, dist);
    const mat = new THREE.MeshBasicMaterial({ color: 0x0d5bd6, depthTest: false });
    const baseDot = new THREE.Mesh(new THREE.SphereGeometry(size * 0.28, 12, 8), mat);
    baseDot.position.copy(p0); baseDot.renderOrder = 12; baseDot.raycast = () => {};
    this.manipGroup.add(baseDot);
    const sign = dist >= 0 ? 1 : -1;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.07, size * 0.07, Math.max(Math.abs(dist), 0.01), 8), mat);
    const mid = p0.clone().addScaledVector(n, dist / 2);
    shaft.position.copy(mid);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    shaft.quaternion.copy(q);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(size * 0.4, size * 1.1, 16), mat);
    cone.position.copy(tip).addScaledVector(n, sign * size * 0.5);
    cone.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().multiplyScalar(sign)));
    const hit = new THREE.Mesh(new THREE.SphereGeometry(size * 1.3, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.copy(tip).addScaledVector(n, sign * size * 0.4);
    for (const o of [shaft, cone, hit]) { o.renderOrder = 12; this.manipGroup.add(o); }
    shaft.raycast = () => {};
    this.manip = { p0, n, tip, hit, label: tip.clone().addScaledVector(n, sign * size * 1.4) };
  }
  pickManip(ev) {
    if (!this.manip) return false;
    this.setRay(ev);
    return this.ray.intersectObject(this.manip.hit, false).length > 0;
  }
  // Signed distance along the manipulator axis closest to the mouse ray.
  manipDistance(ev) {
    this.setRay(ev);
    const { p0, n } = this.manip, o = this.ray.ray.origin, d = this.ray.ray.direction;
    const w = p0.clone().sub(o), b = n.dot(d), dd = n.dot(w), e = d.dot(w), den = 1 - b * b;
    if (Math.abs(den) < 1e-6) return null;
    return (b * e - dd) / den;
  }
  toScreen(p) {
    const r = this.rect();
    const v = (p.isVector3 ? p.clone() : new THREE.Vector3(...p)).project(this.camera);
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, behind: v.z > 1 };
  }

  // Measurement markers/lines drawn over everything.
  setMeasureOverlay(points, lines) {
    for (const c of [...this.measureGroup.children]) { c.geometry?.dispose(); this.measureGroup.remove(c); }
    const sz = Math.max(this.bounds().getSize(new THREE.Vector3()).length() * 0.008, 0.3);
    for (const p of points) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(sz, 12, 8), new THREE.MeshBasicMaterial({ color: 0xe0453a, depthTest: false }));
      m.position.set(...p); m.renderOrder = 10; m.raycast = () => {};
      this.measureGroup.add(m);
    }
    for (const l of lines) {
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(l.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: 0xe0453a, depthTest: false }));
      ln.renderOrder = 10; ln.raycast = () => {};
      this.measureGroup.add(ln);
    }
  }
  pickPlaneHandle(ev) {
    this.setRay(ev);
    return this.ray.intersectObjects(this.planeHandles.children, false)[0]?.object.userData.plane || null;
  }
  setRay(ev) {
    const r = this.rect();
    this.ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), this.camera);
  }

  // Intersect mouse ray with a sketch plane (params: {plane, offset, origin?, normal?, xdir?}); returns [u, v].
  planePoint(ev, params) {
    this.setRay(ev);
    const { o, x, y, n } = planeFrame(params);
    const nv = new THREE.Vector3(...n);
    const hit = this.ray.ray.intersectPlane(new THREE.Plane(nv, -nv.dot(new THREE.Vector3(...o))), new THREE.Vector3());
    if (!hit) return null;
    const d = hit.sub(new THREE.Vector3(...o));
    return [d.dot(new THREE.Vector3(...x)), d.dot(new THREE.Vector3(...y))];
  }
  planeTo3D(params, [u, v]) {
    const { o, x, y } = planeFrame(params);
    return new THREE.Vector3(o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v);
  }
  // Orientation quaternion + origin for a sketch-plane grid.
  planeMatrix(params) {
    const { o, x, y, n } = planeFrame(params);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...n));
    m.setPosition(...o);
    return m;
  }

  // ---- face picking (sketch on face) ----
  // Nearest of: body face or plane handle. Returns {plane} | {face:{origin,normal,xdir,tris,mesh}} | null
  pickSketchTarget(ev) {
    this.setRay(ev);
    const objs = [...this.bodyGroup.children, ...(this.planeHandles.visible ? [...this.planeHandles.children, ...(this.constructionGroup?.children.filter((c) => c.visible) || [])] : [])];
    const hit = this.ray.intersectObjects(objs, false)[0];
    if (!hit) return null;
    if (hit.object.userData.ref) return { ref: hit.object.userData.ref, geo: hit.object.userData.geo };
    if (hit.object.userData.plane) return { plane: hit.object.userData.plane };
    const src = hit.object.userData.src;
    const face = planarFace(src.verts, src.tris, hit.faceIndex);
    if (!face) { // a curved face: the plane that touches the surface where the ray hit it
      const nn = this.smoothNormalAt(hit), h = Math.hypot(nn[0], nn[1]);
      return { face: { plane: 'custom', origin: hit.point.toArray().map((c) => +c.toFixed(4)), normal: nn, xdir: h < 0.01 ? [1, 0, 0] : [-nn[1] / h, nn[0] / h, 0].map((q) => +q.toFixed(6)) }, curvedPlane: true, tris: [], mesh: hit.object };
    }
    const n = face.normal.map((c) => (Math.abs(c) < 1e-6 ? 0 : +c.toFixed(6)));
    const d = n[0] * face.point[0] + n[1] * face.point[1] + n[2] * face.point[2];
    const origin = n.map((c) => +(c * d).toFixed(4));
    const nl = Math.hypot(...n);
    const nn = n.map((c) => c / nl);
    // x = Z x n so that the sketch "up" (y) points towards world +Z
    const xdir = Math.abs(nn[2]) > 0.99 ? [1, 0, 0] : [-nn[1] / Math.hypot(nn[0], nn[1]), nn[0] / Math.hypot(nn[0], nn[1]), 0].map((q) => +q.toFixed(6));
    return { face: { plane: 'custom', origin, normal: nn.map((c) => +c.toFixed(6)), xdir, faceRef: { id: hit.object.userData.id, point: face.point.map((c) => +c.toFixed(3)), normal: nn.map((c) => +c.toFixed(6)) } }, tris: face.tris, mesh: hit.object };
  }
  // Persistent + hover face highlights. Each entry: {id, point, normal}; hover: {tris, mesh} from pickPlanarFace.
  showFaces(selected, hover) {
    for (const c of [...this.faceHL.children]) { c.geometry.dispose(); this.faceHL.remove(c); }
    const draw = (tris, mesh, color, opacity) => {
      const { verts, tris: T } = mesh.userData.src;
      const pos = [];
      for (const t of tris) for (let k = 0; k < 3; k++) { const vi = T[t * 3 + k]; pos.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.raycast = () => {};
      this.faceHL.add(m);
    };
    for (const f of selected || []) {
      const mesh = this.bodyGroup.children.find((c) => c.userData.id === f.id);
      const ft = mesh && this.faceTris(mesh, f);
      if (ft) draw(ft, mesh, 0xe0453a, 0.5);
    }
    if (hover?.face) draw(hover.tris, hover.mesh, 0xf08c00, 0.4);
  }
  highlightFace(target) {
    for (const c of [...this.faceHL.children]) { c.geometry.dispose(); this.faceHL.remove(c); }
    if (!target?.face) return;
    const { verts, tris } = target.mesh.userData.src;
    const pos = [];
    for (const t of target.tris) for (let k = 0; k < 3; k++) { const vi = tris[t * 3 + k]; pos.push(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf08c00, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.raycast = () => {};
    this.faceHL.add(m);
  }

  // ---- edge picking (fillet / chamfer) ----
  // entries: [{body, chain:{pts,closed}, selected}]
  setPickEdges(entries) {
    this.pickEntries = entries;
    this.pickHover = null;
    this.rebuildPickEdges();
  }
  rebuildPickEdges() {
    for (const c of [...this.edgeGroup.children]) { c.geometry.dispose(); this.edgeGroup.remove(c); }
    const sz = this.bounds().getSize(new THREE.Vector3()).length();
    for (const e of this.pickEntries) {
      const pts = e.chain.pts.map((p) => new THREE.Vector3(...p));
      if (e.chain.closed) pts.push(pts[0].clone());
      const hot = e.selected || e === this.pickHover;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2b6cb0 }));
      line.raycast = () => {};
      this.edgeGroup.add(line);
      if (hot) {
        const path = new THREE.CurvePath();
        for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
        const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(2, pts.length * 2), Math.max(sz * 0.004, 0.15), 6, false),
          new THREE.MeshBasicMaterial({ color: e.selected ? 0xe0453a : 0xf08c00 }));
        tube.raycast = () => {};
        this.edgeGroup.add(tube);
      }
    }
  }
  pickEdge(ev, entries = this.pickEntries, tol = 7) {
    const r = this.rect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const proj = (p) => { const v = p.clone().project(this.camera); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height, v]; };
    let best = null, bd = tol;
    const cv = new THREE.Vector3();
    for (const e of entries) {
      // most chains are nowhere near the cursor: test the screen box of the chain's bounding box first, before projecting its points
      if (e.chain.pts.length > 4) {
        const bb = e.chain.bb || (e.chain.bb = (() => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (const p of e.chain.pts) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } return [lo, hi]; })());
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
        for (let c = 0; c < 8; c++) {
          cv.set(bb[c & 1][0], bb[(c >> 1) & 1][1], bb[(c >> 2) & 1][2]).project(this.camera);
          if (cv.z > 1) { behind = true; break; }
          const px = (cv.x + 1) / 2 * r.width, py = (1 - cv.y) / 2 * r.height;
          if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
        if (!behind && (mx < x0 - bd || mx > x1 + bd || my < y0 - bd || my > y1 + bd)) continue;
      }
      const P = e.chain.pts.map((p) => new THREE.Vector3(...p));
      if (e.chain.closed) P.push(P[0]);
      for (let i = 0; i < P.length - 1; i++) {
        const a = proj(P[i]), b = proj(P[i + 1]);
        if (a[2].z > 1 || b[2].z > 1) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const tt = Math.max(0, Math.min(1, ((mx - a[0]) * dx + (my - a[1]) * dy) / l2));
        const dist = Math.hypot(a[0] + dx * tt - mx, a[1] + dy * tt - my);
        if (dist < bd) {
          const pt = P[i].clone().lerp(P[i + 1], tt);
          // occlusion test
          const dir = pt.clone().sub(this.camera.position);
          const dd = dir.length();
          let hidden = false;
          if (!this.opts.ortho) {
            this.ray.set(this.camera.position, dir.normalize());
            const h = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
            hidden = !!h && h.distance < dd - 0.05;
          } else {
            const cd = new THREE.Vector3(); this.camera.getWorldDirection(cd);
            this.ray.set(pt.clone().addScaledVector(cd, -5000), cd);
            const h = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
            hidden = !!h && h.distance < 5000 - 0.05;
          }
          if (!hidden) { bd = dist; best = e; }
        }
      }
    }
    return best;
  }

  // ---- camera ----
  bounds() {
    const box = new THREE.Box3();
    for (const m of this.bodyGroup.children) box.expandByObject(m);
    return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-30, -30, 0), new THREE.Vector3(30, 30, 40)) : box;
  }
  /** Where the camera has to be to frame everything: { target, dist }. */
  fitParams() {
    const b = this.bounds();
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 10);
    return { target: c, dist: (r / Math.sin((this.persp.fov * Math.PI) / 360)) * 1.05 };
  }
  /** Frame everything. Animated when you ask for it; loading a design jumps straight there. */
  fit(animate = false) {
    this.flyTo({ ...this.fitParams(), q: this.anim ? this.anim.q1 : this.camera.quaternion.clone(), animate });
  }
  lookAlong(dir, up = [0, 0, 1], animate = false) {
    const d = new THREE.Vector3(...dir).normalize();
    const m = new THREE.Matrix4().lookAt(d, new THREE.Vector3(), new THREE.Vector3(...up));
    this.orientTo(new THREE.Quaternion().setFromRotationMatrix(m), animate);
  }
  /** Turn the camera (orbiting the target) to orientation q, optionally with a short eased animation. */
  orientTo(q1, animate = false) {
    this.flyTo({ q: q1, animate });
  }
  /**
   * Move the camera to look at `target` from `dist` away with orientation `q`; any of them left out stays as it is.
   * Animated by default over a short, eased time (longer for bigger moves). Dragging the view cancels it.
   */
  flyTo({ target, q, dist, animate = true } = {}) {
    const tg0 = this.controls.target.clone(), q0 = this.camera.quaternion.clone(), d0 = this.camera.position.distanceTo(tg0);
    const tg1 = target ? target.clone() : tg0, qq = q || q0, d1 = dist ?? d0;
    this.anim = null;
    const turn = q0.angleTo(qq), shift = tg0.distanceTo(tg1) / Math.max(d0, 1), zoom = Math.abs(Math.log(Math.max(d1, 1e-3) / Math.max(d0, 1e-3)));
    if (!animate || (turn < 1e-3 && shift < 1e-4 && zoom < 1e-3)) {
      this.controls.target.copy(tg1); this.applyOrientation(qq, d1); return;
    }
    this.anim = { t0: performance.now(), dur: Math.min(520, 200 + 220 * Math.min(1, turn / Math.PI) + 160 * Math.min(1, shift + zoom)), q0, q1: qq, tg0, tg1, d0, d1 };
  }
  applyOrientation(q, dist) {
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q), y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    this.camera.position.copy(this.controls.target).addScaledVector(z, dist);
    this.camera.up.copy(y);
    this.controls.update();
  }
  stepAnim() {
    const a = this.anim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / a.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.controls.target.lerpVectors(a.tg0, a.tg1, e);
    this.applyOrientation(a.q0.clone().slerp(a.q1, e), a.d0 * Math.pow(a.d1 / a.d0, e));
    if (t >= 1) this.anim = null;
  }
  /** Rotate the view by 90 degrees about a camera axis: 'x' (up/down), 'y' (left/right) or 'z' (roll). */
  turnView(axis, deg) {
    const q = this.anim ? this.anim.q1.clone() : this.camera.quaternion.clone();
    const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 'x', axis === 'y', axis === 'z'), (deg * Math.PI) / 180);
    this.orientTo(q.multiply(r), true);
  }
  lookAtPlane(params) {
    const { n, y } = planeFrame(params);
    this.lookAlong(n, Math.abs(n[2]) > 0.99 ? y : [0, 0, 1], true);
  }
  home(animate = false) {
    const d = new THREE.Vector3(1, -1.35, 0.95).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(d, new THREE.Vector3(), new THREE.Vector3(0, 0, 1)));
    this.flyTo({ ...this.fitParams(), q, animate });
  }
  setOrtho(on) {
    this.opts.ortho = on;
    if (this.panes[1]) { this.eachPane(() => this.setOrthoHere(on)); return; }
    this.setOrthoHere(on);
  }
  setOrthoHere(on) {
    const old = this.camera;
    this.camera = on ? this.ortho : this.persp;
    this.camera.position.copy(old.position);
    this.camera.up.copy(old.up);
    this.camera.quaternion.copy(old.quaternion);
    this.controls.object = this.camera;
    this.gizmo.camera = this.camera;
    this.updateOrtho();
    this.controls.update();
  }
  updateOrtho() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const h = Math.tan((this.persp.fov * Math.PI) / 360) * d, w = h * this.persp.aspect;
    Object.assign(this.ortho, { left: -w, right: w, top: h, bottom: -h });
    this.ortho.updateProjectionMatrix();
  }
  resize() {
    const p = this.canvas.parentElement;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const rs = this.paneRects();
    this.eachPane((i) => {
      const q = rs[this.layout === 'single' ? 0 : i] || rs[0];
      this.persp.aspect = q.w / q.h;
      this.persp.updateProjectionMatrix();
      this.updateOrtho();
    });
    this.updatePaneMark();
  }

  // ---- ViewCube (CSS 3D) ----
  buildCube(el) {
    const defs = [
      ['TOP', [0, 0, 1], [1, 0, 0], [0, -1, 0]], ['BOTTOM', [0, 0, -1], [1, 0, 0], [0, 1, 0]],
      ['FRONT', [0, -1, 0], [1, 0, 0], [0, 0, -1]], ['BACK', [0, 1, 0], [-1, 0, 0], [0, 0, -1]],
      ['RIGHT', [1, 0, 0], [0, 1, 0], [0, 0, -1]], ['LEFT', [-1, 0, 0], [0, -1, 0], [0, 0, -1]],
    ];
    const faces = defs.map(([label, n, u, v]) => {
      const d = document.createElement('div');
      d.className = 'cf';
      // 3x3 hit zones: face centre, 4 edges, 4 corners. Row = v direction, column = u direction.
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        const cell = document.createElement('i');
        const dir = n.map((q, k) => q + (c - 1) * u[k] + (r - 1) * v[k]);
        if (r === 1 && c === 1) { cell.className = 'c'; cell.textContent = label; }
        cell.onclick = (ev) => { ev.stopPropagation(); this.lookAlong(dir, Math.abs(dir[2]) > 0.9 * Math.hypot(...dir) ? [0, 1, 0] : [0, 0, 1], true); };
        d.appendChild(cell);
      }
      d.style.gridTemplate = '11px 1fr 11px / 11px 1fr 11px';
      el.appendChild(d);
      return { d, n: new THREE.Vector3(...n), u: new THREE.Vector3(...u), v: new THREE.Vector3(...v) };
    });
    const NS = 'http://www.w3.org/2000/svg', triad = document.getElementById('cube-axes');
    const axes = [['X', [1, 0, 0], '#d12f2f'], ['Y', [0, 1, 0], '#1b7f3a'], ['Z', [0, 0, 1], '#3446e0']].map(([t, a, color]) => {
      const g = document.createElementNS(NS, 'g'), l = document.createElementNS(NS, 'line'), tx = document.createElementNS(NS, 'text');
      l.setAttribute('stroke', color); l.setAttribute('stroke-width', '2'); l.setAttribute('stroke-linecap', 'round');
      tx.textContent = t; tx.setAttribute('fill', color); tx.setAttribute('font-size', '19'); tx.setAttribute('font-weight', '700'); tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('dominant-baseline', 'central');
      g.append(l, tx); triad?.appendChild(g);
      return { g, l, tx, a: new THREE.Vector3(...a) };
    });
    return { el, faces, axes };
  }
  updateCube() {
    const R = new THREE.Matrix4().extractRotation(this.camera.matrixWorldInverse);
    const h = 29;
    for (const f of this.cube.faces) {
      const tx = (w) => { const p = w.clone().applyMatrix4(R); return [p.x, -p.y, p.z]; };
      const u = tx(f.u), v = tx(f.v), n = tx(f.n), c = tx(f.n.clone().multiplyScalar(h));
      f.d.style.transform = `matrix3d(${u[0]},${u[1]},${u[2]},0,${v[0]},${v[1]},${v[2]},0,${n[0]},${n[1]},${n[2]},0,${c[0]},${c[1]},${c[2]},1)`;
    }
    // axis letters sit on the cube's back-bottom-left corner each axis continues past the cube edge
    // with a short stub and a letter; perspective makes the axis pointing at the viewer fan out diagonally.
    const hc = 29 * 1.3, ext = 13, lab = 25, PERSP = 520;
    const proj = (v) => { const p = v.clone().applyMatrix4(R), k = PERSP / (PERSP - p.z); return [55 + p.x * k, 55 - p.y * k]; };
    const corner = new THREE.Vector3(-hc, -hc, -hc);
    for (const ax of this.cube.axes) {
      const dirz = ax.a.clone().applyMatrix4(R).z;
      ax.g.style.opacity = dirz < -0.5 ? 0 : 1; // pointing away from the viewer: it would sit behind the cube
      const at = (d) => proj(corner.clone().addScaledVector(ax.a, d));
      const [x1, y1] = at(2 * hc), [x2, y2] = at(2 * hc + ext), [tx, ty] = at(2 * hc + lab);
      ax.l.setAttribute('x1', x1); ax.l.setAttribute('y1', y1); ax.l.setAttribute('x2', x2); ax.l.setAttribute('y2', y2);
      ax.tx.setAttribute('x', tx); ax.tx.setAttribute('y', ty);
    }
  }

  // ---- move gizmo ----
  showGizmo(center, rot, mode, onChange) {
    this.gizmoProxy.position.set(...center);
    this.gizmoProxy.rotation.set(...rot.map((d) => (d * Math.PI) / 180));
    this.gizmo.attach(this.gizmoProxy);
    this.gizmo.setMode(mode);
    this.gizmo.visible = true;
    this.hold('gizmo', true); // the gizmo only works in a single full view
    this.gizmo.removeEventListener('objectChange', this._gcb);
    this._gcb = () => onChange(this.gizmoProxy.position.toArray(), this.gizmoProxy.rotation.toArray().slice(0, 3).map((r) => (r * 180) / Math.PI));
    this.gizmo.addEventListener('objectChange', this._gcb);
  }
  hideGizmo() { this.hold('gizmo', false); this.gizmo.detach(); this.gizmo.visible = false; }

  frame() {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.camLight.position.copy(this.camera.position).sub(this.controls.target).normalize();
    this.camLight.target.position.set(0, 0, 0);
    this.stepAnim();
    if (this.manip && this.manipArgs) { const pp = this.opts.ortho ? (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.canvas.clientHeight || 600) : (2 * this.camera.position.distanceTo(this.manip.p0) * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.canvas.clientHeight || 600); if (Math.abs(pp - this.manipPx) / this.manipPx > 0.03) this.setManip(...this.manipArgs); }
    this.controls.update();
    this.gizmo.camera = this.camera;
    if (this.opts.ortho) this.updateOrtho();
    this.updateCube();
    this.onFrame?.();
    this.fatMats?.forEach((m) => m.resolution.set(this.canvas.clientWidth, this.canvas.clientHeight));
    if (this.layout === 'single') { this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight); this.renderer.render(this.scene, this.camera); return; }
    const H = this.canvas.clientHeight, rs = this.paneRects(), keepClear = this.renderer.autoClear;
    this.renderer.setScissorTest(false); this.renderer.autoClear = true; this.renderer.clear();
    this.renderer.autoClear = keepClear; this.renderer.setScissorTest(true);
    this.panes.forEach((pn, i) => {
      if (!pn) return;
      const cam = i === this.active ? this.camera : pn.camera, q = rs[i];
      if (i !== this.active) { pn.controls.update(); if (this.opts.ortho) { const d = cam.position.distanceTo(pn.controls.target), hh = Math.tan((pn.persp.fov * Math.PI) / 360) * d; Object.assign(pn.ortho, { left: -hh * pn.persp.aspect, right: hh * pn.persp.aspect, top: hh, bottom: -hh }); pn.ortho.updateProjectionMatrix(); } }
      this.fatMats?.forEach((m) => m.resolution.set(q.w, q.h));
      this.renderer.setViewport(q.x, H - q.y - q.h, q.w, q.h); this.renderer.setScissor(q.x, H - q.y - q.h, q.w, q.h);
      this.renderer.render(this.scene, cam);
    });
    this.renderer.setScissorTest(false);
  }
}
