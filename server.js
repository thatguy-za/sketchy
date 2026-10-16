// Zero-dependency server: static files + accounts (with admin) + per-user project storage with revisions and drafts.
//
// CLI (run inside the container: docker exec <name> node server.js ...):
//   node server.js list-users
//   node server.js reset-password <user> [new-password]   (generates one if omitted)
//   node server.js make-admin <user>
import { createMcp } from './mcp.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const port = +process.env.PORT || 8080;
const MAX_VERSIONS = Math.max(0, parseInt(process.env.MAX_VERSIONS ?? '20', 10) || 0); // old revisions kept per design
const SESSION_MS = 365 * 24 * 3600 * 1000; // sliding: renewed whenever the app is opened, so active users stay signed in
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const settingsFile = path.join(dataDir, 'settings.json');
await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true });
await fs.mkdir(path.join(dataDir, 'drafts'), { recursive: true });

const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const writeJSON = async (f, v) => { const t = f + '.tmp'; await fs.writeFile(t, JSON.stringify(v), { mode: 0o600 }); await fs.rename(t, f); };
let users = await readJSON(usersFile, {});       // username -> {id, salt, hash, created, lastLogin, admin}
let sessions = await readJSON(sessionsFile, {}); // sha256(token) -> {user, exp}
let settings = await readJSON(settingsFile, {});
if (settings.allowRegistration === undefined) settings.allowRegistration = process.env.ALLOW_REGISTRATION !== 'false';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const saveUsers = () => writeJSON(usersFile, users);
const saveSessions = () => writeJSON(sessionsFile, sessions);
const saveSettings = () => writeJSON(settingsFile, settings);
const newHash = async (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scrypt(pw, salt) }; };

// the earliest account becomes admin when none exists (upgrade path from older versions)
if (Object.keys(users).length && !Object.values(users).some((u) => u.admin)) {
  const first = Object.entries(users).sort((a, b) => a[1].created - b[1].created)[0];
  first[1].admin = true; await saveUsers();
}

// ---------------------------------------------------------------- CLI
const [, , cmd, ...args] = process.argv;
if (cmd) {
  const killSessions = (u) => { for (const [k, v] of Object.entries(sessions)) if (v.user === u) delete sessions[k]; };
  if (cmd === 'list-users') {
    for (const [n, u] of Object.entries(users)) console.log(`${n}${u.admin ? '  (admin)' : ''}  created ${new Date(u.created).toISOString().slice(0, 10)}`);
  } else if (cmd === 'reset-password' && args[0]) {
    const u = users[args[0].toLowerCase()];
    if (!u) { console.error('No such user.'); process.exit(1); }
    const pw = args[1] || crypto.randomBytes(9).toString('base64url');
    if (pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
    Object.assign(u, await newHash(pw));
    killSessions(args[0].toLowerCase());
    await saveUsers(); await saveSessions();
    console.log(`Password for ${args[0]} is now: ${pw}`);
  } else if (cmd === 'make-admin' && args[0]) {
    const u = users[args[0].toLowerCase()];
    if (!u) { console.error('No such user.'); process.exit(1); }
    u.admin = true; await saveUsers(); console.log(`${args[0]} is now an admin.`);
  } else { console.error('Usage: node server.js list-users | reset-password <user> [pw] | make-admin <user>'); process.exit(1); }
  process.exit(0);
}

// ---------------------------------------------------------------- helpers
const send = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const readBody = async (req, max = 200e6) => {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
};
const readJSONBody = async (req, max = 8192) => { try { return JSON.parse((await readBody(req, max)).toString()); } catch { return null; } };
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));

// naive per-IP throttle for login/register/password
const attempts = new Map();
const throttled = (ip) => {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 20;
};
const noteAttempt = (ip) => { if (!attempts.has(ip)) attempts.set(ip, []); attempts.get(ip).push(Date.now()); };

const tokenOf = (req) => parseCookies(req.headers.cookie).sketchy_session;
function currentUser(req) {
  const tok = tokenOf(req);
  if (!tok) return null;
  const s = sessions[sha(tok)];
  if (!s || s.exp < Date.now() || !users[s.user]) return null;
  return s.user;
}
const secure = (req) => (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '');
/** Starts a session and remembers it in a long-lived HttpOnly cookie; a plain "known visitor" cookie tells the UI to show login (not sign-up) after a sign-out. */
function setSession(req, res, username, tok = crypto.randomBytes(32).toString('hex')) {
  sessions[sha(tok)] = { user: username, exp: Date.now() + SESSION_MS };
  for (const [k, v] of Object.entries(sessions)) if (v.exp < Date.now()) delete sessions[k];
  saveSessions();
  res.setHeader('set-cookie', [
    `sketchy_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure(req)}`,
    `sketchy_known=1; SameSite=Strict; Path=/; Max-Age=${10 * 365 * 24 * 3600}${secure(req)}`,
  ]);
}
const dropSessions = (username, exceptTok) => { for (const [k, v] of Object.entries(sessions)) if (v.user === username && k !== (exceptTok && sha(exceptTok))) delete sessions[k]; };

const userRe = /^[a-z0-9_-]{3,32}$/;
const nameOk = (n) => /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.');
const pwOk = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const dirs = (u) => ({ proj: path.join(dataDir, 'projects', users[u].id), draft: path.join(dataDir, 'drafts', users[u].id) });

async function readMeta(dir, name) {
  const m = await readJSON(path.join(dir, name + '.meta'), null);
  if (m) return m;
  const rev = parseInt(await fs.readFile(path.join(dir, name + '.ver'), 'utf8').catch(() => '0'), 10) || 0; // legacy
  return { rev, modified: 0, device: '' };
}

const verDir = (D, name) => path.join(D.proj, '.versions', name);
async function snapshotVersion(D, name, cur) { // keep the file about to be overwritten
  if (!MAX_VERSIONS) return;
  const dir = verDir(D, name), src = path.join(D.proj, name + '.json');
  const st = await fs.stat(src).catch(() => null);
  if (!st) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(src, path.join(dir, `${cur.rev || 1}.json`));
  await writeJSON(path.join(dir, `${cur.rev || 1}.meta`), { rev: cur.rev || 1, modified: cur.modified || st.mtimeMs, device: cur.device || '', size: st.size });
  const revs = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => parseInt(f, 10)).sort((a, b) => b - a);
  for (const r of revs.slice(MAX_VERSIONS)) for (const e of ['.json', '.meta']) await fs.rm(path.join(dir, r + e), { force: true });
}

// ---------------------------------------------------------------- project storage (shared by the REST API and MCP)
class Conflict extends Error { constructor(rev) { super('conflict'); this.rev = rev; } }
/** Write a design with revision bookkeeping and version history. ifRev: undefined/'*' = no check. */
async function writeProject(username, name, objStr, device, ifRev) {
  const D = dirs(username), file = path.join(D.proj, name + '.json');
  await fs.mkdir(D.proj, { recursive: true }); await fs.mkdir(D.draft, { recursive: true });
  const exists = await fs.stat(file).catch(() => null);
  const cur = await readMeta(D.proj, name);
  if (exists && ifRev !== undefined && ifRev !== '*' && +ifRev !== cur.rev) throw Object.assign(new Conflict(cur.rev), { modified: exists.mtimeMs, device: cur.device || '' });
  const rev = (cur.rev || 0) + 1;
  if (exists) await snapshotVersion(D, name, { ...cur, modified: cur.modified || exists.mtimeMs });
  await fs.writeFile(file, objStr);
  await writeJSON(path.join(D.proj, name + '.meta'), { rev, modified: Date.now(), device });
  await fs.writeFile(path.join(D.proj, name + '.ver'), String(rev));
  await fs.rm(path.join(D.draft, name + '.json'), { force: true }); await fs.rm(path.join(D.draft, name + '.meta'), { force: true });
  return rev;
}
const mcpStorage = {
  async list(u) {
    const D = dirs(u);
    const files = (await fs.readdir(D.proj).catch(() => [])).filter((f) => f.endsWith('.json'));
    return Promise.all(files.map(async (f) => { const n = f.slice(0, -5), m = await readMeta(D.proj, n), st = await fs.stat(path.join(D.proj, f)); return { name: n, rev: m.rev || 1, modified: st.mtimeMs }; }));
  },
  async read(u, name) {
    const D = dirs(u), raw = await fs.readFile(path.join(D.proj, name + '.json'), 'utf8').catch(() => null);
    if (raw === null) return null;
    return { obj: JSON.parse(raw), rev: (await readMeta(D.proj, name)).rev };
  },
  async write(u, name, obj, device, rev) {
    try { return await writeProject(u, name, JSON.stringify(obj), device, rev); }
    catch (e) { if (e instanceof Conflict) throw new Error('The design was changed by someone else while this edit was being made. Fetch it again and retry.'); throw e; }
  },
};

// ---- MCP access tokens (per user; only the SHA-256 is stored)
const mcpFile = path.join(dataDir, 'mcp-tokens.json');
let mcpTokens = await readJSON(mcpFile, {}); // id -> {hash, user, name, created, lastUsed}
const saveMcp = () => writeJSON(mcpFile, mcpTokens);
if (settings.allowMcp === undefined) settings.allowMcp = process.env.ALLOW_MCP !== 'false';
const mcpHandle = createMcp({ storage: mcpStorage, device: 'Claude / ChatGPT (MCP)', loadHeadless: async () => { const H = await import('./src/headless.js'); await H.initHeadless(); return H; } });
const mcpUser = (req, url) => {
  const m = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
  const pm = /^\/mcp\/([\w-]+)$/.exec(url.pathname);
  const tok = m?.[1] || pm?.[1] || url.searchParams.get('token');
  if (!tok) return null;
  const h = sha(tok), ent = Object.values(mcpTokens).find((t) => t.hash === h);
  if (!ent || !users[ent.user]) return null;
  if (Date.now() - (ent.lastUsed || 0) > 60e3) { ent.lastUsed = Date.now(); saveMcp(); }
  return ent.user;
};
async function mcpEndpoint(req, res, url) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!settings.allowMcp) return send(res, 403, { error: 'MCP access is turned off on this server.' });
  const user = mcpUser(req, url);
  if (!user) { res.setHeader('www-authenticate', 'Bearer realm="sketchy"'); return send(res, 401, { error: 'Missing or invalid MCP token. Create one under Account in Sketchy.' }); }
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'Use POST with a JSON-RPC body.' }); }
  const body = await readJSONBody(req, 4e6);
  if (!body) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const out = await mcpHandle(user, body);
  if (out === null) { res.statusCode = 202; return res.end(); }
  return send(res, 200, out);
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  // CSRF: state-changing requests must carry a custom header (cannot be sent cross-site without CORS preflight)
  if (req.method !== 'GET' && req.headers['x-sketchy'] !== '1') return send(res, 403, { error: 'forbidden' });
  const p = url.pathname;
  const user = currentUser(req);
  const device = String(req.headers['x-device-label'] || '').slice(0, 60);

  if (p === '/api/me') {
    if (user) { // sliding renewal: push the expiry out (and re-issue the cookie) once a day of use
      const tok = tokenOf(req), ss = sessions[sha(tok)];
      if (ss && ss.exp - Date.now() < SESSION_MS - 24 * 3600e3) { delete sessions[sha(tok)]; setSession(req, res, user, tok); }
    }
    return send(res, 200, { user, admin: !!(user && users[user].admin), created: user ? users[user].created : 0, registration: settings.allowRegistration, mcp: settings.allowMcp, setup: !Object.keys(users).length });
  }

  if (p === '/api/register' || p === '/api/login') {
    if (req.method !== 'POST') return send(res, 405, {});
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    noteAttempt(ip);
    const b = await readJSONBody(req, 4096);
    if (!b) return send(res, 400, { error: 'Bad request' });
    const username = String(b.username || '').trim().toLowerCase(), password = String(b.password || '');
    if (p === '/api/register') {
      const first = !Object.keys(users).length;
      if (!settings.allowRegistration && !first) return send(res, 403, { error: 'Registration is disabled on this server.' });
      if (!userRe.test(username)) return send(res, 400, { error: 'Username: 3–32 chars, a–z, 0–9, _ or -.' });
      if (!pwOk(password)) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      users[username] = { id: crypto.randomUUID(), ...(await newHash(password)), created: Date.now(), lastLogin: Date.now(), admin: first };
      await saveUsers();
      setSession(req, res, username);
      return send(res, 200, { user: username, admin: first });
    }
    const u = users[username];
    const hash = await scrypt(password, u?.salt || '0'.repeat(32));
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) return send(res, 401, { error: 'Wrong username or password.' });
    u.lastLogin = Date.now(); await saveUsers();
    setSession(req, res, username);
    return send(res, 200, { user: username, admin: !!u.admin });
  }

  if (p === '/api/logout') {
    const tok = tokenOf(req);
    if (tok) { delete sessions[sha(tok)]; saveSessions(); }
    res.setHeader('set-cookie', 'sketchy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, {});
  }

  if (!user) return send(res, 401, { error: 'Sign in to continue.' });

  // ---- change own password
  if (p === '/api/password') {
    if (req.method !== 'POST') return send(res, 405, {});
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    noteAttempt(ip);
    const b = await readJSONBody(req, 4096);
    if (!b) return send(res, 400, { error: 'Bad request' });
    const u = users[user];
    const hash = await scrypt(String(b.current || ''), u.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) return send(res, 401, { error: 'Current password is wrong.' });
    if (!pwOk(b.next)) return send(res, 400, { error: 'New password must be at least 8 characters.' });
    Object.assign(u, await newHash(b.next));
    dropSessions(user, tokenOf(req)); // sign out other devices
    await saveUsers(); await saveSessions();
    return send(res, 200, {});
  }

  // ---- MCP access tokens (own tokens only)
  if (p === '/api/mcp/tokens') {
    if (req.method === 'GET') return send(res, 200, { enabled: settings.allowMcp, tokens: Object.entries(mcpTokens).filter(([, t]) => t.user === user).map(([id, t]) => ({ id, name: t.name, created: t.created, lastUsed: t.lastUsed || 0 })) });
    if (req.method === 'POST') {
      if (!settings.allowMcp) return send(res, 403, { error: 'MCP access is turned off on this server.' });
      const b = await readJSONBody(req, 1024);
      const nm = String(b?.name || '').trim().slice(0, 60) || 'Assistant';
      if (Object.values(mcpTokens).filter((t) => t.user === user).length >= 10) return send(res, 400, { error: 'You can have up to 10 tokens. Revoke one first.' });
      const token = 'skm_' + crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomUUID();
      mcpTokens[id] = { hash: sha(token), user, name: nm, created: Date.now(), lastUsed: 0 };
      await saveMcp();
      return send(res, 200, { id, name: nm, token }); // the only time the token is shown
    }
    return send(res, 405, {});
  }
  const tm = /^\/api\/mcp\/tokens\/([\w-]+)$/.exec(p);
  if (tm && req.method === 'DELETE') {
    if (mcpTokens[tm[1]]?.user !== user) return send(res, 404, { error: 'No such token.' });
    delete mcpTokens[tm[1]]; await saveMcp();
    return send(res, 200, {});
  }

  // ---- admin
  if (p.startsWith('/api/admin/')) {
    if (!users[user].admin) return send(res, 403, { error: 'Admins only.' });
    const parts = p.slice('/api/admin/'.length).split('/').map(decodeURIComponent);
    if (parts[0] === 'settings') {
      if (req.method === 'GET') return send(res, 200, settings);
      if (req.method === 'PUT') { const b = await readJSONBody(req, 1024); if (typeof b?.allowRegistration === 'boolean') settings.allowRegistration = b.allowRegistration; if (typeof b?.allowMcp === 'boolean') settings.allowMcp = b.allowMcp; await saveSettings(); return send(res, 200, settings); }
    }
    if (parts[0] === 'users' && !parts[1] && req.method === 'GET') {
      const list = await Promise.all(Object.entries(users).map(async ([name, u]) => {
        const d = path.join(dataDir, 'projects', u.id);
        const files = (await fs.readdir(d).catch(() => [])).filter((f) => f.endsWith('.json'));
        let bytes = 0;
        for (const f of files) bytes += (await fs.stat(path.join(d, f)).catch(() => ({ size: 0 }))).size;
        return { name, created: u.created, lastLogin: u.lastLogin || 0, admin: !!u.admin, designs: files.length, bytes };
      }));
      return send(res, 200, list.sort((a, b) => a.name.localeCompare(b.name)));
    }
    const target = parts[0] === 'users' && users[parts[1]] && parts[1];
    if (!target) return send(res, 404, { error: 'No such user.' });
    if (parts[2] === 'password' && req.method === 'POST') {
      const b = await readJSONBody(req, 1024);
      const pw = b?.password || crypto.randomBytes(9).toString('base64url');
      if (!pwOk(pw)) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      Object.assign(users[target], await newHash(pw));
      dropSessions(target);
      await saveUsers(); await saveSessions();
      return send(res, 200, { password: pw });
    }
    if (parts[2] === 'admin' && req.method === 'POST') {
      const b = await readJSONBody(req, 256);
      const on = !!b?.admin;
      if (!on && users[target].admin && Object.values(users).filter((u) => u.admin).length < 2) return send(res, 400, { error: 'There must be at least one admin.' });
      users[target].admin = on; await saveUsers();
      return send(res, 200, {});
    }
    if (!parts[2] && req.method === 'DELETE') {
      if (target === user) return send(res, 400, { error: "You can't delete your own account here." });
      const id = users[target].id;
      delete users[target]; dropSessions(target);
      for (const [id, t] of Object.entries(mcpTokens)) if (t.user === target) delete mcpTokens[id];
      await saveMcp();
      await fs.rm(path.join(dataDir, 'projects', id), { recursive: true, force: true });
      await fs.rm(path.join(dataDir, 'drafts', id), { recursive: true, force: true });
      await saveUsers(); await saveSessions();
      return send(res, 200, {});
    }
    return send(res, 405, {});
  }

  const D = dirs(user);
  await fs.mkdir(D.proj, { recursive: true });
  await fs.mkdir(D.draft, { recursive: true });

  // ---- drafts (server-side autosave so you can resume on another device)
  if (p.startsWith('/api/drafts')) {
    const key = decodeURIComponent(p.slice('/api/drafts/'.length));
    if (!key) {
      const files = (await fs.readdir(D.draft)).filter((f) => f.endsWith('.json'));
      const list = await Promise.all(files.map(async (f) => {
        const st = await fs.stat(path.join(D.draft, f));
        const m = await readJSON(path.join(D.draft, f.slice(0, -5) + '.meta'), {});
        return { key: f.slice(0, -5), modified: st.mtimeMs, size: st.size, device: m.device || '', base: m.base ?? null };
      }));
      return send(res, 200, list.sort((a, b) => b.modified - a.modified));
    }
    if (!nameOk(key) && key !== '__untitled') return send(res, 400, { error: 'Invalid name.' });
    const f = path.join(D.draft, key + '.json'), mf = path.join(D.draft, key + '.meta');
    if (req.method === 'GET') { const d = await fs.readFile(f).catch(() => null); if (!d) return send(res, 404, { error: 'No draft' }); res.setHeader('content-type', 'application/json'); return res.end(d); }
    if (req.method === 'DELETE') { await fs.rm(f, { force: true }); await fs.rm(mf, { force: true }); return send(res, 200, {}); }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      let obj; try { obj = JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const m = typeof obj.thumb === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(obj.thumb);
      delete obj.thumb;
      try {
        const rev = await writeProject(user, name, JSON.stringify(obj), device, req.headers['if-match']);
        if (m && m[1].length < 400000) await fs.writeFile(path.join(D.proj, name + '.jpg'), Buffer.from(m[1], 'base64'));
        return send(res, 200, { rev });
      } catch (e) {
        if (e instanceof Conflict) return send(res, 409, { error: 'conflict', rev: e.rev, modified: e.modified, device: e.device });
        throw e;
      }
    }
    return send(res, 405, {});
  }

  // ---- projects
  if (p.startsWith('/api/projects')) {
    let name = decodeURIComponent(p.slice('/api/projects/'.length));
    const vm = /^(.+)\/versions(?:\/(\d+))?$/.exec(name);
    if (vm) {
      if (!nameOk(vm[1])) return send(res, 400, { error: 'Invalid design name.' });
      const dir = verDir(D, vm[1]);
      if (!vm[2]) {
        const metas = await Promise.all(((await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.meta'))).map((f) => readJSON(path.join(dir, f), null)));
        return send(res, 200, metas.filter(Boolean).sort((a, b) => b.rev - a.rev));
      }
      const d = await fs.readFile(path.join(dir, vm[2] + '.json')).catch(() => null);
      if (!d) return send(res, 404, { error: 'Version not found' });
      res.setHeader('content-type', 'application/json'); res.setHeader('x-rev', vm[2]);
      return res.end(d);
    }
    const suffix = ['/thumb', '/meta'].find((x) => name.endsWith(x));
    if (suffix) name = name.slice(0, -suffix.length);
    if (!name) {
      const files = (await fs.readdir(D.proj)).filter((f) => f.endsWith('.json'));
      const thumbs = new Set((await fs.readdir(D.proj)).filter((f) => f.endsWith('.jpg')));
      const list = await Promise.all(files.map(async (f) => {
        const n = f.slice(0, -5), st = await fs.stat(path.join(D.proj, f));
        const m = await readMeta(D.proj, n);
        return { name: n, modified: st.mtimeMs, size: st.size, ver: m.rev || 1, device: m.device || '', thumb: thumbs.has(n + '.jpg') };
      }));
      return send(res, 200, list.sort((a, b) => b.modified - a.modified));
    }
    if (!nameOk(name)) return send(res, 400, { error: 'Invalid design name.' });
    const file = path.join(D.proj, name + '.json');
    if (suffix === '/thumb') {
      const img = await fs.readFile(path.join(D.proj, name + '.jpg')).catch(() => null);
      if (!img) return send(res, 404, { error: 'No thumbnail' });
      res.setHeader('content-type', 'image/jpeg'); res.setHeader('cache-control', 'private, max-age=60');
      return res.end(img);
    }
    if (suffix === '/meta') {
      const st = await fs.stat(file).catch(() => null);
      if (!st) return send(res, 404, { error: 'Not found' });
      const m = await readMeta(D.proj, name);
      return send(res, 200, { rev: m.rev, modified: st.mtimeMs, device: m.device || '' });
    }
    if (req.method === 'GET') {
      const d = await fs.readFile(file).catch(() => null);
      if (!d) return send(res, 404, { error: 'Not found' });
      const m = await readMeta(D.proj, name);
      res.setHeader('content-type', 'application/json'); res.setHeader('x-rev', String(m.rev));
      return res.end(d);
    }
    if (req.method === 'DELETE') {
      for (const ext of ['.json', '.jpg', '.ver', '.meta']) await fs.rm(path.join(D.proj, name + ext), { force: true });
      await fs.rm(verDir(D, name), { recursive: true, force: true });
      await fs.rm(path.join(D.draft, name + '.json'), { force: true }); await fs.rm(path.join(D.draft, name + '.meta'), { force: true });
      return send(res, 200, {});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      let obj; try { obj = JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      // optimistic concurrency: the client says which revision it started from
      const exists = await fs.stat(file).catch(() => null);
      const cur = await readMeta(D.proj, name);
      const ifMatch = req.headers['if-match'];
      if (exists && ifMatch !== undefined && ifMatch !== '*' && +ifMatch !== cur.rev) {
        return send(res, 409, { error: 'conflict', rev: cur.rev, modified: exists.mtimeMs, device: cur.device || '' });
      }
      const m = typeof obj.thumb === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(obj.thumb);
      if (m && m[1].length < 400000) await fs.writeFile(path.join(D.proj, name + '.jpg'), Buffer.from(m[1], 'base64'));
      delete obj.thumb;
      const rev = (cur.rev || 0) + 1;
      if (exists) await snapshotVersion(D, name, { ...cur, modified: cur.modified || exists.mtimeMs });
      await fs.writeFile(file, JSON.stringify(obj));
      await writeJSON(path.join(D.proj, name + '.meta'), { rev, modified: Date.now(), device });
      await fs.writeFile(path.join(D.proj, name + '.ver'), String(rev));
      await fs.rm(path.join(D.draft, name + '.json'), { force: true }); await fs.rm(path.join(D.draft, name + '.meta'), { force: true });
      return send(res, 200, { rev });
    }
    return send(res, 405, {});
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return await mcpEndpoint(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const p = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!p.startsWith(root)) { res.statusCode = 403; return res.end(); }
    const body = await fs.readFile(p).catch(() => null);
    if (!body) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
    if (p.includes('assets')) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.end(body);
  } catch (e) { send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'File too large' : 'Server error' }); }
}).listen(port, () => console.log(`Sketchy on :${port}, data in ${dataDir}, registration ${settings.allowRegistration ? 'open' : 'closed'}`));
