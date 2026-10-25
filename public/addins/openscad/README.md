# OpenSCAD import and export

An add-in for Sketchy.

**Import:** Insert Model (or drop a file) with a `.scad` script. If the script has settings at the top (`width = 40;`), a form lets you change them first. The result is added as one body.

**Export:** Export, then "OpenSCAD script". Each body becomes a `polyhedron` module. The script is a snapshot of the shape; OpenSCAD cannot recreate Sketchy's feature timeline.

**What it reads:** cube, sphere, cylinder, polyhedron, square, circle, polygon; translate, rotate, scale, mirror, multmatrix, offset, hull, minkowski, union, difference, intersection, linear_extrude, rotate_extrude; variables, functions, modules, loops, conditionals, list comprehensions, the maths functions, `children()`, `$fn`/`$fa`/`$fs`.

**What it skips (and tells you about):** `text()`, `import()`, `surface()`, `projection()`, `resize()`, and `include`/`use` of other files.

This add-in reads the OpenSCAD language itself and contains no OpenSCAD code. It is MIT licensed.
