// Command registry + Fusion-style toolbar layout. Commands are looked up by id from toolbars,
// dropdown menus, the marking menu and the quick-search palette.
//   feature: id of a FEATURES entry started by startFeature()
//   sk:      sketch tool id
//   off:     placeholder that exists in Fusion but isn't implemented here (shown disabled)
const C = (label, icon, extra = {}) => ({ label, icon, ...extra });

export const CMD = {
  // --- design / create ---
  sketch: C('Create Sketch', 'sketch', { feature: 'sketch' }),
  extrude: C('Extrude', 'extrude', { feature: 'extrude', key: 'E' }),
  revolve: C('Revolve', 'revolve', { feature: 'revolve' }),
  sweep: C('Sweep', 'sweep', { feature: 'sweep' }),
  loft: C('Loft', 'loft', { feature: 'loft' }),
  rib: C('Rib', 'rib', { feature: 'rib' }),
  coil: C('Coil', 'coil', { feature: 'coil' }),
  hole: C('Hole', 'hole', { feature: 'hole', key: 'H' }),
  thread: C('Thread', 'thread', { feature: 'thread' }),
  box: C('Box', 'box', { feature: 'box' }),
  cylinder: C('Cylinder', 'cylinder', { feature: 'cylinder' }),
  sphere: C('Sphere', 'sphere', { feature: 'sphere' }),
  cone: C('Cone', 'cone', { feature: 'cone' }),
  torus: C('Torus', 'torus', { feature: 'torus' }),
  pattern: C('Pattern', 'pattern', { feature: 'pattern' }),
  mirror: C('Mirror', 'mirror', { feature: 'mirror' }),
  // --- modify ---
  presspull: C('Press Pull', 'presspull', { feature: 'presspull', key: 'Q' }),
  fillet: C('Fillet', 'fillet', { feature: 'fillet', key: 'F' }),
  chamfer: C('Chamfer', 'chamfer', { feature: 'chamfer' }),
  shell: C('Shell', 'shell', { feature: 'shell' }),
  scale: C('Scale', 'scale', { feature: 'scale' }),
  split: C('Split Body', 'split', { feature: 'split' }),
  combine: C('Combine', 'combine', { feature: 'combine' }),
  move: C('Move/Copy', 'move', { feature: 'move', key: 'M' }),
  remove: C('Delete', 'remove', { feature: 'remove', key: 'Del' }),
  parameters: C('Change Parameters', 'params'),
  // --- assemble / construct / inspect / insert ---
  joint: C('Joint', 'joint', { feature: 'joint', key: 'J' }),
  measure: C('Measure', 'measure', { key: 'I' }),
  angle: C('Measure Angle', 'angle'),
  edgelen: C('Measure Edge Length', 'edge'),
  faces: C('Measure Between Faces', 'faces'),
  properties: C('Properties', 'properties'),
  importstl: C('Insert Mesh (STL)', 'insertmesh'),
  select: C('Select', 'select'),
  cfg1: C('Configure Design', 'table', { off: true }),
  cfg2: C('Insert Configured Design', 'table', { off: true }),
  cfg3: C('Configure Settings', 'table', { off: true }),
  derive: C('Insert Derive', 'derive', { off: true }),
  // --- 3D print / utilities ---
  print3d: C('3D Print (Export STL)', 'threed'),
  print3dsel: C('3D Print Selected Bodies', 'threed'),
  printer: C('Printer…', 'printer'),
  buildvol: C('Show Build Volume', 'box'),
  // --- sketch tools ---
  sk_line: C('Line', 'line', { sk: 'line', key: 'L' }),
  sk_path: C('Open Path', 'path', { sk: 'path' }),
  sk_rect: C('2-Point Rectangle', 'rect', { sk: 'rect', key: 'R' }),
  sk_circle: C('Center Diameter Circle', 'circle', { sk: 'circle', key: 'C' }),
  sk_ngon: C('Polygon', 'ngon', { sk: 'ngon' }),
  sk_delete: C('Delete Shape', 'remove', { skAction: 'delete' }),
  finishsketch: C('Finish Sketch', 'finish', { key: '' }),
  // --- placeholders that exist in Fusion ---
  offsetplane: C('Offset Plane', 'offsetplane', { off: true }),
  newcomp: C('New Component', 'joint', { off: true }),
  asbuilt: C('As-built Joint', 'joint', { off: true }),
  svg: C('Insert SVG', 'sketch', { off: true }),
  dxf: C('Insert DXF', 'sketch', { off: true }),
  canvas: C('Canvas', 'canvas', { off: true }),
  section: C('Section Analysis', 'sectionan', { off: true }),
  interference: C('Interference', 'combine', { off: true }),
  draft: C('Draft', 'chamfer', { off: true }),
  emboss: C('Emboss', 'extrude', { off: true }),
  pipe: C('Pipe', 'sweep', { off: true }),
  splitface: C('Split Face', 'split', { off: true }),
  offsetface: C('Offset Face', 'presspull', { off: true }),
  sk_arc: C('3-Point Arc', 'arc', { off: true }),
  sk_spline: C('Fit Point Spline', 'spline', { off: true }),
  sk_dim: C('Sketch Dimension', 'dimension', { off: true, key: 'D' }),
  sk_trim: C('Trim', 'trim', { off: true }),
  sk_constraint: C('Coincident', 'constraint', { off: true }),
  sk_fillet: C('Sketch Fillet', 'fillet', { off: true }),
  sk_offset: C('Offset', 'offsetplane', { off: true }),
  sk_mirror: C('Mirror', 'mirror', { off: true }),
  sk_project: C('Project / Include', 'select', { off: true }),
};

export const WORKSPACE_TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'PLASTIC', 'MANAGE', 'UTILITIES'];

// show = buttons on the toolbar; menu = full dropdown ('|' = separator)
export const TOOLBAR = {
  SOLID: [
    { label: 'CREATE', show: ['sketch', 'extrude', 'revolve', 'hole'], menu: ['newcomp', 'sketch', '|', 'extrude', 'revolve', 'sweep', 'loft', 'rib', 'coil', 'emboss', '|', 'hole', 'thread', '|', 'box', 'cylinder', 'sphere', 'torus', 'cone', '|', 'pattern', 'mirror'] },
    { label: 'MODIFY', show: ['presspull', 'fillet', 'combine'], menu: ['presspull', 'fillet', 'chamfer', 'shell', 'draft', 'scale', 'combine', '|', 'offsetface', 'splitface', 'split', '|', 'move', 'remove', '|', 'parameters'] },
    { label: 'CONFIGURE', show: ['cfg1', 'cfg2', 'cfg3'], menu: ['cfg1', 'cfg2', 'cfg3'] },
    { label: 'CONSTRUCT', show: ['offsetplane'], menu: ['offsetplane'] },
    { label: 'INSPECT', show: ['measure', 'section'], menu: ['measure', 'angle', 'edgelen', 'faces', '|', 'properties', 'section', 'interference'] },
    { label: 'INSERT', show: ['derive', 'canvas', 'importstl'], menu: ['derive', 'canvas', 'importstl', 'svg', 'dxf'] },
    { label: 'ASSEMBLE', show: ['joint'], menu: ['newcomp', 'joint', 'asbuilt'], right: true },
    { label: 'SELECT', show: ['select'], menu: ['select'], big: true },
  ],
  SURFACE: [
    { label: 'CREATE', show: ['pipe', 'sweep', 'loft', 'extrude', 'revolve'], menu: [], allOff: true },
    { label: 'MODIFY', show: ['fillet', 'combine'], menu: [], allOff: true },
  ],
  MESH: [
    { label: 'CREATE', show: ['importstl'], menu: ['importstl'] },
    { label: 'MODIFY', show: ['shell', 'combine'], menu: [], allOff: true },
  ],
  'SHEET METAL': [{ label: 'CREATE', show: ['extrude', 'loft'], menu: [], allOff: true }],
  PLASTIC: [{ label: 'CREATE', show: ['shell', 'rib'], menu: [], allOff: true }],
  MANAGE: [
    { label: 'PARAMETERS', show: ['parameters'], menu: ['parameters'] },
    { label: 'INSPECT', show: ['measure', 'properties'], menu: ['measure', 'angle', 'edgelen', 'faces', '|', 'properties'] },
  ],
  UTILITIES: [
    { label: 'MAKE', show: ['print3d', 'print3dsel', 'printer', 'buildvol'], menu: ['print3d', 'print3dsel', '|', 'printer', 'buildvol'] },
  ],
};

export const SKETCH_TOOLBAR = [
  { label: 'CREATE', show: ['sk_line', 'sk_rect', 'sk_circle', 'sk_arc', 'sk_ngon'], menu: ['sk_line', 'sk_path', 'sk_rect', 'sk_circle', 'sk_arc', 'sk_ngon', 'sk_spline', '|', 'sk_mirror'] },
  { label: 'MODIFY', show: ['sk_fillet', 'sk_trim', 'sk_delete'], menu: ['sk_fillet', 'sk_trim', 'sk_offset', '|', 'sk_delete'] },
  { label: 'CONSTRAINTS', show: ['sk_constraint', 'sk_dim'], menu: ['sk_constraint', 'sk_dim'] },
  { label: 'INSPECT', show: ['measure'], menu: ['measure'] },
  { label: 'INSERT', show: ['sk_project'], menu: ['sk_project', 'svg', 'dxf'] },
  { label: 'SELECT', show: ['select'], menu: ['select'] },
  { label: 'FINISH SKETCH', show: ['finishsketch'], menu: [], right: true, finish: true },
];

export const WORKSPACES = ['DESIGN', 'GENERATIVE DESIGN', 'RENDER', 'ANIMATION', 'SIMULATION', 'MANUFACTURE', 'DRAWING'];
