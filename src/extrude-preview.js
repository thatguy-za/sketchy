// A quick stand-in for an Extrude with taper, twist, end scale or a thin wall, built from the sketch outlines with no kernel, shown while the
// exact result is being computed. Approximate: the taper is a uniform shrink about the outline's centre, the twist and scale are about the
// sketch origin. The kernel's shape replaces it as soon as it arrives.
import * as THREE from 'three';

const area = (l) => { let a = 0; for (let i = 0; i < l.length; i++) { const [x1, y1] = l[i], [x2, y2] = l[(i + 1) % l.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
const perim = (l) => { let s = 0; for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; };
const centre = (l) => l.reduce((c, p) => [c[0] + p[0] / l.length, c[1] + p[1] / l.length], [0, 0]);
/** The loop moved inwards by about `d` (outwards when negative), as a uniform scale about its centre. */
function inset(l, d) {
  const A = Math.abs(area(l)), P = perim(l);
  if (!(A > 0) || !(P > 0)) return l;
  const k1 = 1 - (d * P) / (2 * A), k = k1 > 0.02 ? k1 : 0.02, c = centre(l); // a similar shape moved in by d: scaled by 1 - d / inradius, the inradius being 2 area / perimeter
  return l.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
}

/**
 * profiles: [[outer, hole, hole...]] loops of [u, v] points in the sketch plane; fr: { o, x, y, n } the plane's frame; ranges: [[z0, z1]...] along
 * the normal; opts: { twist (deg over the whole length), endFactor, taper (deg), thin: { wall, side } }. Returns { verts, tris }.
 */
export function buildExtrudePreview(profiles, fr, ranges, { twist = 0, endFactor = 1, taper = 0, thin = null, planeZ = 0 } = {}) {
  const V = [], T = [];
  const world = (u, v, z) => [0, 1, 2].map((k) => fr.o[k] + fr.x[k] * u + fr.y[k] * v + fr.n[k] * z);
  const tan = Math.tan((taper * Math.PI) / 180);
  for (const [z0, z1] of ranges) {
    const len = z1 - z0, steps = twist ? Math.min(48, Math.max(2, Math.ceil(Math.abs(twist) / 8) + 1)) : 2;
    for (const loops of profiles) {
      // the loops at a height t (0..1): taper first, then the twist and the end scale about the sketch origin
      const at = (list, zz) => list.map((l, li) => {
        const away = Math.abs(zz - planeZ), t = Math.min(1, away / (Math.abs(len) || 1)); // how far from the sketch plane: what the taper, twist and scale grow with
        let m = taper ? inset(l, (li === 0 ? 1 : -1) * away * tan) : l;
        if (twist || endFactor !== 1) {
          const a = (twist * t * Math.PI) / 180, s = 1 + (endFactor - 1) * t, c = Math.cos(a), sn = Math.sin(a);
          m = m.map(([x, y]) => [s * (x * c - y * sn), s * (x * sn + y * c)]);
        }
        return m;
      });
      let sets = [loops]; // one set of loops, or for a thin wall the wall's outer and inner loops
      if (thin) {
        const w = Math.max(1e-3, thin.wall), out = loops[0], dOut = thin.side === 'outside' ? -w : thin.side === 'center' ? -w / 2 : 0, dIn = thin.side === 'outside' ? 0 : thin.side === 'center' ? w / 2 : w;
        sets = [[inset(out, dOut), inset(out, dIn)]]; // a wall between two copies of the outline; holes are left out of the stand-in
      }
      for (const set of sets) {
        const z = (i) => z0 + (len * i) / (steps - 1);
        const layers = Array.from({ length: steps }, (_, i) => at(set, z(i)));
        // side walls
        layers[0].forEach((_, li) => {
          const base = V.length / 3, n = layers[0][li].length;
          layers.forEach((L, i) => L[li].forEach(([u, v]) => V.push(...world(u, v, z(i)))));
          for (let i = 0; i < steps - 1; i++) for (let k = 0; k < n; k++) {
            const a = base + i * n + k, b = base + i * n + ((k + 1) % n), c = base + (i + 1) * n + k, d = base + (i + 1) * n + ((k + 1) % n);
            T.push(a, b, d, a, d, c);
          }
        });
        // end caps: the outline with its holes (a thin wall: the ring between the two loops)
        for (const [i, flip] of [[0, true], [steps - 1, false]]) {
          const L = layers[i], contour = L[0].map(([x, y]) => new THREE.Vector2(x, y)), holes = L.slice(1).map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
          const base = V.length / 3;
          [...L[0], ...L.slice(1).flat()].forEach(([u, v]) => V.push(...world(u, v, z(i))));
          let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { tris = []; }
          for (const [a, b, c] of tris) flip ? T.push(base + a, base + c, base + b) : T.push(base + a, base + b, base + c);
        }
      }
    }
  }
  return { verts: new Float32Array(V), tris: new Uint32Array(T) };
}
