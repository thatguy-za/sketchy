# Sketchy UX research

What users of mainstream parametric CAD expect from nine core areas, where they get frustrated, and what Sketchy should do about it.

**Method and caveats.** This comes from web searches of vendor documentation (Autodesk, Onshape, SolidWorks, FreeCAD, Shapr3D) plus forum threads and reviews. Forum and Reddit items are individual reports, not measured data, and are marked "anecdotal". Some conventions are not covered by the sources I found, such as Fusion's Tab-between-fields dimension entry and the extrude preview colours. Those are marked "from general knowledge" and should be checked before being treated as fact. The Sketchy notes come from reading `src/` read-only (mainly `src/main.js`, `src/sketchui.js`, `src/viewport.js`, `src/commands.js`, `src/params.js`, `src/units.js` and `src/printcheck.js`). I did not run the app, so "Sketchy already does X" means the code is present, not that it was tested.

**Overall read.** Sketchy already covers most of the conventions below: type-in dimensions with Tab, inference snapping, Shift to suppress snaps, a rollback marker, suppress and reorder with dependency handling, named versions, expression parameters with units, blue/red extrude previews, and a print check. The biggest remaining gaps are mostly discoverability and recovery:
- stable edge references for fillets;
- explaining why a feature failed;
- a keyboard-shortcut sheet and first-run guidance;
- version compare;
- print-readiness shown at export time.

---

## 1. Sketching

### What users expect
- **Tool keys.** Single-letter shortcuts are the norm. Fusion uses L (line), R (2-point rectangle), C (centre-diameter circle) and D (dimension) ([Fusion shortcuts](https://www.autodesk.com/shortcuts/fusion-360), [Autodesk blog](https://www.autodesk.com/products/fusion-360/blog/fusion-360-modeling-commands-shortcuts/)). The dimension value box accepts arithmetic.
- **Typing while drawing.** After the first click you can type a length, move to the next field (width then height, radius, angle), and press Enter. Tab to advance is the common convention but I could not confirm it from vendor docs (from general knowledge). Sketchy already does this (`src/sketchui.js` around line 284).
- **Inference snapping.** The cursor snaps to endpoints, midpoints, horizontal/vertical alignment and coincidence, with visible glyphs. Onshape lets you hold Shift to suppress inferences ([Onshape tip](https://onshape.com/en/resource-center/tech-tips/2-ways-the-shift-key-can-increase-productivity)). Onshape's product lead has said too many inferences was a major barrier in early versions: "every little mouse movement snapped to something" ([Onshape forum](https://forum.onshape.com/discussion/737/snapping-to-existing-geometry)).
- **Constraints.** Horizontal, vertical, coincident, parallel, perpendicular, equal and tangent are applied automatically while drawing where intent is obvious, plus dimensions. Colour shows state: Fusion shows unconstrained geometry in blue and fully defined geometry in black ([Autodesk learning](https://app.learn-one.autodesk.com/learn/ondemand/tutorial/sketch-constraints)).
- **Finishing a sketch.** A clear Finish/OK button, Esc to drop the current tool, and a second Esc (or a Finish button) to leave the sketch. Entering an existing sketch rolls the timeline back to where that sketch was created ([Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/timeline-bug/m-p/10395870/highlight/true)).

### Common pain points
- **Over-constraint messages.** "Redundant" and "conflicting" constraints confuse beginners. FreeCAD needs dedicated "select conflicting / redundant constraints" commands, and its developers say removing any one of the involved constraints is enough ([FreeCAD wiki](https://wiki.freecad.org/Sketcher_SelectConflictingConstraints)).
- **Dimensions that can't be edited.** In Fusion, once geometry is fully defined, extra dimensions become "reference" (driven) dimensions shown in brackets. Users ask why they are greyed out ([Autodesk forum](https://forums.autodesk.com/t5/fusion-design-validate-document/dimensions/m-p/6711713)).
- **Snapping that fights the user.** Too many inference candidates, or snaps that can't be turned off, are an Onshape complaint (above).
- **Pencil and touch timing.** On Shapr3D, some users report that sketch tools are too time-dependent ("you either get the selection or nothing") (anecdotal; [Shapr3D forum](https://discourse.shapr3d.com/t/terrible-user-experience-for-ipad-pro/10540)).

### What Sketchy should do
1. **P1 – Explain constraint failures.** `src/sketchcons.js` re-applies constraints in order. When a constraint can't be satisfied or a dimension is redundant, say which one and offer "Remove this constraint" or "Make this dimension reference-only". Don't just fail silently.
2. **P1 – Show sketch state.** Show an under/fully-defined indicator, such as a status chip or a profile colour change. Beginners use it to know when to stop adding dimensions.
3. **P2 – Check discoverability.** Add a small cheat-sheet of the draw keys (L/R/C/D, Tab, Shift to suppress snaps, Esc) shown on first use of each tool. `src/main.js` only wires L/R/C in sketch mode; polygon, slot, ellipse and arc have no key. Consider a short key for each to match Fusion.
4. **P2 – Confirm Shift suppresses snaps** and that the grid-snap toggle is visible. Keep it quiet by default.
5. **P3 – Touch.** Make sure sketch tools use a "tap to place, then type or drag" model, not a time-sensitive press-and-drag (see section 4).

---

## 2. Extrude and push/pull

### What users expect
- **Operations.** New body, Join (add), Cut (remove) and Intersect. Fusion also offers a cut that only affects visible bodies ([Autodesk help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EXTRUDE-SOLID.htm)). Onshape calls them New / Add / Remove / Intersect ([Onshape help](https://cad.onshape.com/help/Content/extrude.htm)).
- **Extent and direction.** A distance, symmetric ("centre"), a second distance in the other direction, and "to face / through all". In Onshape, Symmetric is only available for Blind and Through-all ([Onshape help](https://cad.onshape.com/help/Content/extrude.htm)).
- **Preview colours.** I found no vendor source for a colour convention. From general knowledge, a translucent preview in a tool colour (blue-ish for add, red for cut) is the common pattern, and Sketchy already does this (`src/viewport.js` around line 614, blue `0x2f7cf6` vs red `0xe0453a`).
- **Drag handle plus typed value.** Both are expected: an arrow/handle to drag, and a number box you can type into with expressions. Press-pull on a face (Shapr3D, SketchUp-style) should add or cut automatically depending on drag direction. Reviewers praise this for Shapr3D ([Develop3D](https://develop3d.com/reviews/review-shapr3d-ipad-parasoild-modelling/)).

### Common pain points
- **Surprise operation switches.** Users report that extruding into an existing body flips the operation unexpectedly, in both Fusion and Onshape (anecdotal; [Autodesk community](https://forums.autodesk.com/t5/fusion-360-ideastation-archived/predictable-behavior-in-create-dialog-options/idi-p/4388003), [Onshape forum](https://forum.onshape.com/discussion/24727/extrude-switches-from-new-to-add-without-user-input)).
- **Silent failures.** A cut that doesn't show in the preview, or a red feature name with no explanation. Onshape's workaround is to hover the red name for a tooltip ([Onshape forum](https://forum.onshape.com/discussion/comment/50369)).
- **Cut affects the wrong bodies.** Cutting with several bodies visible removes from all of them. Fusion decides this from visibility ([Autodesk help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-EXTRUDE.htm)).

### What Sketchy should do
1. **P1 – Say what the operation will touch.** Whenever Join/Cut/New is chosen automatically, show a one-line label ("Cut from: Body 2") and highlight the target bodies. Never change a user-chosen operation silently.
2. **P1 – Keep the preview legend.** Add a tiny legend (blue = adds material, red = removes) near the dialog so the convention is learnable.
3. **P2 – Failure reasons inline.** If an extrude produces nothing (profile open, no overlap for a cut), show the reason in the dialog, not just a red timeline item. `result.errors` in `src/main.js` already tracks per-feature errors, so surface them in the properties panel.
4. **P2 – Both entry modes.** Confirm the drag handle updates the number box live and typing updates the handle (Sketchy has a `manip` and a `gizmo` path; verify they agree).

---

## 3. Fillet, chamfer and edge/face selection

### What users expect
- **Selection.** Hover highlights the edge or face under the cursor before the click. Click an edge to add it, and Shift or Ctrl-click to add more. Clicking a face selects all its edges. Tangent propagation (selecting the connected tangent chain) is on by default in Onshape ([Onshape fillet help](https://cad.onshape.com/help/Content/PartStudio/fillet.htm)) and is a "Tangent chain" checkbox in Fusion.
- **Context menus.** SolidWorks exposes "Select Tangency" on right-click ([SolidWorks help](https://help.solidworks.com/2017/English/SolidWorks/sldworks/c_tangent_selection.htm)). Onshape has a "Create Selection" tool for tangent-connected edges and faces ([Onshape help](https://cad.onshape.com/help/Content/Home/create_selection.htm)).
- **Selection filters.** Limit picking to faces, edges, vertices or bodies. This helps when several types overlap.
- **Radius as a typed or dragged value.** Preview before commit.

### Common pain points
- **Fillets fail with unhelpful errors.** The usual advice is to change the size slightly, deselect edges, disable Tangent Chain, or split the operation. A radius change of about 0.001 sometimes makes it solve (anecdotal; [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/fillet-chamfer-not-working/m-p/12845373/highlight/true)).
- **Fillets break when earlier features change.** This is the topological naming problem. FreeCAD's wiki advises putting fillets and chamfers last, and says the problem exists in all CAD, with most packages using heuristics to reduce it ([FreeCAD wiki](https://wiki.freecad.org/Topological_naming_problem)). A user on Reddit-type forums reports that in Onshape a broken reference often means redoing it, while Fusion has a repair tool (anecdotal; [v1e forum](https://forum.v1e.com/t/fusion-360-free-vs-onshape-free-in-2024/45898)).

### What Sketchy should do
Sketchy matches edges by position (see the hand-over note), which is a heuristic like other tools use, with mitred corners as a known limit.
1. **P1 – Make a lost edge visible.** When a fillet/chamfer can't find some of its edges after an upstream edit, mark the feature with a warning that says "2 of 6 edges no longer found", highlight the missing ones, and let the user re-pick. Don't drop them silently.
2. **P1 – Tangent chain on by default**, with a checkbox. `src/edges.js` already chains sharp edges. Check that smooth (tangent) chains are the default behaviour users expect.
3. **P2 – Right-click on an edge or face:** "Fillet…", "Chamfer…", "Select tangent chain", "Select loop". The context menus exist in `src/main.js` (around lines 738–800); add the selection actions there.
4. **P2 – Selection filter** (edges/faces/bodies) as a small toggle in the viewport toolbar. Esc already resets the selection mode.
5. **P3 – Radius too large:** show the maximum valid radius in the error ("max about 4.2 mm for these edges") instead of a generic failure.

---

## 4. Viewport navigation

### What users expect
- **Mouse.** Mappings differ by tool, so presets are expected. Onshape: right-drag orbits, with Alt variants; view-cube arrows rotate in 15° steps, with Shift for 90° ([Onshape help](https://cad.onshape.com/help/Content/View/view_navigation_and_the_view_cube.htm)). Fusion: middle-drag pans, Shift+middle orbits (from general knowledge). Shapr3D ships navigation presets for mouse, trackpad and touch ([Shapr3D](https://support.shapr3d.com/hc/en-us/articles/7873881091356)).
- **Touch.** On iPad, Shapr3D uses one-finger orbit, two-finger pan, pinch zoom, and an optional two-finger twist to roll ([Shapr3D](https://support.shapr3d.com/hc/en-us/articles/7873906073884)). Fingers move the view and the pen draws ([Develop3D](https://develop3d.com/reviews/review-shapr3d-ipad-parasoild-modelling/)).
- **View cube and home.** Click faces, edges and corners to snap to standard views. A home button, zoom-to-fit, and an orthographic/perspective toggle.
- **Trackpad.** Two-finger swipe to pan, pinch to zoom, Shift for constrained orbit (user-reported scheme; [Onshape forum](https://forum.onshape.com/discussion/29052/trackpad-controls-on-mac)).

### Common pain points
- Users who move between tools find the default mappings unintuitive and want presets. Shapr3D users have asked for one-finger pan and two-finger rotate instead of its default (anecdotal; [Shapr3D forum](https://discourse.shapr3d.com/t/improvements-to-the-camera-gestures/2284)).
- Orbit about the wrong pivot (the origin instead of the model or the cursor) is a perennial complaint (general knowledge, not confirmed by the searches).

### What Sketchy should do
Sketchy has a view cube with roll arrows, a home button, an orthographic option, two-pane layouts, a touch bar and nav bar, and a Zoom-window tool. Mouse mapping is left = orbit, middle/right = pan (`src/viewport.js` lines 30 and 173).
1. **P1 – Navigation preset setting** (Sketchy / Fusion / Onshape / SolidWorks-style) as a single dropdown. Left-drag orbit conflicts with box-select and sketch drawing in some tools, so presets matter most there.
2. **P2 – Orbit around the cursor or selection** as an option, plus zoom-to-cursor.
3. **P2 – Check that touch has finger = camera, tap = place** when drawing, and that a stylus draws and fingers navigate when a pen is detected.
4. **P3 – Document the mapping** in the shortcut sheet (section 9).

---

## 5. Feature timeline and history editing

### What users expect
- A rollback marker you drag, double-click to edit a feature, drag to reorder, right-click to suppress or delete, and rename.
- Dependency awareness. Reordering a feature ahead of one it depends on should be blocked or explained.
- A visible error state per feature, so you can see where the model broke.

### Common pain points
- **Drag-and-drop reordering lands in the wrong place or freezes** (anecdotal; [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/timeline-bug/m-p/10395870/highlight/true)).
- **Not everything is in the timeline.** In Fusion, some sketch actions and feature edits aren't captured, so reordering is hard and the undo stack is the only record (anecdotal; same thread family).
- **Suppress is unreliable** for some features, and some users avoid it and delete instead (anecdotal; same source).
- **Entering a sketch silently rolls back the model**, so the part looks different from its final state (Autodesk staff; same source).

### What Sketchy should do
Sketchy has all of these: marker (`src/main.js` around line 549), double-click to edit, a dependency-aware suppress (around line 640) and F2 rename.
1. **P1 – Explain refused reorders.** If a drag is blocked by a dependency, show "Extrude 2 uses Sketch 3, so it can't go before it" rather than doing nothing.
2. **P2 – Make rollback state obvious.** When the marker is not at the end, show a banner such as "Viewing step 4 of 9 – new features insert here" with a "Go to end" button. Items after the marker are already dimmed (`tl-item off`).
3. **P2 – Entering a sketch** shows the same banner and returns to the previous marker on exit (Sketchy uses `sketch.index`; confirm it restores the marker).
4. **P3 – Suppress shows dependents** ("also suppresses 2 features") before applying.

---

## 6. Undo/redo, autosave and versioning

### What users expect
- Ctrl/Cmd+Z and Shift+Ctrl+Z or Ctrl+Y that always work and cover sketch edits, feature edits and parameter changes. Undo that skips some actions is a known frustration in Fusion ([Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/undo-and-redo-are-sometimes-problematic/m-p/12186485)).
- **Autosave** with no save button needed, and draft recovery after a crash.
- **Named versions.** In Onshape you can create a named version from the Versions and history panel without leaving the workspace. Versions are view-only. You can restore from any history entry or branch from a version ([Onshape](https://cad.onshape.com/help/Content/versionmanager.htm), [restore](https://cad.onshape.com/help/Content/restore.htm)).
- **Compare.** Compare any two versions, workspaces or history entries, with the first shown in blue and the second in red ([Onshape compare](https://cad.onshape.com/help/Content/compare.htm)).

### Common pain points
- Fusion users advise trying risky edits on a duplicate and saving versions first, because rollback and repair steps can damage a file (anecdotal; [Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/timeline-bug/m-p/10395870/highlight/true)).
- Restoring overwrites the current state with no preview (a risk Onshape mitigates by letting you review differences before committing; [Onshape restore](https://cad.onshape.com/help/Content/restore.htm)).

### What Sketchy should do
Sketchy has undo with history menus on the undo/redo buttons, draft restore (`src/main.js` around line 2397), and `saveVersion` with a description (commit 051e00e).
1. **P1 – Restore as a new head, never destructive.** Restoring an old version should create a new version on top ("Restored from v3"), so nothing is lost.
2. **P1 – Visual compare.** Overlay two versions in the viewport, with the added volume in blue and the removed volume in red, matching the extrude-preview colours. The boolean kernel makes this cheap. Add a text diff of the feature list as a fallback.
3. **P2 – Auto-version.** Take a silent checkpoint before risky operations (import, delete several features, restore) and on close.
4. **P2 – Show save state.** The dirty dot exists; add "Saved to server 2 min ago" so users trust autosave.

---

## 7. Units, parameters and expressions

### What users expect
- A document unit setting (mm, cm, in, and so on) and the freedom to type a unit into any box. In Fusion a bare number is read in the document's units, while "6.25 in" is always inches whatever the document unit ([Fusion API docs](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/UserParameter_expression.htm), [Autodesk forum](https://forums.autodesk.com/t5/fusion-360-design-validate/user-parameter-units/m-p/9514286)).
- Named parameters usable in any field, with arithmetic and functions, and dependent parameters (width = height * 2).
- Dimensional checking, with a clear error for mixing length with angle.

### Common pain points
- A parameter's unit type is hard to change after many features depend on it (anecdotal; same forum thread).
- Mixed-unit expressions (percentage with length) throw errors that don't say why (anecdotal; same source).
- A bare number being interpreted in the wrong unit after switching document units.

### What Sketchy should do
Sketchy stores millimetres internally and converts at the UI boundary (`src/units.js`). `src/params.js` evaluates expressions with units, functions, constants and reserved names, and resolves dependencies.
1. **P1 – Show the resolved value** next to any field that holds an expression (for example `width*2` shows `= 40 mm`), and show the unit in every box.
2. **P2 – Plain-language expression errors:** "Cannot add a length and an angle", "Unknown name 'wdth' – did you mean 'width'?" (`RESERVED` and `NAME_RE` already exist for validation).
3. **P2 – Switching document units** should convert displayed values only, never reinterpret what is stored. Verify this with a quick test (mm to in and back).
4. **P3 – Create a parameter from a field.** A right-click on a number box that says "Make this a parameter".

---

## 8. Import/export and print-readiness

### What users expect
- **STL** for universal compatibility and **3MF** as the modern default for desktop slicers (Bambu, Prusa). 3MF keeps units, colour and multi-material, which STL can't ([JLC3DP](https://jlc3dp.com/blog/3mf-vs-stl)). **STEP** for exact geometry exchange. Both STL and 3MF are plain meshes from CAD, so there is little geometric difference between them (anecdotal; [Bambu forum](https://forum.bambulab.com/t/fusion-360-export-issues/236227?page=2)).
- **Print checks** before export: watertight (manifold) mesh, fits the bed, no thin walls, overhang warning. "Non-manifold edges" errors in slicers are the classic failure, and the community advice is to fix the source model or export STEP and let the slicer mesh it, rather than repair the STL in the slicer ([Bambu forum](https://forum.bambulab.com/t/non-manifold-edges-all-of-a-sudden/77130)).
- Export dialogs that remember the last format and tell you the file size, unit and what is included (all bodies or only the selection).
- Sensible placement: model sits on the build plate (Z = 0) after export.

### Common pain points
- 3MF placing the model differently on the plate than STL (anecdotal; Bambu forum above).
- Imports with the wrong scale, or a silently repaired mesh.
- A "good" model that the slicer rejects, with no hint in the CAD app about why.

### What Sketchy should do
Sketchy imports STL/3MF/OBJ/STEP and SVG/DXF and has `src/printcheck.js` (bed fit, overhangs, wall thickness) plus mesh repair (`src/meshrepair.js`).
1. **P1 – Run the print check as part of Export.** One panel at export time: "Watertight ✓, fits bed ✓, thinnest wall 0.8 mm ⚠, overhangs ⚠". Offer fix actions (repair, orient to bed) and a "Export anyway" button.
2. **P1 – Default to 3MF** in the export menu with STL one click away, and say why in a tooltip. Always write units into 3MF.
3. **P2 – Import report.** After import show units guess, bounding box, triangle count and any repair done, with an easy rescale. Don't alter the mesh silently.
4. **P2 – Export scope:** a visible choice between selection and all visible bodies, and a plate-placement option.
5. **P3 – STEP import limits:** if a STEP file comes in as a mesh, say so.

---

## 9. Onboarding for first-time users

### What users expect
- **A useful empty state.** Beginners compare everything with Tinkercad, which is described as "insanely user friendly" and is the usual first step before Fusion or Onshape (anecdotal; [v1e forum thread](https://forum.v1e.com/t/fusion-360-free-vs-onshape-free-in-2024/45898), [Tinkercad guide](https://spolearninglab.com/curriculum/lessonPlans/hacking/resources/software/3d/tinkercad_intro.html)). Tinkercad's built-in lessons teach moving objects, camera control and shortcuts.
- **Structured learning.** Onshape's "New to CAD" path gets praise. People still report roughly 10 hours before doing something useful (anecdotal; same thread).
- **Starter shapes or templates**, and a first project that finishes in minutes: sketch a rectangle, extrude, fillet, export.
- **Shortcut discoverability.** Onshape opens a shortcut map with Shift+? and has a customisable shortcut toolbar ([Onshape](https://www.onshape.com/en/resource-center/tech-tips/quickly-open-keyboard-shortcuts-page)). Fusion's S key opens a command search (from general knowledge, unconfirmed). One Onshape forum commenter said a beginner tutorial should teach a few shortcuts up front so they become muscle memory (anecdotal; [Onshape forum](https://forum.onshape.com/discussion/comment/3759/)).

### Common pain points
- Blank workspace with a dense toolbar and no hint of what to do first.
- Cost and sign-in friction (Fusion), and a steep learning curve (FreeCAD) (anecdotal; v1e thread).
- Shortcuts that only appear in a tooltip after hovering.

### What Sketchy should do
Sketchy has Ctrl/Cmd+S quick search (`openQuickSearch`), shortcut hints on menu items, tooltips, and an empty timeline message ("Every operation you perform appears here…", `src/main.js` line 564). I found no first-run flow, template gallery or shortcut sheet in the code.
1. **P1 – First-run guided project** ("Make a phone stand in 2 minutes"): a 5-step overlay that highlights the real controls (Sketch, Rectangle, Extrude, Fillet, Export), advances when the user does each thing, and can be skipped and replayed from Help.
2. **P1 – Keyboard shortcut sheet** opened with `?`, listing sketch, modelling and navigation keys, generated from `CMD[...].key` in `src/commands.js` so it never goes stale.
3. **P2 – Empty-viewport hint** in the centre of an empty design: three buttons ("Start a sketch", "Import a model", "Open an example"), gone once the first feature exists.
4. **P2 – Example designs** (bracket with holes, box with lid, parametric gridfinity-style bin) that open with parameters exposed, so people learn by changing a number.
5. **P3 – Tip of the day** for one shortcut at a time, switchable off.

---

## Ranked top-10 UX improvements

1. **Explain failures where they happen** (extrude, fillet, constraints, reorder). Say what failed and give one-click ways to fix it. This is the most common complaint across every tool searched.
2. **First-run guided project plus an empty-state with three starting points.** Biggest win for new users.
3. **Keyboard shortcut sheet (`?`) generated from the command table**, plus first-use key hints for each sketch tool.
4. **Print-readiness panel at export time**, with 3MF as the default and an import report.
5. **Lost-edge warning for fillet/chamfer** after upstream edits, with re-pick, and tangent chain on by default.
6. **Non-destructive restore and visual version compare** (blue added, red removed).
7. **Sketch state indicator** (under/fully defined) and conflict help for constraints.
8. **Navigation presets** (Sketchy / Fusion / Onshape / SolidWorks-style), orbit-around-cursor, and touch/pen separation.
9. **Operation transparency in extrude/cut:** show which bodies will be affected, never switch the user's chosen operation silently, and add a preview-colour legend.
10. **Expression field polish:** show resolved values, friendly error messages, "make this a parameter", and verified unit switching.

---

## Sources

**Vendor documentation**
- [Autodesk Fusion – Extrude a solid body](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-EXTRUDE-SOLID.htm) and [Extrude reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-EXTRUDE.htm)
- [Autodesk Fusion keyboard shortcuts](https://www.autodesk.com/shortcuts/fusion-360) and [Autodesk blog on shortcuts](https://www.autodesk.com/products/fusion-360/blog/fusion-360-modeling-commands-shortcuts/)
- [Autodesk learning – sketch constraints](https://app.learn-one.autodesk.com/learn/ondemand/tutorial/sketch-constraints)
- [Fusion API – UserParameter.expression](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/UserParameter_expression.htm)
- [Onshape – Extrude](https://cad.onshape.com/help/Content/extrude.htm), [Fillet](https://cad.onshape.com/help/Content/PartStudio/fillet.htm), [Create Selection](https://cad.onshape.com/help/Content/Home/create_selection.htm), [View navigation and the View cube](https://cad.onshape.com/help/Content/View/view_navigation_and_the_view_cube.htm)
- [Onshape – Versions](https://cad.onshape.com/help/Content/versionmanager.htm), [Restore](https://cad.onshape.com/help/Content/restore.htm), [Compare](https://cad.onshape.com/help/Content/compare.htm)
- [Onshape tech tips – Shift key](https://onshape.com/en/resource-center/tech-tips/2-ways-the-shift-key-can-increase-productivity) and [keyboard shortcuts page](https://www.onshape.com/en/resource-center/tech-tips/quickly-open-keyboard-shortcuts-page)
- [SolidWorks – Select Tangency](https://help.solidworks.com/2017/English/SolidWorks/sldworks/c_tangent_selection.htm)
- [FreeCAD – Topological naming problem](https://wiki.freecad.org/Topological_naming_problem) and [Sketcher: select conflicting constraints](https://wiki.freecad.org/Sketcher_SelectConflictingConstraints)
- [Shapr3D – gestures](https://support.shapr3d.com/hc/en-us/articles/7873906073884) and [navigation presets](https://support.shapr3d.com/hc/en-us/articles/7873881091356)

**Forums, reviews and community (anecdotal)**
- [Autodesk forum – dimensions (driven/reference)](https://forums.autodesk.com/t5/fusion-design-validate-document/dimensions/m-p/6711713)
- [Autodesk forum – timeline bug](https://forums.autodesk.com/t5/fusion-support-forum/timeline-bug/m-p/10395870/highlight/true)
- [Autodesk forum – undo/redo problems](https://forums.autodesk.com/t5/fusion-support-forum/undo-and-redo-are-sometimes-problematic/m-p/12186485)
- [Autodesk forum – fillet/chamfer not working](https://forums.autodesk.com/t5/fusion-support-forum/fillet-chamfer-not-working/m-p/12845373/highlight/true)
- [Autodesk forum – user parameter units](https://forums.autodesk.com/t5/fusion-360-design-validate/user-parameter-units/m-p/9514286)
- [Autodesk ideas – predictable dialog behaviour](https://forums.autodesk.com/t5/fusion-360-ideastation-archived/predictable-behavior-in-create-dialog-options/idi-p/4388003)
- [Onshape forum – snapping to existing geometry](https://forum.onshape.com/discussion/737/snapping-to-existing-geometry), [extrude switches from New to Add](https://forum.onshape.com/discussion/24727/extrude-switches-from-new-to-add-without-user-input), [red feature tooltip](https://forum.onshape.com/discussion/comment/50369), [trackpad controls](https://forum.onshape.com/discussion/29052/trackpad-controls-on-mac), [beginner shortcuts](https://forum.onshape.com/discussion/comment/3759/)
- [Shapr3D forum – iPad experience](https://discourse.shapr3d.com/t/terrible-user-experience-for-ipad-pro/10540) and [camera gestures](https://discourse.shapr3d.com/t/improvements-to-the-camera-gestures/2284)
- [Develop3D – Shapr3D review](https://develop3d.com/reviews/review-shapr3d-ipad-parasoild-modelling/)
- [JLC3DP – 3MF vs STL](https://jlc3dp.com/blog/3mf-vs-stl), [Bambu forum – Fusion export issues](https://forum.bambulab.com/t/fusion-360-export-issues/236227?page=2), [Bambu forum – non-manifold edges](https://forum.bambulab.com/t/non-manifold-edges-all-of-a-sudden/77130)
- [v1e forum – Fusion free vs Onshape free](https://forum.v1e.com/t/fusion-360-free-vs-onshape-free-in-2024/45898)
- [Tinkercad intro guide](https://spolearninglab.com/curriculum/lessonPlans/hacking/resources/software/3d/tinkercad_intro.html)
