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
/** What to draw: { custom, color, metalness, roughness, opacity, material } for a body's stored appearance. */
export function look(v) {
  const a = appearanceOf(v), mat = a.material ? materialById(a.material) : null;
  if (!mat && !a.color) return { custom: false };
  return { custom: true, material: mat?.id, color: a.color || mat?.color || '#c3c7cd', metalness: mat ? mat.metal : 0.12, roughness: mat ? mat.rough : 0.5, opacity: mat ? mat.opacity : 1 };
}
export const densityOf = (v) => materialById(appearanceOf(v).material)?.density ?? DEFAULT_DENSITY;
export const materialNameOf = (v) => materialById(appearanceOf(v).material)?.name || 'PLA';
