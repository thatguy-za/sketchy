// Starter designs for people new to 3D printing. Each one is an ordinary design (parameters + a feature timeline built from
// primitives and Combine, so nothing depends on picked faces) with a few sliders for the numbers worth changing. The fit
// gaps use the design's `tol` parameter and the walls follow `nozzle`, so a template prints on the person's own printer.
import { withProfileParams, cleanProfile } from './printprofile.js';

const P = (name, expr, unit = 'length', comment = '') => ({ name, expr, unit, comment });
const S = (name, label, min, max, step, unit = 'mm', hint = '') => ({ name, label, min, max, step, unit, hint });
let ids;
const feat = (type, name, params, exprs = {}, id) => ({ id: id || `${type[0]}${ids.n++}`, type, name, params, ...(Object.keys(exprs).length ? { exprs } : {}) });
const prim = (id, name, shape, params, exprs) => feat('primitive', name, { shape, pos: [0, 0, 0], op: 'new', ...params }, exprs, id);
const combine = (name, target, tool, op) => feat('combine', name, { target, tool, op, keepTool: false });
const move = (name, body, r, t, exprs) => feat('move', name, { body, t: t || [0, 0, 0], r: r || [0, 0, 0], s: [1, 1, 1], copy: false, mode: 'free', from: [0, 0, 0], to: [0, 0, 0] }, exprs);

/** The numbers a template shares: print settings, then its own. */
const base = (profile, own) => ({ params: [...withProfileParams([], profile), ...own] });

const BOX_WITH_LID = {
  id: 'box-lid', name: 'Box with lid', icon: 'box',
  blurb: 'A rounded box and a lid that presses on, with a gap for your printer\'s fit.',
  tip: 'Print both parts flat. The lid lip leaves a small gap (tol) on each side so it slides on.',
  sliders: [S('width', 'Width', 30, 150, 1), S('depth', 'Depth', 30, 150, 1), S('height', 'Height', 15, 100, 1), S('wall', 'Wall thickness', 1.2, 5, 0.1, 'mm', 'Three nozzle widths or more prints strongly'), S('corner', 'Corner rounding', 0, 12, 0.5)],
  build(profile) {
    ids = { n: 1 };
    const features = [
      prim('base', 'Box', 'box', { sx: 60, sy: 40, sz: 33, radius: 3 }, { sx: 'width', sy: 'depth', sz: 'height + corner', radius: 'corner' }),
      prim('cavity', 'Inside', 'box', { sx: 56, sy: 36, sz: 33, radius: 1, pos: [0, 0, 2] }, { sx: 'width - 2 * wall', sy: 'depth - 2 * wall', sz: 'height + corner', radius: 'max(corner - wall, 0)', 'pos.2': 'wall' }),
      prim('trim', 'Trim', 'box', { sx: 70, sy: 50, sz: 13, radius: 0, pos: [0, 0, 30] }, { sx: 'width + 10 mm', sy: 'depth + 10 mm', sz: 'corner + 10 mm', 'pos.2': 'height' }),
      combine('Hollow the box', 'base', ['cavity'], 'cut'),
      combine('Cut the top flat', 'base', ['trim'], 'cut'),
      prim('lidtop', 'Lid', 'box', { sx: 60, sy: 40, sz: 2, radius: 1, pos: [70, 0, 0] }, { sx: 'width', sy: 'depth', sz: 'wall', radius: 'min(corner, wall / 2)', 'pos.0': 'width + 10 mm' }),
      prim('lidlip', 'Lid lip', 'box', { sx: 55, sy: 35, sz: 4, radius: 0, pos: [70, 0, 2] }, { sx: 'width - 2 * wall - 2 * tol', sy: 'depth - 2 * wall - 2 * tol', 'pos.0': 'width + 10 mm', 'pos.2': 'wall' }),
      combine('Join the lip to the lid', 'lidtop', ['lidlip'], 'join'),
    ];
    return { ...base(profile, [P('width', '60 mm'), P('depth', '40 mm'), P('height', '30 mm'), P('wall', `${Math.max(1.6, 4 * cleanProfile(profile).nozzle)} mm`), P('corner', '3 mm')]), features };
  },
};

const PHONE_STAND = {
  id: 'phone-stand', name: 'Phone stand', icon: 'box',
  blurb: 'A desk stand that holds a phone or small tablet at an angle.',
  tip: 'Print it as it sits. The back leans, but it is thick enough that it does not need supports.',
  sliders: [S('width', 'Width', 50, 120, 1), S('lean', 'Lean back', 10, 40, 1, '°', 'Degrees from upright'), S('slot', 'Phone thickness', 6, 20, 0.5, 'mm', 'The gap the phone sits in'), S('rest', 'Back height', 40, 120, 1), S('lipH', 'Front lip height', 6, 30, 1)],
  build(profile) {
    ids = { n: 1 };
    const features = [
      prim('plate', 'Base', 'box', { sx: 70, sy: 70, sz: 4, radius: 1, pos: [0, 35, 0] }, { sx: 'width', sy: 'lipT + slot + rest * sin(lean) + 2 * thick', sz: 'thick', 'pos.1': '(lipT + slot + rest * sin(lean) + 2 * thick) / 2' }),
      prim('lip', 'Front lip', 'box', { sx: 70, sy: 4, sz: 12, radius: 1, pos: [0, 2, 0] }, { sx: 'width', sy: 'lipT', sz: 'lipH', 'pos.1': 'lipT / 2' }),
      prim('back', 'Back', 'box', { sx: 70, sy: 5, sz: 70, radius: 1, pos: [0, 40, 0] }, { sx: 'width', sy: 'thick', sz: 'rest', 'pos.1': 'lipT + slot + (rest / 2) * sin(lean)', 'pos.2': 'thick + (rest / 2) * cos(lean) - rest / 2 - 1.5 mm' }),
      move('Lean the back', 'back', [-15, 0, 0], [0, 0, 0], { 'r.0': '-lean' }),
      combine('Join the lip', 'plate', ['lip'], 'join'),
      combine('Join the back', 'plate', ['back'], 'join'),
    ];
    return { ...base(profile, [P('width', '70 mm'), P('lean', '15', 'angle'), P('slot', '12 mm'), P('rest', '70 mm'), P('lipH', '12 mm'), P('lipT', `${Math.max(2.4, 6 * cleanProfile(profile).nozzle)} mm`), P('thick', `${Math.max(3, 8 * cleanProfile(profile).nozzle)} mm`)]), features };
  },
};

const CABLE_CLIP = {
  id: 'cable-clip', name: 'Cable clip', icon: 'cylinder',
  blurb: 'Holds a cable or pipe against a wall with screws. The cable snaps in.',
  tip: 'Print it with the base on the bed. Bigger "Screw size" is for thicker screws.',
  sliders: [S('cable', 'Cable diameter', 3, 30, 0.5), S('wall', 'Clip wall', 1.2, 5, 0.1), S('clipW', 'Clip width', 6, 25, 1), S('screw', 'Screw size', 2.5, 6, 0.5)],
  build(profile) {
    ids = { n: 1 };
    const features = [
      prim('plate', 'Base', 'box', { sx: 30, sy: 14, sz: 3, radius: 1 }, { sx: 'cable + 2 * wall + 4 * (screw + 4 mm)', sy: 'clipW', sz: 'thick', radius: 'min(1.5 mm, thick / 2)' }),
      prim('ring', 'Ring', 'cylinder', { radius: 6, height: 10, pos: [0, 0, 0] }, { radius: 'cable / 2 + wall', height: 'clipW', 'pos.2': 'thick + cable / 2 + wall - clipW / 2' }),
      move('Lay the ring on its side', 'ring', [90, 0, 0]),
      prim('bore', 'Cable hole', 'cylinder', { radius: 4, height: 14, pos: [0, 0, 0] }, { radius: 'cable / 2 + tol', height: 'clipW + 2 mm', 'pos.2': 'thick + cable / 2 + wall - clipW / 2 - 1 mm' }),
      move('Lay the hole on its side', 'bore', [90, 0, 0]),
      prim('mouth', 'Opening', 'box', { sx: 16, sy: 12, sz: 12, radius: 0, pos: [0, 0, 10] }, { sx: 'cable + 2 * wall + 2 mm', sy: 'clipW + 2 mm', sz: 'cable + 2 * wall', 'pos.2': 'thick + cable / 2 + wall + cable * 0.28' }),
      combine('Join the ring to the base', 'plate', ['ring'], 'join'),
      combine('Cut the cable hole', 'plate', ['bore'], 'cut'),
      combine('Cut the opening', 'plate', ['mouth'], 'cut'),
      prim('h1', 'Screw hole left', 'cylinder', { radius: 1.8, height: 8, pos: [-14, 0, -1] }, { radius: '(screw + 2 * tol) / 2', 'pos.0': '-(cable / 2 + wall + (screw + 4 mm) * 1.5)' }),
      prim('h2', 'Screw hole right', 'cylinder', { radius: 1.8, height: 8, pos: [14, 0, -1] }, { radius: '(screw + 2 * tol) / 2', 'pos.0': 'cable / 2 + wall + (screw + 4 mm) * 1.5' }),
      combine('Cut the left screw hole', 'plate', ['h1'], 'cut'),
      combine('Cut the right screw hole', 'plate', ['h2'], 'cut'),
    ];
    return { ...base(profile, [P('cable', '8 mm'), P('wall', `${Math.max(1.6, 4 * cleanProfile(profile).nozzle)} mm`), P('clipW', '10 mm'), P('screw', '3.5 mm'), P('thick', '3 mm')]), features };
  },
};

const BRACKET = {
  id: 'wall-bracket', name: 'Shelf bracket', icon: 'box',
  blurb: 'An L-shaped bracket with screw holes in both arms.',
  tip: 'Print it on its side so the layers run along the arms; that is the strongest way.',
  sliders: [S('legA', 'Bottom arm', 20, 120, 1), S('legB', 'Upright arm', 20, 120, 1), S('width', 'Width', 10, 60, 1), S('thick', 'Thickness', 2, 10, 0.5), S('screw', 'Screw size', 2.5, 6, 0.5)],
  build(profile) {
    ids = { n: 1 };
    const features = [
      prim('arm', 'Bottom arm', 'box', { sx: 50, sy: 25, sz: 4, radius: 1 }, { sx: 'legA', sy: 'width', sz: 'thick', radius: 'min(1.5 mm, thick / 2)' }),
      prim('up', 'Upright arm', 'box', { sx: 4, sy: 25, sz: 40, radius: 1, pos: [-23, 0, 0] }, { sx: 'thick', sy: 'width', sz: 'legB', radius: 'min(1.5 mm, thick / 2)', 'pos.0': '-(legA - thick) / 2' }),
      combine('Join the arms', 'arm', ['up'], 'join'),
      prim('hole1', 'Hole in the bottom arm', 'cylinder', { radius: 2, height: 8, pos: [12, 0, -2] }, { radius: '(screw + 2 * tol) / 2', height: 'thick + 4 mm', 'pos.0': 'legA / 2 - 12 mm', 'pos.2': '-2 mm' }),
      prim('hole2', 'Hole in the upright arm', 'cylinder', { radius: 2, height: 8, pos: [-23, 0, 22] }, { radius: '(screw + 2 * tol) / 2', height: 'thick + 4 mm', 'pos.0': '-(legA - thick) / 2', 'pos.2': 'legB - 12 mm - (thick + 4 mm) / 2' }),
      move('Turn the hole sideways', 'hole2', [0, 90, 0]),
      combine('Drill the bottom arm', 'arm', ['hole1'], 'cut'),
      combine('Drill the upright arm', 'arm', ['hole2'], 'cut'),
    ];
    return { ...base(profile, [P('legA', '50 mm'), P('legB', '40 mm'), P('width', '25 mm'), P('thick', `${Math.max(3, 8 * cleanProfile(profile).nozzle)} mm`), P('screw', '4 mm')]), features };
  },
};

export const TEMPLATES = [BOX_WITH_LID, PHONE_STAND, CABLE_CLIP, BRACKET];
export const templateById = (id) => TEMPLATES.find((t) => t.id === id);

/** A new design from a template, as the fields of a Sketchy document. */
export function templateDoc(id, profile) {
  const t = templateById(id);
  if (!t) return null;
  const b = t.build(profile);
  return {
    name: t.name, features: b.features, marker: b.features.length, nextId: 100, params: b.params, appearance: {}, faceAppearance: [], units: 'mm',
    components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [], template: { id: t.id, sliders: t.sliders, tip: t.tip },
  };
}
