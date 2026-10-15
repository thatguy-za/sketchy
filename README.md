# Sketchy

An open-source, self-hosted, **lightweight parametric CAD** for 3D designers and 3D printing, with a Fusion 360–style UI.

* Runs in Docker (one tiny Node container, zero runtime dependencies, designs stored in a volume)
* Everything modelled in the browser: [manifold-3d](https://github.com/elalish/manifold) (WASM, guaranteed-watertight booleans) + Three.js
* **Parametric timeline** — every operation is recorded; double-click to edit, drag the blue marker to roll back, right-click to suppress/delete
* **STL import / export** (binary + ASCII in, binary out; drag & drop onto the viewport)
* Fusion-style workspace: ribbon tabs, Browser tree, ViewCube, navigation bar, properties dialogs
* 3D-print tools: build-volume overlay for common printers, volume / mass / fits-bed check

## Run

```bash
docker compose up --build        # http://localhost:8080
```

### Prebuilt images

Publishing a GitHub release builds and pushes a multi-arch (`linux/amd64` + `linux/arm64`) image to GitHub Container Registry via `.github/workflows/docker.yml`. Tags: the release version (`1.2.3`, `1.2`) and `latest`.

```bash
echo YOUR_PAT | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin   # token needs read:packages (the repo is private)
docker run -d -p 8080:8080 -v sketchy-data:/data ghcr.io/thatguy-za/sketchy:latest
```

### Architectures (amd64 + arm64)

The same Dockerfile works on x86-64 PCs, **Raspberry Pi 4/5 (64-bit OS)** and **Apple silicon**: the app is plain JavaScript + WebAssembly with no native modules, and the Node base image is multi-arch. `docker compose up --build` builds for the machine you run it on. To produce images for both architectures (needs Docker buildx):

```bash
./build-multiarch.sh                      # build amd64 + arm64
./build-multiarch.sh --push you/sketchy   # push one multi-arch image; `docker pull you/sketchy` then picks the right one
```

All modelling runs in your browser, so the Pi only serves files and stores designs; a Pi 4 with 2 GB is plenty (the browser device needs to handle the 3D work).

### Accounts & saved designs

Click **Sign in** (top right) to create an account, then **File → Save to My Designs** (Ctrl+S). **File → My Designs…** lists, opens and deletes your saved models. Each user only sees their own designs.

* Data lives in the `sketchy-data` volume (`/data`): `users.json` (scrypt-hashed passwords), `sessions.json`, `projects/<user-id>/*.json`
* Set `ALLOW_REGISTRATION=false` in `docker-compose.yml` to close sign-ups once your users exist
* Sessions are HttpOnly + SameSite=Strict cookies and the API requires a custom header, which blocks cross-site requests. Put it behind HTTPS (e.g. a reverse proxy) if you expose it beyond your LAN — the app itself serves plain HTTP
* Without the server (e.g. `npm run dev`) saving downloads a `.sketchy.json` file; the last session is also auto-restored from browser storage

### Develop

```bash
npm install
node server.js &    # optional: storage API on :8080 (needs `npm run build` for static files)
npm run dev         # http://localhost:5173
```

## Modelling

| Tool | Notes |
|------|-------|
| Sketch | Plane (XY/XZ/YZ + offset) or any flat body face. Line, **Path** (open polyline), rectangle, circle, polygon; snap grid; edit values numerically. Nested shapes become holes |
| Extrude | New / Join / Cut / Intersect / **Auto (cut or join)**; extent *Distance*, *Through all*, *To object* (bounding-box based); symmetric, **draft/taper angle**, twist, top scale |
| Revolve · **Sweep** · **Loft** · **Coil** · **Rib / Web** | Sweep follows an open path (optionally smoothed) with mitred corners; loft blends 2+ profile sketches; coil is a helical solid; rib thickens an open path |
| **Hole** | Simple, counterbore, countersink, through-all, optional internal thread. Place by clicking a face |
| **Thread** | Real helical groove (external or internal, left/right-handed) cut into a body |
| **Press/Pull** | Click a flat face and drag it in the viewport (or type a distance) to push or pull it |
| Fillet · Chamfer | On picked edges |
| **Shell** | Hollow a body to a wall thickness, optionally opening picked faces |
| **Scale** · **Split Body** | Uniform / non-uniform scale; split by plane or by another body |
| Combine · Move/Copy · Mirror · Pattern · Remove | Click bodies in the viewport to fill body fields |
| **Joint** | Rigid, revolute, slider, cylindrical, planar and ball joints positioning one body relative to another |
| **Parameters** | Name dimensions (`width = 40 mm`) and use expressions in any numeric field (`width/2 + 3 mm`, `sin(30)*r`). Changing a parameter rebuilds the whole timeline |
| **Measure** (Inspect tab) | Distance (vertex snap), angle, edge length (detects circles), angle/distance between faces |

The UI follows Fusion's current layout: application bar with design tab, `DESIGN ▾` workspace menu, workspace tabs with icon-only toolbar groups (click a group label for its full dropdown), floating Browser/Comments cards, ViewCube with clickable faces/edges/corners, navigation bar, a timeline of feature icons, a Data panel (grid icon) listing your saved designs with thumbnails, and a right-click **marking menu**.

Shortcuts (Fusion defaults): `F2` rename · `Enter` accepts a dialog · `S` command search · `E` extrude · `Q` press pull · `F` fillet · `M` move/copy · `H` hole · `J` joint · `I` measure · `L`/`R`/`C` line/rectangle/circle in a sketch · `Del` delete · `Ctrl+Z / Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+N` new · `Esc` cancel.

### Editing experience (Fusion-style)

* **Sketching** — every closed region becomes a shaded **profile**; click inside regions in the Extrude/Revolve dialog to pick which ones (a circle inside a rectangle is a hole by default, like Fusion). Tools: line, open path, rectangle, centre rectangle, rounded rectangle, circle, ellipse, slot, polygon.
* **Type while you draw** — after the first click, a dimension box shows live values; type a number, `Tab` to the next field, `Enter` to commit (width/height, diameter, radius, length/angle, corner radius…). Expressions and parameters work.
* **Inference snapping** — endpoints, midpoints, centres, quadrants and the origin snap with markers and dashed alignment guides; the grid step adapts to zoom; hold `Ctrl` to snap to nothing.
* **Select tool** (`Esc` in a sketch) — hover/click shapes, drag to move, drag handles to resize, click a dimension label to type a value, arrow keys nudge.
* **Extrude** — translucent blue (join/new) or red (cut) **preview**, an on-canvas **arrow manipulator** to drag the distance, a value box you can type into, operation icons, direction/extent options; `Enter` accepts. The last extrude distance is remembered.
* **Fillet / Chamfer on edges** — hover any model edge (it turns blue), click to select it (red), `Shift`/`Ctrl`-click to add more, then press `F` (or right-click → Fillet / Chamfer). Or select a **face** (Face priority) and Fillet/Chamfer rounds its whole perimeter. Drag the on-canvas arrow or type the radius/distance; `Esc` clears the selection.
* **Selection priority** (SELECT ▾) — *Body* or *Face*. In Face priority hover highlights flat faces; select one first and `Q` (Press Pull), `E` (pull the face), `H` (hole) or Create Sketch act on it.
* **Timeline** — drag items to reorder (blocked if a feature depends on another), `Ctrl`/`Shift` multi-select, right-click for Edit / Rename (`F2`) / Roll back / Suppress (dependents are suppressed with it, and restored together) / Delete.
* **Browser** — right-click bodies for Rename, Hide, Isolate, Appearance colours, Properties, Delete; hovering a body row highlights it in the model.
* **Navigation** — middle-drag pan, `Shift` + middle-drag orbit, double-click middle to fit, mouse wheel zoom; left-drag also orbits.

### Known limits

The kernel is mesh-based (manifold-3d), not a B-rep, so a few Fusion operations are approximated or absent:
face-level operations act on flat faces only; *Draft* is an extrude taper on single-outline profiles (not a draft of existing faces);
*To object* extents use the object's bounding box; there is no *Split Face* (needs B-rep faces); booleans are body-to-body.

## Roadmap

Fillet/chamfer of tangent-chained edge loops and corner blends, sketch constraints & dimensions, shell/hollow, 3MF export, component hierarchy.

MIT licensed.
