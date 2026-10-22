// MCP tool implementations (shared by the main thread and the worker threads). See mcp.js for the protocol side and mcp-defs.js
// for what each tool is called and takes. Heavy tools get H (the headless kernel, src/headless.js) as their third argument.
import { checkShapes, checkCons, describeSketchText, SHAPES, LINE_TYPES, CONSTRAINTS, POINT_KEYS, DIMENSIONS } from './src/sketch-schema.js';
import { hintFor } from './src/hints.js';
import { cutsFromSpec } from './src/section.js';
import { definedState } from './src/sketchcons.js';

const locks = new Map();
const withLock = async (key, fn) => {
  const prev = locks.get(key) || Promise.resolve();
  let done; const next = new Promise((r) => (done = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { done(); if (locks.get(key) === next) locks.delete(key); }
};

export const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
export const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: typeof msg === 'string' ? msg : JSON.stringify(msg, null, 1) }] });
const UNITS = ['mm', 'cm', 'm', 'in', 'ft'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Edit distance, to suggest the key somebody probably meant. */
const near = (w, list) => { let best = null, bd = 3; for (const k of list) { const m = [...Array(w.length + 1)].map((_, i) => [i]); for (let j = 1; j <= k.length; j++) m[0][j] = j; for (let i = 1; i <= w.length; i++) for (let j = 1; j <= k.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (w[i - 1] === k[j - 1] ? 0 : 1)); if (m[w.length][k.length] < bd) { bd = m[w.length][k.length]; best = k; } } return best; };

/**
 * The tool implementations. `d` = { storage, device }. storage: list, read, write, saveVersion, versions, readVersion, restoreVersion,
 * undo, requests, requestDone (see server.js). Runs inside a worker thread for everything that rebuilds a design, and in the main
 * thread for the cheap tools.
 */
export function createTools(d) {
  const nameOk = (n) => typeof n === 'string' && /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.') && !['__proto__', 'constructor', 'prototype'].includes(n.toLowerCase());

  const load = async (user, name) => {
    const r = await d.storage.read(user, name);
    if (!r) throw new Error(`No design called "${name}". Call list_designs to see what exists.`);
    const o = r.obj;
    return { obj: o, rev: r.rev, doc: { name: o.name || name, features: o.features || [], marker: (o.features || []).length, nextId: o.nextId || 1, params: o.params || [], appearance: o.appearance || {}, faceAppearance: Array.isArray(o.faceAppearance) ? o.faceAppearance : [], units: o.units || 'mm', bodyComp: o.bodyComp, configs: o.configs, activeConfig: o.activeConfig, lastEdit: o.lastEdit } };
  };
  /** Write the design back. `by` names the features this call touched, so the app can show what the assistant changed. */
  const save = (user, name, base, doc, rev, touched = [], tool = '') => d.storage.write(user, name, {
    ...base, format: 'sketchy', version: 1, name, features: doc.features, marker: doc.features.length, nextId: doc.nextId, params: doc.params,
    appearance: doc.appearance, faceAppearance: doc.faceAppearance, units: doc.units,
    lastEdit: { by: 'assistant', at: Date.now(), tool, features: touched.slice(0, 50) },
  }, d.device, rev);

  const findIndex = (doc, ref) => {
    const s = String(typeof ref === 'number' ? '#' + ref : ref);
    let i = /^#\d+$/.test(s) ? +s.slice(1) - 1 : doc.features.findIndex((f) => f.id === s);
    if (i < 0) i = doc.features.findIndex((f) => f.name === s);
    if (i < 0 || i >= doc.features.length) throw new Error(`No feature "${ref}". Features: ${doc.features.slice(0, 40).map((f, k) => `${f.id} "${f.name}" (#${k + 1})`).join(', ') || '(none)'}.`);
    return i;
  };
  const bodyOf = (result, id) => {
    const b = result.bodies.find((x) => x.id === id);
    if (!b) throw new Error(`No body "${id}" in this design. Bodies now: ${result.bodies.map((x) => `${x.id} (${x.name})`).join(', ') || '(none; the design builds no bodies yet)'}.`);
    return b;
  };
  const delta = (a, b) => { // what the change did to the bodies
    const out = [];
    const A = Object.fromEntries(a.bodies.map((x) => [x.id, x])), B = Object.fromEntries(b.bodies.map((x) => [x.id, x]));
    for (const id of Object.keys(B)) if (!A[id]) out.push({ body: id, name: B[id].name, change: 'added', volume_mm3: B[id].volume_mm3 }); else if (Math.abs(A[id].volume_mm3 - B[id].volume_mm3) > 1e-3 || !same(A[id].bbox_max, B[id].bbox_max) || !same(A[id].bbox_min, B[id].bbox_min)) out.push({ body: id, name: B[id].name, change: 'changed', volume_mm3: B[id].volume_mm3, volume_was_mm3: A[id].volume_mm3 });
    for (const id of Object.keys(A)) if (!B[id]) out.push({ body: id, name: A[id].name, change: 'removed' });
    return out;
  };
  /** A failure an assistant can act on: what broke, a hint for each problem, and the fields that exist. */
  const richFail = (headline, problems, extra = {}) => fail({ error: headline, nothing_saved: true, problems, ...extra });
  const problemsOf = (doc, errors, only) => Object.entries(errors).filter(([id]) => !only || only.includes(id)).map(([id, message]) => {
    const f = doc.features.find((x) => x.id === id), i = doc.features.findIndex((x) => x.id === id);
    const hint = hintFor(message, f);
    return { feature: id, name: f ? `${f.name} (#${i + 1})` : id, message, ...(hint ? { hint } : {}) };
  });

  /** Lock, load, evaluate, change, re-evaluate, check, save. `fn(doc, result)` returns { extra, touched } or a failure. */
  const edit = (tool, user, a, H, fn) => withLock(user + '/' + a.design, async () => {
    const { obj, doc, rev } = await load(user, a.design);
    const before = H.evaluate(doc), sumBefore = H.summarize(doc, before.result);
    const r = await fn(doc, before.result, H);
    if (r?.isError) return r;
    const after = H.evaluate(doc);
    const fresh = Object.entries(after.result.errors).filter(([id, m]) => before.result.errors[id] !== m);
    if (fresh.length && !a.keep_on_error) return richFail(`That change makes the model fail to build.`, problemsOf(doc, after.result.errors, fresh.map(([id]) => id)), { bodies_now: sumBefore.bodies.map((b) => `${b.id} (${b.name})`) });
    const nrev = await save(user, a.design, obj, doc, rev, r.touched || [], tool);
    const sumAfter = H.summarize(doc, after.result);
    return text({ ...r.extra, revision: nrev, ...(fresh.length ? { warning: 'Saved with errors because keep_on_error is set.' } : {}), changes: delta(sumBefore, sumAfter), model: sumAfter });
  });

  const stamp = (f) => { f.by = 'assistant'; return f; };

  const tools = {
    // ---------------------------------------------------------------- the running app
    async get_live_context(user) {
      const l = await d.storage.live(user);
      if (!l) return text({ open: false, note: 'Sketchy does not seem to be open right now (nothing was reported in the last 3 minutes). Use list_designs and ask which design they mean.' });
      const { ageSeconds, ...s } = l;
      const open = (await d.storage.requests(user)).filter((r) => r.status === 'open').length;
      return text({ open: true, seconds_ago: ageSeconds, ...s, open_requests: open, hint: s.selection.face ? 'The selected face is a ref you can pass to set_appearance, measure, render_view (highlight_faces) or a feature that takes a face.' : undefined });
    },
    async show_in_app(user, a) {
      const secSpec = [a.section, ...(a.sections || []), a.section_box && { box: a.section_box }].filter(Boolean);
      if (secSpec.length) { try { cutsFromSpec(secSpec.map((x) => (x.box ? { box: x.box } : x))); } catch (e) { return fail(e.message); } }
      const cmd = { design: a.design || '', ...(secSpec.length ? { section: secSpec } : {}), ...(a.clear_section ? { clear_section: true } : {}), ...(a.view ? { view: a.view } : {}), ...(a.select_bodies?.length ? { bodies: a.select_bodies.slice(0, 40) } : {}), ...(a.select_face ? { face: a.select_face } : {}), ...(a.message ? { message: String(a.message).slice(0, 200) } : {}) };
      if (!cmd.view && !cmd.bodies && !cmd.face && !cmd.message && !cmd.section && !cmd.clear_section) return fail('Say what to show: view, select_bodies, select_face, section, clear_section or message.');
      const n = await d.storage.ui(user, cmd);
      return n ? text({ shown: true, windows: n }) : text({ shown: false, note: 'Sketchy is not open, so there was nobody to show it to.' });
    },
    // ---------------------------------------------------------------- requests from the app
    async list_requests(user, a) {
      const l = (await d.storage.requests(user)).filter((r) => a.all || r.status === 'open');
      return text(l.length ? { requests: l.map((r) => ({ id: r.id, status: r.status, design: r.design || null, text: r.text, created: new Date(r.created).toISOString(), ...(r.context ? { context: r.context } : {}), ...(r.reply ? { reply: r.reply } : {}) })) } : { requests: [], note: 'No open requests from the person in the app.' });
    },
    async complete_request(user, a) {
      const r = await d.storage.requestDone(user, a.request_id, String(a.reply || '').slice(0, 2000), !!a.declined);
      return r ? text({ completed: a.request_id, status: a.declined ? 'declined' : 'done' }) : fail(`No open request "${a.request_id}". Call list_requests.`);
    },
    // ---------------------------------------------------------------- designs
    async list_designs(user) {
      const l = await d.storage.list(user);
      return text(l.length ? l.map((x) => ({ name: x.name, revision: x.rev, modified: new Date(x.modified).toISOString() })) : 'No designs yet. Use create_design.');
    },
    async create_design(user, a) {
      if (!nameOk(a.name)) return fail('Invalid name. Use 1-80 letters, numbers, spaces or . _ ( ) -');
      if (await d.storage.read(user, a.name)) return fail(`A design called "${a.name}" already exists. Use get_design to open it.`);
      const doc = { name: a.name, features: [], marker: 0, nextId: 1, params: [], appearance: {}, faceAppearance: [], units: UNITS.includes(a.units) ? a.units : 'mm' };
      await save(user, a.name, {}, doc, 0, [], 'create_design');
      return text({ created: a.name, hint: 'Add a sketch with add_feature kind "sketch", then an "extrude". Or add a primitive (box, cylinder, sphere) for a quick start.' });
    },
    async duplicate_design(user, a) {
      if (!nameOk(a.new_name)) return fail('Invalid name for the copy. Use 1-80 letters, numbers, spaces or . _ ( ) -');
      if (await d.storage.read(user, a.new_name)) return fail(`A design called "${a.new_name}" already exists.`);
      const { obj } = await load(user, a.design);
      await d.storage.write(user, a.new_name, { ...obj, name: a.new_name, lastEdit: { by: 'assistant', at: Date.now(), tool: 'duplicate_design', features: [] } }, d.device, 0);
      return text({ created: a.new_name, copied_from: a.design });
    },
    async get_design(user, a, H) {
      const { doc, rev } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      return text({ name: doc.name, revision: rev, units: doc.units, parameters: doc.params, timeline: doc.features.map(H.describeFeature), appearance: doc.appearance, face_appearance: doc.faceAppearance, model: H.summarize(doc, result) });
    },
    async describe_feature_types(user, a, H) {
      const c = H.catalog();
      if (a.kind) return c[a.kind] ? text({ kind: a.kind, ...c[a.kind] }) : fail(`Unknown kind "${a.kind}". Kinds: ${Object.keys(c).join(', ')}`);
      return text({ kinds: c });
    },
    async describe_sketch() {
      return text({ shapes: Object.fromEntries(Object.entries(SHAPES).map(([t, s]) => [t, { fields: s.fields, ...(s.optional ? { optional: s.optional } : {}), example: s.example, note: s.note }])), line_types: LINE_TYPES, constraints: CONSTRAINTS, named_points: POINT_KEYS, driving_dimensions: DIMENSIONS, summary: describeSketchText() });
    },
    // ---------------------------------------------------------------- editing
    add_feature(user, a, H) {
      return edit('add_feature', user, a, H, async (doc, result) => {
        if (doc.features.length >= 500) return fail('This design already has 500 features, the most Sketchy will build through an assistant. Combine or delete some first.');
        const def = H.FEATURES[a.kind];
        if (!def) return fail(`Unknown feature kind "${a.kind}". Kinds: ${Object.keys(H.FEATURES).join(', ')}`);
        const given = a.params || {};
        if (a.kind === 'sketch') { // check the shapes before building anything
          const bad = [...(given.shapes !== undefined ? checkShapes(given.shapes) : []), ...(given.cons !== undefined ? checkCons(given.cons, given.shapes || []) : [])];
          if (bad.length) return richFail('The sketch has problems.', bad.slice(0, 12).map((m) => ({ message: m })), { see: 'describe_sketch' });
        }
        const f = stamp(H.makeFeature(doc, result, a.kind, given, a.name));
        const allowed = new Set([...Object.keys(f.params).filter((k) => !(k in given)), ...Object.keys(def.make({ lastSketch: '', sketches: [], pathSketch: '', hasBodies: false, selected: '', other: '', topCenter: [0, 0, 0], selectedCenterZ: 0, centerA: [0, 0, 0], centerB: [0, 0, 0] })), ...def.fields.map((x) => x.key), 'exprs']);
        const unknown = Object.keys(given).filter((k) => !allowed.has(k));
        const pos = a.position ? Math.max(0, Math.min(doc.features.length, a.position - 1)) : doc.features.length;
        doc.features.splice(pos, 0, f);
        return { touched: [f.id], extra: { added: H.describeFeature(f, pos), ...(unknown.length ? { warning: `Unknown parameter${unknown.length > 1 ? 's' : ''} ignored by Sketchy: ${unknown.map((k) => `"${k}"${near(k, [...allowed]) ? ` (did you mean "${near(k, [...allowed])}"?)` : ''}`).join(', ')}. Valid: ${[...allowed].filter((k) => k !== 'exprs').join(', ')}.` } : {}) } };
      });
    },
    update_feature(user, a, H) {
      return edit('update_feature', user, a, H, async (doc) => {
        const i = findIndex(doc, a.feature), f = doc.features[i];
        if (f.type === 'sketch' && a.params && (a.params.shapes !== undefined || a.params.cons !== undefined)) {
          const bad = [...(a.params.shapes !== undefined ? checkShapes(a.params.shapes) : []), ...(a.params.cons !== undefined ? checkCons(a.params.cons, a.params.shapes ?? f.params.shapes ?? []) : [])];
          if (bad.length) return richFail('The sketch has problems.', bad.slice(0, 12).map((m) => ({ message: m })), { see: 'describe_sketch' });
        }
        doc.features[i] = stamp({ ...f, ...(a.name ? { name: a.name } : {}), ...(typeof a.suppressed === 'boolean' ? { suppressed: a.suppressed } : {}), params: { ...f.params, ...(a.params || {}) } });
        if (a.params && f.exprs) { const ex = { ...f.exprs }; for (const k of Object.keys(a.params)) delete ex[k]; doc.features[i].exprs = Object.keys(ex).length ? ex : undefined; }
        return { touched: [f.id], extra: { updated: H.describeFeature(doc.features[i], i) } };
      });
    },
    edit_sketch(user, a, H) {
      return edit('edit_sketch', user, a, H, async (doc) => {
        const i = findIndex(doc, a.sketch), f = doc.features[i];
        if (f.type !== 'sketch') return fail(`"${f.name}" is a ${f.type}, not a sketch. Sketches: ${doc.features.filter((x) => x.type === 'sketch').map((x) => `${x.id} "${x.name}"`).join(', ') || '(none)'}.`);
        let shapes = [...(f.params.shapes || [])], cons = [...(f.params.cons || [])];
        const problems = [];
        for (const r of a.replace_shapes || []) { if (!Number.isInteger(r.index) || r.index < 0 || r.index >= shapes.length) problems.push(`replace_shapes: no shape at index ${r.index} (the sketch has ${shapes.length}).`); else shapes[r.index] = r.shape; }
        for (const l of a.line_type || []) { if (!shapes[l.index]) { problems.push(`line_type: no shape at index ${l.index}.`); continue; } const s = { ...shapes[l.index] }; if (l.lt === 'normal') delete s.lt; else s.lt = l.lt; shapes[l.index] = s; }
        if (a.remove_shapes?.length) { // later indexes shift down, so constraints that use them follow along
          const gone = new Set(a.remove_shapes);
          for (const x of gone) if (!shapes[x]) problems.push(`remove_shapes: no shape at index ${x}.`);
          const map = new Map(); let n = 0; shapes.forEach((_, k) => { if (!gone.has(k)) map.set(k, n++); });
          shapes = shapes.filter((_, k) => !gone.has(k));
          cons = cons.filter((c) => ['a', 'b', 'c'].every((r) => !c[r] || map.has(c[r].s))).map((c) => { const o = { ...c }; for (const r of ['a', 'b', 'c']) if (o[r]) o[r] = { ...o[r], s: map.get(o[r].s) }; return o; });
        }
        if (a.add_shapes?.length) shapes.push(...a.add_shapes);
        if (a.remove_constraints?.length) { for (const x of a.remove_constraints) if (!cons[x]) problems.push(`remove_constraints: no constraint at index ${x}.`); const gone = new Set(a.remove_constraints); cons = cons.filter((_, k) => !gone.has(k)); }
        if (a.add_constraints?.length) cons.push(...a.add_constraints);
        if (shapes.length > 2000) problems.push('A sketch can hold at most 2000 shapes.');
        problems.push(...checkShapes(shapes), ...checkCons(cons, shapes));
        if (problems.length) return richFail('The sketch has problems.', problems.slice(0, 15).map((m) => ({ message: m })), { see: 'describe_sketch' });
        doc.features[i] = stamp({ ...f, params: { ...f.params, shapes, cons } });
        return { touched: [f.id], extra: { sketch: f.id, shapes: shapes.map((s, k) => ({ index: k, ...s })), constraints: cons.map((c, k) => ({ index: k, ...c })), definition: (() => { try { const d = definedState(shapes, cons); return { state: d.state, free: d.free?.slice(0, 20), ...(d.dof !== undefined ? { degrees_of_freedom: d.dof } : {}), ...(d.redundant ? { redundant_constraints: d.redundant } : {}) }; } catch { return undefined; } })() } };
      });
    },
    delete_feature(user, a, H) {
      return edit('delete_feature', user, { ...a, keep_on_error: true }, H, async (doc) => {
        const i = findIndex(doc, a.feature);
        const [gone] = doc.features.splice(i, 1);
        return { touched: [], extra: { deleted: gone.name || gone.id } };
      });
    },
    move_feature(user, a, H) {
      return edit('move_feature', user, a, H, async (doc) => {
        const i = findIndex(doc, a.feature), to = Math.max(0, Math.min(doc.features.length - 1, a.position - 1));
        const [f] = doc.features.splice(i, 1);
        doc.features.splice(to, 0, stamp(f));
        return { touched: [f.id], extra: { moved: f.name, from: i + 1, to: to + 1 } };
      });
    },
    set_parameters(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        if (!Array.isArray(a.parameters) || !a.parameters.length) return fail('Pass at least one parameter.');
        const list = [...doc.params];
        if (list.length + a.parameters.length > 200) return fail('A design can have at most 200 parameters.');
        for (const p of a.parameters) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name || '')) return fail(`"${p.name}" is not a valid parameter name (letters, digits, underscore; not starting with a digit).`);
          const np = { name: p.name, expr: String(p.expr), unit: p.unit || 'length', comment: p.comment || '' };
          const i = list.findIndex((q) => q.name === p.name);
          if (i >= 0) list[i] = np; else list.push(np);
        }
        const before = H.evaluate(doc), sb = H.summarize(doc, before.result);
        doc.params = list;
        const ev = H.evaluate(doc);
        if (ev.paramErrors && Object.keys(ev.paramErrors).length) return richFail('A parameter does not evaluate.', Object.entries(ev.paramErrors).map(([name, message]) => ({ message: `${name}: ${message}`, hint: 'Use a number with an optional unit (40 mm), or an expression of other parameters. Names are case-sensitive.' })));
        const nrev = await save(user, a.design, obj, doc, rev, [], 'set_parameters');
        const sa = H.summarize(doc, ev.result);
        return text({ parameters: doc.params, revision: nrev, changes: delta(sb, sa), model: sa });
      });
    },
    async set_appearance(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        const { result } = H.evaluate(doc);
        const spec = { ...(a.material ? { material: a.material } : {}), ...(a.color ? { color: a.color } : {}), ...(a.texture ? { texture: a.texture, ...(a.texture_size_mm ? { texSize: a.texture_size_mm } : {}) } : {}) };
        if (a.color && !/^#[0-9a-f]{6}$/i.test(a.color)) return fail('color must look like #rrggbb.');
        if (a.material && !H.MATERIAL_IDS.includes(a.material)) return fail(`Unknown material "${a.material}". Materials: ${H.MATERIAL_IDS.join(', ')}.`);
        const any = Object.keys(spec).length > 0;
        if (!a.face && !a.bodies?.length) return fail('Say what to change: "bodies" (body ids) or "face" (a ref from find_faces).');
        if (a.face) {
          const f = a.face; bodyOf(result, f.body);
          if (!Array.isArray(f.point) || !Array.isArray(f.normal)) return fail('face needs body, point and normal (the ref from find_faces).');
          const list = doc.faceAppearance.filter((e) => !(e.body === f.body && !!e.curved === !!f.curved && Math.hypot(e.point[0] - f.point[0], e.point[1] - f.point[1], e.point[2] - f.point[2]) < 0.05));
          if (any) list.push({ body: f.body, point: f.point, normal: f.normal, ...(f.curved ? { curved: true } : {}), ...spec });
          doc.faceAppearance = list.slice(-500);
        } else {
          for (const id of a.bodies) bodyOf(result, id);
          const ap = { ...doc.appearance };
          for (const id of a.bodies) { if (any) ap[id] = spec; else delete ap[id]; }
          doc.appearance = ap;
        }
        const nrev = await save(user, a.design, obj, doc, rev, [], 'set_appearance');
        return text({ applied: any ? spec : 'cleared', to: a.face ? 'one face' : a.bodies, revision: nrev });
      });
    },
    async set_units(user, a) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        if (!UNITS.includes(a.units)) return fail(`units must be one of ${UNITS.join(', ')}.`);
        doc.units = a.units;
        const nrev = await save(user, a.design, obj, doc, rev, [], 'set_units');
        return text({ units: a.units, revision: nrev, note: 'Only the display units changed; the geometry and every tool still use millimetres.' });
      });
    },
    async undo_last_change(user, a, H) {
      const r = await d.storage.undo(user, a.design, d.device);
      if (!r) return fail('Nothing to undo: no earlier change of yours is kept for this design (only the most recent one is).');
      const { doc } = await load(user, a.design);
      return text({ undone: true, revision: r, model: H.summarize(doc, H.evaluate(doc).result) });
    },
    // ---------------------------------------------------------------- looking
    async inspect_design(user, a, H) {
      const { doc, rev } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      const model = H.summarize(doc, result);
      if (a.detail) {
        model.bodies = model.bodies.map((b) => { const body = result.bodies.find((x) => x.id === b.id); const q = H.queries; const mp = q.massProps(body, H.densityFor(doc, b.id)); const faces = q.listFaces(body), edges = q.listEdges(body); return { ...b, ...mp, faces: { planar: faces.filter((f) => f.kind === 'planar').length, curved: faces.filter((f) => f.kind === 'curved').length }, edges: edges.length }; });
      }
      return text({ name: doc.name, revision: rev, features: doc.features.length, model });
    },
    async render_view(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      let bodies = H.coloured(doc, result);
      if (a.bodies?.length) { for (const id of a.bodies) bodyOf(result, id); bodies = bodies.filter((b) => a.bodies.includes(b.id)); }
      if (!bodies.length) return fail('The design has no bodies to draw yet. Add a feature that makes one (extrude, a box, ...).');
      if (bodies.reduce((n, b) => n + b.tris.length / 3, 0) > 600000) return fail('This model has too many triangles to draw here (over 600,000). Draw fewer bodies with "bodies".');
      const tris = {};
      for (const f of a.highlight_faces || []) { const b = bodies.find((x) => x.id === f.body); if (!b) continue; const t = H.faceTrisOf(b, f); if (t) tris[b.id] = [...(tris[b.id] || []), ...t]; }
      const view = a.azimuth !== undefined || a.elevation !== undefined ? { azimuth: a.azimuth, elevation: a.elevation } : a.view;
      const secSpec = [a.section, ...(a.sections || []), a.section_box && { box: a.section_box }].filter(Boolean);
      let r;
      try { r = H.renderPNG(bodies, { view, width: a.width, height: a.height, perspective: a.perspective, zoom: a.zoom, section: secSpec.length ? secSpec : undefined, edges: a.edges, highlight: { bodies: a.highlight_bodies || [], tris } }); }
      catch (e) { return fail(e.message); }
      return { content: [{ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ design: doc.name, size: [r.width, r.height], bodies: bodies.map((b) => b.id), ...(secSpec.length ? { section: secSpec } : {}), camera: r.camera, axes: 'The small triad in the corner: red X, green Y, blue Z.' }) }] };
    },
    async find_faces(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      const body = bodyOf(result, a.body);
      let faces; try { faces = H.queries.findFaces(body, a.filter || {}); } catch (e) { return fail(e.message); }
      return text({ body: a.body, count: faces.length, faces, note: 'Pass a face\'s "ref" (point and normal) to a feature field of kind face / faces, or to set_appearance, measure or render_view.' });
    },
    async find_edges(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      const body = bodyOf(result, a.body);
      let edges; try { edges = H.queries.findEdges(body, a.filter || {}); } catch (e) { return fail(e.message); }
      return text({ body: a.body, count: edges.length, edges, note: 'For fillet or chamfer pass the matching "ref" values as params.edges (and params.body).' });
    },
    async measure(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      try { return text(H.queries.measure(result.bodies, a.a, a.b)); } catch (e) { return fail(e.message); }
    },
    async print_check(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      if (!result.bodies.length) return fail('The design has no bodies to check.');
      const bed = Array.isArray(a.bed) && a.bed.length === 3 && a.bed.every((v) => v > 0) ? a.bed : [256, 256, 256];
      const fit = H.printcheck.bedFit(result.bodies, bed), oh = H.printcheck.overhangs(result.bodies, a.overhang_angle ?? 45);
      const minWall = a.min_wall ?? 1.2;
      const wt = await H.printcheck.wallThickness(result.bodies, { minWall, maxSamples: 1200 });
      const thin = wt?.thin || [];
      const issues = [];
      if (!fit.fitsEach) issues.push(`${fit.tooBig.map((t) => `${t.name} is ${t.why}`).join('; ')}. Scale it, split it, or choose a bigger printer.`);
      if (oh.fraction > 0.15) issues.push(`${Math.round(oh.fraction * 100)}% of the surface overhangs more than ${a.overhang_angle ?? 45} degrees, so it needs supports (about ${Math.round(oh.supportVolume)} mm3 of support). Reorienting the part or adding chamfers instead of flat ceilings helps.`);
      if (thin.length) issues.push(`${thin.length} of ${wt.total} sampled points are thinner than ${minWall} mm (the thinnest is ${wt.min.toFixed(2)} mm). Thicken those walls.`);
      return text({
        verdict: issues.length ? 'Needs attention' : 'Looks printable',
        issues,
        fit: { bed, fits_each_body: fit.fitsEach, fits_on_one_plate: fit.fitsAll, plates_needed: fit.plates, too_big: fit.tooBig },
        overhangs: { angle_degrees: a.overhang_angle ?? 45, fraction_of_surface: +oh.fraction.toFixed(3), area_mm2: +oh.area.toFixed(1), worst_degrees: +(oh.worst || 0).toFixed(1), support_volume_mm3: Math.round(oh.supportVolume) },
        walls: { min_wall_mm: minWall, thinnest_mm: Number.isFinite(wt?.min) ? +wt.min.toFixed(3) : null, thin_points: thin.length, samples: wt?.total ?? 0, examples: thin.slice(0, 8).map((s) => ({ at: s.p.map((v) => +v.toFixed(2)), thickness_mm: +s.t.toFixed(3) })) },
      });
    },
    // ---------------------------------------------------------------- versions and files
    async save_version(user, a) {
      return withLock(user + '/' + a.design, async () => {
        const { obj } = await load(user, a.design);
        const r = await d.storage.saveVersion(user, a.design, obj, d.device, String(a.description || 'Saved by an assistant').slice(0, 200));
        return text({ saved: a.design, version: r.rev, description: a.description || 'Saved by an assistant' });
      });
    },
    async list_versions(user, a) {
      const v = await d.storage.versions(user, a.design);
      if (!v) return fail(`No design called "${a.design}".`);
      return text({ design: a.design, versions: v.map((x) => ({ version: x.rev, saved: new Date(x.modified).toISOString(), device: x.device || '', description: x.note || '', ...(x.milestone ? { milestone: x.milestone } : {}), ...(x.cur ? { latest: true } : {}) })) });
    },
    async compare_versions(user, a, H) {
      const read = async (rev) => { const o = rev === undefined ? (await d.storage.read(user, a.design))?.obj : await d.storage.readVersion(user, a.design, rev); if (!o) throw new Error(`Version ${rev ?? '(current)'} of "${a.design}" was not found. Call list_versions.`); return o; };
      const A = await read(a.from), B = await read(a.to);
      const fa = Object.fromEntries((A.features || []).map((f) => [f.id, f])), fb = Object.fromEntries((B.features || []).map((f) => [f.id, f]));
      const added = (B.features || []).filter((f) => !fa[f.id]).map((f) => `${f.name} (${f.type})`), removed = (A.features || []).filter((f) => !fb[f.id]).map((f) => `${f.name} (${f.type})`);
      const changed = (B.features || []).filter((f) => fa[f.id] && !same(fa[f.id].params, f.params)).map((f) => ({ feature: `${f.name} (${f.type})`, fields: Object.keys({ ...fa[f.id].params, ...f.params }).filter((k) => !same(fa[f.id].params[k], f.params[k])).slice(0, 12) }));
      const sum = (o) => { const doc = { features: o.features || [], params: o.params || [], units: o.units || 'mm', nextId: 1, appearance: o.appearance || {} }; return H.summarize(doc, H.evaluate(doc).result).bodies.map((b) => ({ id: b.id, name: b.name, volume_mm3: b.volume_mm3, size: b.size })); };
      return text({ from: a.from, to: a.to ?? 'current', features_added: added, features_removed: removed, features_changed: changed, parameters_changed: [...new Set([...(A.params || []), ...(B.params || [])].map((p) => p.name))].filter((n) => !same((A.params || []).find((p) => p.name === n)?.expr, (B.params || []).find((p) => p.name === n)?.expr)), bodies_before: sum(A), bodies_after: sum(B) });
    },
    async restore_version(user, a) {
      return withLock(user + '/' + a.design, async () => {
        const r = await d.storage.restoreVersion(user, a.design, a.version, d.device);
        return r ? text({ restored: a.version, new_version: r.rev }) : fail(`No version ${a.version} of "${a.design}". Call list_versions.`);
      });
    },
    async export_model(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      let bodies = H.coloured(doc, result);
      if (a.bodies?.length) { for (const id of a.bodies) bodyOf(result, id); bodies = bodies.filter((b) => a.bodies.includes(b.id)); }
      if (!bodies.length) return fail('The design has no bodies to export.');
      let out; try { out = await H.exportOf(a.format || 'stl', bodies, doc.name, doc, a.bodies?.length ? a.bodies : null); } catch (e) { return fail(e.message); }
      if (out.bytes.length > 12e6) return fail('The file is too large to return here (over 12 MB); export it from the Sketchy app instead.');
      return text({ filename: out.filename, mime: out.mime, bytes: out.bytes.length, triangles: bodies.reduce((n, b) => n + b.tris.length / 3, 0), ...(out.exact !== undefined ? { step_exact: out.exact } : {}), ...(out.note ? { note: out.note } : {}), base64: out.bytes.toString('base64') });
    },
    export_stl(user, a, H) { return tools.export_model(user, { ...a, format: 'stl' }, H); },
  };
  return tools;
}
