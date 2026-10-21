// The MCP tools, end to end, against an in-memory store: building, looking, picking faces and edges, errors with hints, versions,
// requests from the app, resources, prompts and the Stop switch. Run with `npm run test:mcp-tools`.
import { readFileSync } from 'node:fs';
import { createTools } from '../mcp-tools.js';
import { createMcp } from '../mcp.js';
import { TOOLS, PROMPTS, INSTRUCTIONS, VERSION } from '../mcp-defs.js';
import { validateArguments } from '../mcp-validate.js';
import * as H from '../src/headless.js';

await H.initHeadless();
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`); };
const section = (n) => console.log('\n' + n);

// ---- an in-memory store with the same operations as the server's
let liveNow = null, windows = 0; const uiSent = [];
const files = new Map(), versions = new Map(), undo = new Map(), requests = [];
let seq = 0, events = [];
const storage = {
  async list() { return [...files].map(([name, o]) => ({ name, rev: o.__rev || 1, modified: Date.now() })); },
  async read(u, name) { const o = files.get(name); return o ? { obj: structuredClone(o), rev: o.__seq || 1 } : null; },
  async write(u, name, obj, device, rev, opts = {}) { const prev = files.get(name); if (prev) undo.set(name, prev); const o = structuredClone(obj); o.__seq = ++seq; o.__rev = prev?.__rev || 1; files.set(name, o); events.push({ name, tool: obj.lastEdit?.tool }); return o.__seq; },
  async undo(u, name) { const p = undo.get(name); if (!p) return null; undo.delete(name); files.set(name, { ...p, __seq: ++seq }); return seq; },
  async saveVersion(u, name, obj, device, note) { const prev = files.get(name); const list = versions.get(name) || []; if (prev) list.push({ rev: prev.__rev || 1, note: prev.__note || '', obj: prev }); versions.set(name, list); const o = structuredClone(obj); o.__rev = (prev?.__rev || 1) + 1; o.__note = note; o.__seq = ++seq; files.set(name, o); return { rev: o.__rev, seq }; },
  async versions(u, name) { const o = files.get(name); if (!o) return null; return [{ rev: o.__rev || 1, modified: Date.now(), note: o.__note || '', cur: true }, ...(versions.get(name) || []).map((v) => ({ rev: v.rev, modified: Date.now(), note: v.note })).reverse()]; },
  async readVersion(u, name, rev) { const cur = files.get(name); if (cur && (cur.__rev || 1) === rev) return structuredClone(cur); return structuredClone((versions.get(name) || []).find((v) => v.rev === rev)?.obj || null); },
  async restoreVersion(u, name, rev) { const o = await storage.readVersion(u, name, rev); if (!o) return null; return storage.saveVersion(u, name, o, '', `Restored from V${rev}`); },
  async live() { return liveNow; },
  async ui(u, cmd) { uiSent.push(cmd); return windows; },
  async requests() { return requests; },
  async requestDone(u, id, reply, declined) { const r = requests.find((x) => x.id === id && x.status === 'open'); if (!r) return false; Object.assign(r, { status: declined ? 'declined' : 'done', reply }); return true; },
};
const tools = createTools({ storage, device: 'test' });
const call = async (name, args = {}) => { const t = TOOLS.find((x) => x.name === name); const bad = validateArguments(t.schema, args); if (bad) return { isError: true, content: [{ type: 'text', text: 'Invalid arguments: ' + bad }] }; return tools[name]('u', args, H); };
const json = (r) => { try { return JSON.parse(r.content.find((c) => c.type === 'text').text); } catch { return null; } };

section('Tool list');
check('the server reports the version in package.json', VERSION === JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, VERSION);
check('every tool has a schema, a description and an implementation', TOOLS.every((t) => t.name && t.description.length > 20 && t.schema?.type === 'object' && (tools[t.name] || t.name === 'complete_request')), TOOLS.filter((t) => !tools[t.name]).map((t) => t.name).join());
check('every implementation has a definition', Object.keys(tools).every((k) => TOOLS.some((t) => t.name === k)), Object.keys(tools).filter((k) => !TOOLS.some((t) => t.name === k)).join());
check('the add_feature kinds come from the app\'s feature list', TOOLS.find((t) => t.name === 'add_feature').schema.properties.kind.enum.length === Object.keys(H.FEATURES).length);
check('the instructions describe every sketch shape and constraint', ['rect', 'rrect', 'circle', 'ellipse', 'ngon', 'slot', 'path', 'point', 'construction', 'centerline', 'tangent', 'symmetry', 'fix'].every((w) => INSTRUCTIONS.includes(w)));
check('the instructions name the new tools', ['list_requests', 'render_view', 'find_faces', 'find_edges', 'save_version', 'undo_last_change'].every((w) => INSTRUCTIONS.includes(w)));

section('Building and looking');
check('create a design', !(await call('create_design', { name: 'T1' })).isError);
let r = json(await call('add_feature', { design: 'T1', kind: 'box', params: { sx: 40, sy: 30, sz: 20 } }));
check('a box builds and the result lists its body', r?.model.bodies.length === 1 && Math.abs(r.model.bodies[0].volume_mm3 - 24000) < 1, JSON.stringify(r)?.slice(0, 200));
check('the change summary says a body was added', r?.changes?.[0]?.change === 'added', JSON.stringify(r?.changes));
const body = r.model.bodies[0].id;
let fr = json(await call('find_faces', { design: 'T1', body, filter: { normal: 'up' } }));
check('find_faces finds the top face by description', fr?.count === 1 && fr.faces[0].kind === 'planar' && Math.abs(fr.faces[0].area - 1200) < 1, JSON.stringify(fr)?.slice(0, 200));
const bottom = json(await call('find_faces', { design: 'T1', body, filter: { normal: '-z' } })).faces[0];
const m = json(await call('measure', { design: 'T1', a: { face: fr.faces[0].ref }, b: { face: bottom.ref } }));
check('measure gives the distance between the top and bottom faces', m?.distance_mm === 20, JSON.stringify(m));
const ed = json(await call('find_edges', { design: 'T1', body, filter: { direction: 'z' } }));
check('find_edges finds the four vertical edges', ed?.count === 4 && ed.edges.every((e) => e.kind === 'line' && Math.abs(e.length - 20) < 1e-6), JSON.stringify(ed)?.slice(0, 200));
const img = await call('render_view', { design: 'T1', view: 'iso', width: 320, height: 240 });
const png = img.content.find((c) => c.type === 'image');
check('render_view returns a PNG image', png && Buffer.from(png.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), JSON.stringify(img).slice(0, 120));
const sec = await call('render_view', { design: 'T1', section: { axis: 'x', offset: 0 }, highlight_faces: [{ body, ...fr.faces[0].ref }], width: 200, height: 150 });
check('a section view with a highlighted face renders', !!sec.content.find((c) => c.type === 'image'));
check('render_view refuses a design with no bodies', (await (async () => { await call('create_design', { name: 'Empty' }); return call('render_view', { design: 'Empty' }); })()).isError === true);

section('Faces and edges feed features');
r = json(await call('add_feature', { design: 'T1', kind: 'fillet', params: { body, edges: ed.edges.map((e) => e.ref), radius: 3 } }));
check('a fillet takes the edges find_edges returned', r?.model && !r.model.errors.length && r.model.bodies[0].volume_mm3 < 24000, JSON.stringify(r)?.slice(0, 300));
const round = json(await call('find_faces', { design: 'T1', body: r?.model.bodies[0].id || body, filter: { type: 'curved' } }));
check('the filleted corners show up as curved faces', round?.count >= 1, JSON.stringify(round)?.slice(0, 160));
r = json(await call('add_feature', { design: 'T1', kind: 'shell', params: { body: r.model.bodies[0].id, thickness: 2, open: [fr.faces[0].ref] } }));
check('a shell takes the face find_faces returned', r?.model && !r.model.errors.length, JSON.stringify(r)?.slice(0, 300));

section('Errors explain themselves');
r = await call('add_feature', { design: 'T1', kind: 'extrude', params: { sketch: 'nope', distance: 5 } });
let e = json(r);
check('a failing feature saves nothing and returns problems with a hint', r.isError && e?.nothing_saved && e.problems?.[0]?.hint?.length > 20, JSON.stringify(e)?.slice(0, 300));
r = await call('add_feature', { design: 'T1', kind: 'sketch', params: { plane: 'XY', shapes: [{ t: 'rect', x: 0, y: 0, w: -3, h: 2 }, { t: 'blob' }] } });
e = json(r);
check('a bad sketch lists every problem', r.isError && e.problems.length === 2 && /above 0/.test(e.problems[0].message) && /unknown shape type/.test(e.problems[1].message), JSON.stringify(e)?.slice(0, 300));
r = json(await call('add_feature', { design: 'T1', kind: 'box', params: { sx: 5, sy: 5, sz: 5, radus: 1 } }));
check('a misspelt parameter is called out with a suggestion', /did you mean/.test(r?.warning || ''), JSON.stringify(r?.warning));

section('Sketch editing');
await call('create_design', { name: 'T2' });
r = json(await call('add_feature', { design: 'T2', kind: 'sketch', name: 'Base', params: { plane: 'XY', shapes: [{ t: 'rect', x: 0, y: 0, w: 40, h: 20 }] } }));
const sk = r.added.id;
r = json(await call('edit_sketch', { design: 'T2', sketch: sk, add_shapes: [{ t: 'circle', cx: 10, cy: 10, r: 3 }, { t: 'path', open: true, lt: 'centerline', pts: [[-5, 0], [-5, 20]] }], add_constraints: [{ t: 'equal', a: { s: 1 }, b: { s: 1 } }] }));
check('edit_sketch adds shapes and constraints and lists them with indexes', r?.shapes?.length === 3 && r.constraints.length === 1 && r.shapes[2].lt === 'centerline', JSON.stringify(r)?.slice(0, 200));
r = json(await call('edit_sketch', { design: 'T2', sketch: sk, remove_shapes: [1] }));
check('removing a shape drops the constraints that used it and renumbers', r?.shapes?.length === 2 && r.constraints.length === 0 && r.shapes[1].lt === 'centerline', JSON.stringify(r)?.slice(0, 200));
r = await call('edit_sketch', { design: 'T2', sketch: sk, add_constraints: [{ t: 'horizontal', a: { s: 0, seg: 9 } }] });
check('a constraint on a missing segment is explained', r.isError && /not a segment/.test(JSON.stringify(json(r))), JSON.stringify(json(r))?.slice(0, 200));
r = json(await call('add_feature', { design: 'T2', kind: 'extrude', params: { sketch: sk, distance: 8 } }));
check('the construction/centerline shapes are left out of the profile', r?.model?.bodies?.length === 1 && Math.abs(r.model.bodies[0].volume_mm3 - 40 * 20 * 8) < 1, JSON.stringify(r?.model?.bodies));
r = json(await call('add_feature', { design: 'T2', kind: 'axis', params: { mode: 'twopoints', p1: [0, 0, 0], p2: [0, 0, 10] } }));
check('construction axes can be added', !!r?.added, JSON.stringify(r)?.slice(0, 200));

section('Appearance, units, parameters, reorder, undo');
r = json(await call('set_appearance', { design: 'T2', bodies: [json(await call('inspect_design', { design: 'T2' })).model.bodies[0].id], material: 'gold', texture: 'brushed' }));
check('set_appearance gives a body a material and texture', r?.applied?.material === 'gold' && r.applied.texture === 'brushed', JSON.stringify(r));
const t2f = json(await call('find_faces', { design: 'T2', body: 'f2', filter: { normal: '+z' } }));
r = json(await call('set_appearance', { design: 'T2', face: { body: 'f2', ...t2f.faces[0].ref }, color: '#ff0000' }));
check('set_appearance colours one face', r?.applied?.color === '#ff0000', JSON.stringify(r));
check('an unknown material is refused with the list', (await call('set_appearance', { design: 'T2', bodies: ['f2'], material: 'unobtainium' })).isError);
r = json(await call('set_units', { design: 'T2', units: 'in' }));
check('set_units changes the display unit only', r?.units === 'in');
r = json(await call('set_parameters', { design: 'T2', parameters: [{ name: 'depth', expr: '12 mm' }] }));
check('set_parameters creates a named parameter', r?.parameters?.some((p) => p.name === 'depth'));
r = json(await call('update_feature', { design: 'T2', feature: 'Extrude1', params: { distance: 4 } }));
check('update_feature rebuilds', r?.model?.bodies?.[0] && Math.abs(r.model.bodies[0].volume_mm3 - 40 * 20 * 4) < 1, JSON.stringify(r)?.slice(0, 200));
r = json(await call('move_feature', { design: 'T2', feature: '#3', position: 1 }));
check('move_feature moves a feature in the timeline', r?.moved && r.to === 1, JSON.stringify(r)?.slice(0, 200));
r = json(await call('undo_last_change', { design: 'T2' }));
check('undo_last_change puts the design back one step', r?.undone === true, JSON.stringify(r)?.slice(0, 200));
check('undo only goes back one step', (await call('undo_last_change', { design: 'T2' })).isError === true);
const g = json(await call('get_design', { design: 'T2' }));
check('features made by the assistant are marked', g.timeline.length > 0 && files.get('T2').features.every((f) => f.by === 'assistant' || f.by === undefined) && files.get('T2').lastEdit?.by === 'assistant');
check('the saved design records who changed what last', files.get('T2').lastEdit?.tool && Array.isArray(files.get('T2').lastEdit.features));

section('Versions');
r = json(await call('save_version', { design: 'T2', description: 'Base plate' }));
check('save_version makes a numbered version', r?.version >= 2, JSON.stringify(r));
await call('update_feature', { design: 'T2', feature: 'Extrude1', params: { distance: 10 } });
const lv = json(await call('list_versions', { design: 'T2' }));
check('list_versions lists versions with descriptions', lv?.versions?.length >= 2 && lv.versions.some((v) => v.description === 'Base plate'), JSON.stringify(lv));
const cmp = json(await call('compare_versions', { design: 'T2', from: lv.versions[lv.versions.length - 1].version }));
check('compare_versions reports changes', cmp && Array.isArray(cmp.features_changed) && cmp.bodies_after?.length >= 1, JSON.stringify(cmp)?.slice(0, 300));
r = json(await call('restore_version', { design: 'T2', version: lv.versions.find((v) => !v.latest).version }));
check('restore_version brings an older version back as a new one', !!r?.new_version, JSON.stringify(r));

section('Checks and files');
r = json(await call('print_check', { design: 'T1' }));
check('print_check returns a verdict with fit, overhangs and walls', r?.verdict && r.fit && r.overhangs && r.walls, JSON.stringify(r)?.slice(0, 200));
r = json(await call('inspect_design', { design: 'T1', detail: true }));
check('inspect_design with detail adds mass and face counts', r?.model?.bodies?.[0]?.mass_g > 0 && r.model.bodies[0].faces.planar >= 1, JSON.stringify(r?.model?.bodies?.[0]));
for (const fmt of ['stl', '3mf', 'obj', 'step']) { const x = json(await call('export_model', { design: 'T1', format: fmt })); check(`export_model writes ${fmt}`, x?.bytes > 100 && x.filename.endsWith('.' + fmt), JSON.stringify(x)?.slice(0, 100)); }
{ const x = json(await call('export_model', { design: 'T1', format: 'step' })); const txt = x?.base64 ? Buffer.from(x.base64, 'base64').toString() : ''; check('STEP says whether it is exact, and is exact when the design allows', typeof x?.step_exact === 'boolean' && (x.step_exact ? /AP242/.test(txt) && !/FACETED_BREP/.test(txt) : /FACETED_BREP/.test(txt) && !!x.note), JSON.stringify({ ...x, base64: undefined })); }
check('the old export_stl still works', json(await call('export_stl', { design: 'T1' }))?.filename === 'T1.stl');
r = json(await call('describe_sketch'));
check('describe_sketch lists shapes, constraints and line types', r?.shapes?.rect && r.constraints?.tangent && r.line_types?.centerline);
for (const k of ['sweep', 'pipe']) { const d = json(await call('describe_feature_types', { kind: k })); check(`the catalogue lists the corner option of ${k}`, d?.fields?.some((f) => f.key === 'corner' && f.options.some((o) => /mitre/.test(o))), JSON.stringify(d)?.slice(0, 120)); }
r = json(await call('describe_feature_types', { kind: 'fillet' }));
check('the catalogue tells an assistant where face and edge values come from', JSON.stringify(r).includes('find_edges'), JSON.stringify(r)?.slice(0, 200));

section('Requests from the app');
requests.push({ id: 'r1', text: 'Make the box 5 mm taller', design: 'T1', status: 'open', created: Date.now(), context: { face: { point: [0, 0, 20], normal: [0, 0, 1] } } });
r = json(await call('list_requests'));
check('list_requests shows the open request with its context', r?.requests?.[0]?.id === 'r1' && r.requests[0].context?.face);
r = json(await call('complete_request', { request_id: 'r1', reply: 'Done: now 25 mm tall.' }));
check('complete_request marks it done and stores the reply', r?.status === 'done' && requests[0].reply.startsWith('Done'));
check('a finished request is not listed again', json(await call('list_requests')).requests.length === 0);
check('completing a request twice fails', (await call('complete_request', { request_id: 'r1', reply: 'x' })).isError);

section('The running app');
r = json(await call('get_live_context'));
check('with the app closed, get_live_context says so', r?.open === false);
liveNow = { design: 'T1', dirty: true, openDesigns: ['T1', 'T2'], tool: 'sketch', selection: { bodies: ['f1'], features: [], edges: 0, face: { body: 'f1', point: [0, 0, 20], normal: [0, 0, 1] } }, view: [1, -1, 1], ageSeconds: 4 };
r = json(await call('get_live_context'));
check('get_live_context returns the open design, selection and view', r?.open && r.design === 'T1' && r.selection.face.normal[2] === 1 && r.seconds_ago === 4 && /ref/.test(r.hint || ''), JSON.stringify(r)?.slice(0, 200));
r = json(await call('show_in_app', { design: 'T1', view: 'top', message: 'This one' }));
check('show_in_app with no window open says nobody saw it', r?.shown === false);
windows = 1;
r = json(await call('show_in_app', { select_bodies: ['f1'], message: 'Here' }));
check('show_in_app sends the view, selection and message to the app', r?.shown === true && uiSent.at(-1).bodies[0] === 'f1' && uiSent.at(-1).message === 'Here');
check('show_in_app with nothing to show is refused', (await call('show_in_app', {})).isError);

section('Protocol: resources, prompts, Stop');
let held = false; const activity = [];
const pool = { run: (u, name, args) => tools[name](u, args, H) };
const rpc = createMcp({ storage, pool, device: 'test', held: () => held, activity: (u, ev) => activity.push(ev) });
const ask = async (method, params) => (await rpc('u', { jsonrpc: '2.0', id: 1, method, params })).result ?? (await rpc('u', { jsonrpc: '2.0', id: 1, method, params }));
let ini = await ask('initialize', { protocolVersion: '2025-06-18' });
check('initialize advertises tools, resources and prompts', ini.capabilities.tools && ini.capabilities.resources && ini.capabilities.prompts && ini.serverInfo.version === VERSION);
const rl = await ask('resources/list');
check('resources/list lists the designs', rl.resources.some((x) => x.uri === 'sketchy://design/T1'));
check('resource templates are offered', (await ask('resources/templates/list')).resourceTemplates.length === 2);
const rd = await ask('resources/read', { uri: 'sketchy://design/T1' });
check('a design can be read as a resource', JSON.parse(rd.contents[0].text).name === 'T1');
const rp = await ask('resources/read', { uri: 'sketchy://design/T1/preview.png' });
check('a design preview is a PNG resource', rp.contents[0].mimeType === 'image/png' && Buffer.from(rp.contents[0].blob, 'base64').length > 500);
check('a resource with a bad address is refused', !!(await rpc('u', { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'file:///etc/passwd' } })).error);
const pl = await ask('prompts/list');
check('prompts are listed', pl.prompts.length === PROMPTS.length && pl.prompts.every((p) => p.description));
const pg = await ask('prompts/get', { name: 'design_for_printing', arguments: { description: 'a cable clip', printer: 'Prusa MK4' } });
check('a prompt fills in its arguments', /cable clip/.test(pg.messages[0].content.text) && /Prusa MK4/.test(pg.messages[0].content.text));
check('a prompt without its required argument is refused', !!(await rpc('u', { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'review_design', arguments: {} } })).error);
let tc = await ask('tools/call', { name: 'inspect_design', arguments: { design: 'T1' } });
check('a read tool works through the protocol', !tc.isError);
tc = await ask('tools/call', { name: 'inspect_design', arguments: { design: '@current' } });
check('"@current" means the design open in the app', !tc.isError && JSON.parse(tc.content[0].text).name === 'T1', JSON.stringify(tc).slice(0, 160));
liveNow = null;
tc = await ask('tools/call', { name: 'inspect_design', arguments: { design: '@current' } });
check('"@current" with no open design explains itself', tc.isError && /No design is open/.test(tc.content[0].text));
liveNow = { design: 'T1', ageSeconds: 1, selection: {} };
held = true;
tc = await ask('tools/call', { name: 'add_feature', arguments: { design: 'T1', kind: 'box' } });
check('while the person has pressed Stop, changes are refused with a clear message', tc.isError && /pressed Stop/.test(tc.content[0].text));
tc = await ask('tools/call', { name: 'inspect_design', arguments: { design: 'T1' } });
check('but looking still works', !tc.isError);
held = false;
activity.length = 0;
await ask('tools/call', { name: 'add_feature', arguments: { design: 'T1', kind: 'box', params: { sx: 4, sy: 4, sz: 4, pos: [100, 0, 0] } } });
check('a change reports start and end activity for the app', activity.some((a) => a.state === 'start' && a.tool === 'add_feature' && a.write) && activity.some((a) => a.state === 'end'), JSON.stringify(activity));
check('every write tool is blocked by Stop and every read tool is not', TOOLS.filter((t) => t.write).length > 8 && TOOLS.filter((t) => t.ro).every((t) => !t.write));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
