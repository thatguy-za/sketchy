# Moving toward an exact (B-rep) kernel

## Why

Sketchy's kernel (manifold-3d) works on triangle meshes. That is fast and robust for booleans, but it means:

* A cylinder is a few hundred flat triangles. Fillets and chamfers have to be cut with generated cutters, so they only work on edges where two faces meet sharply, and a fillet on a curved face is not possible.
* STEP export is faceted (every flat triangle group becomes a face). Other CAD programs cannot select a hole or change a radius in it.
* "Faces" have no identity. Sketchy finds them again by position and normal (`findFaceTri`, `curvedFace`), which is why a painted face can lose its place after a big edit.
* Anything that needs exact surfaces (CAM, tolerance work, sheet metal, threads that other tools accept) is out of reach.

## What the spike showed

`scripts/spike-occt.mjs` uses [replicad](https://replicad.xyz) on OpenCascade compiled to WebAssembly (`replicad-opencascadejs`), measured on this Mac in Node:

| | Result |
|---|---|
| Start-up (load WASM) | about 70 ms |
| Box 40 x 30 x 20, fillet the top edges (3 mm), drill a 10 mm hole | about 110 ms |
| Mesh of that part | 460 triangles in 13 ms, **grouped by true B-rep face (11 groups)** |
| STEP export | 34 KB, AP242, 11 real faces: planes, cylinders, a torus |
| Package size | the WASM file is **23 MB** (Sketchy's current kernel is about 1 MB) |
| License | replicad is MIT; OpenCascade is **LGPL 2.1 with an exception**. Fine for a self-hosted, open-source app (ship the notice, keep it replaceable), but worth a deliberate decision. |

So it is feasible: exact fillets (including on curved faces), exact STEP, and stable face identity (every B-rep face has an id that survives a rebuild when the geometry is the same).

## What it would cost

Every feature in `src/kernel.js` is written against manifold: sketches to profiles, extrude, revolve, sweep, loft, rib, coil, thread, hole, shell, draft, scale, split, combine, patterns, mirror, fillet, chamfer, Press/Pull, offset face, surfaces, and the incremental cache and worker around them. Imported meshes (STL, OBJ, 3MF) are not B-rep at all and need a mesh path anyway. A big-bang rewrite would stall the project for a long time and regress the large-model work.

## Proposed route: a second backend, feature by feature

1. **Backend interface.** Put the solid operations behind one small interface (`box`, `extrude(profile, ...)`, `revolve`, `union`, `subtract`, `intersect`, `fillet(edges, r)`, `chamfer`, `shell`, `mesh()`, `stepBlob()`). The current manifold code becomes the `mesh` backend. Nothing changes for users.
2. **B-rep backend, phase 1:** primitives, sketch profiles (lines, arcs, circles, ellipses, splines), extrude, revolve, booleans, fillet and chamfer on B-rep edges, holes, mirror and patterns. A design whose features are all in this set builds as a B-rep, and exports exact STEP. Anything else falls back to the mesh backend for that design, and the app says which feature caused it.
3. **Face identity.** B-rep faces get ids from the mesh face groups; Appearance, Shell, Press/Pull and Hole use them instead of point-and-normal matching (the old matching stays as a fallback for mesh bodies).
4. **Phase 2:** sweep, loft, shell, draft, thread, coil; import of STEP as true B-rep (replicad can read it).
5. **Load on demand.** The 23 MB WASM is fetched only when a design needs the B-rep backend (or when you export STEP), and cached; the page and the mesh backend stay light.
6. **Tests.** Every robustness scenario that builds a body runs on both backends and compares volume, bounding box and face counts within tolerance.

## Decisions for the owner

* Accept the LGPL notice and the 23 MB download (loaded only when needed)?
* Is exact STEP the main goal (then phase 1 alone delivers it for most parts), or is it exact fillets on curved faces (needs the sketch-to-face pipeline too)?
* Keep the mesh backend permanently (needed for imported meshes and very large models)? The plan assumes yes.

## Status

Superseded by `docs/BREP-ONLY-MIGRATION.md`: the mesh kernel is gone and OpenCascade is the only kernel. This document keeps the original feasibility study.
