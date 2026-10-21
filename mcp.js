// MCP (Model Context Protocol) endpoint, Streamable HTTP transport, JSON responses only (no SSE stream).
// Lets an AI assistant (Claude, ChatGPT, anything MCP-capable) build designs inside one user's Sketchy account.
// Auth is a per-user bearer token in the Authorization header (created on the Account page); every tool acts only on that user's designs.
// Tools that rebuild a design run in worker threads (mcp-pool.js) so a heavy design can't stall the server.
import { createTools } from './mcp-tools.js';
import { validateArguments } from './mcp-validate.js';
import { TOOLS, PROMPTS, INSTRUCTIONS, VERSION } from './mcp-defs.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'sketchy', version: VERSION };
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const LOCAL = new Set(TOOLS.filter((t) => t.local).map((t) => t.name)); // cheap tools that never rebuild a design
const URI = /^sketchy:\/\/design\/([^/]{1,80})(\/preview\.png)?$/;

/**
 * @param {object} d  { storage, pool, device, activity?, held? }  pool.run(user, name, args, device) runs a tool in a worker thread with a time and memory limit;
 *   activity(user, {state, tool, design, write}) tells the app what an assistant is doing; held(user) says the person pressed Stop
 * @returns {(user: string, msg: object, ctx?: {strike: (kind: string) => void}) => Promise<object|null>} JSON-RPC message handler
 */
export function createMcp(d) {
  const local = createTools({ storage: d.storage, device: d.device });
  /** Run one tool: in this thread for the cheap ones, in a worker for the rest. Tells the app what is going on while it runs. */
  const runTool = async (user, tool, args, ctx = {}) => {
    if (args.design === '@current') { // the design the person has open
      const live = await d.storage.live(user);
      if (!live?.design) return fail('No design is open in Sketchy right now, so "@current" means nothing. Use list_designs and the design\'s name.');
      args = { ...args, design: live.design };
    }
    const note = (state) => { try { d.activity?.(user, { state, tool: tool.name, design: args.design || '', write: !!tool.write }); } catch { /* the app being unreachable must not break a tool */ } };
    if (tool.write && d.held?.(user)) return fail('The person using Sketchy pressed Stop, so changes are paused. Do not retry. Tell them what you were about to do and ask them to press Resume in Sketchy (or tell you to carry on). Looking (get_design, render_view, find_faces) still works.');
    if (!LOCAL.has(tool.name) || tool.write) note('start');
    try {
      return LOCAL.has(tool.name) ? await local[tool.name](user, args, null) : await d.pool.run(user, tool.name, args, d.device);
    } finally { if (!LOCAL.has(tool.name) || tool.write) note('end'); }
  };
  const rpc = async (user, m, ctx) => {
    const id = m.id;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const want = m.params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: !!t.ro, destructiveHint: t.name === 'delete_feature' || t.name === 'restore_version', idempotentHint: !!t.ro, openWorldHint: false } })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === m.params?.name);
        if (!tool) return err(-32602, `Unknown tool: ${String(m.params?.name).slice(0, 60)}`);
        const bad = validateArguments(tool.schema, m.params.arguments ?? {});
        if (bad) return ok(fail(`Invalid arguments: ${bad}`));
        try {
          return ok(await runTool(user, tool, m.params.arguments || {}, ctx));
        } catch (e) {
          if (e.kind && e.kind !== 'busy') ctx?.strike?.(e.kind); // timeout, memory or crash: counts against the token
          return ok(fail(e.kind ? e.message : e.message || String(e)));
        }
      }
      case 'resources/list': {
        const l = await d.storage.list(user);
        return ok({ resources: l.slice(0, 200).map((x) => ({ uri: `sketchy://design/${x.name}`, name: x.name, description: `Sketchy design, revision ${x.rev}: timeline, parameters and model summary as JSON.`, mimeType: 'application/json' })) });
      }
      case 'resources/templates/list':
        return ok({ resourceTemplates: [
          { uriTemplate: 'sketchy://design/{name}', name: 'Design', description: 'A design as JSON: its timeline of features, parameters, units, appearance and the bodies it builds, with errors.', mimeType: 'application/json' },
          { uriTemplate: 'sketchy://design/{name}/preview.png', name: 'Design preview', description: 'A picture of the design from the front right above.', mimeType: 'image/png' },
        ] });
      case 'resources/read': {
        const mt = URI.exec(String(m.params?.uri || ''));
        if (!mt) return err(-32602, 'Unknown resource. Use sketchy://design/{name} or sketchy://design/{name}/preview.png');
        const design = mt[1];
        try {
          if (mt[2]) { // the preview
            const r = await runTool(user, TOOLS.find((t) => t.name === 'render_view'), { design }, ctx);
            const img = r.content?.find((c) => c.type === 'image');
            return img ? ok({ contents: [{ uri: m.params.uri, mimeType: 'image/png', blob: img.data }] }) : err(-32002, r.content?.[0]?.text || 'Nothing to draw yet.');
          }
          const r = await runTool(user, TOOLS.find((t) => t.name === 'get_design'), { design }, ctx);
          if (r.isError) return err(-32002, r.content?.[0]?.text || 'Design not found');
          return ok({ contents: [{ uri: m.params.uri, mimeType: 'application/json', text: r.content[0].text }] });
        } catch (e) { return err(-32002, e.message || String(e)); }
      }
      case 'prompts/list':
        return ok({ prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })) });
      case 'prompts/get': {
        const p = PROMPTS.find((x) => x.name === m.params?.name);
        if (!p) return err(-32602, `Unknown prompt: ${String(m.params?.name).slice(0, 60)}`);
        const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
        for (const a of p.arguments) if (a.required && !String(args[a.name] ?? '').trim()) return err(-32602, `Missing argument: ${a.name}`);
        const clean = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v).slice(0, 500)]));
        return ok({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(clean) } }] });
      }
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
