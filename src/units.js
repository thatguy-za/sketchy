// Document length units. Geometry is always stored in millimetres; this module converts at the UI boundary
// (fields, sketch dimensions, measurements, parameters).
export const UNIT_TABLE = {
  mm: { f: 1, dec: 3, steps: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500] },
  cm: { f: 10, dec: 4, steps: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50] },
  m: { f: 1000, dec: 6, steps: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5] },
  in: { f: 25.4, dec: 4, steps: [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50] },
  ft: { f: 304.8, dec: 5, steps: [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50] },
};
export const UNIT_NAMES = { mm: 'Millimeter', cm: 'Centimeter', m: 'Meter', in: 'Inch', ft: 'Foot' };

let cur = 'mm';
export const setUnits = (u) => { if (UNIT_TABLE[u]) cur = u; };
export const getUnits = () => cur;
export const lenF = () => UNIT_TABLE[cur].f;

export const toDisp = (mm) => mm / lenF();
export const fromDisp = (v) => v * lenF();
/** Millimetres -> display number string in the current unit. */
export const dispStr = (mm, dec) => String(+(mm / lenF()).toFixed(dec ?? UNIT_TABLE[cur].dec));
export const fmtLen = (mm, dec) => `${dispStr(mm, dec)} ${cur}`;

/** Areas and volumes: mm gets the 3D-printing convention (cm² / cm³); other units use unit²/unit³. */
export const fmtArea = (mm2) => (cur === 'mm' ? `${(mm2 / 100).toFixed(2)} cm²` : `${+(mm2 / lenF() ** 2).toFixed(4)} ${cur}²`);
export const fmtVolume = (mm3) => (cur === 'mm' ? `${(mm3 / 1000).toFixed(3)} cm³` : `${+(mm3 / lenF() ** 3).toFixed(4)} ${cur}³`);

/** A friendly arrow-key step for a field whose step is given in millimetres. */
export const niceStep = (mm) => { const v = mm / lenF(); return Math.max(+v.toPrecision(1), 1e-6); };
