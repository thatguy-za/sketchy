// Binary + ASCII STL import/export. Triangle soup is Float32Array [x,y,z]*3 per tri.

export function parseSTL(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const txt = new TextDecoder().decode(buf);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const v = [];
  let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  if (!v.length || v.length % 9) throw new Error('Not a valid STL file');
  return new Float32Array(v);
}

export function writeSTL(bodies, name = 'Sketchy') {
  let tris = 0;
  for (const b of bodies) tris += b.tris.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  new TextEncoder().encodeInto(`Sketchy ${name}`.slice(0, 79), new Uint8Array(buf, 0, 80));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const b of bodies) {
    const v = b.verts;
    for (let i = 0; i < b.tris.length; i += 3) {
      const a = b.tris[i] * 3, c = b.tris[i + 1] * 3, d = b.tris[i + 2] * 3;
      const ux = v[c] - v[a], uy = v[c + 1] - v[a + 1], uz = v[c + 2] - v[a + 2];
      const wx = v[d] - v[a], wy = v[d + 1] - v[a + 1], wz = v[d + 2] - v[a + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const x of [nx, ny, nz]) { dv.setFloat32(o, x, true); o += 4; }
      for (const k of [a, c, d]) for (let j = 0; j < 3; j++) { dv.setFloat32(o, v[k + j], true); o += 4; }
      o += 2;
    }
  }
  return new Blob([buf], { type: 'model/stl' });
}
