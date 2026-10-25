// The file formats: a design is plain JSON that follows docs/design.schema.json, and a 3MF written by Sketchy carries it inside so one
// file prints in a slicer and reopens for editing. Run with `npm run test:formats`.
import fs from 'node:fs';
import { write3MF, writeGLB } from '../src/exporters.js';
import { parse3MF, readEmbeddedDesign } from '../src/importers.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
