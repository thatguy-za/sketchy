// The file formats: a design is plain JSON that follows docs/design.schema.json, and a 3MF written by Sketchy carries it inside so one
// file prints in a slicer and reopens for editing. Run with `npm run test:formats`.
import fs from 'node:fs';
import { write3MF, writeGLB } from '../src/exporters.js';
import { parse3MF, readEmbeddedDesign } from '../src/importers.js';
import { parseSTEP } from '../src/stepimport.js';

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };
const schema = JSON.parse(fs.readFileSync(new URL('../docs/design.schema.json', import.meta.url), 'utf8'));

/** A small JSON Schema checker: the keywords the schema file uses. Returns a list of problems. */
function validate(v, s, at = '$', root = schema) {
  if (s.$ref) return validate(v, s.$ref.split('/').slice(1).reduce((o, k) => o[k], root), at, root);
  const errs = [], type = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if ('const' in s && v !== s.const) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.type) {
    const ok = [].concat(s.type).some((t) => t === type(v) || (t === 'number' && typeof v === 'number') || (t === 'object' && type(v) === 'object'));
    if (!ok) return [`${at}: expected ${[].concat(s.type).join(' or ')}, got ${type(v)}`];
  }
  if (typeof v === 'string' && s.maxLength && v.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) errs.push(`${at}: below ${s.minimum}`);
  if (type(v) === 'object') {
    for (const k of s.required || []) if (!(k in v)) errs.push(`${at}: missing "${k}"`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) errs.push(...validate(v[k], sub, `${at}.${k}`, root));
    if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const [k, x] of Object.entries(v)) if (!(s.properties || {})[k]) errs.push(...validate(x, s.additionalProperties, `${at}.${k}`, root));
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(x, s.items, `${at}[${i}]`, root)));
  return errs;
}

const design = (name, features = []) => ({ format: 'sketchy', version: 1, name, features, marker: features.length, nextId: 10, params: [{ name: 'w', expr: '20 mm', unit: 'length', comment: '' }], appearance: {}, faceAppearance: [], units: 'mm', components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [] });
const body = { id: 'b', name: 'Block', color: '#336699', verts: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), tris: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };

console.log('The design schema');
check('an ordinary design follows the schema', validate(design('Bracket'), schema).length === 0);
check('a file that is not a design is refused', validate({ format: 'other', features: [] }, schema).length > 0);
check('a feature without an id is refused', validate(design('X', [{ type: 'extrude' }]), schema).length > 0);

console.log('3MF with the design inside');
const d = JSON.stringify(design('Box with lid'));
const plain = await write3MF([body], 'Plain').arrayBuffer(), withD = await write3MF([body], 'Box', d).arrayBuffer();
check('the design comes back unchanged', (await readEmbeddedDesign(withD)) === d);
check('a plain 3MF has no design', (await readEmbeddedDesign(plain)) === null);
check('a file that is not a zip has no design', (await readEmbeddedDesign(new TextEncoder().encode('hello').buffer)) === null);
const shapes = await parse3MF(withD);
check('slicers and Insert Model still see the shape', shapes.length === 1 && shapes[0].soup.length === 36, String(shapes[0]?.soup.length));
check('the colour is kept', shapes[0].color === '#336699', shapes[0].color);
const text = Buffer.from(withD).toString('latin1');
check('the design is declared as its own relationship and part', text.includes('/Metadata/sketchy-design.json') && text.includes('relationships/design') && text.includes('Extension="json"'));
const notDesign = await write3MF([body], 'X', JSON.stringify({ format: 'other' })).arrayBuffer();
check('a JSON part that is not a Sketchy design is ignored', (await readEmbeddedDesign(notDesign)) === null);

console.log('glTF (.glb)');
{
  const buf = Buffer.from(await writeGLB([body, { ...body, id: 'c', name: 'Plain', color: undefined }], 'Two').arrayBuffer());
  const jlen = buf.readUInt32LE(12), json = JSON.parse(buf.subarray(20, 20 + jlen).toString()), bstart = 20 + jlen + 8;
  check('the header says glTF version 2 and the length matches the file', buf.toString('latin1', 0, 4) === 'glTF' && buf.readUInt32LE(4) === 2 && buf.readUInt32LE(8) === buf.length);
  check('the JSON chunk and the binary chunk are 4-byte aligned', jlen % 4 === 0 && buf.readUInt32LE(bstart - 4) === 0x004e4942 && (buf.length - bstart) % 4 === 0);
  check('one node and mesh per body', json.nodes.length === 2 && json.meshes.length === 2 && json.asset.version === '2.0');
  const pos = json.accessors[0], idx = json.accessors[1];
  check('positions are in metres with Y up (z of 10 mm is y of 0.01)', pos.count === 4 && Math.abs(pos.max[1] - 0.01) < 1e-9 && Math.abs(pos.min[2] + 0.01) < 1e-9, JSON.stringify([pos.min, pos.max]));
  check('indices stay inside the vertex list', idx.count === 12 && new Uint32Array(buf.buffer.slice(buf.byteOffset + bstart + json.bufferViews[1].byteOffset, buf.byteOffset + bstart + json.bufferViews[1].byteOffset + 48)).every((i) => i < 4));
  check('the colour becomes a material and a body without colour has none', json.materials?.length === 1 && json.meshes[0].primitives[0].material === 0 && json.meshes[1].primitives[0].material === undefined);
  check('the buffer length in the JSON matches the binary chunk', json.buffers[0].byteLength === buf.readUInt32LE(bstart - 8));
  const empty = Buffer.from(await writeGLB([], 'None').arrayBuffer());
  check('a file with no bodies is still a valid glb', empty.toString('latin1', 0, 4) === 'glTF' && empty.readUInt32LE(8) === empty.length);
}

console.log('\nSTEP with free-form (B-spline) geometry');
/** A 10 mm box as STEP text: five plane faces and a top that is a B-spline surface whose edges are B-spline curves.
 *  complex: write them as complex entities (the form rational surfaces come in) and run the surface's parameters the other way round. */
function boxStep(complex) {
  const e = [], add = (txt) => { e.push(txt); return e.length; }; // entity ids start at 1
  const pt = (x, y, z) => add(`CARTESIAN_POINT('',(${x}.,${y}.,${z}.))`), dir = (x, y, z) => add(`DIRECTION('',(${x}.,${y}.,${z}.))`);
  const V = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]], P = V.map((v) => pt(...v)), VP = P.map((p) => add(`VERTEX_POINT('',#${p})`));
  const line = (a, b) => { const d = V[b].map((v, i) => v - V[a][i]); return add(`LINE('',#${P[a]},#${add(`VECTOR('',#${dir(...d.map((x) => x / 10))},10.)`)})`); };
  const spline = (a, b) => (complex
    ? add(`(BOUNDED_CURVE() B_SPLINE_CURVE(1,(#${P[a]},#${P[b]}),.UNSPECIFIED.,.F.,.F.) B_SPLINE_CURVE_WITH_KNOTS((2,2),(0.,1.),.UNSPECIFIED.) CURVE() GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE((1.,1.)) REPRESENTATION_ITEM(''))`)
    : add(`B_SPLINE_CURVE_WITH_KNOTS('',1,(#${P[a]},#${P[b]}),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.)`));
  const ends = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const EC = ends.map(([a, b], i) => add(`EDGE_CURVE('',#${VP[a]},#${VP[b]},#${i >= 4 && i <= 7 ? spline(a, b) : line(a, b)},.T.)`));
  const loop = (list) => add(`EDGE_LOOP('',(${list.map(([i, f]) => `#${add(`ORIENTED_EDGE('',*,*,#${EC[i]},.${f ? 'T' : 'F'}.)`)}`).join(',')}))`);
  const plane = (o, n, r) => add(`PLANE('',#${add(`AXIS2_PLACEMENT_3D('',#${pt(...o)},#${dir(...n)},#${dir(...r)})`)})`);
  const face = (lp, surf, same = true) => add(`ADVANCED_FACE('',(#${add(`FACE_OUTER_BOUND('',#${loop(lp)},.T.)`)}),#${surf},.${same ? 'T' : 'F'}.)`);
  const cps = complex ? [[[0, 0, 10], [10, 0, 10]], [[0, 10, 10], [10, 10, 10]]] : [[[0, 0, 10], [0, 10, 10]], [[10, 0, 10], [10, 10, 10]]]; // u along y (complex) or x
  const rows = cps.map((r) => `(${r.map((c) => `#${pt(...c)}`).join(',')})`).join(',');
  const top = complex
    ? add(`(BOUNDED_SURFACE() B_SPLINE_SURFACE(1,1,(${rows}),.UNSPECIFIED.,.F.,.F.,.F.) B_SPLINE_SURFACE_WITH_KNOTS((2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.) GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_SURFACE(((1.,1.),(1.,1.))) REPRESENTATION_ITEM('') SURFACE())`)
    : add(`B_SPLINE_SURFACE_WITH_KNOTS('',1,1,(${rows}),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)`);
  const faces = [
    face([[3, 0], [2, 0], [1, 0], [0, 0]], plane([0, 0, 0], [0, 0, -1], [1, 0, 0])),
    face([[4, 1], [5, 1], [6, 1], [7, 1]], top, !complex), // the complex surface's normal points down, so the face says "reversed"
    face([[0, 1], [9, 1], [4, 0], [8, 0]], plane([0, 0, 0], [0, -1, 0], [1, 0, 0])),
    face([[1, 1], [10, 1], [5, 0], [9, 0]], plane([10, 0, 0], [1, 0, 0], [0, 1, 0])),
    face([[2, 1], [11, 1], [6, 0], [10, 0]], plane([0, 10, 0], [0, 1, 0], [-1, 0, 0])),
    face([[3, 1], [8, 1], [7, 0], [11, 0]], plane([0, 0, 0], [-1, 0, 0], [0, 1, 0])),
  ];
  const solid = add(`MANIFOLD_SOLID_BREP('Box',#${add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)})`);
  void solid;
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('box.step','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${e.map((t, i) => `#${i + 1}=${t};`).join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
/** Weld the triangle soup (0.0001 mm, as the kernel does) and say whether it is a closed, consistently turned surface, and its volume. */
function closedAndVolume(soup) {
  const ids = new Map(), id = (i) => { const k = [0, 1, 2].map((c) => Math.round(soup[i * 3 + c] * 1e4)).join(','); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const edges = new Map(); let vol = 0;
  for (let t = 0; t < soup.length / 9; t++) {
    const v = [id(t * 3), id(t * 3 + 1), id(t * 3 + 2)];
    for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`, e = edges.get(key) || [0, 0]; e[a < b ? 0 : 1]++; edges.set(key, e); }
    const o = t * 9, [ax, ay, az, bx, by, bz, cx, cy, cz] = soup.subarray(o, o + 9);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { closed: [...edges.values()].every((e) => e[0] === 1 && e[1] === 1), vol };
}
for (const complex of [false, true]) {
  const form = complex ? 'complex entities' : 'single entities';
  let part = null, err = '';
  try { part = parseSTEP(boxStep(complex))[0]; } catch (x) { err = x.message; }
  check(`a box with a B-spline top (${form}) imports`, !!part, err);
  if (!part) continue;
  const r = closedAndVolume(part.soup);
  check(`its surface is closed with every triangle turned the same way (${form})`, r.closed);
  check(`its volume is 1000 mm3 and positive, so the faces point outward (${form})`, Math.abs(r.vol - 1000) < 0.01, `volume ${r.vol}`);
  check(`nothing was left unread (${form})`, !part.notes.some((n) => /could not be read/.test(n)), part.notes.join('; '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
