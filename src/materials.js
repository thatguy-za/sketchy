// Materials for the Appearance dialog and the renderer. density is in g/cm³ (used for mass); the rest is how the body is shaded.
// A body's appearance (doc.appearance[bodyId]) is either a plain colour string (older files) or { material?, color? }.
export const MATERIALS = [
  // 3D-printing plastics
  { id: 'pla', name: 'PLA', group: 'Printing', color: '#e3e0d8', metal: 0, rough: 0.55, opacity: 1, density: 1.24 },
  { id: 'petg', name: 'PETG', group: 'Printing', color: '#b9d3e6', metal: 0, rough: 0.35, opacity: 0.92, density: 1.27 },
  { id: 'abs', name: 'ABS', group: 'Printing', color: '#d8d3c4', metal: 0, rough: 0.5, opacity: 1, density: 1.04 },
  { id: 'asa', name: 'ASA', group: 'Printing', color: '#c9ccd0', metal: 0, rough: 0.55, opacity: 1, density: 1.07 },
  { id: 'nylon', name: 'Nylon (PA12)', group: 'Printing', color: '#e8e6df', metal: 0, rough: 0.8, opacity: 1, density: 1.01 },
  { id: 'tpu', name: 'TPU (flexible)', group: 'Printing', color: '#3d6fb5', metal: 0, rough: 0.7, opacity: 1, density: 1.21 },
  { id: 'resin', name: 'Resin (standard)', group: 'Printing', color: '#c7c3b8', metal: 0, rough: 0.3, opacity: 1, density: 1.12 },
  { id: 'cf', name: 'Carbon fibre nylon', group: 'Printing', color: '#2a2c30', metal: 0.15, rough: 0.5, opacity: 1, density: 1.15 },
  // metals
  { id: 'aluminium', name: 'Aluminium', group: 'Metal', color: '#c8ccd2', metal: 1, rough: 0.35, opacity: 1, density: 2.7 },
  { id: 'steel', name: 'Steel', group: 'Metal', color: '#9aa0a8', metal: 1, rough: 0.4, opacity: 1, density: 7.85 },
  { id: 'stainless', name: 'Stainless steel', group: 'Metal', color: '#b6bbc2', metal: 1, rough: 0.3, opacity: 1, density: 8.0 },
  { id: 'brass', name: 'Brass', group: 'Metal', color: '#c9a24a', metal: 1, rough: 0.3, opacity: 1, density: 8.5 },
  { id: 'copper', name: 'Copper', group: 'Metal', color: '#c4764a', metal: 1, rough: 0.28, opacity: 1, density: 8.96 },
  { id: 'titanium', name: 'Titanium', group: 'Metal', color: '#8d9096', metal: 1, rough: 0.4, opacity: 1, density: 4.5 },
  { id: 'gold', name: 'Gold', group: 'Metal', color: '#e0b440', metal: 1, rough: 0.22, opacity: 1, density: 19.3 },
  // other
  { id: 'oak', name: 'Oak', group: 'Other', color: '#b98b5a', metal: 0, rough: 0.7, opacity: 1, density: 0.75 },
  { id: 'walnut', name: 'Walnut', group: 'Other', color: '#6b4a32', metal: 0, rough: 0.65, opacity: 1, density: 0.65 },
  { id: 'rubber', name: 'Rubber', group: 'Other', color: '#2b2b2d', metal: 0, rough: 0.9, opacity: 1, density: 1.1 },
  { id: 'glass', name: 'Glass', group: 'Other', color: '#cfe8f0', metal: 0, rough: 0.05, opacity: 0.35, density: 2.5 },
  { id: 'acrylic', name: 'Acrylic', group: 'Other', color: '#dbe9f2', metal: 0, rough: 0.1, opacity: 0.55, density: 1.18 },
  { id: 'concrete', name: 'Concrete', group: 'Other', color: '#a6a39b', metal: 0, rough: 0.95, opacity: 1, density: 2.4 },
];
export const DEFAULT_DENSITY = 1.24; // PLA, when a body has no material
export const materialById = (id) => MATERIALS.find((m) => m.id === id);
export const appearanceOf = (v) => (typeof v === 'string' ? { color: v } : v && typeof v === 'object' ? v : {});
// Surface textures, drawn with canvas 2D into a square tile that repeats without a seam. They are mapped onto the model
// from its position in space (not from UV coordinates), so they work on any body or flat face. size is the width of one tile
// in mm. A texture is multiplied by the colour, so it keeps its own colours when the colour is white.
const noise = (ctx, n, a) => { const id = ctx.getImageData(0, 0, n, n), d = id.data; for (let i = 0; i < d.length; i += 4) { const k = (Math.random() - 0.5) * a; d[i] += k; d[i + 1] += k; d[i + 2] += k; } ctx.putImageData(id, 0, 0); };
export const TEXTURES = [
  { id: 'checker', name: 'Checker', size: 20, draw(c, n) { c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, n, n); c.fillStyle = '#3a3a3a'; c.fillRect(0, 0, n / 2, n / 2); c.fillRect(n / 2, n / 2, n / 2, n / 2); } },
  { id: 'grid', name: 'Grid lines', size: 20, draw(c, n) { c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, n, n); c.fillStyle = '#4a5560'; c.fillRect(0, 0, n, 6); c.fillRect(0, 0, 6, n); } },
  { id: 'stripes', name: 'Stripes', size: 20, draw(c, n) { c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, n, n); c.fillStyle = '#2f3a46'; c.fillRect(0, 0, n, n / 2); } },
  { id: 'dots', name: 'Dots', size: 16, draw(c, n) { c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, n, n); c.fillStyle = '#3a4650'; for (const [x, y] of [[0.25, 0.25], [0.75, 0.75]]) { c.beginPath(); c.arc(x * n, y * n, n * 0.14, 0, 7); c.fill(); } } },
  { id: 'wood', name: 'Wood grain', size: 60, draw(c, n) {
    c.fillStyle = '#c99a63'; c.fillRect(0, 0, n, n);
    for (let y = 0; y < n; y++) { const w = 0.5 + 0.5 * Math.sin((y / n) * Math.PI * 2 * 7) * Math.cos((y / n) * Math.PI * 2 * 3); c.fillStyle = `rgba(110,70,30,${0.08 + 0.25 * w})`; c.fillRect(0, y, n, 1); }
    for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(90,55,25,${0.1 + Math.random() * 0.15})`; c.beginPath(); const y0 = Math.random() * n; c.moveTo(0, y0); c.bezierCurveTo(n * 0.3, y0 + (Math.random() - 0.5) * 6, n * 0.6, y0 + (Math.random() - 0.5) * 6, n, y0); c.stroke(); }
  } },
  { id: 'brushed', name: 'Brushed metal', size: 40, draw(c, n) { c.fillStyle = '#b9bcc0'; c.fillRect(0, 0, n, n); for (let y = 0; y < n; y++) { const k = 150 + Math.random() * 70; c.fillStyle = `rgba(${k},${k},${k + 4},.55)`; c.fillRect(0, y, n, 1); } } },
  { id: 'carbon', name: 'Carbon weave', size: 16, draw(c, n) { c.fillStyle = '#1b1d20'; c.fillRect(0, 0, n, n); const h = n / 2; for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const g = c.createLinearGradient(0, 0, (i + j) % 2 ? h : 0, (i + j) % 2 ? 0 : h); g.addColorStop(0, '#4a4e55'); g.addColorStop(1, '#14161a'); c.fillStyle = g; c.fillRect(i * h + 1, j * h + 1, h - 2, h - 2); } } },
  { id: 'speckle', name: 'Speckle (granite)', size: 30, draw(c, n) { c.fillStyle = '#9a9a98'; c.fillRect(0, 0, n, n); noise(c, n, 90); for (let i = 0; i < 160; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(30,30,30,.55)' : 'rgba(235,235,235,.6)'; c.fillRect(Math.random() * n, Math.random() * n, 1 + Math.random() * 2, 1 + Math.random() * 2); } } },
];
export const textureById = (id) => TEXTURES.find((t) => t.id === id);
/** What to draw: { custom, color, metalness, roughness, opacity, material, texture, texSize } for a stored appearance. */
export function look(v) {
  const a = appearanceOf(v), mat = a.material ? materialById(a.material) : null, tex = a.texture ? textureById(a.texture) : null;
  if (!mat && !a.color && !tex) return { custom: false };
  return { custom: true, material: mat?.id, texture: tex?.id, texSize: tex ? Math.min(2000, Math.max(0.5, +a.texSize || tex.size)) : 0, color: a.color || (tex ? '#ffffff' : mat?.color) || '#c3c7cd', metalness: mat ? mat.metal : 0.12, roughness: mat ? mat.rough : 0.5, opacity: mat ? mat.opacity : 1 };
}
export const densityOf = (v) => materialById(appearanceOf(v).material)?.density ?? DEFAULT_DENSITY;
export const materialNameOf = (v) => materialById(appearanceOf(v).material)?.name || 'PLA';
