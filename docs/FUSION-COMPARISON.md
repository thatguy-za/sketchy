# Sketchy compared with Autodesk Fusion

A walk through Fusion's help centre, command by command, against what Sketchy does today. The aim is to find where Sketchy's process or UI differs from Fusion's, so people who know Fusion are not surprised, and to decide which differences are worth closing.

**How this was made.** About 45 Autodesk help pages were read (the commands and options below come from them; sources at the end). Sketchy's side comes from reading its code (`src/commands.js`, `src/features.js`, `src/main.js`). Nothing was tested in Fusion itself. Where a Fusion page was not read, or a Sketchy behaviour was not confirmed, the row says so ("not read", "verify").

**Verdicts.** **Same**: the process and options match. **Differs**: the command exists but works differently or offers fewer options. **Missing**: no equivalent. **Extra**: Sketchy has something Fusion's help does not describe.

---

## 1. Summary

**Where Sketchy already follows Fusion closely**
- **Window layout:** application bar with designs, save, undo, redo and document tabs; ribbon tabs (Solid, Surface, Mesh, Manage, Utilities) with Create, Modify, Construct, Inspect, Insert, Assemble and Select groups; Browser tree (Document Settings, Named Views, Origin, Bodies, Sketches); a Timeline along the bottom; ViewCube; navigation bar; right-click marking menu.
- **Keys:** E (Extrude), H (Hole), Q (Press/Pull), F (Fillet), M (Move/Copy), I (Measure), D (Sketch Dimension), L, R, C (sketch tools), Delete.
- **Mouse:** middle-drag pans, Shift+middle-drag orbits, wheel zooms.
- **Feature behaviour:** a feature timeline with a rollback marker, editing, suppress and reorder; Extrude operations (New Body, Join, Cut, Intersect); Thin Extrude; Fillet and Chamfer by edge, face or loop; Combine, Split Body, Shell, Draft, Scale, Offset Face, Replace Face; Revolve, Sweep, Loft, Rib, Emboss, Coil, Thread, Hole (simple, counterbore, countersink).
- **Other areas:** user parameters with units and expressions; selection modes (click, window, freeform, paint) and body/face priority; joints (Rigid, Revolute, Slider, Cylindrical, Planar, Ball), As-built joint, Drive Joints; Insert SVG, DXF, canvas, mesh; save with a description; restore as the newest version ("Save As Latest").

**The biggest differences**
1. **Sketch tools are thinner.** One circle type, one arc type, one slot, no Extend, Break, Chamfer, Scale or Blend; seven constraints against Fusion's twelve or so; no driven/driving dimensions; no Construction/Centerline line types; fewer Sketch Palette toggles.
2. **Construct has one tool.** Fusion has nine plane tools, five axis tools and six point tools. Sketchy has Offset Plane.
3. **Dialogs offer fewer choices.** Extrude (no Two Sides, no Start offset), Revolve (axis cannot be chosen), Sweep (no guide rail), Loft (no rails, continuity or closed), Fillet (no rule, full-round or chordal types), Chamfer (one type), Shell, Draft and Combine each lack one or more of Fusion's modes.
4. **Patterns and Mirror are one command each.** Fusion has Rectangular, Circular and Path patterns that work on faces, features, bodies and components, with per-instance suppression.
5. **Several Fusion commands do not exist:** Align, Split Face, Silhouette Split, Web, Boss, Lip and groove, Decal, Insert Component, fasteners, most analysis tools (draft, zebra, curvature), Remesh, Convert Mesh.

**Where Sketchy differs on purpose or has extras:** self-hosted storage and versions (no Data Panel or hub); the Print Check and Export checks; version compare; section analysis; MCP assistants; a single Settings and Server settings model.

---

## 2. Sketching

| Area | Fusion ([sketch help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-3D-SKETCH.htm)) | Sketchy | Verdict |
|---|---|---|---|
| Start a sketch | Create Sketch, then pick an origin plane, planar face or construction plane (or preselect) | Same: pick a plane or flat face | Same |
| Finish | A 3D tool such as Extrude finishes the sketch automatically; there is also Finish Sketch | Finish Sketch button; whether a feature command finishes it automatically: not confirmed | Verify |
| Sketch Palette | Linetype (Construction, Centerline), Look At, Sketch Grid, Snap, Slice, Show Profile, Show Points, Show Dimensions, Show Constraints, Show Construction Geometries, Show Projected Geometries, 3D Sketch ([reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/GUID-4183A4B7-E002-4396-AD5A-7FF3C8B2F33A.htm)) | Plane (changeable), Offset, Snap size, Polygon sides, Sketch Grid, Show Profile, Snap, Look At; lists of shapes and constraints | Differs: no Linetype, Slice or per-item Show toggles; 3D sketch is a separate command |
| Line | Line tool also draws tangent arcs | Line and Open Path; arcs are a separate 3-point tool | Differs |
| Rectangle | 2-Point, 3-Point, Center | 2-Point, Center, Rounded | Differs: no 3-Point |
| Circle | Center Diameter, 2-Point, 3-Point, 2-Tangent, 3-Tangent ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-CIRCLES.htm)) | Center Diameter | Differs: 4 types missing |
| Arc | 3-Point, Center-Point, Tangent ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-ARCS.htm)) | 3-Point | Differs: 2 types missing |
| Polygon, Ellipse, Slot | Polygon (circumscribed, inscribed, edge), Ellipse, Slot (several types) (not read) | Polygon (sides in the palette), Ellipse, one Slot | Differs (from general knowledge) |
| Spline | Fit Point Spline, Control Point Spline, Conic Curve | Fit Point Spline | Differs |
| Point | Sketch Point tool | No point tool | Missing |
| Text | Text with fonts, on a path | Text | Same (details not compared) |
| Mirror, Patterns | Mirror adds a Symmetry constraint; Rectangular and Circular patterns | Mirror, Rectangular and Circular patterns | Same (constraints not compared) |
| Project / Include / Intersect | Project (with link), Include 3D Geometry, Intersect, Project to Surface, Intersection Curve ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-SKETCH-CREATE-PROJECT-INCLUDE.htm)) | One Project / Include | Differs |
| Modify | Fillet, three Chamfers, Trim, Extend, Break, Scale, Offset, Blend Curve, Move/Copy ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-SKETCH-MODIFY-TOOLS.htm)) | Fillet, Trim, Offset, Delete | Differs: Chamfer, Extend, Break, Scale, Blend Curve, sketch Move/Copy missing |
| Trim | Hover preview; click or drag across segments; Enter to end; a segment with no intersection is deleted | Trim exists; the preview and drag-across behaviour: not confirmed | Verify |
| Offset | One Side, Two Sides, Symmetric; adds linked offset dimension and constraints | Offset by a distance | Differs |
| Dimension | Sketch Dimension (D): click geometry, type a value or expression, Enter; Toggle Driven / Driving; reference dimensions in other sketches ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-DIMENSIONS.htm)) | Sketch Dimension (D) with editable labels and parameter expressions; no driven/driving toggle (Sketchy has no constraint solver) | Differs |
| Constraints | Coincident, Collinear, Concentric, Midpoint, Fix/Unfix, Parallel, Perpendicular, Horizontal/Vertical, Tangent, Smooth, Equal, Symmetry | Coincident, Concentric, Horizontal, Vertical, Equal, Parallel, Perpendicular | Differs: Collinear, Midpoint, Fix, Tangent, Smooth, Symmetry missing |
| "Fully defined" | Geometry turns black; a red lock shows on the sketch in the Browser ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-FULLY-DEFINE-CONSTRAIN-SKETCH.htm)) | A status line in the palette: "N of M sizes and directions locked", position not counted | Differs |
| Construction / Centerline | Linetype on any geometry; centerline drives Revolve and symmetry | No construction or centerline line type | Missing |

---

## 3. Create (solid)

| Command | Fusion ([Extrude](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EXTRUDE-SOLID.htm), [Revolve](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REVOLVE-SOLID.htm), [Sweep](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SWEEP-SOLID.htm), [Loft](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-LOFT-SOLID.htm), [Rib](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-RIB.htm), [Emboss](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EMBOSS.htm)) | Sketchy | Verdict |
|---|---|---|---|
| **Extrude** | Type (Extrude, Thin Extrude); Start (Profile Plane, Offset, Object); Direction (One Side, Two Sides, Symmetric with half or whole length); Extent (Distance, To Object with extend options, All); Taper; Thin: wall thickness and location (Side 1, Side 2, Center); Operation incl. Objects to Cut and New Component | Type (solid, thin); Direction (One Side, Symmetric); Extent (Distance, All, To Object); Taper; Twist and Top scale (extras); Operation incl. Auto; one target body or all | Differs: no Two Sides, no Start offset, one cut target at a time, no New Component |
| **Revolve** | Profile; Axis (a line, edge, cylindrical face or axis); Extent (Full, Partial, To Object); Direction (One Side, Two Sides, Symmetric); Operation | Profile and angle; the axis is fixed (the sketch's own axis) | Differs: no axis choice, no To Object, no Two Sides |
| **Sweep** | Type (Single Path, Solid Sweep, Path + Guide Rail, Path + Guide Surface); Tangent chain; Distance; Taper and Twist; Orientation (Perpendicular, Parallel, Aligned); rail scaling (Scale, Stretch, None) | Profile sketch and path sketch, Smooth path, Operation | Differs: no guide rail or surface, orientation, taper or twist |
| **Loft** | Profiles; end conditions (Connected, Direction, G0, G1, G2); edge alignment; Guide Type (Rails, Centerline); Tangent Edges (Merge, Keep); Closed | Profiles in order, Operation | Differs: no rails, centerline, continuity or Closed |
| **Rib / Web** | Rib: open profile, thickness direction (Symmetric, One Side), Start, Extent (To Next, Distance), draft and base fillet. Web is a separate command | One "Rib / Web": path sketch, thickness, height, symmetric | Differs |
| **Emboss** | Select faces and profiles; Effect (Emboss, Deboss); Depth (sign flips the effect); Alignment (distance and angle manipulators); Flip normal | Sketch, Raise or Engrave, Depth, Target body; extrudes along the sketch normal | Differs: no face wrap or alignment manipulators |
| **Hole** ([reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-3A76B269-8C8D-437B-8F4A-85D0B2BBA492.htm)) | Placement: At Point or From Sketch (many holes); position from reference edges; Extents (Distance, To, All); Type (Simple, Counterbore, Countersink); Tap type (Simple, Clearance, Tapped, Taper Tapped) from a thread library; Drill Point (Flat, Angle); Flip; Objects to cut | Click a point on a face (with snapping); Simple, Counterbore, Countersink; Through all or Depth; Threaded with pitch and length | Differs: no From Sketch, edge references, thread library, drill-point option or To-extent |
| **Thread** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-HOLE-THREAD.htm)) | Modeled or cosmetic; length and offset; type, size, designation and class from a library | Internal or external, pitch, length and depth as numbers | Differs: no library or cosmetic option |
| **Coil, Pipe** | Coil and Pipe in Create | Coil, Pipe | Same (options not compared) |
| **Primitives** | Box, Cylinder, Sphere, Torus: pick a plane, drag, then set dimensions | Box, Cylinder, Sphere, Cone, Torus from a dialog with a base position | Differs in process |
| **Mirror, Patterns** ([reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-PATTERN.htm)) | Mirror any faces, bodies, features or components about any plane. Rectangular (axes, Extent or Spacing, symmetric), Circular (axis; Full, Partial, Symmetric) and Pattern on Path (Start Point, Orientation); uncheck instances; Compute Type for features | Mirror a body about an origin plane. One Pattern command (Linear, Circular, Along a path, On a face) on bodies | Differs: three types merged, no per-instance suppression, bodies only |
| **Boss, Lip and groove, Snap fit, Rest, Web** | Plastic-part helpers | None | Missing |
| **Components** | New Component, plus New Component as an operation | New Component | Differs |

---

## 4. Modify

| Command | Fusion | Sketchy | Verdict |
|---|---|---|---|
| **Press/Pull (Q)** | Edge opens Fillet, face opens Offset Face, profile opens Extrude ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-02F9ADA3-7556-42A9-8AD1-552728D537AB.htm)) | Press/Pull on a face with a drag handle and a distance | Differs: faces only |
| **Fillet (F)** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-FILLET-SOLID.htm)) | Types Fillet, Rule Fillet, Full Round; Radius type Constant, Chord Length, Variable, Asymmetric; Continuity G1 or G2; Corner type Rolling Ball or Setback; Tangent Chain; several selection sets | Edges, Whole loop (tangent chain), Radius, Variable radius with a swap option | Differs: no Rule, Full Round, chord length, asymmetric, G2 or corner types |
| **Chamfer** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CHAMFER-SOLID.htm)) | Equal Distance, Two Distance, Distance And Angle; Flip; Corner type (Chamfer, Miter, Blend) | One distance | Differs |
| **Shell** | Sharp or Rounded Offset; faces or whole body; Inside, Outside or Both with separate Inside and Outside thickness | Inside, Outside or Both (centred) with one thickness; open faces | Differs: no rounded offset, one thickness |
| **Draft** | Fixed Plane (pick a plane or face; One Side, Two Side, Symmetric; Relative or Absolute) or Parting Line (fix or move) | Pull direction from a fixed axis list, neutral plane at base or top, one angle | Differs |
| **Scale** | Pick a point (the fixed anchor); Uniform or Non Uniform (X, Y, Z distances) | Uniform or non-uniform; about the body centre or the origin; copy | Differs: no picked anchor point |
| **Combine** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-COMBINE.htm)) | One target, several tool bodies; Join, Cut, Intersect; New Component; Keep Tools | One target, one tool; Join, Cut, Intersect; Keep tool | Differs: one tool only |
| **Offset Face** | Select faces, drag or type a distance; neighbours follow | Offset Face exists | Same (not compared in detail) |
| **Replace Face** | Replace faces with a new face | Replace Face exists | Same (not compared in detail) |
| **Split Body** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SPLIT-BODY-SOLID.htm)) | Body, splitting tools (several), Extend Splitting Tool | A plane or a body as splitter; keep both parts or one side | Same, with a different option set |
| **Split Face, Silhouette Split** | Present | None | Missing |
| **Align** | From and To geometry, Flip, Angle in 90° steps, no relationship created | None | Missing |
| **Move/Copy (M)** ([reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-FFD25CD3-0707-429E-B0E6-B7F9984CDC4C.htm)) | Free Move, Translate (component or design XYZ, or pick a direction), Rotate (with Set Pivot), Point to Point, Point to Position; Create Copy | Move, Rotate and Scale numbers with a manipulator, and Create copy | Differs: no Point to Point, Point to Position, Set Pivot or direction choice |
| **Delete** | Delete key | Delete (adds a Remove step) | Same |
| **Change Parameters** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MODIFY-PARAMETERS.htm)) | User and Model parameters; Name, Unit, Expression, Value, Comment; Favorites; `if` and logical operators; text parameters; CSV import and export | User parameters with unit, expression, comment; plain-language expression errors; "Make this a parameter" | Differs: no automatic model parameters, favourites, `if`, text parameters or CSV |

---

## 5. Construct, Inspect, Insert, Assemble

| Area | Fusion | Sketchy | Verdict |
|---|---|---|---|
| **Construction planes** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CONSTRUCT-TOOLS.htm)) | Offset Plane, Plane At Angle, Tangent Plane, Midplane, Perpendicular Plane, Plane Through Two Edges, Through Three Points, Along Path, plus User Coordinate System | Offset Plane (from a base plane) | Differs: eight types missing |
| **Construction axes and points** | 5 axis tools and 6 point tools | None | Missing |
| **Measure (I)** | Distance, angle, area and position in one dialog | Measure (two points), Angle, Edge Length, Between Faces; two selected faces now show their distance in the status bar | Differs: separate commands |
| **Section Analysis** | Pick a plane, set distance and angle, flip | Plane, offset, flip | Same |
| **Interference** | Between bodies or components; can create components from the overlap | Reports overlapping pairs and volumes | Differs: no create-from-overlap |
| **Other analysis** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSPECT-TOOLS.htm)) | Center of Mass, Curvature Comb, Curvature Map, Draft Analysis, Environment Map, Isocurve, Zebra, Accessibility, Minimum Radius, Display Component Colors | Properties (volume, area); Print Check (bed fit, overhangs, wall thickness) | Missing, plus Extra (Print Check) |
| **Insert** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-TOOLS.htm)) | Insert Component (linked), Fastener, Derive (linked), Decal, Canvas, SVG, DXF, McMaster-Carr, Mesh, manufacturer parts, TraceParts | Insert Design (a copy, not linked), Canvas, Insert Model (STL, OBJ, 3MF, STEP), SVG, DXF | Differs: no linked inserts, Decal or part libraries |
| **Joints** ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/GUID-8818AE31-958A-4A59-989B-9875A174C67A.htm)) | Rigid, Revolute, Slider, Cylindrical, Pin-Slot, Planar, Ball; joint origins (Simple, Between Two Faces, Two Edge Intersection); motion limits; contact sets; rigid groups; Drive Joints, Motion Link | Rigid, Revolute, Slider, Cylindrical, Planar, Ball; As-built joint; Drive Joints | Differs: no Pin-Slot, joint origin modes, limits, contact sets or rigid groups |
| **Configurations** | Configuration table; suppress per configuration | Configure Design, Insert Configured Design, Configure Settings | Same in spirit |

---

## 6. Surface and Mesh

| Area | Fusion | Sketchy | Verdict |
|---|---|---|---|
| **Surface create** ([overview](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/GUID-B1A3AD96-A19E-4A7E-A5A3-27327A4E074B.htm)) | Patch, Extrude, Revolve, Sweep, Loft, Ruled, Offset | Extrude, Revolve, Sweep, Loft, Pipe | Differs: no Patch, Ruled, Offset |
| **Surface modify** | Trim, Untrim, Extend, Stitch, Unstitch, Merge, Thicken, and more ([page](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-MODIFY-SURFACE.htm)) | Stitch, Thicken, Trim, Extend | Differs |
| **Mesh** | Reduce (by tolerance, proportion or count), Remesh, Repair (close holes, stitch, one-touch), Shell, Combine, Convert Mesh, Separate, Reverse Normal, Generate Face Groups | Insert, Repair, Clean, Reduce (keep % and deviation), Separate, Shell, Combine | Differs: no Remesh, Convert Mesh, Reverse Normal or face groups |

---

## 7. Interface, selection, view, files

| Area | Fusion | Sketchy | Verdict |
|---|---|---|---|
| **Timeline** (the help page could not be opened; this comes from search-result summaries) | Marker with Move to Beginning, Previous, Next, End; double-click or Edit Feature (rolls back to just before the feature); Suppress and Unsuppress; drag to reorder; groups | Marker; double-click or Edit; Suppress; drag to reorder; rename | Same, but no timeline groups |
| **Browser** | Components, Bodies, Sketches, Origin, Named Views, Joints, Construction | Same folders; components via New Component | Same |
| **Selection** ([filters](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-FILTERS.htm)) | Window, Freeform, Paint; Body, Face, Edge, Component priority; a list of selection filters; Select Through | Click, Window, Freeform, Paint; Body and Face priority | Differs: no Edge or Component priority, no filter list, no Select Through |
| **Navigation** ([ViewCube](https://help.autodesk.com/cloudhelp/ITA/Fusion-GetStarted/files/GS-VIEWCUBE.htm)) | Mouse presets (Fusion, Alias, Inventor, SolidWorks); ViewCube right-click: Go Home, Camera (Orthographic, Perspective, Perspective with Ortho Faces), Set current view as Home, Reset Home, size; Look At; Orbit Constrained | Fusion-style mouse mapping; ViewCube with a menu; Home; Look At; ortho and perspective | Differs: no presets, no custom Home, no Perspective with Ortho Faces |
| **Display** | Six visual styles (Shaded, with hidden edges, with visible edges only, and wireframe variants); effects such as ground shadow, reflections, ambient occlusion in Preferences | Shaded, Shaded with visible edges only, Wireframe; ortho and perspective; render mode | Differs: no hidden-edge styles |
| **Marking menu** ([reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-GetStarted/files/GUID-6514ABC1-CB75-4F0B-AB0E-316FAD36BA93.htm)) | Radial menu in two levels plus a context menu | Radial marking menu plus a context menu | Same |
| **Save and versions** ([history](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-VIEW-DESIGN-HISTORY.htm), [Save As Latest](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-SAVE-AS-LATEST.htm)) | Every save is a version with a description; a **Milestone** option (not on the first save); History dialog to open, copy or promote a version; Save As Latest | Save with a description and a read-only next version number; version list with Open, Compare, Restore | Differs: milestones were removed in v0.0.18; compare is an extra |
| **Export** ([Save As Mesh](https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-SAVE-AS-MESH.htm)) | File > Export (STEP, STL, 3MF, OBJ, F3D and more); mesh Refinement (surface and normal deviation); Structure: One File or One Body Per File | STL, 3MF, OBJ, STEP, Sketchy project; each body as its own file; print checks | Differs: no refinement control, but per-body files and checks match or exceed |
| **Send to a printer** | Make > 3D Print sends a mesh to a print utility; arrange, orient and supports are in the Manufacture workspace | Print Check and Export checks; no hand-off | Differs |

---

## 8. Suggested order of work

Ranked by how often a maker, who is Sketchy's main audience, would hit the difference. Items 1 to 5 are implemented. Of items 6 to 8, these are done: chamfer by two distances or distance and angle, fillet by chord length, patterns with Extent or Spacing, Symmetric and skipped instances, Mirror about any construction plane, Combine with several tool bodies, and Move/Copy point to point. Still open: Rule fillet, patterns on faces and features (not only bodies), Path pattern options, Align, selection filters and Select Through. The sketch constraint solver is in (see `src/sketchsolve.js`).

1. **Sketch geometry types:** 3-point rectangle, 2-point and 3-point circle, center-point and tangent arc, slot variants, Point. Most designs start here.
2. **Sketch tools and state:** Extend, Break, Chamfer; Construction and Centerline line types; Show toggles for dimensions, constraints and construction geometry.
3. **More constraints:** Tangent, Collinear, Midpoint, Fix/Unfix, Symmetry. Tangent and Fix matter most.
4. **Construct:** Plane At Angle, Midplane, Plane Through Three Points, and basic axes and points.
5. **Extrude and Revolve completeness:** Two Sides, Start Offset, several cut targets; choose the Revolve axis and a Full / Partial option.
6. **Chamfer types and Fillet options:** Two Distance, Distance And Angle; chord length; Rule fillet.
7. **Patterns:** split into Rectangular, Circular and Path with Extent or Spacing, Symmetric, per-instance suppression; Mirror about any plane.
8. **Combine with several tools; Align; Move/Copy Point to Point.**
9. **Selection filters and Select Through; Edge priority.**
10. **Display:** hidden-edge styles; custom Home view.
11. **Hole from a sketch (many holes), with distance from edges; a small built-in thread table.**
12. **Sweep guide rail and orientation; Loft rails and Closed.**

**Keep on purpose:** self-hosted versions without milestones, the Print Check and export checks, version compare, "Make this a parameter", MCP assistants.

---

## Sources (Autodesk Fusion help)

- Create: [Extrude](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EXTRUDE-SOLID.htm), [Revolve](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REVOLVE-SOLID.htm), [Sweep](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SWEEP-SOLID.htm), [Loft](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-LOFT-SOLID.htm), [Rib](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-RIB.htm), [Emboss](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EMBOSS.htm), [Solids from sketches](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CREATE-SOLID-FROM-SKETCH.htm), [Hole reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-3A76B269-8C8D-437B-8F4A-85D0B2BBA492.htm), [Holes and threads](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-HOLE-THREAD.htm), [Pattern reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-PATTERN.htm)
- Modify: [Modify tools for solid bodies](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MODIFY-SOLID-BODY.htm), [Fillet](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-FILLET-SOLID.htm), [Chamfer](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CHAMFER-SOLID.htm), [Shell](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-83A14252-0009-42AA-AE7E-435F595DE41B.htm), [Draft](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-83C650C2-E602-4BBC-AC9A-AB9A96F07B72.htm), [Scale](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-D3F6F79B-1498-48B3-B98C-7D57B620005A.htm), [Combine](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-COMBINE.htm), [Offset Face](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-OFFSET-FACES.htm), [Split Body](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SPLIT-BODY-SOLID.htm), [Press Pull](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-02F9ADA3-7556-42A9-8AD1-552728D537AB.htm), [Align](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-ALIGN-CMD.htm), [Move/Copy reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-FFD25CD3-0707-429E-B0E6-B7F9984CDC4C.htm), [Parameters](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MODIFY-PARAMETERS.htm)
- Sketch: [Sketches in Fusion](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-3D-SKETCH.htm), [Sketch Palette](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/GUID-4183A4B7-E002-4396-AD5A-7FF3C8B2F33A.htm), [Sketch modification tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-SKETCH-MODIFY-TOOLS.htm), [Trim or extend](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-TRIM-EXTEND.htm), [Offset](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-OFFSET.htm), [Dimensions](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-DIMENSIONS.htm), [Fully define a sketch](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-FULLY-DEFINE-CONSTRAIN-SKETCH.htm), [Circles](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-CIRCLES.htm), [Arcs](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-ARCS.htm), [Project and include](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-SKETCH-CREATE-PROJECT-INCLUDE.htm)
- Construct, Inspect, Insert, Assemble: [Construction geometry](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CONSTRUCT-TOOLS.htm), [Analysis tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSPECT-TOOLS.htm), [Insert tools](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSERT-TOOLS.htm), [Joint types](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/GUID-8818AE31-958A-4A59-989B-9875A174C67A.htm)
- Interface and files: [Selection filters](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION-FILTERS.htm), [ViewCube](https://help.autodesk.com/cloudhelp/ITA/Fusion-GetStarted/files/GS-VIEWCUBE.htm), [Marking menu](https://help.autodesk.com/cloudhelp/ENU/Fusion-GetStarted/files/GUID-6514ABC1-CB75-4F0B-AB0E-316FAD36BA93.htm), [Design history](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-VIEW-DESIGN-HISTORY.htm), [Save As Latest](https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-SAVE-AS-LATEST.htm), [Save bodies as mesh](https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-SAVE-AS-MESH.htm), [Surface overview](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/GUID-B1A3AD96-A19E-4A7E-A5A3-27327A4E074B.htm), [Surface modify](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-MODIFY-SURFACE.htm)
- Taken from search-result summaries only (not opened): timeline and mesh workspace behaviour, mouse presets, visual styles, 3D Print, and the exact options of the Rectangle, Polygon, Ellipse and Slot tools.
