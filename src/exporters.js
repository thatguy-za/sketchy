// Mesh exporters: OBJ, 3MF (zip, stored) and faceted STEP (AP203 FACETED_BREP, triangles only - not parametric/exact).
// `bodies` are kernel bodies: { id, name, verts: Float32Array, tris: Uint32Array, color? }

const enc = new TextEncoder();
const safe = (s) => String(s || 'body').replace(/[^\w .-]/g, '_');

export function writeOBJ(bodies, name = 'Sketchy') {
  const out = [`# ${name} - exported from Sketchy (units: mm)`];
  let base = 1;
  for (const b of bodies) {
    out.push(`o ${safe(b.name || b.id)}`);
    for (let i = 0; i < b.verts.length; i += 3) out.push(`v ${+b.verts[i].toFixed(5)} ${+b.verts[i + 1].toFixed(5)} ${+b.verts[i + 2].toFixed(5)}`);
    for (let i = 0; i < b.tris.length; i += 3) out.push(`f ${b.tris[i] + base} ${b.tris[i + 1] + base} ${b.tris[i + 2] + base}`);
    base += b.verts.length / 3;
  }
  return new Blob([out.join('\n') + '\n'], { type: 'model/obj' });
}

// ---- minimal ZIP writer (no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipStore(files) { // files: [{name, data: Uint8Array}]
  const chunks = [], central = [];
  let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + sz;
  }
  const csize = central.reduce((n, u) => n + u.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

const hex = (c) => { const v = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16); return Number.isFinite(v) ? '#' + (v & 0xffffff).toString(16).padStart(6, '0').toUpperCase() + 'FF' : null; };

export const DESIGN_PART = '/Metadata/sketchy-design.json';
export const DESIGN_REL = 'https://sketchy.app/schemas/2026/relationships/design';

/** 3MF core spec, millimetre units, one object per body, optional per-body colour. When `design` (the Sketchy design JSON, as text) is given it
 *  rides along as a package part with its own relationship, as the 3MF/OPC format allows: slicers ignore it, Sketchy reopens it for editing. */
export function write3MF(bodies, name = 'Sketchy', design = null) {
  const colors = [...new Set(bodies.map((b) => hex(b.color)).filter(Boolean))];
  let m = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<metadata name="Title">${safe(name)}</metadata>\n<metadata name="Application">Sketchy</metadata>\n<resources>\n`;
  if (colors.length) m += `<basematerials id="1">${colors.map((c, i) => `<base name="c${i}" displaycolor="${c}"/>`).join('')}</basematerials>\n`;
  const ids = [];
  bodies.forEach((b, n) => {
    const id = n + 2; ids.push(id);
    const ci = colors.indexOf(hex(b.color));
    m += `<object id="${id}" type="model" name="${safe(b.name || b.id)}"${ci >= 0 ? ` pid="1" pindex="${ci}"` : ''}><mesh><vertices>\n`;
    for (let i = 0; i < b.verts.length; i += 3) m += `<vertex x="${+b.verts[i].toFixed(5)}" y="${+b.verts[i + 1].toFixed(5)}" z="${+b.verts[i + 2].toFixed(5)}"/>\n`;
    m += '</vertices><triangles>\n';
    for (let i = 0; i < b.tris.length; i += 3) m += `<triangle v1="${b.tris[i]}" v2="${b.tris[i + 1]}" v3="${b.tris[i + 2]}"/>\n`;
    m += '</triangles></mesh></object>\n';
  });
  m += `</resources>\n<build>${ids.map((i) => `<item objectid="${i}"/>`).join('')}</build>\n</model>\n`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>${design ? '<Default Extension="json" ContentType="application/json"/>' : ''}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${design ? `<Relationship Target="${DESIGN_PART}" Id="rel1" Type="${DESIGN_REL}"/>` : ''}</Relationships>`;
  const z = zipStore([
    { name: '[Content_Types].xml', data: enc.encode(ct) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(m) },
    ...(design ? [{ name: DESIGN_PART.slice(1), data: enc.encode(design) }] : []),
  ]);
  return new Blob([z], { type: 'model/3mf' });
}

/**
 * glTF 2.0 binary (.glb): one node and mesh per body with its base colour. glTF is Y-up and in metres, so a point (x, y, z) in millimetres
 * becomes (x, z, -y) / 1000; that turn keeps the triangles facing the same way. No normals are written: viewers shade each triangle flat.
 */
export function writeGLB(bodies, name = 'Sketchy') {
  const parts = bodies.filter((b) => b.verts.length && b.tris.length);
  const bin = [], views = [], accessors = [], meshes = [], nodes = [], materials = [];
  let off = 0;
  const push = (u8) => { const at = off; bin.push(u8); off += u8.length; const pad = (4 - (off % 4)) % 4; if (pad) { bin.push(new Uint8Array(pad)); off += pad; } return at; };
  const matOf = new Map();
  parts.forEach((b, n) => {
    const nv = b.verts.length / 3, pos = new Float32Array(nv * 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) {
      const x = b.verts[i * 3] / 1000, y = b.verts[i * 3 + 2] / 1000, z = -b.verts[i * 3 + 1] / 1000;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      for (const [k, v] of [x, y, z].entries()) { if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    }
    const idx = Uint32Array.from(b.tris);
    const pv = views.push({ buffer: 0, byteOffset: push(new Uint8Array(pos.buffer)), byteLength: pos.byteLength, target: 34962 }) - 1;
    const iv = views.push({ buffer: 0, byteOffset: push(new Uint8Array(idx.buffer)), byteLength: idx.byteLength, target: 34963 }) - 1;
    const pa = accessors.push({ bufferView: pv, componentType: 5126, count: nv, type: 'VEC3', min: lo.map((v) => +v.toFixed(7)), max: hi.map((v) => +v.toFixed(7)) }) - 1;
    const ia = accessors.push({ bufferView: iv, componentType: 5125, count: idx.length, type: 'SCALAR' }) - 1;
    const c = hex(b.color); let mi = null;
    if (c) {
      if (!matOf.has(c)) { const v = parseInt(c.slice(1, 7), 16), lin = (s) => { const x = s / 255; return +(x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).toFixed(5); }; matOf.set(c, materials.push({ name: `c${materials.length}`, pbrMetallicRoughness: { baseColorFactor: [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255), 1], metallicFactor: 0, roughnessFactor: 0.6 } }) - 1); }
      mi = matOf.get(c);
    }
    meshes.push({ name: safe(b.name || b.id), primitives: [{ attributes: { POSITION: pa }, indices: ia, mode: 4, ...(mi !== null ? { material: mi } : {}) }] });
    nodes.push({ name: safe(b.name || b.id), mesh: n });
  });
  const json = { asset: { version: '2.0', generator: 'Sketchy' }, scene: 0, scenes: [{ name: safe(name), nodes: nodes.map((_, i) => i) }], nodes, meshes, ...(materials.length ? { materials } : {}), accessors, bufferViews: views, buffers: [{ byteLength: off }] };
  let js = enc.encode(JSON.stringify(json)); const jpad = (4 - (js.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(js.length + jpad).fill(0x20); t.set(js); js = t; }
  const head = new DataView(new ArrayBuffer(12 + 8));
  head.setUint32(0, 0x46546c67, true); head.setUint32(4, 2, true); head.setUint32(8, 12 + 8 + js.length + (off ? 8 + off : 0), true);
  head.setUint32(12, js.length, true); head.setUint32(16, 0x4e4f534a, true);
  const parts2 = [new Uint8Array(head.buffer), js];
  if (off) { const bh = new DataView(new ArrayBuffer(8)); bh.setUint32(0, off, true); bh.setUint32(4, 0x004e4942, true); parts2.push(new Uint8Array(bh.buffer), ...bin); }
  return new Blob(parts2, { type: 'model/gltf-binary' });
}

/**
 * Group the triangles of a closed mesh into flat faces (connected, coplanar) and trace each face's outline.
 * Returns [{ loops: [[vertexIndex...]] }] with the outer loop first; faces whose outline cannot be traced cleanly are
 * returned as their individual triangles instead, so the result always covers every triangle exactly once.
 */
export function flatFaces(verts, tris) {
  const nv = verts.length / 3, nt = tris.length / 3, id = new Int32Array(nv), seen = new Map();
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(verts[i * 3] * 1e4)},${Math.round(verts[i * 3 + 1] * 1e4)},${Math.round(verts[i * 3 + 2] * 1e4)}`;
    if (!seen.has(k)) seen.set(k, i);
    id[i] = seen.get(k);
  }
  const P = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  const nrm = new Float64Array(nt * 3), edge = new Map();
  for (let t = 0; t < nt; t++) {
    const a = P(tris[t * 3]), b = P(tris[t * 3 + 1]), c = P(tris[t * 3 + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    nrm.set([n[0] / l, n[1] / l, n[2] / l], t * 3);
    for (let k = 0; k < 3; k++) { const e = `${id[tris[t * 3 + k]]}>${id[tris[t * 3 + (k + 1) % 3]]}`; edge.set(e, t); }
  }
  const dotN = (s, t) => nrm[s * 3] * nrm[t * 3] + nrm[s * 3 + 1] * nrm[t * 3 + 1] + nrm[s * 3 + 2] * nrm[t * 3 + 2];
  const region = new Int32Array(nt).fill(-1), faces = [];
  for (let s = 0; s < nt; s++) {
    if (region[s] >= 0) continue;
    const r = faces.length, list = [s], p0 = P(tris[s * 3]), n0 = [nrm[s * 3], nrm[s * 3 + 1], nrm[s * 3 + 2]];
    region[s] = r;
    for (let q = 0; q < list.length; q++) {
      const t = list[q];
      for (let k = 0; k < 3; k++) {
        const nb = edge.get(`${id[tris[t * 3 + (k + 1) % 3]]}>${id[tris[t * 3 + k]]}`);
        if (nb === undefined || region[nb] >= 0 || dotN(s, nb) < 0.99999) continue;
        const q1 = P(tris[nb * 3]);
        if (Math.abs((q1[0] - p0[0]) * n0[0] + (q1[1] - p0[1]) * n0[1] + (q1[2] - p0[2]) * n0[2]) > 1e-4) continue;
        region[nb] = r; list.push(nb);
      }
    }
    faces.push({ tris: list, n: n0 });
  }
  const out = [];
  for (const fc of faces) {
    const asTris = () => fc.tris.map((t) => ({ loops: [[tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]] }));
    if (fc.tris.length === 1) { out.push(...asTris()); continue; }
    const dir = new Set(), rep = new Map();
    for (const t of fc.tris) for (let k = 0; k < 3; k++) { const a = id[tris[t * 3 + k]], b = id[tris[t * 3 + (k + 1) % 3]]; dir.add(`${a}>${b}`); rep.set(a, tris[t * 3 + k]); }
    const next = new Map();
    let bad = false;
    for (const e of dir) {
      const [a, b] = e.split('>').map(Number);
      if (dir.has(`${b}>${a}`)) continue;
      if (next.has(a)) bad = true; // outline touches itself at a vertex
      next.set(a, b);
    }
    const loops = [], used = new Set();
    if (!bad) for (const [st] of next) {
      if (used.has(st)) continue;
      const lp = []; let a = st;
      while (a !== undefined && !used.has(a)) { used.add(a); lp.push(rep.get(a)); a = next.get(a); }
      if (a !== st) { bad = true; break; }
      loops.push(lp);
    }
    if (bad || !loops.length) { out.push(...asTris()); continue; }
    const area = (lp) => { let sx = 0, sy = 0, sz = 0; for (let i = 0; i < lp.length; i++) { const a = P(lp[i]), b = P(lp[(i + 1) % lp.length]); sx += a[1] * b[2] - a[2] * b[1]; sy += a[2] * b[0] - a[0] * b[2]; sz += a[0] * b[1] - a[1] * b[0]; } return (sx * fc.n[0] + sy * fc.n[1] + sz * fc.n[2]) / 2; };
    const pos = loops.filter((lp) => area(lp) > 0);
    if (pos.length !== 1) { out.push(...asTris()); continue; }
    out.push({ loops: [pos[0], ...loops.filter((lp) => area(lp) <= 0)] });
  }
  return out;
}

/**
 * STEP (ISO 10303-21, AP214): flat faces are written as single planar faces (with holes where they have them) of a
 * FACETED_BREP. Curved surfaces stay as many small flat facets, because the kernel is a mesh kernel, not an exact one.
 */
export function writeSTEP(bodies, name = 'Sketchy') {
  let n = 0;
  const L = [];
  const e = (s) => { L.push(`#${++n}=${s};`); return n; };
  const f = (x) => (Number.isInteger(x) ? x + '.' : String(+x.toFixed(6)));
  const q = (s) => String(s).replace(/'/g, '');
  const appCtx = e(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const pc = e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const lu = e(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
  const au = e(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
  const su = e(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lu},'distance_accuracy_value','')`);
  const ctx = e(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su})) REPRESENTATION_CONTEXT('','') )`);
  const origin = e(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const dz = e(`DIRECTION('',(0.,0.,1.))`), dx = e(`DIRECTION('',(1.,0.,0.))`);
  const axis = e(`AXIS2_PLACEMENT_3D('',#${origin},#${dz},#${dx})`);
  const breps = [];
  for (const b of bodies) {
    const pts = [];
    for (let i = 0; i < b.verts.length; i += 3) pts.push(e(`CARTESIAN_POINT('',(${f(b.verts[i])},${f(b.verts[i + 1])},${f(b.verts[i + 2])}))`));
    const faces = [];
    for (const fc of flatFaces(b.verts, b.tris)) {
      const bounds = fc.loops.map((lp, k) => {
        const loop = e(`POLY_LOOP('',(${lp.map((v) => '#' + pts[v]).join(',')}))`);
        return e(k === 0 ? `FACE_OUTER_BOUND('',#${loop},.T.)` : `FACE_BOUND('',#${loop},.T.)`);
      });
      faces.push(e(`FACE('',(${bounds.map((x) => '#' + x).join(',')}))`));
    }
    const shell = e(`CLOSED_SHELL('',(${faces.map((x) => '#' + x).join(',')}))`);
    breps.push(e(`FACETED_BREP('${q(b.name || b.id)}',#${shell})`));
  }
  const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('${q(name)}',(${[axis, ...breps].map((x) => '#' + x).join(',')}),#${ctx})`);
  const prod = e(`PRODUCT('${q(name)}','${q(name)}','',(#${pc}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  const head = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Sketchy export, flat faces merged'),'2;1');\nFILE_NAME('${q(name)}.step','${new Date().toISOString().slice(0, 19)}',('Sketchy'),(''),'Sketchy','Sketchy','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
  return new Blob([head + L.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n'], { type: 'model/step' });
}
