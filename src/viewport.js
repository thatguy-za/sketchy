// Three.js viewport: Z-up scene, orbit navigation, body meshes, ViewCube, picking, move gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PLANES, planeFrame } from './kernel.js';
import { planarFace } from './edges.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewport {
  constructor(canvas, cubeEl) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.camera = this.persp;
    this.persp.position.set(90, -120, 80);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.screenSpacePanning = true;

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
  buildGrid() {
    this.grid = new THREE.Group();
    const mk = (size, div, c1, c2) => { const g = new THREE.GridHelper(size, div, c1, c2); g.rotation.x = Math.PI / 2; g.material.transparent = true; g.material.opacity = 0.9; return g; };
    this.grid.add(mk(1000, 100, 0xaab2bd, 0xbcc3cc), mk(1000, 1000, 0xcdd3da, 0xcdd3da));
    this.grid.children[1].material.opacity = 0.55;
    this.grid.position.z = -0.02;
    this.scene.add(this.grid);
  }

  buildOrigin() {
    const line = (a, b, c, o) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o }));
    // long X (red) and Y (green) axis lines through the grid like Fusion; short Z stub
    this.scene.add(line([-600, 0, 0], [600, 0, 0], 0xe27d78, 0.75), line([0, -600, 0], [0, 600, 0], 0x7fcf92, 0.75), line([0, 0, 0], [0, 0, 60], 0x6f9be8, 0.9));
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 28), new THREE.MeshBasicMaterial({ color: 0x8b9096, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.7, 12), new THREE.MeshBasicMaterial({ color: 0x8b9096, side: THREE.DoubleSide }));
    ring.position.z = dot.position.z = 0.03;
    this.scene.add(ring, dot);
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
  setOriginVisible(v) { this.originGroup.visible = v; }
  // Zoom so the pixel rectangle (canvas coords) fills the view.
  zoomToRect(x0, y0, x1, y1) {
    const r = this.canvas.getBoundingClientRect();
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
    this.controls.target.copy(hit);
    cam.position.copy(hit).addScaledVector(dir, -dist);
    this.updateOrtho();
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
  setBodies(bodies) {
    for (const c of [...this.bodyGroup.children]) { c.traverse((o) => o.geometry?.dispose()); this.bodyGroup.remove(c); }
    for (const b of bodies) {
      let geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.verts, 3));
      geo.setIndex(new THREE.BufferAttribute(b.tris, 1));
      geo = toCreasedNormals(geo, (35 * Math.PI) / 180);
      const mesh = new THREE.Mesh(geo, this.mats.body);
      mesh.userData.id = b.id;
      mesh.userData.src = { verts: b.verts, tris: b.tris };
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), this.mats.edge);
      edges.raycast = () => {};
      mesh.add(edges);
      this.bodyGroup.add(mesh);
    }
    this.refreshMaterials();
    if (!this.fitted && bodies.length) { this.fit(); this.fitted = true; }
  }

  refreshMaterials() {
    for (const m of this.bodyGroup.children) {
      const sel = this.selected.has(m.userData.id);
      m.material = sel ? this.mats.sel : m.userData.id === this.hover ? this.mats.hover : this.mats.body;
      const e = m.children[0];
      e.visible = this.opts.edges;
      e.material = sel ? this.mats.edgeSel : this.mats.edge;
    }
    this.mats.body.wireframe = this.mats.sel.wireframe = this.mats.hover.wireframe = this.opts.wire;
    this.grid.visible = this.opts.grid && !this.hideGround;
    if (this.bedObj) this.bedObj.visible = this.opts.bed;
  }

  pickBody(ev) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    return hit ? { id: hit.object.userData.id, point: hit.point, normal: hit.face?.normal?.toArray() } : null;
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
    return { face: true, id, point: hit.point.toArray().map(r4), normal: n, tris: face.tris, mesh: hit.object };
  }
  // Closest mesh vertex to the cursor (within `px` pixels) or the surface hit: {point, vertex, id}
  pickSnap(ev, px = 12) {
    this.setRay(ev);
    const hit = this.ray.intersectObjects(this.bodyGroup.children, false)[0];
    if (!hit) return null;
    const src = hit.object.userData.src;
    const r = this.canvas.getBoundingClientRect();
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
    const r = this.canvas.getBoundingClientRect();
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
    const objs = [...this.bodyGroup.children, ...(this.planeHandles.visible ? this.planeHandles.children : [])];
    const hit = this.ray.intersectObjects(objs, false)[0];
    if (!hit) return null;
    if (hit.object.userData.plane) return { plane: hit.object.userData.plane };
    const src = hit.object.userData.src;
    const face = planarFace(src.verts, src.tris, hit.faceIndex);
    if (!face) return { curved: true };
    const n = face.normal.map((c) => (Math.abs(c) < 1e-6 ? 0 : +c.toFixed(6)));
    const d = n[0] * face.point[0] + n[1] * face.point[1] + n[2] * face.point[2];
    const origin = n.map((c) => +(c * d).toFixed(4));
    const nl = Math.hypot(...n);
    const nn = n.map((c) => c / nl);
    // x = Z x n so that the sketch "up" (y) points towards world +Z
    const xdir = Math.abs(nn[2]) > 0.99 ? [1, 0, 0] : [-nn[1] / Math.hypot(nn[0], nn[1]), nn[0] / Math.hypot(nn[0], nn[1]), 0].map((q) => +q.toFixed(6));
    return { face: { plane: 'custom', origin, normal: nn.map((c) => +c.toFixed(6)), xdir }, tris: face.tris, mesh: hit.object };
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
      if (!mesh) continue;
      const { verts, tris } = mesh.userData.src;
      let best = -1, bd = Infinity;
      for (let i = 0; i < tris.length / 3; i++) {
        const a = [0, 1, 2].map((k) => verts[tris[i * 3] * 3 + k]), b = [0, 1, 2].map((k) => verts[tris[i * 3 + 1] * 3 + k]), c = [0, 1, 2].map((k) => verts[tris[i * 3 + 2] * 3 + k]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const l = Math.hypot(...n) || 1; n = n.map((q) => q / l);
        if (n[0] * f.normal[0] + n[1] * f.normal[1] + n[2] * f.normal[2] < 0.999) continue;
        if (Math.abs((f.point[0] - a[0]) * f.normal[0] + (f.point[1] - a[1]) * f.normal[1] + (f.point[2] - a[2]) * f.normal[2]) > 0.02) continue;
        const d = Math.hypot((a[0] + b[0] + c[0]) / 3 - f.point[0], (a[1] + b[1] + c[1]) / 3 - f.point[1], (a[2] + b[2] + c[2]) / 3 - f.point[2]);
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) continue;
      const face = planarFace(verts, tris, best);
      if (face) draw(face.tris, mesh, 0xe0453a, 0.5);
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
  pickEdge(ev) {
    const r = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const proj = (p) => { const v = p.clone().project(this.camera); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height, v]; };
    let best = null, bd = 7;
    for (const e of this.pickEntries) {
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
  fit() {
    const b = this.bounds();
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 10);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, r / Math.sin((this.persp.fov * Math.PI) / 360) * 1.05);
    this.updateOrtho();
  }
  lookAlong(dir, up = [0, 0, 1]) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(new THREE.Vector3(...dir).normalize(), dist);
    this.camera.up.set(...up);
    this.controls.update();
  }
  lookAtPlane(params) {
    const { n, y } = planeFrame(params);
    this.lookAlong(n, Math.abs(n[2]) > 0.99 ? y : [0, 0, 1]);
  }
  home() { this.camera.up.set(0, 0, 1); this.lookAlong([1, -1.35, 0.95]); this.fit(); }
  setOrtho(on) {
    this.opts.ortho = on;
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
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
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
        cell.onclick = (ev) => { ev.stopPropagation(); this.lookAlong(dir, Math.abs(dir[2]) > 0.9 * Math.hypot(...dir) ? [0, 1, 0] : [0, 0, 1]); };
        d.appendChild(cell);
      }
      d.style.gridTemplate = '13px 1fr 13px / 13px 1fr 13px';
      el.appendChild(d);
      return { d, n: new THREE.Vector3(...n), u: new THREE.Vector3(...u), v: new THREE.Vector3(...v) };
    });
    const axesEl = document.getElementById('cube-axes');
    const axes = [['X', [1, 0, 0], '#d8473d'], ['Y', [0, 1, 0], '#2f9e4f'], ['Z', [0, 0, 1], '#3b6fe0']].map(([t, a, color]) => {
      const b = document.createElement('b');
      b.textContent = t; b.style.color = color;
      axesEl?.appendChild(b);
      return { b, a: new THREE.Vector3(...a) };
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
    for (const ax of this.cube.axes) {
      const p = ax.a.clone().applyMatrix4(R);
      ax.b.style.left = `${55 + p.x * 66}px`;
      ax.b.style.top = `${55 - p.y * 66}px`;
      ax.b.style.opacity = p.z < -0.2 ? 0.45 : 1;
    }
  }

  // ---- move gizmo ----
  showGizmo(center, rot, mode, onChange) {
    this.gizmoProxy.position.set(...center);
    this.gizmoProxy.rotation.set(...rot.map((d) => (d * Math.PI) / 180));
    this.gizmo.attach(this.gizmoProxy);
    this.gizmo.setMode(mode);
    this.gizmo.visible = true;
    this.gizmo.removeEventListener('objectChange', this._gcb);
    this._gcb = () => onChange(this.gizmoProxy.position.toArray(), this.gizmoProxy.rotation.toArray().slice(0, 3).map((r) => (r * 180) / Math.PI));
    this.gizmo.addEventListener('objectChange', this._gcb);
  }
  hideGizmo() { this.gizmo.detach(); this.gizmo.visible = false; }

  frame() {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.camLight.position.copy(this.camera.position).sub(this.controls.target).normalize();
    this.camLight.target.position.set(0, 0, 0);
    this.controls.update();
    this.gizmo.camera = this.camera;
    if (this.opts.ortho) this.updateOrtho();
    this.updateCube();
    this.renderer.render(this.scene, this.camera);
  }
}
