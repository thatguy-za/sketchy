// Feature catalogue: defaults + editable field schema (drives the properties dialog).
const PLANE_OPTS = [['XY', 'XY (Top)'], ['XZ', 'XZ (Front)'], ['YZ', 'YZ (Right)']];
const EXTENT_OPTS = [['distance', 'Distance'], ['all', 'All'], ['object', 'To Object']];
export const LAST = {};
const OP_OPTS = [['new', 'New Body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];
const prim = (shape, label, icon, defaults, fields) => ({
  label, icon, group: 'primitive',
  make: () => ({ shape, pos: [0, 0, 0], ...defaults }),
  fields: [...fields, { key: 'pos', label: 'Base position', type: 'vec3' }],
});

export const FEATURES = {
  box: { ...prim('box', 'Box', 'box', { sx: 20, sy: 20, sz: 20, radius: 0 }, [
    { key: 'sx', label: 'Length X', type: 'num', min: 0.01 }, { key: 'sy', label: 'Width Y', type: 'num', min: 0.01 },
    { key: 'sz', label: 'Height Z', type: 'num', min: 0.01 }, { key: 'radius', label: 'Corner radius', type: 'num', min: 0 },
  ]), type: 'primitive' },
  cylinder: { ...prim('cylinder', 'Cylinder', 'cylinder', { radius: 10, height: 20 }, [
    { key: 'radius', label: 'Radius', type: 'num', min: 0.01 }, { key: 'height', label: 'Height', type: 'num', min: 0.01 },
  ]), type: 'primitive' },
  sphere: { ...prim('sphere', 'Sphere', 'sphere', { radius: 10, pos: [0, 0, 10] }, [
    { key: 'radius', label: 'Radius', type: 'num', min: 0.01 },
  ]), type: 'primitive' },
  cone: { ...prim('cone', 'Cone', 'cone', { radius: 10, radius2: 0, height: 20 }, [
    { key: 'radius', label: 'Bottom radius', type: 'num', min: 0.01 }, { key: 'radius2', label: 'Top radius', type: 'num', min: 0 },
    { key: 'height', label: 'Height', type: 'num', min: 0.01 },
  ]), type: 'primitive' },
  torus: { ...prim('torus', 'Torus', 'torus', { major: 12, minor: 3, pos: [0, 0, 3] }, [
    { key: 'major', label: 'Major radius', type: 'num', min: 0.02 }, { key: 'minor', label: 'Minor radius', type: 'num', min: 0.01 },
  ]), type: 'primitive' },
  sketch: {
    label: 'Sketch', icon: 'sketch', type: 'sketch', make: () => ({ plane: 'XY', offset: 0, shapes: [] }),
    fields: [{ key: 'plane', label: 'Plane', type: 'select', options: PLANE_OPTS }, { key: 'offset', label: 'Offset', type: 'num' }],
  },
  plane: {
    label: 'Offset Plane', icon: 'offsetplane', type: 'plane',
    make: (ctx) => ({ base: ctx.lastPlane || 'XY', offset: 20 }),
    fields: [
      { key: 'base', label: 'Base plane', type: 'planeref' },
      { key: 'offset', label: 'Distance', type: 'num', step: 1 },
    ],
  },
  emboss: {
    label: 'Emboss', icon: 'extrude', type: 'emboss', manip: { key: 'depth', sketch: 'sketch' },
    make: (ctx) => ({ sketch: ctx.selSketch || ctx.lastSketch, profiles: null, depth: 1, mode: 'raise', target: '' }),
    fields: [
      { key: 'sketch', label: 'Sketch (text or shapes)', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'profiles' },
      { key: 'mode', label: 'Style', type: 'select', options: [['raise', 'Raise (stand proud of the face)'], ['engrave', 'Engrave (cut into the face)']] },
      { key: 'depth', label: 'Depth', type: 'num', min: 0.01, step: 0.1 },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all' },
    ],
  },
  extrude: {
    label: 'Extrude', icon: 'extrude', type: 'extrude', manip: { key: 'distance', sketch: 'sketch', show: (p) => p.extent === 'distance' },
    make: (ctx) => ({ sketch: ctx.lastSketch, profiles: null, extent: 'distance', distance: LAST.extrude ?? 10, flip: false, symmetric: false, op: ctx.lastSketchOnFace ? 'auto' : ctx.hasBodies ? 'join' : 'new', target: '', toBody: '', taper: 0, twist: 0, scaleTop: 1 }),
    fields: [
      { key: 'type', label: 'Type', type: 'soltype' },
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'profiles' },
      { key: 'start', label: 'Start', type: 'static', text: 'Profile Plane', icon: 'start' },
      { key: 'symmetric', label: 'Direction', type: 'select', boolSelect: true, icon: 'dir', options: [[false, 'One Side'], [true, 'Symmetric']], show: (p) => p.extent === 'distance' },
      { key: 'extent', label: 'Extent Type', type: 'select', icon: 'ext', options: EXTENT_OPTS },
      { key: 'distance', label: 'Distance', type: 'num', show: (p) => p.extent === 'distance' },
      { key: 'toBody', label: 'To object', type: 'body', show: (p) => p.extent === 'object' },
      { key: 'flip', label: 'Flip direction', type: 'bool', show: (p) => p.extent !== 'distance' },
      { key: 'taper', label: 'Taper Angle', type: 'num', unit: 'deg', step: 0.5, show: (p) => p.extent === 'distance' },
      { key: 'twist', label: 'Twist (°)', type: 'num', adv: true, show: (p) => !p.taper },
      { key: 'scaleTop', label: 'Top scale', type: 'num', adv: true, min: 0.01, step: 0.05, show: (p) => !p.taper },
      { key: 'op', label: 'Operation', type: 'ops', options: [...OP_OPTS, ['auto', 'Auto (cut or join)']] },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' && p.op !== 'auto' },
    ],
  },
  revolve: {
    label: 'Revolve', icon: 'revolve', type: 'revolve',
    make: (ctx) => ({ sketch: ctx.lastSketch, profiles: null, angle: 360, op: ctx.hasBodies ? 'join' : 'new', target: '' }),
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'profiles' },
      { key: 'angle', label: 'Angle (°)', type: 'num', min: 1, max: 360 },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  move: {
    label: 'Move / Copy', icon: 'move', type: 'move', gizmo: true,
    make: (ctx) => ({ body: ctx.selected || '', t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1], copy: false }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' }, { key: 't', label: 'Move', type: 'vec3' },
      { key: 'r', label: 'Rotate (°)', type: 'vec3' }, { key: 's', label: 'Scale', type: 'vec3', min: 0.001, step: 0.05 },
      { key: 'copy', label: 'Create copy', type: 'bool' },
    ],
  },
  combine: {
    label: 'Combine', icon: 'combine', type: 'combine',
    make: (ctx) => ({ target: ctx.selected || '', tool: '', op: 'join', keepTool: false }),
    fields: [
      { key: 'target', label: 'Target body', type: 'body' }, { key: 'tool', label: 'Tool body', type: 'body' },
      { key: 'op', label: 'Operation', type: 'select', options: [['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']] },
      { key: 'keepTool', label: 'Keep tool', type: 'bool' },
    ],
  },
  mirror: {
    label: 'Mirror', icon: 'mirror', type: 'mirror',
    make: (ctx) => ({ body: ctx.selected || '', plane: 'YZ', offset: 0, join: false }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' }, { key: 'plane', label: 'Mirror plane', type: 'select', options: PLANE_OPTS },
      { key: 'offset', label: 'Offset', type: 'num' }, { key: 'join', label: 'Join with original', type: 'bool' },
    ],
  },
  pattern: {
    label: 'Pattern', icon: 'pattern', type: 'pattern',
    make: (ctx) => ({ body: ctx.selected || '', kind: 'linear', count: 3, spacing: [30, 0, 0], axis: 'Z', angle: 360, path: ctx.sketches.at(-1) || '', face: null, countU: 3, countV: 2, spacingU: 20, spacingV: 20 }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' },
      { key: 'kind', label: 'Type', type: 'select', options: [['linear', 'Linear'], ['circular', 'Circular'], ['path', 'Along a path'], ['face', 'On a face']] },
      { key: 'path', label: 'Path (sketch)', type: 'sketch', show: (p) => p.kind === 'path' },
      { key: 'face', label: 'Face', type: 'face', bodyKey: 'body', show: (p) => p.kind === 'face' },
      { key: 'countU', label: 'Columns', type: 'num', min: 1, step: 1, show: (p) => p.kind === 'face' },
      { key: 'spacingU', label: 'Column spacing', type: 'num', show: (p) => p.kind === 'face' },
      { key: 'countV', label: 'Rows', type: 'num', min: 1, step: 1, show: (p) => p.kind === 'face' },
      { key: 'spacingV', label: 'Row spacing', type: 'num', show: (p) => p.kind === 'face' },
      { key: 'count', label: 'Quantity', type: 'num', min: 2, step: 1, show: (p) => p.kind !== 'face' },
      { key: 'spacing', label: 'Spacing', type: 'vec3', show: (p) => p.kind === 'linear' },
      { key: 'axis', label: 'Axis', type: 'select', options: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], show: (p) => p.kind === 'circular' },
      { key: 'angle', label: 'Total angle (°)', type: 'num', show: (p) => p.kind === 'circular' },
    ],
  },
  fillet: {
    label: 'Fillet', icon: 'fillet', type: 'fillet', pickEdges: true, manip: { key: 'radius', edge: true },
    make: () => ({ edges: [], radius: 2 }),
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges' },
      { key: 'radius', label: 'Radius', type: 'num', min: 0.01, step: 0.5 },
    ],
  },
  chamfer: {
    label: 'Chamfer', icon: 'chamfer', type: 'chamfer', pickEdges: true, manip: { key: 'distance', edge: true },
    make: () => ({ edges: [], distance: 2 }),
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges' },
      { key: 'distance', label: 'Distance', type: 'num', min: 0.01, step: 0.5 },
    ],
  },
  // ---- surfaces: open surface bodies (not solids)
  sextrude: {
    label: 'Extrude Surface', icon: 'extrude', type: 'sextrude', manip: { key: 'distance', sketch: 'sketch' },
    make: (ctx) => ({ sketch: ctx.selSketch || ctx.lastSketch, distance: 10, symmetric: false }),
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'distance', label: 'Distance', type: 'num', step: 1 },
      { key: 'symmetric', label: 'Symmetric', type: 'bool' },
    ],
  },
  srevolve: {
    label: 'Revolve Surface', icon: 'revolve', type: 'srevolve',
    make: (ctx) => ({ sketch: ctx.selSketch || ctx.lastSketch, angle: 360 }),
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'angle', label: 'Angle', type: 'num', unit: 'deg', min: 1, max: 360 },
    ],
  },
  ssweep: {
    label: 'Sweep Surface', icon: 'sweep', type: 'ssweep',
    make: (ctx) => ({ profile: ctx.sketches.filter((k) => k !== ctx.pathSketch).at(-1) || ctx.sketches.at(-2) || '', path: ctx.pathSketch || ctx.sketches.at(-1) || '', smooth: true }),
    fields: [
      { key: 'profile', label: 'Profile (sketch)', type: 'sketch' },
      { key: 'path', label: 'Path (sketch)', type: 'sketch' },
      { key: 'smooth', label: 'Smooth path', type: 'bool' },
    ],
  },
  sloft: {
    label: 'Loft Surface', icon: 'loft', type: 'sloft',
    make: (ctx) => ({ sketches: ctx.sketches.slice(-2) }),
    fields: [{ key: 'sketches', label: 'Profiles (in order)', type: 'sketchlist' }],
  },
  pipe: {
    label: 'Pipe', icon: 'sweep', type: 'pipe',
    make: (ctx) => ({ path: ctx.pathSketch || ctx.lastSketch, diameter: 10, wall: 0, smooth: true, op: ctx.hasBodies ? 'join' : 'new', target: '' }),
    fields: [
      { key: 'path', label: 'Path (sketch)', type: 'sketch' },
      { key: 'diameter', label: 'Outer diameter', type: 'num', min: 0.05, step: 1 },
      { key: 'wall', label: 'Wall thickness (0 = solid)', type: 'num', min: 0, step: 0.5 },
      { key: 'smooth', label: 'Smooth path', type: 'bool' },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  sstitch: {
    label: 'Stitch', icon: 'combine', type: 'sstitch',
    make: (ctx) => ({ surfaces: ctx.surfaces || [], requireSolid: false }),
    fields: [
      { key: 'surfaces', label: 'Surfaces', type: 'surfaces' },
      { key: 'requireSolid', label: 'Must form a solid', type: 'bool' },
    ],
  },
  sthicken: {
    label: 'Thicken', icon: 'shell', type: 'sthicken',
    make: (ctx) => ({ surface: (ctx.surfaces || []).at(-1) || '', thickness: 2, both: false }),
    fields: [
      { key: 'surface', label: 'Surface', type: 'surface' },
      { key: 'thickness', label: 'Thickness', type: 'num', min: 0.01, step: 0.5 },
      { key: 'both', label: 'Both sides', type: 'bool' },
    ],
  },
  sweep: {
    label: 'Sweep', icon: 'sweep', type: 'sweep',
    make: (ctx) => ({ profile: ctx.sketches.filter((k) => k !== ctx.pathSketch).at(-1) || ctx.sketches.at(-2) || '', path: ctx.pathSketch || ctx.sketches.at(-1) || '', smooth: true, op: ctx.hasBodies ? 'join' : 'new', target: '' }),
    fields: [
      { key: 'profile', label: 'Profile (sketch)', type: 'sketch' },
      { key: 'path', label: 'Path (sketch)', type: 'sketch' },
      { key: 'smooth', label: 'Smooth path', type: 'bool' },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  loft: {
    label: 'Loft', icon: 'loft', type: 'loft',
    make: (ctx) => ({ sketches: ctx.sketches.slice(-2), op: ctx.hasBodies ? 'join' : 'new', target: '' }),
    fields: [
      { key: 'sketches', label: 'Profiles (in order)', type: 'sketchlist' },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  coil: {
    label: 'Coil', icon: 'coil', type: 'coil',
    make: (ctx) => ({ origin: [0, 0, 0], axis: 'Z', diameter: 20, section: 'circle', size: 2, pitch: 5, turns: 5, left: false, op: 'new', target: '' }),
    fields: [
      { key: 'origin', label: 'Base point', type: 'point' },
      { key: 'axis', label: 'Axis', type: 'select', options: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']] },
      { key: 'diameter', label: 'Coil diameter', type: 'num', min: 0.1 },
      { key: 'section', label: 'Section', type: 'select', options: [['circle', 'Circular'], ['square', 'Square']] },
      { key: 'size', label: 'Section size', type: 'num', min: 0.05, step: 0.5 },
      { key: 'pitch', label: 'Pitch', type: 'num', min: 0.05, step: 0.5 },
      { key: 'turns', label: 'Turns', type: 'num', min: 0.25, step: 0.5 },
      { key: 'left', label: 'Left-handed', type: 'bool' },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  thread: {
    label: 'Thread', icon: 'thread', type: 'thread', needsBody: true,
    make: (ctx) => ({ target: ctx.selected || '', origin: [0, 0, 0], axis: 'Z', radius: 5, pitch: 1.5, length: 10, depth: 0.92, internal: false, left: false }),
    fields: [
      { key: 'target', label: 'Body', type: 'body' },
      { key: 'internal', label: 'Internal (in a hole)', type: 'bool' },
      { key: 'origin', label: 'Start point', type: 'point', centerOf: 'target' },
      { key: 'axis', label: 'Axis', type: 'select', options: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']] },
      { key: 'radius', label: 'Surface radius', type: 'num', min: 0.1, step: 0.5 },
      { key: 'pitch', label: 'Pitch', type: 'num', min: 0.1, step: 0.25 },
      { key: 'length', label: 'Thread length', type: 'num', min: 0.1 },
      { key: 'depth', label: 'Thread depth', type: 'num', min: 0.05, step: 0.1 },
      { key: 'left', label: 'Left-handed', type: 'bool' },
    ],
  },
  rib: {
    label: 'Rib / Web', icon: 'rib', type: 'rib', manip: { key: 'height', sketch: 'sketch' },
    make: (ctx) => ({ sketch: ctx.pathSketch || ctx.lastSketch, thickness: 2, height: 10, symmetric: false, op: ctx.hasBodies ? 'join' : 'new', target: '' }),
    fields: [
      { key: 'sketch', label: 'Path sketch', type: 'sketch' },
      { key: 'thickness', label: 'Thickness', type: 'num', min: 0.05, step: 0.5 },
      { key: 'height', label: 'Height (±)', type: 'num' },
      { key: 'symmetric', label: 'Symmetric', type: 'bool' },
      { key: 'op', label: 'Operation', type: 'ops', options: OP_OPTS },
      { key: 'target', label: 'Target body', type: 'body', optional: 'Auto / all', show: (p) => p.op !== 'new' },
    ],
  },
  hole: {
    label: 'Hole', icon: 'hole', type: 'hole', needsBody: true,
    make: (ctx) => ({ target: '', pos: ctx.topCenter, dir: [0, 0, 1], kind: 'simple', diameter: 6, through: false, depth: 10, cbDia: 10, cbDepth: 3, cskDia: 10, cskAngle: 90, thread: false, pitch: 1, threadLength: 8 }),
    fields: [
      { key: 'pos', label: 'Position', type: 'point', dirKey: 'dir' },
      { key: 'dir', label: 'Face normal', type: 'vec3', step: 0.1 },
      { key: 'kind', label: 'Type', type: 'select', options: [['simple', 'Simple'], ['counterbore', 'Counterbore'], ['countersink', 'Countersink']] },
      { key: 'diameter', label: 'Diameter', type: 'num', min: 0.05, step: 0.5 },
      { key: 'through', label: 'Through all', type: 'bool' },
      { key: 'depth', label: 'Depth', type: 'num', min: 0.05, show: (p) => !p.through },
      { key: 'cbDia', label: 'Counterbore Ø', type: 'num', min: 0.1, show: (p) => p.kind === 'counterbore' },
      { key: 'cbDepth', label: 'Counterbore depth', type: 'num', min: 0.05, show: (p) => p.kind === 'counterbore' },
      { key: 'cskDia', label: 'Countersink Ø', type: 'num', min: 0.1, show: (p) => p.kind === 'countersink' },
      { key: 'cskAngle', label: 'Countersink angle', type: 'num', min: 10, max: 170, show: (p) => p.kind === 'countersink' },
      { key: 'thread', label: 'Threaded', type: 'bool' },
      { key: 'pitch', label: 'Thread pitch', type: 'num', min: 0.1, step: 0.25, show: (p) => p.thread },
      { key: 'threadLength', label: 'Thread length', type: 'num', min: 0.1, show: (p) => p.thread },
      { key: 'target', label: 'Target body', type: 'body', optional: 'All bodies' },
    ],
  },
  draft: {
    label: 'Draft', icon: 'chamfer', type: 'draft', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '', faces: [], angle: 5, dir: '+Z', neutral: 'start' }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' },
      { key: 'faces', label: 'Faces to draft', type: 'faces' },
      { key: 'dir', label: 'Pull direction', type: 'select', options: [['+Z', '+Z (up)'], ['-Z', '-Z (down)'], ['+X', '+X'], ['-X', '-X'], ['+Y', '+Y'], ['-Y', '-Y']] },
      { key: 'neutral', label: 'Neutral plane at', type: 'select', options: [['start', 'Start of the body (base)'], ['end', 'End of the body (top)']] },
      { key: 'angle', label: 'Draft angle', type: 'num', unit: 'deg', step: 0.5 },
    ],
  },
  mreduce: {
    label: 'Reduce', icon: 'scale', type: 'mreduce', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '', keep: 50, tolerance: 0.2 }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' },
      { key: 'keep', label: 'Keep (% of triangles)', type: 'num', min: 1, max: 100, step: 5 },
      { key: 'tolerance', label: 'Max deviation', type: 'num', min: 0.001, step: 0.05 },
    ],
  },
  mseparate: {
    label: 'Separate', icon: 'split', type: 'mseparate', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '' }),
    fields: [{ key: 'body', label: 'Body', type: 'body' }],
  },
  shell: {
    label: 'Shell', icon: 'shell', type: 'shell', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '', thickness: 2, open: [], side: 'inside' }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' },
      { key: 'side', label: 'Direction', type: 'select', options: [['inside', 'Inside'], ['outside', 'Outside'], ['both', 'Both (centred)']] },
      { key: 'thickness', label: 'Wall thickness', type: 'num', min: 0.05, step: 0.5 },
      { key: 'open', label: 'Open faces', type: 'faces' },
    ],
  },
  presspull: {
    label: 'Press/Pull', icon: 'presspull', type: 'presspull', needsBody: true, dragFace: true,
    make: (ctx) => ({ body: '', face: null, distance: 5 }),
    fields: [
      { key: 'face', label: 'Face', type: 'face', bodyKey: 'body' },
      { key: 'distance', label: 'Distance', type: 'num', step: 0.5 },
    ],
  },
  scale: {
    label: 'Scale', icon: 'scale', type: 'scale', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '', mode: 'uniform', factor: 1.5, s: [1, 1, 1], about: 'center', copy: false }),
    fields: [
      { key: 'body', label: 'Body', type: 'body' },
      { key: 'mode', label: 'Type', type: 'select', options: [['uniform', 'Uniform'], ['nonuniform', 'Non-uniform']] },
      { key: 'factor', label: 'Factor', type: 'num', min: 0.001, step: 0.1, show: (p) => p.mode === 'uniform' },
      { key: 's', label: 'Scale X / Y / Z', type: 'vec3', min: 0.001, step: 0.1, show: (p) => p.mode === 'nonuniform' },
      { key: 'about', label: 'About', type: 'select', options: [['center', 'Body centre'], ['origin', 'Origin']] },
      { key: 'copy', label: 'Create copy', type: 'bool' },
    ],
  },
  split: {
    label: 'Split Body', icon: 'split', type: 'split', needsBody: true,
    make: (ctx) => ({ body: ctx.selected || '', by: 'plane', plane: 'XY', offset: ctx.selectedCenterZ || 0, tool: '', keep: 'both', keepTool: true }),
    fields: [
      { key: 'body', label: 'Body to split', type: 'body' },
      { key: 'by', label: 'Split with', type: 'select', options: [['plane', 'Plane'], ['body', 'Body']] },
      { key: 'plane', label: 'Plane', type: 'select', options: PLANE_OPTS, show: (p) => p.by === 'plane' },
      { key: 'offset', label: 'Offset', type: 'num', show: (p) => p.by === 'plane' },
      { key: 'tool', label: 'Splitting body', type: 'body', show: (p) => p.by === 'body' },
      { key: 'keepTool', label: 'Keep splitting body', type: 'bool', show: (p) => p.by === 'body' },
      { key: 'keep', label: 'Keep', type: 'select', options: [['both', 'Both parts'], ['above', 'Positive side only'], ['below', 'Negative side only']], show: (p) => p.by === 'plane' },
    ],
  },
  joint: {
    label: 'Joint', icon: 'joint', type: 'joint', needsBodies: 2,
    make: (ctx) => ({ jtype: 'rigid', bodyA: ctx.selected || '', bodyB: ctx.other || '', pointA: ctx.centerA || [0, 0, 0], pointB: ctx.centerB || [0, 0, 0], axis: 'Z', value: 0, value2: 0, value3: 0, rot: [0, 0, 0], flip: false }),
    fields: [
      { key: 'jtype', label: 'Joint type', type: 'select', options: [['rigid', 'Rigid'], ['revolute', 'Revolute'], ['slider', 'Slider'], ['cylindrical', 'Cylindrical'], ['planar', 'Planar'], ['ball', 'Ball']] },
      { key: 'bodyA', label: 'Moving body', type: 'body' },
      { key: 'pointA', label: 'Point on moving', type: 'point', centerOf: 'bodyA' },
      { key: 'bodyB', label: 'Anchor body', type: 'body' },
      { key: 'pointB', label: 'Point on anchor', type: 'point', centerOf: 'bodyB' },
      { key: 'axis', label: 'Axis', type: 'select', options: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], show: (p) => p.jtype !== 'ball' },
      { key: 'flip', label: 'Flip 180°', type: 'bool', show: (p) => p.jtype === 'rigid' },
      { key: 'value', label: 'Angle (°)', type: 'num', show: (p) => ['revolute', 'cylindrical'].includes(p.jtype) },
      { key: 'value', label: 'Offset', type: 'num', show: (p) => ['slider', 'planar'].includes(p.jtype) },
      { key: 'value2', label: 'Slide', type: 'num', show: (p) => p.jtype === 'cylindrical' },
      { key: 'value2', label: 'Offset 2', type: 'num', show: (p) => p.jtype === 'planar' },
      { key: 'value3', label: 'Rotate (°)', type: 'num', show: (p) => p.jtype === 'planar' },
      { key: 'rot', label: 'Rotation (°)', type: 'vec3', show: (p) => p.jtype === 'ball' },
    ],
  },
  remove: {
    label: 'Remove', icon: 'remove', type: 'remove', make: (ctx) => ({ body: ctx.selected || '' }),
    fields: [{ key: 'body', label: 'Body', type: 'body' }],
  },
  import: { label: 'Import STL', icon: 'import', type: 'import', make: () => ({}), fields: [] },
};

// Resolve catalogue entry for a stored feature.
export function defOf(f) {
  if (f.type === 'primitive') return FEATURES[f.params.shape];
  return FEATURES[f.type];
}

/** 'len' (stored in mm, shown in document units), 'deg' (degrees) or 'num' (unitless) for a feature field. */
export function fieldKind(f, key) {
  const t = f.type, p = f.params || {};
  if (t === 'move' && key === 'r') return 'deg';
  if (t === 'joint') {
    if (key === 'value') return ['revolute', 'cylindrical'].includes(p.jtype) ? 'deg' : 'len';
    if (key === 'value3' || key === 'rot') return 'deg';
  }
  if (['scaleTop', 'factor', 'keep', 's', 'count', 'turns', 'dir', 'countU', 'countV'].includes(key)) return 'num';
  if (['taper', 'twist', 'angle', 'cskAngle'].includes(key)) return 'deg';
  return 'len';
}
