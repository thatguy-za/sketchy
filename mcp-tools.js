// MCP tool implementations (shared by the main thread and the worker threads). See mcp.js for the protocol side.

const locks = new Map();
const withLock = async (key, fn) => {
  const prev = locks.get(key) || Promise.resolve();
  let done; const next = new Promise((r) => (done = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { done(); if (locks.get(key) === next) locks.delete(key); }
};

export const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
export const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

/**
 * The tool implementations. `d` = { storage: {list, read, write}, device }. Heavy ones get H (the headless kernel) as their third argument.
 * Runs inside a worker thread (mcp-worker.js) for everything that rebuilds a design, and in the main thread for list/create.
 */
export function createTools(d) {
  const nameOk = (n) => typeof n === 'string' && /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.') && !['__proto__', 'constructor', 'prototype'].includes(n.toLowerCase());

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
        if (doc.features.length >= 500) return fail('This design already has 500 features, the most Sketchy will build through an assistant. Combine or delete some first.');
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
        if (list.length + a.parameters.length > 200) return fail('A design can have at most 200 parameters.');
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
  return tools;
}
