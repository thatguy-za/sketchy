# Performance

Measured numbers for what people wait for, how they were taken, and what was changed. Machine: a laptop that was busy with other work
during part of the measuring (load average 8 to 10), so timings vary by about 30 % from run to run; the before and after figures of one
item were taken back to back, and CPU time (`process.cpuUsage`) was used where wall time was too noisy.

How to repeat them:

* `node scripts/profile-ui.mjs` (add `--json` for data): rebuilds after typical edits on a 27 and a 41 feature design and on 100
  separate bodies, opening a saved design, importing meshes of 1,600, 6,400 and 14,400 triangles. Runs without a browser.
* `scripts/profile-ui-browser.js`: start-up marks, rebuild times as the page sees them (worker included), a drag of a value, orbit frame
  rate on a 297,000 triangle model. Run it in the page of a signed-in session on a built server (`npm run build`, then `node server.js`;
  restart the server after each build, it keeps the old files in memory). With the browser tool: define the function from the file and call
  `await window.__profileUI()`. The browser pane must be visible: a hidden page gets no animation frames and the frame-rate numbers are void.
* `node scripts/bench-brep.mjs`: the older 41 feature kernel bench.

## Where the time goes (ranked)

1. **Rebuilding a long single-body design after an early edit**: 0.5 to 1 s for 41 features. Almost all of it is OpenCascade booleans
   (joins and cuts 245 of about 740 ms) and tessellating the final bodies (140 ms), see `docs/BREP-ONLY-MIGRATION.md`. A late edit is
   0.1 to 0.2 s because of the checkpoints. A single body chain depends on itself, so nothing can be skipped.
2. **Importing a mesh**: sewing a mesh into a solid was 1.9 s at 6,400 triangles and 8.6 s at 14,400. The time was in replicad listing
   the faces of the result (a comparison of every face with every other, one WebAssembly call each) and in sewing by search.
3. **Start-up**: the page used to wait for the 23 MB kernel before it created the viewport or bound a single button.
4. **Many separate bodies**: every edit rebuilt and re-tessellated every body after the edited one.
5. **Dragging a value** when a rebuild takes half a second: the worker finished the rebuild it was in before looking at the newest value.
6. Display: orbiting a 297,000 triangle model runs at the display rate (120 frames per second here); not a problem on this machine.

## Baseline and after

### Start-up (warm: the files are in the browser cache and the service worker; `performance.mark`s in the page)

| | before | after |
|---|---|---|
| UI ready (viewport, ribbon, buttons bound, signed in) | 175 to 572 ms after navigation | 84 to 90 ms |
| kernel ready | 141 to 493 ms | 165 to 180 ms (now in parallel with the UI) |
| first design shown | 182 to 572 ms | 166 to 181 ms |

The UI no longer waits for the kernel. Until it is there a small "Loading geometry kernel… x of y MB" chip shows at the bottom of the
viewport (it used to cover the whole viewport), a design is built the moment the kernel arrives, and commands that need it say so instead of
failing. The kernel file is also compiled while it downloads (`WebAssembly.instantiateStreaming`), and a copy in the cache is handed to the
browser as it is so that it can use its compiled-code cache. Cold start (nothing cached) is bound by the download: 5.9 MB with
brotli (`content-encoding: br`, `cache-control: immutable`, preloaded by a `<link>` in the page head and kept by the service worker). Before,
the first screen waited for that download plus about 0.2 s; now it does not wait. I could not measure a cold load on this machine: the
browser pane cannot clear its cache and a throttling proxy did not work, so cold times are the download time at your bandwidth
(5.9 MB: 1.2 s at 40 Mbit/s, 4.7 s at 10 Mbit/s) and the UI is usable from the first 0.1 s.

### Rebuilds in the app (41 feature design, kernel in the worker; milliseconds from the edit to the new shape on screen)

| edit | before | after |
|---|---|---|
| open the design | 455 | 468 |
| dimension of the first feature | 514 | 518 |
| dimension of a middle feature | 469 | 481 |
| dimension of the last feature | 103 | 107 |
| add a hole | 113 | 115 |

Unchanged: these are single-body chains. What changed is what happens during a drag.

### Dragging a value (a new value every frame for 0.2 s, then the final value; milliseconds from the last value to its result)

| edit | before (no abandoning of a running rebuild) | after (rebuild done in six pieces, newest wins) |
|---|---|---|
| first feature of the 41 | 879 to 939 | 574 to 621 (**-35 %**) |
| last feature | 169 to 482 | 147 to 482 |

The kernel worker now builds in pieces (a sixth of the features at a time, the checkpoints make that cost the same as one pass: CPU time
measured 1.00 s against 1.00 s) and reads its message queue between pieces, so a value that arrives while it is busy is built next
instead of after the old one finishes. The page sends every change at once instead of holding one back. A fix was needed for it to work
at all: the first version ran each queued request as soon as its message arrived, so 25 queued values took 12 s (`yieldToMessages` at the start).

### Many bodies: dependency-aware rebuild (100 separate bodies, `scripts/profile-ui.mjs`)

| edit | before | after |
|---|---|---|
| dimension of the first body | 438 ms (all 100 built again) | 2 ms (1 built, 99 taken from the last run) |
| a middle body | 190 | 7 (1 built, 48 taken) |
| the last body | 9 | 7 |

A feature that did not change, and whose inputs did not change (the bodies and sketches it names: any string in its parameters that is the
id of an earlier feature; "all bodies", "the first body" and automatic targets count as reading everything), takes its result from the
previous run: the same shapes, so also the same tessellation and the same mesh keys, which the page already knew. Sketches and planes are always rebuilt (they are cheap and set up what later features read), and a
joint, which looks at bodies it does not name, is rebuilt whenever anything before it changed. What a rebuilt feature did in the previous run counts as changed for the features after it, so suppressing, failing
or re-ordering a feature cannot leave stale results. Tested against clean rebuilds for 22 edits and their undos on a design of mixed
features (`scripts/robustness.mjs`). Single-body designs: no change.

### Importing meshes (a torus of flat triangles; parse, repair check, sew and tessellate)

| triangles | before | after |
|---|---|---|
| 1,600 | 287 ms | 183 |
| 6,400 | 1,880 | 605 (**3.1 x**) |
| 14,400 | 8,562 | 1,418 (**6.0 x**) |

Parsing an STL or an OBJ is 0.1 to 26 ms; the repair check 9 to 100 ms; everything else is sewing. Two changes: the faces of a shape are
listed without the quadratic duplicate check (`fastFaces` in `backend-brep.js`: 3,216 faces took 1,048 ms, now 10 ms), and a mesh is
built as one shell whose faces share their edges and vertices (made once per vertex and per edge, used reversed on the other side), so nothing
has to be sewn by search afterwards: 331 ms of polygons plus 363 ms of sewing became 239 ms. A mesh over 12,000 flat faces is still refused
with the advice to reduce it first (Reduce works on the triangles before sewing). Not done: real progress and a cancel button while sewing,
and spatial hashing of the welding (the weld is 10 % of the total).

### Display

* Orbit, 41 feature design: 120 frames per second (median frame 8.3 ms, worst 9.4 ms).
* Orbit, 150 spheres (297,000 triangles): 120 frames per second (median 8.3 ms, worst 10 ms). While the camera moves the page draws a
  clustered copy of big meshes (`src/lod.js`) and returns to the full mesh when it stops; bodies keep their mesh and edges while their kernel
  key is unchanged. Nothing is rebuilt per frame (checked by reading `Viewport.frame`).
* Showing a rebuilt design on the page took 6 to 8 ms (`setBodies`), so the time after an edit is the kernel's.

## Not done, and why

* A cheap preview while the exact rebuild runs (the old shape moved or a coarse mesh): the old shape stays on screen until the new one
  arrives (that was already so), but moving it as a preview needs a per-feature idea of what moves, which does not exist for dimensions typed
  into a feature. The drag lag above is the cost.
* Cancelling inside one feature: a single long boolean cannot be interrupted, only the gaps between pieces.
* Cold start measurements (see above) and the throttled-network picture.
* Frame-rate numbers need a visible browser pane; the machine had a 120 Hz display so frame rates top out at 120.

## Round two: imports at size, preview, a second look at booleans

### Imports at 14,400, 30,000 and 60,000 triangles (Node, whole import: weld, flat-face merge, sewing, tessellation; resident memory of the process, which starts near 450 MB)

| mesh | triangles | merged faces | time | memory |
|---|---|---|---|---|
| a torus of flat quads (merges well) | 14,400 | 7,680 | 1.7 s | 0.84 GB |
| | 30,000 | 16,200 | 3.6 s | 1.36 GB |
| | 59,780 | 32,342 | 7.6 s | 1.87 GB |
| the same torus with a ripple (no two triangles flat together) | 15,000 | 14,896 | 2.6 s | 1.24 GB |
| | 29,960 | 29,047 | 5.7 s | 1.53 GB |

Time is about 0.19 to 0.23 ms per merged face; memory about 45 KB per face. The limit on merged faces went from 12,000 to **32,000** (about 7 s, about 1.5 GB in the worst case, which stays under the 2 GB that WebAssembly memory can reach); over it the import is refused with the same message that points to Reduce. The Large model dialog now starts at 30,000 triangles and reduces to about 20,000. A 30,000 triangle import in the app (the browser, on the worker) took about 6 s and showed "Sewing faces: 11,500 of 12,150…" on its bar.

Progress and Cancel: sewing and reducing report how many faces or triangles they have done (about six times a second, relayed from the worker); the import bar and the busy bar show it. Cancel stops the worker, which ends the step at once (it does not wait for the next one), undoes the import step and rebuilds the design in a fresh worker. Checked in the app: a cancelled import left the design as it was (6 features before and after). The vertex weld uses a hash of the rounded coordinates instead of strings; it was 10 % of the sewing time, and the gain is small (the weld of 30,000 triangles is about 40 ms).

### Preview while the exact result is built

A Move or Scale that is being dragged (the gizmo) or typed, when the kernel runs in the worker (a design that takes more than 150 ms): the body on screen is moved or stretched by the change since the shapes on screen were built, at once, with no kernel; the kernel's shape replaces it when it arrives (`previewBody` and `clearBodyPreviews` in `viewport.js`, `cheapPreview` in `main.js`). Checked in the app: the mesh matrix showed the 30 mm move one frame after the edit while the worker was still building, and was back to identity with the exact bounding box when the result arrived. Not done for extrude distance and fillet radius: those change the shape of the body, not its place, and a moved copy of the old mesh would be wrong where the body is joined to others.

### Second look at booleans and tessellation (`profile-ui.mjs`, `bench-brep.mjs`)

Nothing safe left. Reuse across rebuilds is in (bodies a join did not change are not meshed again: two meshes per rebuild on the 41 feature bench, both final), the per-feature cost is OpenCascade's, and the things tried changed nothing measurable: simplifying without unifying edges (CPU time 997 to 1,032 ms against 987 to 1,025 ms, same faces), skipping simplify (breaks face picking, see the first round), glue, non-destructive and OBB options. A coarse first mesh refined when idle would save about 60 ms of 740 (the tessellation of the two final bodies is 86 ms of OpenCascade) at the price of a second message and a visible change after a beat; not done. Closed hollows of spline sweeps are still 2 to 3 s, and a join of a sweep and a box after the hollow of it 1.4 s (booleans between near-parallel B-spline surfaces and `solidWithVoid`, respectively).

### Extrude distance preview, and imports near the face limit (browser pass)

* Stand-in previews while a heavy design rebuilds in the worker (`cheapPreview` in `main.js`): a straight Extrude whose distance changes stretches its translucent tool solid along the profile normal (one side, symmetric, or two sides with their own distances, with or without an offset start); a Fillet or Chamfer shows a translucent tube of the radius, chord or distance along the picked edges. Taper, twist and thin extrudes have no stand-in (the shape is not a stretch of the old one); the real result replaces the stand-in when the kernel is done.
* Imports in Chromium (the in-app browser): a 24,000 triangle sphere in 2.9 s, 31,000 in 5 s, 41,760 in 8 s; 87,780 triangles (43,086 merged faces) is refused in about 1 s with the message to reduce first. Main-thread heap stayed under 80 MB; the sewing runs in the worker. Firefox, Safari and low-memory devices were not tried.
* Booleans: profiled the 41 feature bench again (1,000 ms): OpenCascade's Build is 275 ms over 27 booleans and SimplifyResult 65 ms, so booleans are a third of it; the rest is flat across many OpenCascade functions with no one hot spot. No change made.

### Closed hollows of spline sweeps (third look)

A closed hollow of a sweep (no end opened) now makes the wall as a solid with an inner shell (`solidWithVoid`) instead of a boolean between the sweep and its inner sweep. The smooth sweep bench: inside 2.4 to 2.7 s down to 0.5 to 0.6 s; outside 1.6 s to 1.2 s and both sides 2.4 s to 1.3 s (the rest is fusing the end caps, about 0.4 s each; glue did not help). A cavity that folds over itself (thickness at or past the tube radius) is caught by a volume check and handed to the cut, which reports "too large" as before. Hollows with an end left open still use the boolean.

Profiling the 41 feature bench by feature type: the mirror and extrude joins are about 60 % of it and are real overlaps of large bodies (glue needs shapes that only touch). Meshing is 160 ms of 1,000, booleans 270 ms. The faceted fallback could not be reproduced: lofts (square to circle, circle to circle, rectangle to rectangle), revolves and a sweep joined to a box all hollow exactly, so there was nothing to fix blind.

### Stand-ins for taper, twist, end scale and thin extrudes; coil hollows (fourth look)

* `src/extrude-preview.js` builds a translucent stand-in from the sketch outlines for an Extrude with taper, twist, top scale or a thin wall, shown while a heavy design rebuilds. The taper is a uniform shrink by 1 - d / inradius (a 16 mm square tapered 10 degrees over 20 mm: 8.95 mm at the top, the same as the kernel's), the twist and scale are about the sketch origin, and a thin wall is the ring between the outline and a shrunk copy (holes are left out of the stand-in). The kernel's shape replaces it.
* The faceted fallback had one reproducible case: a hollowed coil (OpenCascade cannot offset a helical sweep). A coil now carries the same `_hollow` / `_hollowEnds` as other sweeps, so the wall is exact (inside about 1.5 s, outside about 2 s on a 3 turn coil). Its ends are trimmed with a block near the end instead of a half space, because the other turns of a helix lie on the far side of the end plane. Lofts, revolves, spheres, tori, cones, 3D pipes, twisted and tapered extrudes and fillets all hollowed exactly in the sweep.
