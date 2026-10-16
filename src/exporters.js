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

/** 3MF core spec, millimetre units, one object per body, optional per-body colour. */
export function write3MF(bodies, name = 'Sketchy') {
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
  const ct = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const z = zipStore([
    { name: '[Content_Types].xml', data: enc.encode(ct) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(m) },
  ]);
  return new Blob([z], { type: 'model/3mf' });
}

/** Faceted STEP (ISO 10303-21, AP203): every triangle is a planar FACE of a FACETED_BREP. Opens as a faceted solid, not exact surfaces. */
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
    for (let i = 0; i < b.tris.length; i += 3) {
      const loop = e(`POLY_LOOP('',(#${pts[b.tris[i]]},#${pts[b.tris[i + 1]]},#${pts[b.tris[i + 2]]}))`);
      const bound = e(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(e(`FACE('',(#${bound}))`));
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
  const head = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Sketchy faceted export'),'2;1');\nFILE_NAME('${q(name)}.step','${new Date().toISOString().slice(0, 19)}',('Sketchy'),(''),'Sketchy','Sketchy','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
  return new Blob([head + L.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n'], { type: 'model/step' });
}
