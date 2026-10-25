// Writes a design as an OpenSCAD script: one polyhedron module per body (exact triangles, in millimetres), then a call for each.
// The script is a snapshot of the shape. It is not parametric: OpenSCAD cannot recreate Sketchy's feature timeline.

const fmt = (v) => String(+v.toFixed(4));
const ident = (s, i) => (String(s || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9]/, '_$&') || `body_${i + 1}`);

/** @param design { name, units, bodies: [{ id, name, verts: Float32Array, tris: Uint32Array }], parameters?: [{ name, expr }] } */
export function exportScad(design) {
  const out = [];
  out.push(`// ${String(design.name || 'Design').replace(/[\r\n]+/g, ' ')}: exported from Sketchy`);
  out.push('// Units: millimetres. Each body is a polyhedron (a snapshot of the shape, not the feature timeline).');
  if (design.parameters?.length) { out.push('// Sketchy parameters at the time of export (for reference):'); for (const p of design.parameters.slice(0, 200)) out.push(`//   ${String(p.name).replace(/[\r\n]+/g, ' ')} = ${String(p.expr).replace(/[\r\n]+/g, ' ')}`); }
  out.push('');
  const used = new Set(), calls = [];
  design.bodies.forEach((b, bi) => {
    let name = ident(b.name, bi); while (used.has(name)) name += '_'; used.add(name);
    const key = (i) => `${fmt(b.verts[i * 3])},${fmt(b.verts[i * 3 + 1])},${fmt(b.verts[i * 3 + 2])}`;
    const index = new Map(), pts = [], remap = new Uint32Array(b.verts.length / 3);
    for (let i = 0; i < remap.length; i++) { const k = key(i); let id = index.get(k); if (id === undefined) { id = pts.length; index.set(k, id); pts.push(k); } remap[i] = id; }
    const faces = [];
    for (let t = 0; t < b.tris.length; t += 3) {
      const a = remap[b.tris[t]], c = remap[b.tris[t + 1]], d = remap[b.tris[t + 2]];
      if (a === c || c === d || a === d) continue; // a triangle that collapsed to a line
      faces.push(`[${a},${d},${c}]`); // OpenSCAD wants faces clockwise seen from outside; Sketchy's are counter-clockwise
    }
    out.push(`module ${name}() {`);
    out.push('  polyhedron(');
    out.push(`    points = [${pts.map((p) => `[${p}]`).join(',')}],`);
    out.push(`    faces = [${faces.join(',')}]`);
    out.push('  );');
    out.push('}');
    out.push('');
    calls.push(`${name}();`);
  });
  out.push(...calls);
  return out.join('\n') + '\n';
}
