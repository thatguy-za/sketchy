# Sketchy reference

Detailed notes on how things work. New here? Start with the [README](../README.md).

## Modelling tools

| Tool | Notes |
|------|-------|
| Sketch | Plane (XY/XZ/YZ + offset) or any flat body face. Line, **Path** (open polyline), rectangle, circle, polygon; snap grid; edit values numerically. Nested shapes become holes |
| Extrude | New / Join / Cut / Intersect / **Auto (cut or join)**; extent *Distance*, *Through all*, *To object* (bounding-box based); symmetric, **draft/taper angle**, twist, top scale |
| Revolve · **Sweep** · **Loft** · **Coil** · **Rib / Web** | Sweep follows an open path (optionally smoothed) with mitred corners; loft blends 2+ profile sketches; coil is a helical solid; rib thickens an open path |
| **Hole** | Simple, counterbore, countersink, through-all, optional internal thread. Place by clicking a face |
| **Thread** | Real helical groove (external or internal, left/right-handed) cut into a body |
| **Press/Pull** | Click a flat face and drag it in the viewport (or type a distance) to push or pull it |
| Fillet · Chamfer | On picked edges or faces (constant radius) |
| **Shell** | Hollow a body to a wall thickness (inside, outside or centred), optionally opening picked faces |
| **Scale** · **Split Body** | Uniform / non-uniform scale; split by plane or by another body |
| Combine · Move/Copy · Mirror · Remove | Click bodies in the viewport to fill body fields |
| **Pattern** | Linear, circular, **along a sketch path** or **on a face** (grid on the picked plane) |
| **Text · Insert SVG · Insert DXF** | Sketch tools: text uses real Roboto outlines (counters become holes); SVG (paths, shapes, transforms, curves flattened) and DXF (LINE/ARC/CIRCLE/LWPOLYLINE/POLYLINE, touching segments joined, `$INSUNITS` honoured) are scaled to mm and centred. Also drag a `.svg`/`.dxf` onto the viewport |
| **Interference** · **Drive Joints** · **As-built Joint** | Lists overlapping body pairs with volume; sliders move revolute/slider/cylindrical/planar joints; as-built keeps both bodies where they are |
| **Units** | File → Document units (see the menu for the list). Geometry stays in mm; fields, measure and properties convert |
| **Mesh repair** | Non-watertight STLs are welded, de-duplicated, re-oriented and hole-filled on import; the toast says what was fixed |
| **Export** | STL, **3MF** (with body colours), **OBJ**, and **STEP (faceted mesh)** — triangles only, not exact surfaces |
| **Joint** | Rigid, revolute, slider, cylindrical, planar and ball joints positioning one body relative to another |
| **Parameters** | Name dimensions (`width = 40 mm`) and use expressions in any numeric field (`width/2 + 3 mm`, `sin(30)*r`). Changing a parameter rebuilds the whole timeline |
| **Section Analysis** (Inspect tab) | Clip the model with an XY/XZ/YZ plane (slider or typed offset, flip side); the cut face is capped. View-only, not stored in the timeline |
| **Measure** (Inspect tab) | Distance (vertex snap), angle, edge length (detects circles), angle/distance between faces |

**Tabs:** every open design is a tab. **+** opens a blank design in a new tab, designs opened from the sidebar get their own tab (an already-open design is just focused), and each tab keeps its own undo history, view and hidden bodies. Closing the last tab leaves a fresh blank design.

The UI uses a conventional parametric-CAD layout: application bar with design tab, `DESIGN ▾` workspace menu, workspace tabs with icon-only toolbar groups (click a group label for its full dropdown), floating Browser card, ViewCube with clickable faces/edges/corners, navigation bar, a timeline of feature icons, a Data panel (grid icon) listing your saved designs with thumbnails, and a right-click **marking menu**.

Shortcuts: `F2` rename · `Enter` accepts a dialog · `S` command search · `E` extrude · `Q` press pull · `F` fillet · `M` move/copy · `H` hole · `J` joint · `I` measure · `L`/`R`/`C` line/rectangle/circle in a sketch · `Del` delete · `Ctrl+Z / Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+N` new · `Esc` cancel.

### Editing experience

* **Sketching** — every closed region becomes a shaded **profile**; click inside regions in the Extrude/Revolve dialog to pick which ones (a circle inside a rectangle is a hole by default). Tools: line, open path, rectangle, centre rectangle, rounded rectangle, circle, ellipse, slot, polygon.
* **Arcs** — the 3-point **Arc** tool, and in the Line / Open Path tools press `A` for a **tangent arc**. Lines and arcs that meet end to end automatically form a closed, selectable profile.
* **Parametric dimensions** — click a shape in the Select tool and type an *expression* in any dimension label (`width/2`, `hole + 0.2 mm`); it follows your named parameters, so changing a parameter reshapes the sketch. The **Sketch Dimension** tool (`D`) jumps straight to a shape's dimensions.
* **Constraints** — Horizontal, Vertical, Coincident, Concentric, Equal, Parallel and Perpendicular. Pick two items (the first one moves) and the relation is kept through edits and parameter changes; a badge marks each one (click to delete) and the palette lists them.
* **Offset and Fillet** — offset a closed shape by a typed distance (negative goes inward); round a corner of a rectangle or path with a typed radius.
* **Type while you draw** — after the first click, a dimension box shows live values; type a number, `Tab` to the next field, `Enter` to commit (width/height, diameter, radius, length/angle, corner radius…). Expressions and parameters work.
* **Inference snapping** — endpoints, midpoints, centres, quadrants and the origin snap with markers and dashed alignment guides; the grid step adapts to zoom; hold `Ctrl` to snap to nothing.
* **Select tool** (`Esc` in a sketch) — hover/click shapes, drag to move, drag handles to resize, click a dimension label to type a value, arrow keys nudge.
* **Extrude** — translucent blue (join/new) or red (cut) **preview**, an on-canvas **arrow manipulator** to drag the distance, a value box you can type into, operation icons, direction/extent options; `Enter` accepts. The last extrude distance is remembered.
* **Fillet / Chamfer on edges** — hover any model edge (it turns blue), click to select it (red), `Shift`/`Ctrl`-click to add more, then press `F` (or right-click → Fillet / Chamfer). Or select a **face** (Face priority) and Fillet/Chamfer rounds its whole perimeter. Drag the on-canvas arrow or type the radius/distance; `Esc` clears the selection.
* **Selection priority** (SELECT ▾) — *Body* or *Face*. In Face priority hover highlights flat faces; select one first and `Q` (Press Pull), `E` (pull the face), `H` (hole) or Create Sketch act on it.
* **Timeline** — drag items to reorder (blocked if a feature depends on another), `Ctrl`/`Shift` multi-select, right-click for Edit / Rename (`F2`) / Roll back / Suppress (dependents are suppressed with it, and restored together) / Delete.
* **Browser** — right-click bodies for Rename, Hide, Isolate, Appearance colours, Properties, Delete; hovering a body row highlights it in the model.
* **Navigation** — middle-drag pan, `Shift` + middle-drag orbit, double-click middle to fit, mouse wheel zoom; left-drag also orbits.


## AI assistants (MCP)

Sketchy runs a [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp` so Claude, ChatGPT or any MCP client can build designs for you.

1. Sign in, click your initial → **Account** → **AI assistants (MCP)** → **Create token**. Tokens belong to your account only, are shown once, and can be revoked there. (Admins can switch MCP off for the whole server under **Server settings**, or set `ALLOW_MCP=false`.)
2. Add the server to your assistant. The Account page gives copy-paste snippets, for example:
   * Claude Code: `claude mcp add --transport http sketchy https://your-host/mcp --header "Authorization: Bearer <token>"`
   * Claude Desktop: the `mcp-remote` config shown on the Account page
   * ChatGPT and other web assistants: use `https://your-host/mcp/<token>` (they need a publicly reachable **https** address, so put Sketchy behind a reverse proxy; treat that URL like a password)
3. Ask it to build something: *"Make a 60×30×8 mm bracket with two 10 mm holes, call it Bracket"*.

Tools: `list_designs`, `create_design`, `get_design`, `describe_feature_types`, `add_feature`, `update_feature`, `delete_feature`, `set_parameters`, `inspect_design`, `export_stl`. The server replays the design with the same modelling kernel the app uses, so every call returns the real bodies, sizes, volumes and any errors, and a change that would break the model is rejected rather than saved. Designs show up in your sidebar like any other, and every assistant edit is a new revision in the version history. Limits: the transport is plain JSON over HTTP (no streaming), authentication is bearer tokens (no OAuth), and features that need picking edges or faces in the 3D view (fillet, chamfer, press/pull) can't be placed from here yet.


## Typography

One system font stack (`system-ui`, falling back through Segoe UI / Roboto / Helvetica / Arial) and a seven-step size scale defined as CSS variables in `style.css`: `--fs-xs` 11px (ribbon labels, hints, shortcuts), `--fs-sm` 12px (base UI), `--fs-md` 13px (tabs, card titles), `--fs-lg` 14px (dialogs and forms), `--fs-xl` 16px (large inputs, on-canvas readouts), `--fs-2xl` 18px and `--fs-3xl` 22px (headings). Weights are 400 regular, 500 for titles and 600 for emphasis; code uses `--font-mono`. Use the variables rather than pixel sizes.

## Accessibility

The interface chrome (menus, dialogs, sidebar, sign-up / login) targets **WCAG 2.2 AA**: text contrast of at least 4.5:1, control borders of at least 3:1, visible keyboard focus, accessible names on icon buttons, keyboard-operable menus (arrows, Enter, Esc) and 24px minimum target sizes. The palette is built on flag green `#169B62` (buttons and links use `#0E7C4A` so white text passes). Checked with axe-core on the main screen, the Extrude dialog, the sidebar, menus and the sign-in page. **Not covered:** the 3D viewport and sketching tools are pointer-driven and have no keyboard or screen-reader equivalent, and this has not had a manual screen-reader review.


## Accounts, storage and versions

* Data lives in the `sketchy-data` volume (`/data`): `users.json` (scrypt-hashed passwords), `sessions.json`, `mcp-tokens.json` (hashed), `settings.json`, `projects/<user-id>/*.json`
* Sessions are `HttpOnly` + `SameSite=Strict` cookies lasting a year (renewed whenever you use the app), and the API requires a custom header, which blocks cross-site requests. Sketchy itself serves plain HTTP, so put it behind HTTPS (a reverse proxy) if you expose it beyond your home network
* **Version history:** every save keeps the previous revision under `projects/<user-id>/.versions/<design>/`. Click the **V3 ▾** badge on a design in the sidebar to open an older version or restore it as the newest (nothing is lost)
* **Drafts:** an in-progress design is synced to the server so you can resume on another device, and Sketchy warns if the same design changed elsewhere
* Without the server (for example `npm run dev`) saving downloads a `.sketchy.json` file, and the last session is restored from browser storage

## Known limits

The modelling kernel is mesh-based ([manifold-3d](https://github.com/elalish/manifold)), not a boundary-representation (B-rep) kernel, so a few common CAD operations are approximated or absent: face-level operations act on flat faces only; *Draft* is an extrude taper on single-outline profiles (not a draft of existing faces); *To object* extents use the object's bounding box; fillets are constant-radius (no variable radius, setbacks or tangent-chain option); there is no Thicken, Replace Face, Boundary Fill, per-face shell thickness, IGES or exact STEP; components are not implemented (use bodies and joints); there is no *Split Face*; booleans are body-to-body.

## Roadmap

Variable-radius fillets and corner blends, draft on existing faces, component hierarchy, emboss, exact STEP.
