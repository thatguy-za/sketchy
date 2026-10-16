// MCP (Model Context Protocol) endpoint, Streamable HTTP transport, JSON responses only (no SSE stream).
// Lets an AI assistant (Claude, ChatGPT, anything MCP-capable) build designs inside one user's Sketchy account.
// Auth is a per-user bearer token (created on the Account page); every tool acts only on that user's designs.
// Zero dependencies; the modelling kernel (src/headless.js) is loaded lazily on first use.

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'sketchy', version: '0.0.2' };

const INSTRUCTIONS = `Sketchy is a parametric 3D CAD tool. You build a design as an ordered timeline of features (sketch, extrude, hole, fillet...), like Fusion 360. Everything is in millimetres.

Workflow: create_design (or list_designs / get_design) -> add_feature one step at a time -> inspect the result (every add_feature returns the bodies, sizes, volumes and any errors) -> fix with update_feature / delete_feature. Call describe_feature_types to see every feature kind with its parameters and defaults.

Coordinates: planes are XY (floor, Z up), XZ (front) and YZ (right). A sketch lives on one plane (params.plane, optionally params.offset along the plane normal). Sketch shapes (params.shapes, 2D coordinates in the sketch plane, mm):
- {"t":"rect","x":0,"y":0,"w":40,"h":20}  (x,y = lower-left corner)
- {"t":"circle","cx":0,"cy":0,"r":5}
- {"t":"rrect","x":0,"y":0,"w":40,"h":20,"r":3}  rounded rectangle
- {"t":"slot","x1":0,"y1":0,"x2":20,"y2":0,"w":6}
- {"t":"ellipse","cx":0,"cy":0,"rx":10,"ry":5,"rot":0}
- {"t":"ngon","cx":0,"cy":0,"r":10,"n":6,"rot":0}
- {"t":"path","pts":[[0,0],[10,0],[10,10]]}  closed polygon; pts may be [x,y,bulge] for arcs (bulge = tan(sweep/4)); add "open":true for an open path (used by sweep/rib/pattern)
Closed shapes nested inside another become holes. An extrude takes the sketch id (e.g. "f1") and a distance; op is new / join / cut / intersect / auto. Body ids look like "f3" (the feature that created them). Features that need picking edges or faces in the 3D view (fillet, chamfer, presspull...) cannot be placed from here yet; prefer primitives, sketches + extrude/revolve/sweep/loft, holes, patterns, mirror and boolean combine.

Parameters (set_parameters) are named values usable in expressions, e.g. width=40 mm then "width/2 + 3" in any numeric field via the feature's expressions.`;

const FEATURE_REF = { type: 'string', description: 'Feature id (e.g. "f3"), exact feature name, or "#3" for the 3rd feature in the timeline.' };
const DESIGN = { type: 'string', description: 'Design name exactly as shown in list_designs.' };

const TOOLS = [
  { name: 'list_designs', description: 'List the designs saved in this user\'s Sketchy account.', schema: { type: 'object', properties: {} }, ro: true },
  { name: 'create_design', description: 'Create a new empty design. Fails if the name is taken.', schema: { type: 'object', properties: { name: { type: 'string', description: 'Design name (letters, numbers, spaces, . _ ( ) -).' } }, required: ['name'] } },
  { name: 'get_design', description: 'Get a design: its timeline of features with all parameters, its named parameters, and the resulting bodies and errors.', schema: { type: 'object', properties: { design: DESIGN }, required: ['design'] }, ro: true },
  { name: 'describe_feature_types', description: 'Catalogue of feature kinds you can add (box, cylinder, sketch, extrude, revolve, hole, pattern, mirror, combine, ...) with their parameters, option lists and defaults. Pass kind to see just one.', schema: { type: 'object', properties: { kind: { type: 'string' } } }, ro: true },
  { name: 'add_feature', description: 'Append a feature to the timeline (or insert at position). Returns the updated bodies and any error. If the feature fails to build it is NOT saved (unless keep_on_error is true) and the error is returned so you can correct the parameters.', schema: { type: 'object', properties: { design: DESIGN, kind: { type: 'string', description: 'Feature kind from describe_feature_types, e.g. "sketch", "extrude", "box", "hole".' }, params: { type: 'object', description: 'Parameters overriding the defaults for this kind.' }, name: { type: 'string' }, position: { type: 'integer', description: '1-based timeline position to insert at; default is the end.' }, keep_on_error: { type: 'boolean' } }, required: ['design', 'kind'] } },
  { name: 'update_feature', description: 'Change parameters of an existing feature (shallow merge). Later features are rebuilt. The change is rejected, with the error, if it breaks the feature or anything after it (unless keep_on_error is true).', schema: { type: 'object', properties: { design: DESIGN, feature: FEATURE_REF, params: { type: 'object' }, name: { type: 'string' }, suppressed: { type: 'boolean', description: 'Temporarily disable the feature.' }, keep_on_error: { type: 'boolean' } }, required: ['design', 'feature'] } },
  { name: 'delete_feature', description: 'Remove a feature from the timeline. Features that depended on it will report errors in the result.', schema: { type: 'object', properties: { design: DESIGN, feature: FEATURE_REF }, required: ['design', 'feature'] } },
  { name: 'set_parameters', description: 'Create or update named design parameters (e.g. width = 40 mm) that feature fields can reference in expressions. Existing parameters with other names are kept.', schema: { type: 'object', properties: { design: DESIGN, parameters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, expr: { type: 'string', description: 'Expression, e.g. "40 mm" or "width/2".' }, unit: { type: 'string', enum: ['length', 'angle', 'number'] }, comment: { type: 'string' } }, required: ['name', 'expr'] } } }, required: ['design', 'parameters'] } },
  { name: 'inspect_design', description: 'Rebuild the design and report each body (volume, surface area, bounding box, size) and every feature error. Use after changes to verify the model.', schema: { type: 'object', properties: { design: DESIGN }, required: ['design'] }, ro: true },
  { name: 'export_stl', description: 'Export the design (or chosen bodies) as a binary STL file, returned base64-encoded, ready for slicing.', schema: { type: 'object', properties: { design: DESIGN, bodies: { type: 'array', items: { type: 'string' }, description: 'Body ids to include; default all.' } }, required: ['design'] }, ro: true },
];

const locks = new Map();
const withLock = async (key, fn) => {
  const prev = locks.get(key) || Promise.resolve();
  let done; const next = new Promise((r) => (done = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { done(); if (locks.get(key) === next) locks.delete(key); }
};

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

/**
 * @param {object} d  { storage: {list, read, write}, loadHeadless: () => Promise<module>, device: string }
 * @returns {(user: string, msg: object) => Promise<object|null>} JSON-RPC message handler
 */
export function createMcp(d) {
  const nameOk = (n) => typeof n === 'string' && /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.');

  const load = async (user, name) => {
    const r = await d.storage.read(user, name);
    if (!r) throw new Error(`No design called "${name}". Call list_designs to see what exists.`);
    const o = r.obj;
    return { obj: o, rev: r.rev, doc: { name: o.name || name, features: o.features || [], marker: (o.features || []).length, nextId: o.nextId || 1, params: o.params || [], appearance: o.appearance || {}, units: o.units || 'mm' } };
  };
  const save = (user, name, base, doc, rev) => d.storage.write(user, name, { ...base, format: 'sketchy', version: 1, name, features: doc.features, marker: doc.features.length, nextId: doc.nextId, params: doc.params, appearance: doc.appearance, units: doc.units }, d.device, rev);

  const findIndex = (doc, ref) => {
    const s = String(typeof ref === 'number' ? '#' + ref : ref);
    let i = /^#\d+$/.test(s) ? +s.slice(1) - 1 : doc.features.findIndex((f) => f.id === s);
    if (i < 0) i = doc.features.findIndex((f) => f.name === s);
    if (i < 0 || i >= doc.features.length) throw new Error(`No feature "${ref}". Call get_design to see the timeline.`);
    return i;
  };

  const tools = {
    async list_designs(user) {
      const l = await d.storage.list(user);
      return text(l.length ? l.map((x) => ({ name: x.name, revision: x.rev, modified: new Date(x.modified).toISOString() })) : 'No designs yet. Use create_design.');
    },
    async create_design(user, a) {
      if (!nameOk(a.name)) return fail('Invalid name. Use 1-80 letters, numbers, spaces or . _ ( ) -');
      if (await d.storage.read(user, a.name)) return fail(`A design called "${a.name}" already exists. Use get_design to open it.`);
      const doc = { name: a.name, features: [], marker: 0, nextId: 1, params: [], appearance: {}, units: 'mm' };
      await save(user, a.name, {}, doc, 0);
      return text({ created: a.name, hint: 'Add a sketch with add_feature kind "sketch", then an "extrude".' });
    },
    async get_design(user, a, H) {
      const { doc, rev } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      return text({ name: doc.name, revision: rev, parameters: doc.params, timeline: doc.features.map(H.describeFeature), model: H.summarize(doc, result) });
    },
    async describe_feature_types(user, a, H) {
      const c = H.catalog();
      if (a.kind) return c[a.kind] ? text({ kind: a.kind, ...c[a.kind] }) : fail(`Unknown kind "${a.kind}". Kinds: ${Object.keys(c).join(', ')}`);
      return text({ kinds: c });
    },
    async add_feature(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        const { result } = H.evaluate(doc);
        const f = H.makeFeature(doc, result, a.kind, a.params || {}, a.name);
        const pos = a.position ? Math.max(0, Math.min(doc.features.length, a.position - 1)) : doc.features.length;
        doc.features.splice(pos, 0, f);
        const ev = H.evaluate(doc);
        const err = ev.result.errors[f.id];
        if (err && !a.keep_on_error) return fail(`The ${a.kind} could not be built: ${err}\nNothing was saved. Adjust the parameters and try again.`);
        const nrev = await save(user, a.design, obj, doc, rev);
        return text({ added: H.describeFeature(f, pos), revision: nrev, ...(err ? { warning: err } : {}), model: H.summarize(doc, ev.result) });
      });
    },
    async update_feature(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        const before = H.evaluate(doc).result.errors;
        const i = findIndex(doc, a.feature);
        const f = doc.features[i];
        doc.features[i] = { ...f, ...(a.name ? { name: a.name } : {}), ...(typeof a.suppressed === 'boolean' ? { suppressed: a.suppressed } : {}), params: { ...f.params, ...(a.params || {}) } };
        if (a.params && f.exprs) { const ex = { ...f.exprs }; for (const k of Object.keys(a.params)) delete ex[k]; doc.features[i].exprs = Object.keys(ex).length ? ex : undefined; }
        const ev = H.evaluate(doc);
        const fresh = Object.entries(ev.result.errors).filter(([id, m]) => before[id] !== m);
        if (fresh.length && !a.keep_on_error) return fail(`That change breaks the model: ${fresh.map(([id, m]) => `${id}: ${m}`).join('; ')}\nNothing was saved.`);
        const nrev = await save(user, a.design, obj, doc, rev);
        return text({ updated: H.describeFeature(doc.features[i], i), revision: nrev, model: H.summarize(doc, ev.result) });
      });
    },
    async delete_feature(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        const i = findIndex(doc, a.feature);
        const [gone] = doc.features.splice(i, 1);
        const ev = H.evaluate(doc);
        const nrev = await save(user, a.design, obj, doc, rev);
        return text({ deleted: gone.name || gone.id, revision: nrev, model: H.summarize(doc, ev.result) });
      });
    },
    async set_parameters(user, a, H) {
      return withLock(user + '/' + a.design, async () => {
        const { obj, doc, rev } = await load(user, a.design);
        if (!Array.isArray(a.parameters) || !a.parameters.length) return fail('Pass at least one parameter.');
        const list = [...doc.params];
        for (const p of a.parameters) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name || '')) return fail(`"${p.name}" is not a valid parameter name (letters, digits, underscore; not starting with a digit).`);
          const np = { name: p.name, expr: String(p.expr), unit: p.unit || 'length', comment: p.comment || '' };
          const i = list.findIndex((q) => q.name === p.name);
          if (i >= 0) list[i] = np; else list.push(np);
        }
        doc.params = list;
        const ev = H.evaluate(doc);
        if (ev.paramErrors && Object.keys(ev.paramErrors).length) return fail(`Parameter problem: ${JSON.stringify(ev.paramErrors)}\nNothing was saved.`);
        const nrev = await save(user, a.design, obj, doc, rev);
        return text({ parameters: doc.params, revision: nrev, model: H.summarize(doc, ev.result) });
      });
    },
    async inspect_design(user, a, H) {
      const { doc, rev } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      return text({ name: doc.name, revision: rev, features: doc.features.length, model: H.summarize(doc, result) });
    },
    async export_stl(user, a, H) {
      const { doc } = await load(user, a.design);
      const { result } = H.evaluate(doc);
      const bodies = a.bodies?.length ? result.bodies.filter((b) => a.bodies.includes(b.id)) : result.bodies;
      if (!bodies.length) return fail('The design has no bodies to export.');
      const buf = Buffer.from(await H.stlOf(bodies, doc.name).arrayBuffer());
      if (buf.length > 12e6) return fail('The STL is too large to return here; export it from the Sketchy app instead.');
      return text({ filename: `${doc.name}.stl`, bytes: buf.length, triangles: bodies.reduce((n, b) => n + b.tris.length / 3, 0), base64: buf.toString('base64') });
    },
  };

  const rpc = async (user, m) => {
    const id = m.id;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const want = m.params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: !!t.ro, destructiveHint: t.name === 'delete_feature', openWorldHint: false } })) });
      case 'tools/call': {
        const fn = tools[m.params?.name];
        if (!fn) return err(-32602, `Unknown tool: ${m.params?.name}`);
        try {
          const H = ['list_designs', 'create_design'].includes(m.params.name) ? null : await d.loadHeadless();
          return ok(await fn(user, m.params.arguments || {}, H));
        } catch (e) { return ok(fail(e.message || String(e))); }
      }
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return err(-32601, `Method not found: ${m.method}`);
    }
  };

  /** Handle one JSON-RPC message or a batch. Returns the response body, or null when only notifications were sent. */
  return async (user, body) => {
    const one = async (m) => {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
      if (m.id === undefined || m.id === null) { return null; } // notification
      return rpc(user, m);
    };
    if (Array.isArray(body)) { const r = (await Promise.all(body.map(one))).filter(Boolean); return r.length ? r : null; }
    return one(body);
  };
}
