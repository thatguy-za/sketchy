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
