// MCP (Model Context Protocol) endpoint, Streamable HTTP transport, JSON responses only (no SSE stream).
// Lets an AI assistant (Claude, ChatGPT, anything MCP-capable) build designs inside one user's Sketchy account.
// Auth is a per-user bearer token in the Authorization header (created on the Account page); every tool acts only on that user's designs.
// Tools that rebuild a design run in worker threads (mcp-pool.js) so a heavy design can't stall the server.
import { createTools } from './mcp-tools.js';
import { validateArguments } from './mcp-validate.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'sketchy', version: '0.0.4' };

const INSTRUCTIONS = `Sketchy is a parametric 3D CAD tool. You build a design as an ordered timeline of features (sketch, extrude, hole, fillet...), like other parametric CAD tools. Everything is in millimetres.

Workflow: create_design (or list_designs / get_design) -> add_feature one step at a time -> inspect the result (every add_feature returns the bodies, sizes, volumes and any errors) -> fix with update_feature / delete_feature. Call describe_feature_types to see every feature kind with its parameters and defaults.

Coordinates: planes are XY (floor, Z up), XZ (front) and YZ (right). A sketch lives on one plane (params.plane, optionally params.offset along the plane normal). Sketch shapes (params.shapes, 2D coordinates in the sketch plane, mm):
- {"t":"rect","x":0,"y":0,"w":40,"h":20}  (x,y = lower-left corner)
- {"t":"circle","cx":0,"cy":0,"r":5}
- {"t":"rrect","x":0,"y":0,"w":40,"h":20,"r":3}  rounded rectangle
- {"t":"slot","x1":0,"y1":0,"x2":20,"y2":0,"w":6}
- {"t":"ellipse","cx":0,"cy":0,"rx":10,"ry":5,"rot":0}
- {"t":"ngon","cx":0,"cy":0,"r":10,"n":6,"rot":0}
- {"t":"path","pts":[[0,0],[10,0],[10,10]]}  closed polygon; pts may be [x,y,bulge] for arcs (bulge = tan(sweep/4)); add "open":true for an open path (used by sweep/rib/pattern)
Closed shapes nested inside another become holes. An extrude takes the sketch id (e.g. "f1") and a distance; op is new / join / cut / intersect / auto. Body ids look like "f3" (the feature that created them). Surface kinds (sextrude, srevolve, ssweep, sloft) make open surface bodies listed under surfaces in the results; join them with sstitch (a closed shell becomes a solid) or give them thickness with sthicken. The pipe kind makes a solid or hollow tube along an open path sketch. Features that need picking edges or faces in the 3D view (fillet, chamfer, presspull...) cannot be placed from here yet; prefer primitives, sketches + extrude/revolve/sweep/loft, holes, patterns, mirror and boolean combine.

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

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const LOCAL = new Set(['list_designs', 'create_design']); // cheap tools that never rebuild a design

/**
 * @param {object} d  { storage, pool, device }  pool.run(user, name, args, device) runs a tool in a worker thread with a time and memory limit
 * @returns {(user: string, msg: object, ctx?: {strike: (kind: string) => void}) => Promise<object|null>} JSON-RPC message handler
 */
export function createMcp(d) {
  const local = createTools({ storage: d.storage, device: d.device });
  const rpc = async (user, m, ctx) => {
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
        const tool = TOOLS.find((t) => t.name === m.params?.name);
        if (!tool) return err(-32602, `Unknown tool: ${String(m.params?.name).slice(0, 60)}`);
        const bad = validateArguments(tool.schema, m.params.arguments ?? {});
        if (bad) return ok(fail(`Invalid arguments: ${bad}`));
        try {
          if (LOCAL.has(tool.name)) return ok(await local[tool.name](user, m.params.arguments || {}, null));
          return ok(await d.pool.run(user, tool.name, m.params.arguments || {}, d.device));
        } catch (e) {
          if (e.kind && e.kind !== 'busy') ctx?.strike?.(e.kind); // timeout, memory or crash: counts against the token
          return ok(fail(e.kind ? e.message : e.message || String(e)));
        }
      }
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default: return err(-32601, `Method not found: ${String(m.method).slice(0, 60)}`);
    }
  };

  /** Handle one JSON-RPC message or a batch. Returns the response body, or null when only notifications were sent. */
  return async (user, body, ctx = {}) => {
    const one = async (m) => {
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
      if (m.id === undefined || m.id === null) { return null; } // notification
      return rpc(user, m, ctx);
    };
    if (Array.isArray(body)) {
      if (body.length > 20) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A batch can hold at most 20 messages.' } };
      const r = [];
      for (const m of body) { const x = await one(m); if (x) r.push(x); } // one after another, so a batch can't fan out into many parallel rebuilds
      return r.length ? r : null;
    }
    return one(body);
  };
}
