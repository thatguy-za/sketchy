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

// In the Docker image the server starts as root, makes the data directory writable, and then switches to an unprivileged user
// (PUID and PGID, default 1000:1000). Doing it here means the image needs no extra tools, so building it runs nothing under
// emulation. Only when SKETCHY_DROP_ROOT is set (the image sets it); a normal install is untouched.
if (process.getuid?.() === 0 && process.env.SKETCHY_DROP_ROOT) {
  const num = (v, d) => (v === undefined || v === '' ? d : /^\d+$/.test(v) ? +v : NaN);
  const uid = num(process.env.PUID, 1000), gid = num(process.env.PGID, 1000);
  if (Number.isNaN(uid) || Number.isNaN(gid)) { console.error(`PUID and PGID must be numbers (got PUID=${process.env.PUID ?? ''} PGID=${process.env.PGID ?? ''})`); process.exit(1); }
  if (uid === 0) console.error('Warning: PUID=0 runs the server as root. Use your own user id instead.');
  else {
    await fs.mkdir(dataDir, { recursive: true });
    const chownAll = async (dir) => {
      await fs.lchown(dir, uid, gid);
      for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await chownAll(f); else await fs.lchown(f, uid, gid); }
    };
    try { await chownAll(dataDir); } catch (e) { console.error(`Warning: could not change the owner of ${dataDir} (${e.code}); a read-only or network mount?`); }
    process.setgroups([]); process.setgid(gid); process.setuid(uid);
  }
}

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
// Open sign-up is a Server settings option (admins change it in the app). Until an admin has set it, sign-up is closed; an
// ALLOW_REGISTRATION environment variable from an older setup is honoured once, as the starting value.
if (settings.allowRegistration === undefined) { settings.allowRegistration = process.env.ALLOW_REGISTRATION === 'true'; await writeJSON(settingsFile, settings); }
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
// Failed sign-ins are counted per address and per username. After maxFailedLogins failures within failWindowMinutes the address
// (or username) is locked out for lockoutMinutes. The numbers are Server settings; 0 failures switches the lock-out off.
const LOGIN_DEFAULTS = { maxFailedLogins: 5, failWindowMinutes: 15, lockoutMinutes: 15 };
const loginCfg = () => ({ ...LOGIN_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([k]) => k in LOGIN_DEFAULTS)) });
const failures = new Map(); // key ('ip:1.2.3.4' / 'user:name') -> { times: [], until }
const lockedFor = (...keys) => { const now = Date.now(); let ms = 0; for (const k of keys) { const f = failures.get(k); if (f?.until > now) ms = Math.max(ms, f.until - now); } return ms; };
function noteFailure(...keys) {
  const c = loginCfg(), now = Date.now();
  if (!c.maxFailedLogins) return;
  for (const k of keys) {
    const f = failures.get(k) || { times: [], until: 0 };
    f.times = f.times.filter((t) => now - t < c.failWindowMinutes * 60e3); f.times.push(now);
    if (f.times.length >= c.maxFailedLogins) { f.until = now + c.lockoutMinutes * 60e3; f.times = []; }
    failures.set(k, f);
  }
}
const clearFailures = (...keys) => keys.forEach((k) => failures.delete(k));
// Behind a reverse proxy (Caddy, Cloudflare Tunnel) every request arrives from the proxy's own private address, so the real
// client address is read from the forwarding header, but only when the request really came from a private or loopback address.
const privateAddr = (a) => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a);
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (!privateAddr(peer)) return peer;
  const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || peer;
}
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
const dirs = (u) => ({ proj: path.join(dataDir, 'projects', users[u].id), draft: path.join(dataDir, 'drafts', users[u].id), fold: path.join(dataDir, 'folders', users[u].id + '.json') });

// ---- folders: a label layer over the flat design list. Design names stay unique per account; a design lives in at most one folder.
const folderOk = (f) => f === '' || (typeof f === 'string' && f.length <= 200 && f.split('/').every((seg) => nameOk(seg)));
async function readFolders(D) {
  const f = await readJSON(D.fold, null);
  return { folders: Array.isArray(f?.folders) ? f.folders : [], map: f?.map && typeof f.map === 'object' ? f.map : {} };
}
async function writeFolders(D, f) { await fs.mkdir(path.dirname(D.fold), { recursive: true }); await writeJSON(D.fold, f); }
/** Add a folder and every ancestor to the list. */
function addFolder(f, p) { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) { const q = parts.slice(0, i).join('/'); if (q && !f.folders.includes(q)) f.folders.push(q); } }

async function readMeta(dir, name) {
  const m = await readJSON(path.join(dir, name + '.meta'), null);
  if (m) return { ...m, seq: m.seq ?? m.rev }; // seq counts every write (autosaves too); rev counts saved versions
  const rev = parseInt(await fs.readFile(path.join(dir, name + '.ver'), 'utf8').catch(() => '0'), 10) || 0; // legacy
  return { rev, seq: rev, modified: 0, device: '' };
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
class Conflict extends Error { constructor(seq) { super('conflict'); this.seq = seq; } }
/**
 * Write a design. `seq` counts every write and is what concurrent editors compare; `rev` counts saved versions: an autosave
 * (opts.auto) updates the file in place and does not add a version, a normal save keeps the file it replaces in the history.
 * ifSeq: undefined or '*' = no check. Returns { rev, seq }.
 */
async function writeProject(username, name, objStr, device, ifSeq, opts = {}) {
  const D = dirs(username), file = path.join(D.proj, name + '.json');
  await fs.mkdir(D.proj, { recursive: true }); await fs.mkdir(D.draft, { recursive: true });
  const exists = await fs.stat(file).catch(() => null);
  const cur = await readMeta(D.proj, name);
  if (exists && ifSeq !== undefined && ifSeq !== '*' && +ifSeq !== cur.seq) throw Object.assign(new Conflict(cur.seq), { rev: cur.rev, modified: exists.mtimeMs, device: cur.device || '' });
  const rev = opts.auto && exists ? cur.rev || 1 : (cur.rev || 0) + 1, seq = (cur.seq || 0) + 1;
  if (exists && !opts.auto) await snapshotVersion(D, name, { ...cur, modified: cur.modified || exists.mtimeMs });
  await fs.writeFile(file, objStr);
  await writeJSON(path.join(D.proj, name + '.meta'), { rev, seq, modified: Date.now(), device });
  await fs.writeFile(path.join(D.proj, name + '.ver'), String(rev));
  await fs.rm(path.join(D.draft, name + '.json'), { force: true }); await fs.rm(path.join(D.draft, name + '.meta'), { force: true });
  return { rev, seq };
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
    return { obj: JSON.parse(raw), rev: (await readMeta(D.proj, name)).seq };
  },
  async write(u, name, obj, device, rev) {
    try { return (await writeProject(u, name, JSON.stringify(obj), device, rev)).seq; }
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
  const ip = clientIp(req);
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
    const ipKey = 'ip:' + ip, userKey = 'user:' + username, wait = lockedFor(ipKey, userKey);
    if (wait) return send(res, 429, { error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60e3)} minute${wait > 60e3 ? 's' : ''}.` });
    const u = users[username];
    const hash = await scrypt(password, u?.salt || '0'.repeat(32));
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) { noteFailure(ipKey, userKey); return send(res, 401, { error: 'Wrong username or password.' }); }
    clearFailures(ipKey, userKey);
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
      if (req.method === 'GET') return send(res, 200, { ...settings, ...loginCfg() });
      if (req.method === 'PUT') {
        const b = await readJSONBody(req, 1024);
        if (typeof b?.allowRegistration === 'boolean') settings.allowRegistration = b.allowRegistration;
        if (typeof b?.allowMcp === 'boolean') settings.allowMcp = b.allowMcp;
        const lim = { maxFailedLogins: [0, 1000], failWindowMinutes: [1, 10080], lockoutMinutes: [1, 10080] };
        for (const [k, [lo, hi]] of Object.entries(lim)) if (b && k in b) {
          const n = Number(b[k]);
          if (!Number.isInteger(n) || n < lo || n > hi) return send(res, 400, { error: `${k === 'maxFailedLogins' ? 'Failed sign-ins' : 'Minutes'} must be a whole number from ${lo} to ${hi}.` });
          settings[k] = n;
        }
        await saveSettings(); return send(res, 200, { ...settings, ...loginCfg() });
      }
    }
    if (parts[0] === 'lockouts') { // who is locked out right now, and a way to let them back in
      if (req.method === 'GET') { const now = Date.now(); return send(res, 200, [...failures].filter(([, f]) => f.until > now).map(([key, f]) => ({ key, kind: key.startsWith('ip:') ? 'address' : 'username', name: key.slice(key.indexOf(':') + 1), minutes: Math.ceil((f.until - now) / 60e3) }))); }
      if (req.method === 'DELETE') { const k = url.searchParams.get('key'); if (k) failures.delete(k); else failures.clear(); return send(res, 200, {}); }
    }
    if (parts[0] === 'users' && !parts[1] && req.method === 'POST') { // an admin adds a person; with no password a temporary one is generated
      const b = await readJSONBody(req, 4096);
      const username = String(b?.username || '').trim().toLowerCase();
      if (!userRe.test(username)) return send(res, 400, { error: 'Username: 3–32 chars, a–z, 0–9, _ or -.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      const generated = !b?.password, pw = generated ? crypto.randomBytes(9).toString('base64url') : String(b.password);
      if (!pwOk(pw)) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      users[username] = { id: crypto.randomUUID(), ...(await newHash(pw)), created: Date.now(), lastLogin: 0, admin: !!b?.admin };
      await saveUsers();
      return send(res, 200, { user: username, admin: !!b?.admin, ...(generated ? { password: pw } : {}) });
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
      try { JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      await fs.writeFile(f, body);
      await writeJSON(mf, { device, base: +req.headers['x-base-rev'] || 0 });
      return send(res, 200, {});
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
    const suffix = ['/thumb', '/meta', '/move', '/rename'].find((x) => name.endsWith(x));
    if (suffix) name = name.slice(0, -suffix.length);
    if (!name) {
      const fmap = (await readFolders(D)).map;
      const files = (await fs.readdir(D.proj)).filter((f) => f.endsWith('.json'));
      const thumbs = new Set((await fs.readdir(D.proj)).filter((f) => f.endsWith('.jpg')));
      const list = await Promise.all(files.map(async (f) => {
        const n = f.slice(0, -5), st = await fs.stat(path.join(D.proj, f));
        const m = await readMeta(D.proj, n);
        return { name: n, modified: st.mtimeMs, size: st.size, ver: m.rev || 1, seq: m.seq || 1, device: m.device || '', thumb: thumbs.has(n + '.jpg'), folder: fmap[n] || '' };
      }));
      return send(res, 200, list.sort((a, b) => b.modified - a.modified));
    }
    if (!nameOk(name)) return send(res, 400, { error: 'Invalid design name.' });
    const file = path.join(D.proj, name + '.json');
    if (suffix === '/move' || suffix === '/rename') {
      if (req.method !== 'POST') return send(res, 405, {});
      let b; try { b = JSON.parse((await readBody(req)).toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!(await fs.stat(file).catch(() => null))) return send(res, 404, { error: 'Not found' });
      const F = await readFolders(D);
      if (suffix === '/move') {
        if (!folderOk(b.folder)) return send(res, 400, { error: 'Invalid folder name.' });
        if (b.folder) addFolder(F, b.folder);
        if (b.folder) F.map[name] = b.folder; else delete F.map[name];
        await writeFolders(D, F);
        return send(res, 200, { folder: b.folder });
      }
      const to = b.to;
      if (!nameOk(to)) return send(res, 400, { error: 'Invalid design name.' });
      if (to === name) return send(res, 200, { name });
      if (await fs.stat(path.join(D.proj, to + '.json')).catch(() => null)) return send(res, 409, { error: 'A design with that name already exists.' });
      for (const ext of ['.json', '.jpg', '.meta', '.ver']) await fs.rename(path.join(D.proj, name + ext), path.join(D.proj, to + ext)).catch(() => {});
      await fs.rename(verDir(D, name), verDir(D, to)).catch(() => {});
      for (const ext of ['.json', '.meta']) await fs.rename(path.join(D.draft, name + ext), path.join(D.draft, to + ext)).catch(() => {});
      if (F.map[name] !== undefined) { F.map[to] = F.map[name]; delete F.map[name]; await writeFolders(D, F); }
      return send(res, 200, { name: to });
    }
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
      return send(res, 200, { rev: m.rev, seq: m.seq, modified: st.mtimeMs, device: m.device || '', folder: (await readFolders(D)).map[name] || '' });
    }
    if (req.method === 'GET') {
      const d = await fs.readFile(file).catch(() => null);
      if (!d) return send(res, 404, { error: 'Not found' });
      const m = await readMeta(D.proj, name);
      res.setHeader('content-type', 'application/json'); res.setHeader('x-rev', String(m.rev)); res.setHeader('x-seq', String(m.seq));
      return res.end(d);
    }
    if (req.method === 'DELETE') {
      for (const ext of ['.json', '.jpg', '.ver', '.meta']) await fs.rm(path.join(D.proj, name + ext), { force: true });
      await fs.rm(verDir(D, name), { recursive: true, force: true });
      await fs.rm(path.join(D.draft, name + '.json'), { force: true }); await fs.rm(path.join(D.draft, name + '.meta'), { force: true });
      const F = await readFolders(D); if (F.map[name] !== undefined) { delete F.map[name]; await writeFolders(D, F); }
      return send(res, 200, {});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      let obj; try { obj = JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const folderHdr = req.headers['x-folder'] !== undefined ? decodeURIComponent(String(req.headers['x-folder'])) : null;
      if (folderHdr !== null && !folderOk(folderHdr)) return send(res, 400, { error: 'Invalid folder name.' });
      // optimistic concurrency: the client says which write (seq) it started from; x-autosave: 1 updates in place without adding a version
      const thumb = typeof obj.thumb === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(obj.thumb);
      delete obj.thumb;
      let res2;
      try { res2 = await writeProject(user, name, JSON.stringify(obj), device, req.headers['if-match'], { auto: req.headers['x-autosave'] === '1' }); }
      catch (e) { if (e instanceof Conflict) return send(res, 409, { error: 'conflict', rev: e.rev, seq: e.seq, modified: e.modified, device: e.device }); throw e; }
      if (thumb && thumb[1].length < 400000) await fs.writeFile(path.join(D.proj, name + '.jpg'), Buffer.from(thumb[1], 'base64'));
      if (folderHdr !== null) { const F = await readFolders(D); if (folderHdr) { addFolder(F, folderHdr); F.map[name] = folderHdr; } else delete F.map[name]; await writeFolders(D, F); }
      return send(res, 200, res2);
    }
    return send(res, 405, {});
  }

  // ---- folders
  if (p.startsWith('/api/folders')) {
    const F = await readFolders(D);
    if (req.method === 'GET') return send(res, 200, { folders: F.folders.sort((a, b) => a.localeCompare(b)) });
    if (req.method === 'POST' || req.method === 'PATCH') {
      let b; try { b = JSON.parse((await readBody(req)).toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (req.method === 'POST') {
        if (!b.path || !folderOk(b.path)) return send(res, 400, { error: 'Folder names may use letters, numbers, spaces and . _ ( ) -' });
        if (F.folders.includes(b.path)) return send(res, 409, { error: 'That folder already exists.' });
        addFolder(F, b.path); await writeFolders(D, F);
        return send(res, 200, { path: b.path });
      }
      const { from, to } = b;
      if (!from || !F.folders.includes(from)) return send(res, 404, { error: 'Folder not found.' });
      if (!to || !folderOk(to)) return send(res, 400, { error: 'Invalid folder name.' });
      if (to === from || to.startsWith(from + '/')) return send(res, 400, { error: 'A folder cannot be moved into itself.' });
      if (F.folders.includes(to)) return send(res, 409, { error: 'A folder with that name already exists.' });
      const re = (q) => (q === from ? to : q.startsWith(from + '/') ? to + q.slice(from.length) : q);
      F.folders = F.folders.map(re); addFolder(F, to);
      for (const k of Object.keys(F.map)) F.map[k] = re(F.map[k]);
      await writeFolders(D, F);
      return send(res, 200, { path: to });
    }
    if (req.method === 'DELETE') {
      const fp = decodeURIComponent(url.searchParams.get('path') || '');
      if (!fp || !F.folders.includes(fp)) return send(res, 404, { error: 'Folder not found.' });
      if (Object.values(F.map).some((v) => v === fp || v.startsWith(fp + '/'))) return send(res, 409, { error: 'The folder still contains designs. Move or delete them first.' });
      F.folders = F.folders.filter((q) => q !== fp && !q.startsWith(fp + '/'));
      await writeFolders(D, F);
      return send(res, 200, {});
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
    else res.setHeader('cache-control', 'no-cache'); // the page itself is re-checked on every visit, so an upgrade shows up straight away
    res.end(body);
  } catch (e) { send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'File too large' : 'Server error' }); }
}).listen(port, () => console.log(`Sketchy on :${port}, data in ${dataDir}, registration ${settings.allowRegistration ? 'open' : 'closed'}`));
