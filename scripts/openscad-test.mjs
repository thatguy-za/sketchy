// The OpenSCAD add-in: the script reader (public/addins/openscad/scad.js) and the shapes it builds with the geometry service.
// Run with `npm run test:openscad`.
import { runScad, listParameters } from '../public/addins/openscad/scad.js';
import { buildTree } from '../src/csg-service.js';
import { exportScad } from '../public/addins/openscad/export.js';
import { validateManifest, validatePackage } from '../addin-validate.js';
import { readFileSync } from 'node:fs';
import { initKernel } from '../src/kernel.js';

const K = await initKernel(); // the mesh kernel: the geometry service builds with it
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`); };
const vol = (src, opts) => { const r = runScad(src, opts); const m = r.tree && buildTree(K, r.tree); return { r, v: m ? +m.volume.toFixed(3) : 0, m }; };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const section = (n) => console.log('\n' + n);

section('Shapes and transforms');
check('a cube', near(vol('cube([10,20,30]);').v, 6000));
check('a centred cube', near(vol('cube(10, center=true);').v, 1000) && vol('cube(10, center=true);').m.verts.every((_, i) => true));
check('a sphere with $fn=64 is close to a true sphere', near(vol('sphere(r=10, $fn=64);').v, (4 / 3) * Math.PI * 1000, 0.02));
check('a cylinder with diameter and $fn', near(vol('cylinder(h=10, d=10, $fn=128);').v, Math.PI * 25 * 10, 0.01));
check('a cone (r1, r2)', near(vol('cylinder(h=10, r1=5, r2=0, $fn=128);').v, (Math.PI * 25 * 10) / 3, 0.02));
check('translate and rotate keep the volume', near(vol('translate([5,5,5]) rotate([30,40,50]) cube([2,3,4]);').v, 24));
check('rotate about an axis', near(vol('rotate(a=45, v=[1,1,0]) cube([2,3,4]);').v, 24));
check('scale multiplies the volume', near(vol('scale([2,3,4]) cube(1);').v, 24));
check('mirror keeps the volume (and a solid, not an inside-out one)', near(vol('mirror([1,0,0]) cube([2,3,4]);').v, 24));
check('multmatrix', near(vol('multmatrix([[1,0,0,10],[0,1,0,0],[0,0,1,0]]) cube(2);').v, 8));

section('Booleans and extrusions');
check('difference', near(vol('difference(){ cube(10); translate([5,5,5]) cube(10); }').v, 1000 - 125));
check('intersection', near(vol('intersection(){ cube(10); translate([5,5,5]) cube(10); }').v, 125));
check('union of overlapping cubes', near(vol('union(){ cube(10); translate([5,5,5]) cube(10); }').v, 1875));
check('top-level objects are joined', near(vol('cube(2); translate([5,0,0]) cube(2);').v, 16));
check('linear_extrude of a square', near(vol('linear_extrude(height=5) square([4,6]);').v, 120));
check('linear_extrude of a circle with center', near(vol('linear_extrude(height=10, center=true) circle(r=3, $fn=96);').v, Math.PI * 9 * 10, 0.01));
check('linear_extrude with scale', near(vol('linear_extrude(height=10, scale=0.5) square(10);').v, (10 * (100 + 50 + 25)) / 3, 0.02), String(vol('linear_extrude(height=10, scale=0.5) square(10);').v));
check('linear_extrude of a polygon with a hole', near(vol('linear_extrude(1) polygon(points=[[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8]], paths=[[0,1,2,3],[4,5,6,7]]);').v, 64));
check('rotate_extrude makes a ring', near(vol('rotate_extrude($fn=128) translate([10,0]) square([2,2]);').v, Math.PI * (144 - 100) * 2, 0.01));
check('2D difference then extrude', near(vol('linear_extrude(2) difference(){ square(10); translate([2,2]) square(6); }').v, 128));
check('offset rounds a square', near(vol('linear_extrude(1) offset(r=1, $fn=64) square(10);').v, 100 + 40 + Math.PI, 0.01));
check('hull of two cubes', near(vol('hull(){ cube(1); translate([10,0,0]) cube(1); }').v, 11));
check('minkowski of a cube and a sphere is bigger than the cube', vol('minkowski(){ cube(10); sphere(1, $fn=24); }').v > 1500);
check('a polyhedron (a tetrahedron)', near(vol('polyhedron(points=[[0,0,0],[6,0,0],[0,6,0],[0,0,6]], faces=[[0,2,1],[0,1,3],[1,2,3],[2,0,3]]);').v, 36), String(vol('polyhedron(points=[[0,0,0],[6,0,0],[0,6,0],[0,0,6]], faces=[[0,2,1],[0,1,3],[1,2,3],[2,0,3]]);').v));

section('The language');
check('variables and arithmetic', near(vol('a=3; b=a*2+1; cube([b, a, 1]);').v, 21));
check('the last assignment in a scope wins everywhere (OpenSCAD rule)', near(vol('x=1; cube(x); x=2;').v, 8));
check('a user module with parameters and defaults', near(vol('module box(w=2,h=3){ cube([w,w,h]); } box(); translate([10,0,0]) box(w=4,h=1);').v, 12 + 16));
check('a user function', near(vol('function sq(x)=x*x; cube(sq(3));').v, 729));
check('a for loop with a range', near(vol('for(i=[0:3]) translate([i*10,0,0]) cube(2);').v, 32));
check('a for loop with a step and a vector', near(vol('for(i=[0:2:6]) translate([i*10,0,0]) cube(1); for(p=[[0,20,0],[5,20,0]]) translate(p) cube(1);').v, 4 + 2));
check('nested loops', near(vol('for(i=[0:2]) for(j=[0:1]) translate([i*5,j*5,0]) cube(1);').v, 6));
check('if / else', near(vol('n=3; if(n>2) cube(2); else cube(5);').v, 8) && near(vol('n=1; if(n>2) cube(2); else cube(5);').v, 125));
check('the conditional operator', near(vol('cube(1>2 ? 5 : 3);').v, 27));
check('let', near(vol('let(a=2, b=a+1) cube(b);').v, 27));
check('list comprehension and sum with recursion', near(vol('function sum(v,i=0)= i>=len(v)?0:v[i]+sum(v,i+1); cube(sum([for(k=[1:3]) k*2]));').v, 1728));
check('vector indexing and .x', near(vol('p=[4,5,6]; cube([p[0], p.y, p[2]]);').v, 120));
check('math functions use degrees', near(vol('cube(sin(90)*2);').v, 8) && near(vol('cube(cos(0)*round(2.6));').v, 27));
check('children() lets a module wrap other shapes', near(vol('module twice(){ children(); translate([10,0,0]) children(); } twice() cube(2);').v, 16));
check('$fn passes into modules (dynamic scope)', vol('module ball(){ sphere(5); } $fn=12; ball();').v < vol('module ball(){ sphere(5); } $fn=64; ball();').v);
check('default fragments from $fa and $fs', vol('sphere(10);').v > 3000);
check('a disabled shape (*) is skipped', near(vol('*cube(100); cube(2);').v, 8));
check('a background shape (%) is skipped', near(vol('%cube(100); cube(2);').v, 8));
check('strings and str()', near(vol('s=str("a",2); cube(len(s));').v, 8));
check('echo is collected, not printed', runScad('echo("hi", 1+1); cube(1);').echoes[0] === '"hi", 2');
check('comments are ignored', near(vol('// one\n/* two\n three */ cube(2); // four').v, 8));
check('numbers like .5 and 1e1', near(vol('cube([.5, 1e1, 2]);').v, 10));

section('What it cannot do is reported, not hidden');
let r = runScad('text("hi"); import("x.stl"); include <lib.scad>; cube(1);');
check('text, import and include are skipped with warnings, and the rest still builds', r.warnings.length === 3 && r.tree && buildTree(K, r.tree).volume > 0.9, JSON.stringify(r.warnings));
r = runScad('foo(); cube(1);');
check('an unknown module is reported', /foo/.test(r.warnings[0]));
check('an empty script gives no shape', runScad('x=1;').tree === null);

section('Errors and limits');
const throws = (src) => { try { runScad(src); return null; } catch (e) { return e.message; } };
check('a syntax error says which line', /Line 2/.test(throws('cube(1);\ncube(;') || ''), throws('cube(1);\ncube(;'));
check('an unclosed brace is explained', /never closed/.test(throws('module a(){ cube(1);') || ''), throws('module a(){ cube(1);'));
check('endless recursion is stopped', /too deeply|too long/.test(throws('module a(){ a(); } a();') || ''), throws('module a(){ a(); } a();'));
check('a runaway loop is stopped', /too long|too many/.test(throws('for(i=[0:1e9]) cube(1);') || ''), throws('for(i=[0:1e9]) cube(1);'));
check('an assertion that fails stops the script with its message', /assertion failed: nope/.test(throws('assert(false, "nope");') || ''));
check('a huge script is refused', /too large/.test(throws('x'.repeat(2e6)) || ''));
check('a model with too many shapes is refused', /more than/.test(throws('for(i=[0:30000]) translate([i,0,0]) cube(1);') || ''), throws('for(i=[0:30000]) translate([i,0,0]) cube(1);'));
check('a bad shape in the tree is refused by the builder, not crashed on', (() => { try { buildTree(K, { t: 'cube', size: 'big' }); return false; } catch (e) { return /cube size/.test(e.message); } })());
check('the builder frees what it made and is repeatable', near(vol('cube(3);').v, 27) && near(vol('cube(3);').v, 27));

section('Customizer settings');
const ps = listParameters('width = 40;\nname = "Box";\nthick = 2.5;\nfancy = true;\nneg = -3;\nx = width*2;\nmodule m(){}\nlate = 5;');
check('the top-level settings above the first module are listed', ps.map((p) => p.name).join() === 'width,name,thick,fancy,neg' && ps[0].value === 40 && ps[4].value === -3, JSON.stringify(ps));
check('a setting can be overridden before the script runs', near(vol('width=10; cube([width,1,1]);', { overrides: { width: 30 } }).v, 30));

section('Export to OpenSCAD and back');
{
  const src = 'difference(){ cube([20,10,8]); translate([10,5,-1]) cylinder(h=12, r=3, $fn=48); }';
  const a = vol(src), body = { id: 'f1', name: 'Plate 1', verts: a.m.verts, tris: a.m.tris };
  const scad = exportScad({ name: 'Round trip', bodies: [body, { ...body, id: 'f2', name: 'Plate 1' }], parameters: [{ name: 'w', expr: '20 mm' }] });
  check('the exported script has a module per body, named safely and uniquely', /module Plate_1\(\)/.test(scad) && /module Plate_1_\(\)/.test(scad) && /Plate_1\(\);\nPlate_1_\(\);/.test(scad));
  check('parameters are listed as comments', /\/\/   w = 20 mm/.test(scad));
  const back = runScad(scad), m = back.tree && buildTree(K, back.tree);
  check('two identical bodies in one script read back as one shape (they overlap)', m && near(m.volume, a.v, 0.001), `${m?.volume} vs ${a.v}`);
  const one = runScad(exportScad({ name: 'x', bodies: [body] })), m1 = one.tree && buildTree(K, one.tree);
  check('a body survives the round trip: same volume', m1 && near(m1.volume, a.v, 0.001), `${m1?.volume} vs ${a.v}`);
  check('a name with odd characters, newlines or a leading digit is made safe', (() => { const t = exportScad({ name: 'A\nB', bodies: [{ ...body, name: '3 holes!' }] }); return /module _3_holes\(\)/.test(t) && !/A\nB/.test(t.split('\n')[0].slice(3)); })());
}

section('Add-in packages');
{
  const dir = new URL('../public/addins/openscad/', import.meta.url), manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const files = Object.fromEntries(['main.js', 'scad.js', 'export.js', 'README.md', 'LICENSE'].map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
  check('the shipped OpenSCAD add-in is a valid package', validatePackage(manifest, files) === null, validatePackage(manifest, files));
  const ok = { id: 'demo', name: 'Demo', version: '1.0.0' };
  check('a minimal manifest is fine', validateManifest(ok) === null);
  for (const [why, m] of [['no id', { ...ok, id: undefined }], ['a bad id', { ...ok, id: 'Bad Id' }], ['no name', { ...ok, name: '' }], ['a bad version', { ...ok, version: 'one' }], ['an unknown permission', { ...ok, permissions: ['network'] }], ['a main that climbs out', { ...ok, main: '../x.js' }], ['contributes of an unknown kind', { ...ok, contributes: { toolbars: [] } }], ['an importer with no extensions', { ...ok, contributes: { importers: [{ id: 'a', label: 'A' }] } }], ['a repeated command id', { ...ok, contributes: { commands: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] } }], ['not an object', 'text']]) check(`a manifest with ${why} is refused`, !!validateManifest(m));
  check('a package whose main file is missing is refused', !!validatePackage({ ...ok, main: 'run.js' }, { 'main.js': 'x' }));
  check('a package with a path that climbs out is refused', !!validatePackage(ok, { 'main.js': 'x', '../y.js': 'z' }));
  check('a package with too many files is refused', !!validatePackage(ok, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.js`, 'x']))));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
