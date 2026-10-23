// Every starter template must build into the expected bodies, and keep building across the whole range of each slider.
import { initHeadless, evaluate } from '../src/headless.js';
import { TEMPLATES, templateDoc } from '../src/templates.js';
import { DEFAULT_PROFILE, orientations, placement, findings, verdict, profileOfParams, withProfileParams, minWallFor } from '../src/printprofile.js';
import { bedFit, overhangs, wallThickness } from '../src/printcheck.js';

await initHeadless();
let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { if (ok) passed++; else { failed++; console.log('FAIL', name, extra); } };
const setParam = (d, name, v) => { const p = d.params.find((x) => x.name === name); p.expr = `${v} ${p.unit === 'angle' ? '' : 'mm'}`.trim(); };
const errs = (r) => Object.values(r.result.errors).join('; ');

for (const t of TEMPLATES) {
  const d = templateDoc(t.id, DEFAULT_PROFILE);
  const r = evaluate(d);
  const names = r.result.bodies.map((b) => b.name);
  check(`${t.name} builds without errors`, !errs(r), errs(r));
  const want = t.id === 'box-lid' ? 2 : 1;
  check(`${t.name} makes ${want} body/bodies`, r.result.bodies.length === want, `${r.result.bodies.length}: ${names}`);
  check(`${t.name} has no empty bodies`, r.result.bodies.every((b) => b.volume > 100), r.result.bodies.map((b) => b.volume.toFixed(0)));
  const all = r.result.bodies;
  const fit = bedFit(all, [220, 220, 250]);
  check(`${t.name} fits a small printer`, fit.fitsAll, JSON.stringify(fit.tooBig));
  // every slider across its range
  for (const s of t.sliders) {
    for (const v of [s.min, s.max]) {
      const dd = templateDoc(t.id, DEFAULT_PROFILE); setParam(dd, s.name, v);
      const rr = evaluate(dd);
      check(`${t.name}: ${s.name} = ${v}`, !errs(rr) && rr.result.bodies.length === want && rr.result.bodies.every((b) => b.volume > 10), errs(rr) || `${rr.result.bodies.length} bodies`);
    }
  }
  // a starter design must pass the print check it teaches people to run
  {
    const w = await wallThickness(all, { minWall: minWallFor(DEFAULT_PROFILE) });
    const list = findings({ fit, over: overhangs(all, 45), wall: w, turn: orientations(all), profile: DEFAULT_PROFILE, bedName: 'Ender 3', count: all.length });
    check(`${t.name} reads as ready to print`, verdict(list) === 'ok', JSON.stringify(list.filter((x) => x.level !== 'ok')));
  }
  // the print profile reaches the design
  const loose = templateDoc(t.id, { ...DEFAULT_PROFILE, tol: 0.5 });
  check(`${t.name} carries the print profile`, profileOfParams(loose.params)?.tol === 0.5);
}

// box with lid: the lip is smaller than the opening by the fit gap on each side
{
  const tight = evaluate(templateDoc('box-lid', { ...DEFAULT_PROFILE, tol: 0.1 })), loose = evaluate(templateDoc('box-lid', { ...DEFAULT_PROFILE, tol: 0.4 }));
  const lid = (r) => r.result.bodies.find((b) => b.name === 'Lid');
  check('a looser fit makes a smaller lip', lid(loose).volume < lid(tight).volume, `${lid(loose).volume} vs ${lid(tight).volume}`);
}
// phone stand: the back leans backwards and reaches above the lip
{
  const r = evaluate(templateDoc('phone-stand', DEFAULT_PROFILE)), b = r.result.bodies[0];
  check('phone stand is as tall as the back leans', b.bbox.max[2] > 55 && b.bbox.max[2] < 75, b.bbox.max[2]);
}
// cable clip: the holes are really cut (cable hole wider than the cable)
{
  const r = evaluate(templateDoc('cable-clip', DEFAULT_PROFILE));
  const plain = evaluate({ ...templateDoc('cable-clip', DEFAULT_PROFILE), features: templateDoc('cable-clip', DEFAULT_PROFILE).features.filter((f) => !/Cut/.test(f.name)) });
  check('cable clip cuts material away', r.result.bodies[0].volume < plain.result.bodies[0].volume - 100, `${r.result.bodies[0].volume} vs ${plain.result.bodies[0].volume}`);
}
// bracket: screw holes follow the fit gap
{
  const a = evaluate(templateDoc('wall-bracket', { ...DEFAULT_PROFILE, tol: 0 })), b = evaluate(templateDoc('wall-bracket', { ...DEFAULT_PROFILE, tol: 0.5 }));
  check('a bigger tolerance opens the screw holes', b.result.bodies[0].volume < a.result.bodies[0].volume, `${b.result.bodies[0].volume} vs ${a.result.bodies[0].volume}`);
}

// laying flat: an L-bracket standing on its upright arm prints better on its side
{
  const r = evaluate(templateDoc('wall-bracket', DEFAULT_PROFILE)), bodies = r.result.bodies;
  const o = orientations(bodies);
  check('orientations lists six ways', o.all.length === 6);
  check('orientation never makes things worse', o.best.supportVolume <= o.current.supportVolume + 1e-6);
  const pl = placement(bodies[0], [90, 0, 0]);
  check('placement gives a z lift', Number.isFinite(pl.t[2]));
}
{ // a part lying upside down gets turned over
  const r = evaluate({ features: [{ id: 'cone', type: 'primitive', name: 'Cone', params: { shape: 'cone', pos: [0, 0, 0], op: 'new', radius: 30, radius2: 0, height: 20 } }, { id: 'mv', type: 'move', name: 'Flip', params: { body: 'cone', t: [0, 0, 0], r: [180, 0, 0], s: [1, 1, 1], copy: false, mode: 'free', from: [0, 0, 0], to: [0, 0, 0] } }], params: [], units: 'mm', nextId: 10 });
  const b = r.result.bodies[0];
  const ov = overhangs([b], 45, b.bbox.min[2]);
  const o = orientations([b]);
  check('a point-down cone has overhangs', ov.fraction > 0.5, ov.fraction);
  check('it is advised to turn over', o.best !== o.current && o.best.overhang < 0.1, JSON.stringify({ cur: o.current.overhang, best: o.best.overhang, r: o.best.r }));
}

// plain-language findings
{
  const r = evaluate(templateDoc('box-lid', DEFAULT_PROFILE)), bodies = r.result.bodies;
  const list = findings({ fit: bedFit(bodies, [220, 220, 250]), over: overhangs(bodies, 45), wall: null, turn: orientations(bodies), profile: DEFAULT_PROFILE, bedName: 'Ender 3', count: bodies.length });
  check('findings read in plain words', list.length >= 2 && list.every((x) => x.title && x.detail), JSON.stringify(list));
  const big = findings({ fit: bedFit(bodies, [20, 20, 20]), over: overhangs(bodies, 45), wall: { min: 0.3, thin: [1], samples: [1] }, turn: null, profile: DEFAULT_PROFILE, bedName: 'tiny', count: 2 });
  check('a too-big part is called out', big.some((x) => x.level === 'bad' && /Too big/.test(x.title)), JSON.stringify(big));
  check('thin walls name the nozzle', big.some((x) => /0\.4 mm nozzle/.test(x.detail)), JSON.stringify(big));
}
check('min wall is three nozzle widths', minWallFor({ nozzle: 0.6 }) === 1.8);
check('profile params keep other parameters', withProfileParams([{ name: 'w', expr: '5 mm', unit: 'length' }], DEFAULT_PROFILE).length === 4);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
