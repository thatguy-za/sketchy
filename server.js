// Zero-dependency server: static files + accounts + per-user project storage.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const port = +process.env.PORT || 8080;
const allowRegistration = process.env.ALLOW_REGISTRATION !== 'false';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
await fs.mkdir(path.join(dataDir, 'projects'), { recursive: true });

const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const writeJSON = async (f, v) => { const t = f + '.tmp'; await fs.writeFile(t, JSON.stringify(v), { mode: 0o600 }); await fs.rename(t, f); };
let users = await readJSON(usersFile, {});       // username -> {id, salt, hash, created}
let sessions = await readJSON(sessionsFile, {}); // sha256(token) -> {user, exp}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const saveSessions = () => writeJSON(sessionsFile, sessions);

const send = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const readBody = async (req, max = 200e6) => {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
};
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));

// naive per-IP throttle for login/register
const attempts = new Map();
const throttled = (ip) => {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 20;
};
const noteAttempt = (ip) => attempts.get(ip)?.push(Date.now());

function currentUser(req) {
  const tok = parseCookies(req.headers.cookie).sketchy_session;
  if (!tok) return null;
  const s = sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  return s.user;
}
function setSession(res, username) {
  const tok = crypto.randomBytes(32).toString('hex');
  sessions[sha(tok)] = { user: username, exp: Date.now() + SESSION_MS };
  for (const [k, v] of Object.entries(sessions)) if (v.exp < Date.now()) delete sessions[k];
  saveSessions();
  res.setHeader('set-cookie', `sketchy_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

const userRe = /^[a-z0-9_-]{3,32}$/;
const nameOk = (n) => /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.');

async function api(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  // CSRF: state-changing requests must carry a custom header (cannot be sent cross-site without CORS preflight)
  if (req.method !== 'GET' && req.headers['x-sketchy'] !== '1') return send(res, 403, { error: 'forbidden' });
  const p = url.pathname;

  if (p === '/api/me') return send(res, 200, { user: currentUser(req), registration: allowRegistration });

  if (p === '/api/register' || p === '/api/login') {
    if (req.method !== 'POST') return send(res, 405, {});
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    noteAttempt(ip);
    let b; try { b = JSON.parse((await readBody(req, 4096)).toString()); } catch { return send(res, 400, { error: 'Bad request' }); }
    const username = String(b.username || '').trim().toLowerCase(), password = String(b.password || '');
    if (p === '/api/register') {
      if (!allowRegistration) return send(res, 403, { error: 'Registration is disabled on this server.' });
      if (!userRe.test(username)) return send(res, 400, { error: 'Username: 3–32 chars, a–z, 0–9, _ or -.' });
      if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[username] = { id: crypto.randomUUID(), salt, hash: await scrypt(password, salt), created: Date.now() };
      await writeJSON(usersFile, users);
      setSession(res, username);
      return send(res, 200, { user: username });
    }
    const u = users[username];
    const hash = await scrypt(password, u?.salt || '0'.repeat(32));
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) return send(res, 401, { error: 'Wrong username or password.' });
    setSession(res, username);
    return send(res, 200, { user: username });
  }

  if (p === '/api/logout') {
    const tok = parseCookies(req.headers.cookie).sketchy_session;
    if (tok) { delete sessions[sha(tok)]; saveSessions(); }
    res.setHeader('set-cookie', 'sketchy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, {});
  }

  if (p.startsWith('/api/projects')) {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: 'Sign in to use saved designs.' });
    const dir = path.join(dataDir, 'projects', users[user].id);
    await fs.mkdir(dir, { recursive: true });
    let name = decodeURIComponent(p.slice('/api/projects/'.length));
    const wantThumb = name.endsWith('/thumb');
    if (wantThumb) name = name.slice(0, -6);
    if (!name) {
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
      const thumbs = new Set((await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')));
      const list = await Promise.all(files.map(async (f) => { const st = await fs.stat(path.join(dir, f)); const ver = parseInt(await fs.readFile(path.join(dir, f.slice(0, -5) + '.ver'), 'utf8').catch(() => '1'), 10) || 1; return { name: f.slice(0, -5), modified: st.mtimeMs, size: st.size, ver, thumb: thumbs.has(f.slice(0, -5) + '.jpg') }; }));
      return send(res, 200, list.sort((a, b) => b.modified - a.modified));
    }
    if (!nameOk(name)) return send(res, 400, { error: 'Invalid design name.' });
    if (wantThumb) {
      const img = await fs.readFile(path.join(dir, name + '.jpg')).catch(() => null);
      if (!img) return send(res, 404, { error: 'No thumbnail' });
      res.setHeader('content-type', 'image/jpeg'); res.setHeader('cache-control', 'private, max-age=60');
      return res.end(img);
    }
    const file = path.join(dir, name + '.json');
    if (req.method === 'GET') { const d = await fs.readFile(file).catch(() => null); if (!d) return send(res, 404, { error: 'Not found' }); res.setHeader('content-type', 'application/json'); return res.end(d); }
    if (req.method === 'DELETE') { await fs.rm(file, { force: true }); await fs.rm(path.join(dir, name + '.jpg'), { force: true }); await fs.rm(path.join(dir, name + '.ver'), { force: true }); return send(res, 200, {}); }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      let obj; try { obj = JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const m = typeof obj.thumb === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(obj.thumb);
      if (m && m[1].length < 400000) await fs.writeFile(path.join(dir, name + '.jpg'), Buffer.from(m[1], 'base64'));
      delete obj.thumb;
      const vf = path.join(dir, name + '.ver');
      const prev = parseInt(await fs.readFile(vf, 'utf8').catch(() => '0'), 10) || 0;
      await fs.writeFile(vf, String(prev + 1));
      await fs.writeFile(file, JSON.stringify(obj));
      return send(res, 200, {});
    }
    return send(res, 405, {});
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const p = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!p.startsWith(root)) { res.statusCode = 403; return res.end(); }
    const body = await fs.readFile(p).catch(() => null);
    if (!body) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
    if (p.includes('assets')) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.end(body);
  } catch (e) { send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'File too large' : 'Server error' }); }
}).listen(port, () => console.log(`Sketchy on :${port}, data in ${dataDir}, registration ${allowRegistration ? 'open' : 'closed'}`));
