// Model import: STL, OBJ, 3MF and STEP all turn into the same thing, a list of { name, soup, color?, notes[] } where
// `soup` is a Float32Array with 9 numbers (three corners) per triangle, in millimetres. The app then repairs and welds it.
import { parseSTL } from './stl.js';
import { parseSTEP } from './stepimport.js';
import { DESIGN_REL } from './exporters.js';

const MM = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

// ---------------------------------------------------------------- OBJ
/** Wavefront OBJ: v, f (any polygon, negative indices), o/g groups become separate bodies. */
export function parseOBJ(text) {
  const verts = [], groups = [];
  let cur = { name: 'OBJ', tris: [] };
  const flush = () => { if (cur.tris.length) groups.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    if (p[0] === 'v') verts.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'o' || p[0] === 'g') { flush(); cur = { name: p.slice(1).join(' ') || 'OBJ', tris: [] }; }
    else if (p[0] === 'f') {
      const ids = p.slice(1).map((t) => { const n = parseInt(t.split('/')[0], 10); return n < 0 ? verts.length + n : n - 1; });
      if (ids.length < 3 || ids.some((i) => !(i >= 0 && i < verts.length))) continue;
      for (let k = 1; k < ids.length - 1; k++) cur.tris.push(ids[0], ids[k], ids[k + 1]); // fan; fine for the convex polygons CAD exports
    }
  }
  flush();
  if (!groups.length) throw new Error('No faces found in this OBJ file');
  return groups.map((g) => {
    const soup = new Float32Array(g.tris.length * 3);
    g.tris.forEach((vi, i) => soup.set(verts[vi], i * 3));
    return { name: g.name, soup, notes: [] };
  });
}

// ---------------------------------------------------------------- ZIP reader (for 3MF)
/** Read the files of a ZIP archive: stored and deflated entries. Returns Map(name -> Uint8Array). */
export async function readZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This is not a valid 3MF (zip) file');
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const dataAt = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(dataAt, dataAt + csize);
    if (method === 0) files.set(name, raw.slice());
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      files.set(name, new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer()));
    }
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// ---------------------------------------------------------------- 3MF
const attr = (tag, k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(tag); return m ? m[1] : undefined; };
const mulM = (a, b) => { // 3MF 4x3 matrices as 12 numbers (row vectors): result = a then b
  const A = (r, c) => (r < 3 ? a[r * 3 + c] : a[9 + c]), B = (r, c) => (r < 3 ? b[r * 3 + c] : b[9 + c]), out = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) out.push(A(r, 0) * B(0, c) + A(r, 1) * B(1, c) + A(r, 2) * B(2, c) + (r === 3 ? B(3, c) : 0));
  return out;
};
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseM = (s) => { const v = (s || '').trim().split(/\s+/).map(Number); return v.length === 12 && v.every(Number.isFinite) ? v : IDENT; };
const apply = (m, x, y, z) => [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]];

/** 3MF: objects with meshes and components, placed by the build items and their transforms. Reads base colours too. */
export async function parse3MF(buf) {
  const files = await readZip(buf);
  const td = new TextDecoder();
  const model = [...files.keys()].find((k) => /3dmodel\.model$/i.test(k));
  if (!model) throw new Error('No 3D model inside this 3MF file');
  const xml = td.decode(files.get(model));
  const unit = MM[attr(/<model\b[^>]*>/.exec(xml)?.[0] || '', 'unit')] ?? 1;
  const colors = {}; // "pid:index" -> hex
  for (const bm of xml.matchAll(/<basematerials\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/basematerials>/g)) {
    [...bm[2].matchAll(/<base\b[^>]*>/g)].forEach((b, i) => { const c = attr(b[0], 'displaycolor'); if (c) colors[`${bm[1]}:${i}`] = c.slice(0, 7); });
  }
  const objects = new Map();
  for (const o of xml.matchAll(/<object\b([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g)) {
    const head = o[1], body = o[3] || '', id = attr(head, 'id');
    const ob = { id, name: attr(head, 'name') || `Object ${id}`, color: colors[`${attr(head, 'pid')}:${attr(head, 'pindex')}`], verts: null, tris: null, comps: [] };
    const mesh = /<mesh\b[\s\S]*?<\/mesh>/.exec(body)?.[0];
    if (mesh) {
      const v = [];
      for (const m of mesh.matchAll(/<vertex\b[^>]*>/g)) v.push(+attr(m[0], 'x'), +attr(m[0], 'y'), +attr(m[0], 'z'));
      const t = [];
      for (const m of mesh.matchAll(/<triangle\b[^>]*>/g)) t.push(+attr(m[0], 'v1'), +attr(m[0], 'v2'), +attr(m[0], 'v3'));
      ob.verts = v; ob.tris = t;
    }
    for (const c of body.matchAll(/<component\b[^>]*>/g)) ob.comps.push({ id: attr(c[0], 'objectid'), m: parseM(attr(c[0], 'transform')) });
    objects.set(id, ob);
  }
  const items = [...xml.matchAll(/<item\b[^>]*>/g)].map((m) => ({ id: attr(m[0], 'objectid'), m: parseM(attr(m[0], 'transform')) }));
  if (!items.length) items.push(...[...objects.keys()].map((id) => ({ id, m: IDENT })));
  const out = [];
  const place = (id, m, depth, root) => { // meshes of an object and of its components, with all transforms applied
    const ob = objects.get(id);
    if (!ob || depth > 8) return [];
    const parts = [];
    if (ob.verts) parts.push({ ob, m });
    for (const c of ob.comps) parts.push(...place(c.id, mulM(c.m, m), depth + 1, root));
    return parts;
  };
  for (const it of items) {
    const parts = place(it.id, it.m, 0, it.id);
    if (!parts.length) continue;
    const soup = [];
    for (const { ob, m } of parts) {
      for (let i = 0; i < ob.tris.length; i++) soup.push(...apply(m, ob.verts[ob.tris[i] * 3], ob.verts[ob.tris[i] * 3 + 1], ob.verts[ob.tris[i] * 3 + 2]).map((c) => c * unit));
    }
    out.push({ name: objects.get(it.id)?.name || 'Part', soup: Float32Array.from(soup), color: parts[0].ob.color, notes: [] });
  }
  if (!out.length) throw new Error('No meshes found in this 3MF file');
  return out;
}

/** The Sketchy design stored inside a 3MF written by Sketchy (as text), or null for any other 3MF. */
export async function readEmbeddedDesign(buf) {
  let files;
  try { files = await readZip(buf); } catch { return null; }
  const td = new TextDecoder();
  const rels = files.get('_rels/.rels');
  let target = null;
  if (rels) for (const m of td.decode(rels).matchAll(/<Relationship\b[^>]*>/g)) if (attr(m[0], 'Type') === DESIGN_REL) target = attr(m[0], 'Target');
  const part = target && files.get(target.replace(/^\//, ''));
  if (!part) return null;
  const txt = td.decode(part);
  try { return JSON.parse(txt)?.format === 'sketchy' ? txt : null; } catch { return null; }
}

// ---------------------------------------------------------------- dispatcher
export const IMPORT_ACCEPT = '.stl,.obj,.3mf,.step,.stp';

/** Read any supported model file into [{ name, soup, color?, notes }]. */
export async function readModelFile(file) {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || '').toLowerCase(), base = file.name.replace(/\.[^.]+$/, '');
  let list;
  if (ext === 'stl') list = [{ name: base, soup: parseSTL(await file.arrayBuffer()), notes: [] }];
  else if (ext === 'obj') list = parseOBJ(await file.text());
  else if (ext === '3mf') list = await parse3MF(await file.arrayBuffer());
  else if (ext === 'step' || ext === 'stp') list = parseSTEP(await file.text());
  else throw new Error('Unsupported file type. Open an STL, OBJ, 3MF or STEP file.');
  if (list.length === 1 && (!list[0].name || /^(OBJ|Part|STEP)$/i.test(list[0].name))) list[0].name = base;
  return list;
}
