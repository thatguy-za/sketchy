// A feasibility spike, not part of the app or the tests: builds a filleted, drilled box with replicad (OpenCascade compiled to WebAssembly),
// meshes it and writes STEP. See docs/BREP-KERNEL-PLAN.md. To run it: in an empty folder `npm install replicad replicad-opencascadejs`, copy this file there, `node spike-occt.mjs`.
import opencascade from 'replicad-opencascadejs';
import { setOC, makeBaseBox, drawCircle, draw, makeCylinder, exportSTEP } from 'replicad';
import fs from 'fs';
let t0 = Date.now();
const oc = await opencascade({ locateFile: (f) => new URL('./node_modules/replicad-opencascadejs/dist/' + f, import.meta.url).pathname });
setOC(oc);
console.log('init ms', Date.now() - t0);
t0 = Date.now();
let box = makeBaseBox(40, 30, 20);
box = box.fillet(3, (e) => e.inPlane('XY', 20));
const hole = makeCylinder(5, 30, [0, 0, -5], [0, 0, 1]);
let part = box.cut(hole);
console.log('model ms', Date.now() - t0, 'volume', part.volume ? part.volume : 'n/a');
t0 = Date.now();
const m = part.mesh({ tolerance: 0.05, angularTolerance: 0.2 });
console.log('mesh ms', Date.now() - t0, Object.keys(m), 'tris', m.triangles.length / 3, 'face groups', m.faceGroups?.length);
t0 = Date.now();
const step = part.blobSTEP ? part.blobSTEP() : null;
console.log('step ok', !!step, Date.now() - t0);
if (step) { const buf = Buffer.from(await step.arrayBuffer()); fs.writeFileSync('part.step', buf); console.log('step bytes', buf.length); }
