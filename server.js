// Zero-dependency server: static files + accounts (with admin) + per-user project storage with revisions and drafts.
//
// CLI (run inside the container: docker exec <name> node server.js ...):
//   node server.js list-users
//   node server.js reset-password <user> [new-password]   (generates one if omitted)
//   node server.js make-admin <user>
import { validateDesign } from './design-validate.js';
import { createMcp } from './mcp.js';
import { createPool } from './mcp-pool.js';
import { createOAuth } from './oauth.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const port = +process.env.PORT || 8080;
const MAX_VERSIONS = Math.max(0, parseInt(process.env.MAX_VERSIONS ?? '20', 10) || 0); // old revisions kept per design
const DAY = 24 * 3600e3;
const SESSION_MS = Math.max(1, +process.env.SESSION_DAYS || 30) * DAY;                       // sliding: renewed whenever the app is opened, so active people stay signed in
const SESSION_MAX_MS = Math.max(SESSION_MS, (+process.env.SESSION_MAX_DAYS || 90) * DAY);   // but no sign-in lasts longer than this, however often it is used
const MAX_SESSIONS = Math.max(1, +process.env.MAX_SESSIONS_PER_USER || 10);                 // devices signed in at once; the least recently used is signed out
// Limits that keep one account (or one client) from filling the disk or hogging the server. 0 switches a limit off.
const MAX_DESIGN_BYTES = (process.env.MAX_DESIGN_MB === undefined ? 64 : +process.env.MAX_DESIGN_MB || 0) * 1048576; // one saved design
const DEFAULT_QUOTA_MB = process.env.USER_QUOTA_MB === undefined ? 2048 : +process.env.USER_QUOTA_MB || 0; // everything one account stores; admins can change it per person
// TRUST_PROXY=false stops the server believing X-Forwarded-For / CF-Connecting-IP. Leave it unset behind a reverse proxy; set it
// when the container's port is published straight to the internet (a client could then pretend to be any address).
const TRUST_PROXY = !/^(0|false|no|off)$/i.test(process.env.TRUST_PROXY || '');

// Host header allow-list. A web page on another site can make a visitor's browser talk to this server under the attacker's own name
// (DNS rebinding), and a forged Host can poison the addresses the server hands out. So the Host must be one we expect:
//   * with PUBLIC_URL or ALLOWED_HOSTS set, only those names, plus localhost / 127.0.0.1 / [::1] (the container health check);
//   * with neither set (a home server reached by IP or a local name), any IP address, "localhost", names ending .local .lan .home.arpa
//     .internal or .localdomain, and one-word names such as "nas". A public-looking name like evil.example.com is refused.
// ALLOWED_HOSTS is a comma-separated list of extra names (host names only, no port).
const hostOnly = (h) => { h = String(h || '').trim().toLowerCase(); if (h.startsWith('[')) { const e = h.indexOf(']'); return e > 0 ? h.slice(1, e) : ''; } return h.replace(/:\d*$/, '').replace(/\.$/, ''); };
const publicHost = (() => { try { return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname.toLowerCase().replace(/^\[|\]$/g, '') : ''; } catch { return ''; } })();
const extraHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map((x) => hostOnly(x)).filter(Boolean);
const STRICT_HOSTS = !!(publicHost || extraHosts.length);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ANY_HOST = extraHosts.includes('*'); // ALLOWED_HOSTS=* switches the check off
function hostOk(req) {
  const h = hostOnly(req.headers.host);
  if (!h) return false;
  if (ANY_HOST) return true;
  if (LOCAL_HOSTS.has(h) || h === publicHost || extraHosts.includes(h)) return true;
  if (STRICT_HOSTS) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') /* an IPv6 address */ || !h.includes('.') || /\.(local|lan|home\.arpa|internal|localdomain)$/.test(h);
}
const log = (event, ip = '', extra = '') => console.log(`${new Date().toISOString()} ${event}${ip ? ' ip=' + ip : ''}${extra ? ' ' + extra : ''}`); // one line per security event, easy to feed to fail2ban
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
const nullMap = (o) => Object.assign(Object.create(null), o); // keys like __proto__ or constructor are then ordinary names
let users = nullMap(await readJSON(usersFile, {}));       // username -> {id, salt, hash, created, lastLogin, admin}
let sessions = nullMap(await readJSON(sessionsFile, {})); // sha256(token) -> {user, exp}
let settings = await readJSON(settingsFile, {});
// Open sign-up is a Server settings option (admins change it in the app). Until an admin has set it, sign-up is closed; an
// ALLOW_REGISTRATION environment variable from an older setup is honoured once, as the starting value.
if (settings.allowRegistration === undefined) { settings.allowRegistration = process.env.ALLOW_REGISTRATION === 'true'; await writeJSON(settingsFile, settings); }
// Two sign-in policies an admin can change in Server settings. Both start off: a self-hosted server may have no route to the internet,
// and an idle timeout is a matter of taste. BREACH_CHECK=true / IDLE_MINUTES=60 set the starting values from the environment.
if (settings.breachCheck === undefined) settings.breachCheck = /^(1|true|yes|on)$/i.test(process.env.BREACH_CHECK || '');
if (settings.idleMinutes === undefined) settings.idleMinutes = Math.max(0, +process.env.IDLE_MINUTES || 0);
for (const [k, v] of Object.entries(sessions)) { // sessions made by an older version: give them the new limits
  v.created ||= Date.now(); v.last ||= v.created;
  v.exp = Math.min(v.exp, v.created + SESSION_MAX_MS, Date.now() + SESSION_MS);
  if (v.exp < Date.now()) delete sessions[k];
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
const saveUsers = () => writeJSON(usersFile, users);
const saveSessions = () => writeJSON(sessionsFile, sessions);
const saveSettings = () => writeJSON(settingsFile, settings);
// ---- Two-step sign-in (TOTP, RFC 6238): 6-digit codes from an authenticator app, 30-second steps, SHA-1 (what every app supports).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = (str) => { let bits = ''; for (const c of str.replace(/[\s=-]/g, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) return null; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const totpCode = (secretB32, step) => {
  const key = b32decode(secretB32), msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
};
/** The step a code belongs to (within one step either side of now), or null. Compared without leaking timing. */
const totpStep = (secret, code) => {
  const c = String(code || '').replace(/\s/g, ''), now = Math.floor(Date.now() / 30e3);
  if (!/^\d{6}$/.test(c)) return null;
  let hit = null;
  for (const st of [now - 1, now, now + 1]) if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, st)), Buffer.from(c))) hit = st;
  return hit;
};
const newRecoveryCodes = () => Array.from({ length: 8 }, () => { const r = crypto.randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
const normRecovery = (c) => String(c || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
/** Check a 6-digit code or a recovery code for this user. A code can be used once (the last accepted step is remembered). */
function checkSecondFactor(u, code) {
  const t = u.totp;
  if (!t?.enabled) return false;
  const st = totpStep(t.secret, code);
  if (st !== null && st > (t.last || 0)) { t.last = st; return 'code'; }
  const rc = normRecovery(code);
  if (rc.length === 10) { const h = sha(rc), i = (t.recovery || []).indexOf(h); if (i >= 0) { t.recovery.splice(i, 1); return 'recovery'; } }
  return false;
}
const tickets = new Map(); // ticket -> { user, exp, tries }: a password was right and the second step is pending
const newHash = async (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scrypt(pw, salt) }; };

// the earliest account becomes admin when none exists (upgrade path from older versions)
if (Object.keys(users).length && !Object.values(users).some((u) => u.admin)) {
  const first = Object.entries(users).sort((a, b) => a[1].created - b[1].created)[0];
  first[1].admin = true; await saveUsers();
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof']);
const userRe = /^[a-z0-9_-]{3,32}$/;
const COMMON_PW = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'qwertyuiop', 'iloveyou', 'letmein1', 'admin123', 'welcome1', 'abc12345', '11111111', '00000000', 'changeme', 'sketchy123', 'sketchy1']);
const pwOk = (p, username = '') => typeof p === 'string' && p.length >= 8 && p.length <= 200 && !COMMON_PW.has(p.toLowerCase()) && p.toLowerCase() !== String(username).toLowerCase();
const pwMsg = 'Password must be at least 8 characters and not an obvious one (such as "password" or your username).';

/**
 * Has this password appeared in a known data breach? Uses the Have I Been Pwned range API: only the first five characters of the
 * password's SHA-1 leave the server, never the password. Off unless an admin turns it on. If the service cannot be reached the
 * password is accepted (a down service must not stop anyone signing up). Returns how many times it was seen, 0 if never or unknown.
 */
const HIBP_URL = process.env.HIBP_URL || 'https://api.pwnedpasswords.com/range/';
async function breachedCount(pw) {
  if (!settings.breachCheck) return 0;
  const h = crypto.createHash('sha1').update(String(pw)).digest('hex').toUpperCase(), prefix = h.slice(0, 5), suffix = h.slice(5);
  try {
    const r = await fetch(HIBP_URL + prefix, { headers: { 'add-padding': 'true', 'user-agent': 'Sketchy password check' }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return 0;
    for (const row of (await r.text()).split(/\r?\n/)) { const [sfx, n] = row.trim().split(':'); if (sfx === suffix) return +n || 0; }
  } catch { /* offline or slow: accept */ }
  return 0;
}
const breachMsg = 'That password has appeared in a known data breach. Choose a different one.';

// Setting ADMIN_USER and ADMIN_PASSWORD creates the first account (an admin) on a fresh install, so nobody can claim it by
// being first to open the page. Ignored once any account exists.
if (!Object.keys(users).length && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
  const name = process.env.ADMIN_USER.trim().toLowerCase();
  if (!userRe.test(name) || RESERVED.has(name) || !pwOk(process.env.ADMIN_PASSWORD, name)) console.error('ADMIN_USER / ADMIN_PASSWORD were ignored: the username or password is not acceptable.');
  else { users[name] = { id: crypto.randomUUID(), ...(await newHash(process.env.ADMIN_PASSWORD)), created: Date.now(), lastLogin: 0, admin: true }; await saveUsers(); console.log(`Created the admin account "${name}" from ADMIN_USER.`); }
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
    if (!pwOk(pw, args[0])) { console.error(pwMsg); process.exit(1); }
    Object.assign(u, await newHash(pw));
    killSessions(args[0].toLowerCase());
    await saveUsers(); await saveSessions();
    console.log(`Password for ${args[0]} is now: ${pw}`);
  } else if (cmd === 'create-user' && args[0]) { // docker exec <name> node server.js create-user <user> [password] [--admin]
    const name = args[0].toLowerCase(), admin = args.includes('--admin'), given = args.slice(1).find((a) => !a.startsWith('--'));
    if (!userRe.test(name) || RESERVED.has(name)) { console.error('Username: 3-32 chars, a-z, 0-9, _ or -.'); process.exit(1); }
    if (users[name]) { console.error('That username is taken.'); process.exit(1); }
    const pw = given || crypto.randomBytes(9).toString('base64url');
    if (!pwOk(pw, name)) { console.error(pwMsg); process.exit(1); }
    users[name] = { id: crypto.randomUUID(), ...(await newHash(pw)), created: Date.now(), lastLogin: 0, admin };
    await saveUsers();
    console.log(`Created ${admin ? 'admin ' : ''}user ${name}. Password: ${pw}`);
  } else if (cmd === 'reset-totp' && args[0]) {
    const u = users[args[0].toLowerCase()];
    if (!u) { console.error('No such user.'); process.exit(1); }
    delete u.totp; await saveUsers(); console.log(`Two-step sign-in is now off for ${args[0]}.`);
  } else if (cmd === 'make-admin' && args[0]) {
    const u = users[args[0].toLowerCase()];
    if (!u) { console.error('No such user.'); process.exit(1); }
    u.admin = true; await saveUsers(); console.log(`${args[0]} is now an admin.`);
  } else { console.error('Usage: node server.js list-users | create-user <user> [pw] [--admin] | reset-totp <user> | reset-password <user> [pw] | make-admin <user>'); process.exit(1); }
  process.exit(0);
}

// ---------------------------------------------------------------- helpers
const send = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const readBody = async (req, max = 1e6) => {
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
  if (!TRUST_PROXY || !privateAddr(peer)) return peer;
  const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || peer;
}
const AUTH_ATTEMPTS = Math.max(1, +process.env.AUTH_ATTEMPTS_PER_15MIN || 20); // sign-in, sign-up, password and code attempts one address may make in 15 minutes
const attempts = new Map();
const throttled = (ip) => {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= AUTH_ATTEMPTS;
};
const noteAttempt = (ip) => { if (!attempts.has(ip)) attempts.set(ip, []); attempts.get(ip).push(Date.now()); };
// Fixed-window request counter: returns the seconds to wait when `key` has made more than `max` requests in `windowMs`, else 0.
const hits = new Map();
function rate(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  return ++h.n > max ? Math.ceil((h.reset - now) / 1000) : 0;
}
// Memory guard: addresses and usernames are attacker-chosen, so the bookkeeping maps are swept and capped.
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  for (const [k, a] of attempts) if (!a.some((t) => now - t < 15 * 60e3)) attempts.delete(k);
  for (const [k, f] of failures) if (f.until < now && !f.times.some((t) => now - t < loginCfg().failWindowMinutes * 60e3)) failures.delete(k);
  for (const m of [hits, attempts, failures]) if (m.size > 50000) for (const k of [...m.keys()].slice(0, m.size - 50000)) m.delete(k);
}, 60e3).unref();

// Over HTTPS the cookie gets the __Host- prefix: browsers then accept it only if it is Secure, set from this exact host and has no Domain,
// so a sibling subdomain or an insecure page can't plant or overwrite it.
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
const COOKIE = '__Host-sketchy_session', COOKIE_PLAIN = 'sketchy_session';
const tokenOf = (req) => { const c = parseCookies(req.headers.cookie); return c[COOKIE] || c[COOKIE_PLAIN]; };
const gone = (v) => !v || v.exp < Date.now() || Date.now() > (v.created || 0) + SESSION_MAX_MS;
function currentUser(req) {
  const tok = tokenOf(req);
  if (!tok) return null;
  const k = sha(tok), s = sessions[k];
  if (!s || gone(s) || !users[s.user]) return null;
  const now = Date.now(), idle = (settings.idleMinutes || 0) * 60e3;
  if (idle && now - (s.last || s.created || 0) > idle) { delete sessions[k]; saveSessions(); return null; } // nobody used this device for too long: sign it out
  if (now - (s.last || 0) > Math.min(5 * 60e3, idle ? idle / 4 : Infinity)) { s.last = now; saveSessions(); } // "last active", for the list of signed-in devices
  return s.user;
}
/** Starts (or, with `keep`, renews) a session and puts it in an HttpOnly cookie. */
function setSession(req, res, username, tok = crypto.randomBytes(32).toString('hex'), keep = null) {
  const now = Date.now(), created = keep?.created || now;
  sessions[sha(tok)] = { user: username, created, last: now, exp: Math.min(now + SESSION_MS, created + SESSION_MAX_MS), device: keep?.device || String(req.headers['x-device-label'] || '').slice(0, 60), ip: keep?.ip || clientIp(req).slice(0, 45) };
  for (const [k, v] of Object.entries(sessions)) if (gone(v)) delete sessions[k];
  const mine = Object.entries(sessions).filter(([, v]) => v.user === username).sort((a, b) => (b[1].last || 0) - (a[1].last || 0));
  for (const [k] of mine.slice(MAX_SESSIONS)) delete sessions[k]; // too many devices: the one unused longest is signed out
  saveSessions();
  const https = isHttps(req);
  res.setHeader('set-cookie', `${https ? COOKIE : COOKIE_PLAIN}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((sessions[sha(tok)].exp - now) / 1000)}${https ? '; Secure' : ''}`);
}
const dropSessions = (username, exceptTok) => { for (const [k, v] of Object.entries(sessions)) if (v.user === username && k !== (exceptTok && sha(exceptTok))) delete sessions[k]; };

const nameOk = (n) => /^[\w .()-]{1,80}$/.test(n) && !n.startsWith('.') && !RESERVED.has(n.toLowerCase());
const dirs = (u) => ({ proj: path.join(dataDir, 'projects', users[u].id), draft: path.join(dataDir, 'drafts', users[u].id), fold: path.join(dataDir, 'folders', users[u].id + '.json') });

// ---- folders: a label layer over the flat design list. Design names stay unique per account; a design lives in at most one folder.
const folderOk = (f) => f === '' || (typeof f === 'string' && f.length <= 200 && f.split('/').every((seg) => nameOk(seg)));
async function readFolders(D) {
  const f = await readJSON(D.fold, null);
  return { folders: Array.isArray(f?.folders) ? f.folders : [], map: nullMap(f?.map && typeof f.map === 'object' ? f.map : {}) };
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

/** A version description from a request header: decoded, one line, control characters removed, 200 characters at most. */
const cleanNote = (h) => { try { return decodeURIComponent(String(h || '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200); } catch { return ''; } };
const verDir = (D, name) => path.join(D.proj, '.versions', name);
async function snapshotVersion(D, name, cur) { // keep the file about to be overwritten
  if (!MAX_VERSIONS) return;
  const dir = verDir(D, name), src = path.join(D.proj, name + '.json');
  const st = await fs.stat(src).catch(() => null);
  if (!st) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(src, path.join(dir, `${cur.rev || 1}.json`));
  await writeJSON(path.join(dir, `${cur.rev || 1}.meta`), { rev: cur.rev || 1, modified: cur.modified || st.mtimeMs, device: cur.device || '', size: st.size, note: cur.note || '', milestone: cur.milestone || '' });
  const revs = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => parseInt(f, 10)).sort((a, b) => b - a);
  for (const r of revs.slice(MAX_VERSIONS)) for (const e of ['.json', '.meta']) await fs.rm(path.join(dir, r + e), { force: true });
}

// ---------------------------------------------------------------- storage limits
const usageCache = new Map(); // username -> { bytes, at }
/** An account's storage limit in bytes (0 = unlimited): the admin's per-person value, else the server default. */
const quotaOf = (username) => { const q = users[username]?.quotaMb; return (Number.isFinite(q) && q >= 0 ? q : Number.isFinite(settings.defaultQuotaMb) ? settings.defaultQuotaMb : DEFAULT_QUOTA_MB) * 1048576; };
async function dirBytes(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name);
    n += e.isDirectory() ? await dirBytes(f) : (await fs.stat(f).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
/** Throws a 413 when saving `incoming` more bytes would put the account over its quota (a design being replaced counts as `replacing`). */
async function checkQuota(username, incoming, replacing = 0) {
  if (MAX_DESIGN_BYTES && incoming > MAX_DESIGN_BYTES) throw Object.assign(new Error('design too large'), { code: 413, msg: `This design is larger than the ${Math.round(MAX_DESIGN_BYTES / 1048576)} MB limit.` });
  const quota = quotaOf(username);
  if (!quota) return;
  let c = usageCache.get(username);
  if (!c || Date.now() - c.at > 30e3) { const D = dirs(username); c = { bytes: (await dirBytes(D.proj)) + (await dirBytes(D.draft)), at: Date.now() }; usageCache.set(username, c); }
  if (c.bytes - replacing + incoming > quota) throw Object.assign(new Error('over quota'), { code: 413, msg: `Your account is over its ${Math.round(quota / 1048576)} MB storage limit. Delete old designs or ask the admin.` });
  c.bytes += Math.max(0, incoming - replacing);
}

// ---------------------------------------------------------------- project storage (shared by the REST API and MCP)
/** Parse a design and check its structure (see design-validate.js). Returns a message, or null when it is fine. */
function checkDesign(text) {
  let d; try { d = JSON.parse(text); } catch { return 'Invalid JSON'; }
  return validateDesign(d);
}
class Conflict extends Error { constructor(seq) { super('conflict'); this.seq = seq; } }
/**
 * Write a design. `seq` counts every write and is what concurrent editors compare; `rev` counts saved versions: an autosave
 * (opts.auto) updates the file in place and does not add a version, a normal save keeps the file it replaces in the history.
 * ifSeq: undefined or '*' = no check. Returns { rev, seq }.
 */
async function writeProject(username, name, objStr, device, ifSeq, opts = {}) {
  const D = dirs(username), file = path.join(D.proj, name + '.json');
  const bad = checkDesign(objStr);
  if (bad) throw Object.assign(new Error(bad), { code: 400, msg: bad });
  await fs.mkdir(D.proj, { recursive: true }); await fs.mkdir(D.draft, { recursive: true });
  const exists = await fs.stat(file).catch(() => null);
  await checkQuota(username, Buffer.byteLength(objStr), exists?.size || 0);
  const cur = await readMeta(D.proj, name);
  if (exists && ifSeq !== undefined && ifSeq !== '*' && +ifSeq !== cur.seq) throw Object.assign(new Conflict(cur.seq), { rev: cur.rev, modified: exists.mtimeMs, device: cur.device || '' });
  const rev = opts.auto && exists ? cur.rev || 1 : (cur.rev || 0) + 1, seq = (cur.seq || 0) + 1;
  // The file on disk is the saved version until an autosave first changes it, so keep it then (once); a later save finds it already kept.
  if (exists && !cur.autosaved) await snapshotVersion(D, name, { ...cur, modified: cur.modified || exists.mtimeMs });
  await fs.writeFile(file, objStr);
  await writeJSON(path.join(D.proj, name + '.meta'), { rev, seq, modified: Date.now(), device, note: opts.auto && exists ? cur.note || '' : opts.note || '', milestone: opts.auto && exists ? cur.milestone || '' : opts.milestone || '', ...(opts.auto && exists ? { autosaved: true } : {}) }); // a description belongs to the version that was saved with it
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
    if (!nameOk(name)) return null; // never build a file path from an unchecked name
    const D = dirs(u), raw = await fs.readFile(path.join(D.proj, name + '.json'), 'utf8').catch(() => null);
    if (raw === null) return null;
    const obj = JSON.parse(raw), bad = validateDesign(obj);
    if (bad) throw new Error('This design cannot be opened by an assistant: ' + bad);
    return { obj, rev: (await readMeta(D.proj, name)).seq };
  },
  async write(u, name, obj, device, rev) {
    if (!nameOk(name)) throw new Error('Invalid design name.');
    try { return (await writeProject(u, name, JSON.stringify(obj), device, rev)).seq; }
    catch (e) { if (e instanceof Conflict) throw new Error('The design was changed by someone else while this edit was being made. Fetch it again and retry.'); throw e; }
  },
};

// ---- MCP access tokens (per user; only the SHA-256 is stored)
const mcpFile = path.join(dataDir, 'mcp-tokens.json');
let mcpTokens = nullMap(await readJSON(mcpFile, {})); // id -> {hash, user, name, created, lastUsed}
const saveMcp = () => writeJSON(mcpFile, mcpTokens);
if (settings.allowMcp === undefined) settings.allowMcp = process.env.ALLOW_MCP !== 'false';
const mcpPool = createPool({ storage: mcpStorage, size: Math.max(1, +process.env.MCP_WORKERS || 2), timeoutMs: (+process.env.MCP_TIMEOUT_SECONDS || 20) * 1000, memoryMb: +process.env.MCP_WORKER_MEMORY_MB || 512 });
const mcpHandle = createMcp({ storage: mcpStorage, pool: mcpPool, device: 'Claude / ChatGPT (MCP)' });
// Tokens are only accepted in the Authorization header: a token in a URL ends up in proxy logs, browser history and referrers.
const MCP_RATE = Math.max(1, +process.env.MCP_RATE_PER_MIN || 60);         // calls per minute for one token
const MCP_STRIKES = 5, STRIKE_WINDOW = 10 * 60e3;                          // this many strikes in ten minutes pauses the token
const mcpOrigins = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean); // browser origins allowed to call /mcp; none by default
// OAuth, so assistants with an "Add custom connector" screen (Claude, ChatGPT) can connect: see oauth.js. PUBLIC_URL pins the address the metadata advertises.
const oauth = await createOAuth({ dataDir, mcpTokens, saveMcp, users, send, readBody, readJSONBody, rate, log, sha, clientIp, isHttps, publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '') });
const mcpUser = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]), id = Object.keys(mcpTokens).find((k) => mcpTokens[k].hash === h), ent = id && mcpTokens[id];
  if (!ent || !users[ent.user] || oauth.expired(ent)) return null; // an expired app token is refused so the app asks for a new one
  if (Date.now() - (ent.lastUsed || 0) > 60e3) { ent.lastUsed = Date.now(); saveMcp(); }
  return { user: ent.user, id, ent };
};
/** A token misbehaved (too many calls, work that timed out or ran out of memory). Enough of those and it is paused until its owner resumes it. */
function strikeToken(id, kind, ip) {
  const ent = mcpTokens[id];
  if (!ent || ent.paused) return;
  const now = Date.now();
  ent.strikes = [...(ent.strikes || []).filter((t) => now - t < STRIKE_WINDOW), now];
  log('mcp_strike', ip, `user=${ent.user} token=${id.slice(0, 8)} reason=${kind} count=${ent.strikes.length}`);
  if (ent.strikes.length >= MCP_STRIKES) { ent.paused = { at: now, reason: kind }; ent.strikes = []; log('mcp_token_paused', ip, `user=${ent.user} token=${id.slice(0, 8)} reason=${kind}`); }
  saveMcp();
}
async function mcpEndpoint(req, res, url) {
  const origin = req.headers.origin;
  if (origin) { // a browser page is calling: only origins the admin listed may, and they get CORS headers
    if (!(mcpOrigins.includes('*') || mcpOrigins.includes(origin))) { log('mcp_origin_refused', clientIp(req), origin.slice(0, 80)); return send(res, 403, { error: 'This origin is not allowed to call the MCP endpoint. Set MCP_ALLOWED_ORIGINS on the server to allow it.' }); }
    res.setHeader('access-control-allow-origin', mcpOrigins.includes('*') ? '*' : origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!settings.allowMcp) return send(res, 403, { error: 'MCP access is turned off on this server.' });
  const ip = clientIp(req), who = url.pathname === '/mcp' ? mcpUser(req) : null;
  if (!who) {
    const presented = !!req.headers.authorization; // a request with no token at all is just a connector discovering how to sign in: not counted as a failure
    if (presented) {
      const wait = rate('mcpfail:' + ip, 20, 15 * 60e3);
      log('mcp_auth_failed', ip);
      if (wait) { res.setHeader('retry-after', String(wait)); return send(res, 429, { error: 'Too many attempts. Try again later.' }); }
    }
    res.setHeader('www-authenticate', `Bearer realm="sketchy", resource_metadata="${oauth.base(req)}/.well-known/oauth-protected-resource"${presented ? ', error="invalid_token"' : ''}`);
    return send(res, 401, { error: 'Sign in needed. Add Sketchy as a connector in your assistant, or send an access token as "Authorization: Bearer <token>" (create one under Account in Sketchy).' });
  }
  if (who.ent.paused) return send(res, 403, { error: 'This token was paused after repeated problems (' + who.ent.paused.reason + '). Resume it under Account, then AI assistants.' });
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'Use POST with a JSON-RPC body.' }); }
  const wait = Math.max(rate('mcptok:' + who.id, MCP_RATE, 60e3), rate('mcpuser:' + who.user, MCP_RATE * 2, 60e3)); // each call can rebuild a whole design
  if (wait) { strikeToken(who.id, 'rate_limited', ip); res.setHeader('retry-after', String(wait)); return send(res, 429, { error: 'Too many requests. Slow down.' }); }
  const body = await readJSONBody(req, 4e6);
  if (!body) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const out = await mcpHandle(who.user, body, { strike: (kind) => strikeToken(who.id, kind, ip) });
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
      if (ss && ss.exp - Date.now() < SESSION_MS - DAY && ss.exp < ss.created + SESSION_MAX_MS) setSession(req, res, user, tok, ss);
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
      if (!userRe.test(username) || RESERVED.has(username)) return send(res, 400, { error: 'Username: 3–32 chars, a–z, 0–9, _ or -.' });
      if (!pwOk(password, username)) return send(res, 400, { error: pwMsg });
      if (await breachedCount(password)) return send(res, 400, { error: breachMsg });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      users[username] = { id: crypto.randomUUID(), ...(await newHash(password)), created: Date.now(), lastLogin: Date.now(), admin: first };
      await saveUsers();
      log('registered', ip, `user=${username}${first ? ' (first account, admin)' : ''}`);
      setSession(req, res, username);
      return send(res, 200, { user: username, admin: first });
    }
    const ipKey = 'ip:' + ip, userKey = 'user:' + username, wait = lockedFor(ipKey, userKey);
    if (wait) return send(res, 429, { error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60e3)} minute${wait > 60e3 ? 's' : ''}.` });
    const u = users[username];
    const hash = await scrypt(password, u?.salt || '0'.repeat(32));
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) { noteFailure(ipKey, userKey); log('login_failed', ip, `user=${JSON.stringify(username.slice(0, 32))}${lockedFor(ipKey, userKey) ? ' LOCKED_OUT' : ''}`); return send(res, 401, { error: 'Wrong username or password.' }); }
    if (u.totp?.enabled) { // the password was right; the session starts only after the second step
      for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
      const ticket = crypto.randomBytes(24).toString('base64url');
      tickets.set(ticket, { user: username, exp: Date.now() + 5 * 60e3, tries: 0 });
      return send(res, 200, { totp: true, ticket });
    }
    clearFailures(ipKey, userKey);
    u.lastLogin = Date.now(); await saveUsers();
    setSession(req, res, username);
    return send(res, 200, { user: username, admin: !!u.admin });
  }

  if (p === '/api/login/totp') {
    if (req.method !== 'POST') return send(res, 405, {});
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    noteAttempt(ip);
    const b = await readJSONBody(req, 1024), t = b && tickets.get(String(b.ticket || ''));
    if (!t || t.exp < Date.now() || !users[t.user]) return send(res, 401, { error: 'That sign-in expired. Enter your password again.', expired: true });
    const ipKey = 'ip:' + ip, userKey = 'user:' + t.user, wait = lockedFor(ipKey, userKey);
    if (wait) return send(res, 429, { error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60e3)} minute${wait > 60e3 ? 's' : ''}.` });
    const u = users[t.user], how = checkSecondFactor(u, b.code);
    if (!how) {
      noteFailure(ipKey, userKey); log('totp_failed', ip, `user=${t.user}`);
      if (++t.tries >= 5) tickets.delete(b.ticket);
      return send(res, 401, { error: 'That code is not right.', expired: t.tries >= 5 });
    }
    tickets.delete(b.ticket); clearFailures(ipKey, userKey);
    u.lastLogin = Date.now(); await saveUsers();
    if (how === 'recovery') log('totp_recovery_code_used', ip, `user=${t.user} left=${u.totp.recovery.length}`);
    setSession(req, res, t.user);
    return send(res, 200, { user: t.user, admin: !!u.admin, ...(how === 'recovery' ? { recoveryLeft: u.totp.recovery.length } : {}) });
  }

  if (p === '/api/logout') {
    if (req.method !== 'POST') return send(res, 405, {});
    const tok = tokenOf(req);
    if (tok) { delete sessions[sha(tok)]; saveSessions(); }
    res.setHeader('set-cookie', [`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`, `${COOKIE_PLAIN}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`]);
    return send(res, 200, {});
  }

  if (!user) return send(res, 401, { error: 'Sign in to continue.' });
  if (p.startsWith('/api/oauth/') && await oauth.api(req, res, url, user)) return;

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
    if (!pwOk(b.next, user)) return send(res, 400, { error: pwMsg });
    if (await breachedCount(b.next)) return send(res, 400, { error: breachMsg });
    Object.assign(u, await newHash(b.next));
    log('password_changed', ip, `user=${user}`);
    dropSessions(user, tokenOf(req)); // sign out other devices
    await saveUsers(); await saveSessions();
    return send(res, 200, {});
  }

  // ---- two-step sign-in, optional for every account
  if (p.startsWith('/api/totp')) {
    const u = users[user], t = u.totp;
    if (p === '/api/totp' && req.method === 'GET') return send(res, 200, { enabled: !!t?.enabled, recoveryLeft: t?.enabled ? (t.recovery || []).length : 0 });
    if (req.method !== 'POST') return send(res, 405, {});
    if (throttled(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
    noteAttempt(ip);
    const b = await readJSONBody(req, 1024) || {};
    const pwOkNow = async () => { const h = await scrypt(String(b.password || ''), u.salt); return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash)); };
    if (p === '/api/totp/setup') {
      if (t?.enabled) return send(res, 409, { error: 'Two-step sign-in is already on.' });
      if (!(await pwOkNow())) return send(res, 401, { error: 'Password is wrong.' });
      const secret = b32encode(crypto.randomBytes(20));
      u.totp = { enabled: false, pending: secret, last: 0, recovery: [] };
      await saveUsers();
      const uri = `otpauth://totp/Sketchy:${encodeURIComponent(user)}?secret=${secret}&issuer=Sketchy&algorithm=SHA1&digits=6&period=30`;
      return send(res, 200, { secret, uri });
    }
    if (p === '/api/totp/enable') {
      if (!t?.pending) return send(res, 400, { error: 'Start the setup first.' });
      const st = totpStep(t.pending, b.code);
      if (st === null) return send(res, 400, { error: 'That code is not right. Check the time on your phone and try the next code.' });
      const codes = newRecoveryCodes();
      u.totp = { enabled: true, secret: t.pending, last: st, recovery: codes.map((c) => sha(normRecovery(c))) };
      await saveUsers(); log('totp_enabled', ip, `user=${user}`);
      return send(res, 200, { recoveryCodes: codes });
    }
    if (p === '/api/totp/disable') {
      if (!t?.enabled) return send(res, 400, { error: 'Two-step sign-in is not on.' });
      if (!(await pwOkNow())) return send(res, 401, { error: 'Password is wrong.' });
      if (!checkSecondFactor(u, b.code)) return send(res, 401, { error: 'That code is not right.' });
      delete u.totp; await saveUsers(); log('totp_disabled', ip, `user=${user}`);
      return send(res, 200, {});
    }
    return send(res, 404, { error: 'Not found' });
  }

  if (p === '/api/storage' && req.method === 'GET') { // how much room this account has used
    const D0 = dirs(user);
    return send(res, 200, { used: (await dirBytes(D0.proj)) + (await dirBytes(D0.draft)), quota: quotaOf(user) });
  }

  // ---- signed-in devices
  if (p === '/api/sessions' && req.method === 'GET') {
    const cur = tokenOf(req) && sha(tokenOf(req));
    return send(res, 200, Object.entries(sessions).filter(([, v]) => v.user === user && !gone(v)).sort((a, b) => (b[1].last || 0) - (a[1].last || 0)).map(([k, v]) => ({ id: k.slice(0, 16), device: v.device || 'Unknown device', created: v.created, last: v.last, current: k === cur })));
  }
  if (p === '/api/sessions/others' && req.method === 'POST') { dropSessions(user, tokenOf(req)); await saveSessions(); log('sessions_ended', ip, `user=${user}`); return send(res, 200, {}); }
  const sm = /^\/api\/sessions\/([0-9a-f]{16})$/.exec(p);
  if (sm && req.method === 'DELETE') {
    const key = Object.keys(sessions).find((k) => k.startsWith(sm[1]) && sessions[k].user === user);
    if (!key) return send(res, 404, { error: 'No such session.' });
    delete sessions[key]; await saveSessions();
    return send(res, 200, {});
  }

  // ---- MCP access tokens (own tokens only)
  if (p === '/api/mcp/tokens') {
    if (req.method === 'GET') return send(res, 200, { enabled: settings.allowMcp, tokens: Object.entries(mcpTokens).filter(([, t]) => t.user === user).map(([id, t]) => ({ id, name: t.name, created: t.created, lastUsed: t.lastUsed || 0, paused: t.paused || null, app: !!t.oauth })) });
    if (req.method === 'POST') {
      if (!settings.allowMcp) return send(res, 403, { error: 'MCP access is turned off on this server.' });
      const b = await readJSONBody(req, 1024);
      const nm = String(b?.name || '').trim().slice(0, 60) || 'Assistant';
      if (Object.values(mcpTokens).filter((t) => t.user === user && !t.oauth).length >= 10) return send(res, 400, { error: 'You can have up to 10 tokens. Revoke one first.' });
      const token = 'skm_' + crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomUUID();
      mcpTokens[id] = { hash: sha(token), user, name: nm, created: Date.now(), lastUsed: 0 };
      log('mcp_token_created', ip, `user=${user}`);
      await saveMcp();
      return send(res, 200, { id, name: nm, token }); // the only time the token is shown
    }
    return send(res, 405, {});
  }
  const rm = /^\/api\/mcp\/tokens\/([\w-]+)\/resume$/.exec(p);
  if (rm && req.method === 'POST') {
    if (mcpTokens[rm[1]]?.user !== user) return send(res, 404, { error: 'No such token.' });
    delete mcpTokens[rm[1]].paused; mcpTokens[rm[1]].strikes = []; await saveMcp(); log('mcp_token_resumed', ip, `user=${user}`);
    return send(res, 200, {});
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
      if (req.method === 'GET') return send(res, 200, { ...settings, ...loginCfg(), defaultQuotaMb: Number.isFinite(settings.defaultQuotaMb) ? settings.defaultQuotaMb : DEFAULT_QUOTA_MB });
      if (req.method === 'PUT') {
        const b = await readJSONBody(req, 1024);
        if (typeof b?.allowRegistration === 'boolean') settings.allowRegistration = b.allowRegistration;
        if (typeof b?.allowMcp === 'boolean') settings.allowMcp = b.allowMcp;
        if (typeof b?.breachCheck === 'boolean') settings.breachCheck = b.breachCheck;
        if (b && 'idleMinutes' in b) { const n = Number(b.idleMinutes); if (!Number.isFinite(n) || (n !== 0 && (n < 0.02 || n > 525600))) return send(res, 400, { error: 'Idle time must be 0 (never sign out) or a number of minutes up to 525600.' }); settings.idleMinutes = n; }
        if (b && 'defaultQuotaMb' in b) { const n = Number(b.defaultQuotaMb); if (!Number.isInteger(n) || n < 0 || n > 1e7) return send(res, 400, { error: 'Storage must be a whole number of megabytes from 0 (no limit) to 10000000.' }); settings.defaultQuotaMb = n; usageCache.clear(); }
        const lim = { maxFailedLogins: [0, 1000], failWindowMinutes: [1, 10080], lockoutMinutes: [1, 10080] };
        for (const [k, [lo, hi]] of Object.entries(lim)) if (b && k in b) {
          const n = Number(b[k]);
          if (!Number.isInteger(n) || n < lo || n > hi) return send(res, 400, { error: `${k === 'maxFailedLogins' ? 'Failed sign-ins' : 'Minutes'} must be a whole number from ${lo} to ${hi}.` });
          settings[k] = n;
        }
        await saveSettings(); return send(res, 200, { ...settings, ...loginCfg(), defaultQuotaMb: Number.isFinite(settings.defaultQuotaMb) ? settings.defaultQuotaMb : DEFAULT_QUOTA_MB });
      }
    }
    if (parts[0] === 'lockouts') { // who is locked out right now, and a way to let them back in
      if (req.method === 'GET') { const now = Date.now(); return send(res, 200, [...failures].filter(([, f]) => f.until > now).map(([key, f]) => ({ key, kind: key.startsWith('ip:') ? 'address' : 'username', name: key.slice(key.indexOf(':') + 1), minutes: Math.ceil((f.until - now) / 60e3) }))); }
      if (req.method === 'DELETE') { const k = url.searchParams.get('key'); if (k) failures.delete(k); else failures.clear(); return send(res, 200, {}); }
    }
    if (parts[0] === 'users' && !parts[1] && req.method === 'POST') { // an admin adds a person; with no password a temporary one is generated
      const b = await readJSONBody(req, 4096);
      const username = String(b?.username || '').trim().toLowerCase();
      if (!userRe.test(username) || RESERVED.has(username)) return send(res, 400, { error: 'Username: 3–32 chars, a–z, 0–9, _ or -.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      const generated = !b?.password, pw = generated ? crypto.randomBytes(9).toString('base64url') : String(b.password);
      if (!pwOk(pw, username)) return send(res, 400, { error: pwMsg });
      if (!generated && await breachedCount(pw)) return send(res, 400, { error: breachMsg });
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
        const used = await dirBytes(d) + await dirBytes(path.join(dataDir, 'drafts', u.id));
        return { name, created: u.created, lastLogin: u.lastLogin || 0, admin: !!u.admin, designs: files.length, bytes: used, quotaMb: Number.isFinite(u.quotaMb) ? u.quotaMb : null, effectiveQuotaMb: Math.round(quotaOf(name) / 1048576), totp: !!u.totp?.enabled };
      }));
      return send(res, 200, list.sort((a, b) => a.name.localeCompare(b.name)));
    }
    const target = parts[0] === 'users' && users[parts[1]] && parts[1];
    if (!target) return send(res, 404, { error: 'No such user.' });
    if (parts[2] === 'password' && req.method === 'POST') {
      const b = await readJSONBody(req, 1024);
      const pw = b?.password || crypto.randomBytes(9).toString('base64url');
      if (!pwOk(pw, target)) return send(res, 400, { error: pwMsg });
      if (b?.password && await breachedCount(pw)) return send(res, 400, { error: breachMsg });
      Object.assign(users[target], await newHash(pw));
      dropSessions(target);
      await saveUsers(); await saveSessions();
      return send(res, 200, { password: pw });
    }
    if (parts[2] === 'quota' && req.method === 'PUT') { // null = follow the server default; 0 = no limit
      const b = await readJSONBody(req, 256);
      if (b?.quotaMb === null) delete users[target].quotaMb;
      else {
        const n = Number(b?.quotaMb);
        if (b?.quotaMb === '' || !Number.isInteger(n) || n < 0 || n > 1e7) return send(res, 400, { error: 'Storage must be a whole number of megabytes (0 = no limit).' });
        users[target].quotaMb = n;
      }
      usageCache.delete(target); await saveUsers(); log('quota_changed', ip, `user=${target} by=${user} quotaMb=${users[target].quotaMb ?? 'default'}`);
      return send(res, 200, { quotaMb: users[target].quotaMb ?? null, effectiveQuotaMb: Math.round(quotaOf(target) / 1048576) });
    }
    if (parts[2] === 'totp' && req.method === 'DELETE') { // for someone who lost their phone and recovery codes
      delete users[target].totp; await saveUsers(); log('totp_reset_by_admin', ip, `user=${target} by=${user}`);
      return send(res, 200, {});
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
      const body = await readBody(req, MAX_DESIGN_BYTES || 200e6);
      { const bad = checkDesign(body.toString()); if (bad) return send(res, 400, { error: bad }); }
      await checkQuota(user, body.length, (await fs.stat(f).catch(() => ({ size: 0 }))).size);
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
        return { name: n, modified: st.mtimeMs, size: st.size, ver: m.rev || 1, seq: m.seq || 1, device: m.device || '', note: m.note || '', milestone: m.milestone || '', thumb: thumbs.has(n + '.jpg'), folder: fmap[n] || '' };
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
      const body = await readBody(req, MAX_DESIGN_BYTES || 200e6);
      let obj; try { obj = JSON.parse(body.toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const folderHdr = req.headers['x-folder'] !== undefined ? decodeURIComponent(String(req.headers['x-folder'])) : null;
      if (folderHdr !== null && !folderOk(folderHdr)) return send(res, 400, { error: 'Invalid folder name.' });
      // optimistic concurrency: the client says which write (seq) it started from; x-autosave: 1 updates in place without adding a version
      const thumb = typeof obj.thumb === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(obj.thumb);
      delete obj.thumb;
      let res2;
      try { res2 = await writeProject(user, name, JSON.stringify(obj), device, req.headers['if-match'], { auto: req.headers['x-autosave'] === '1', note: cleanNote(req.headers['x-note']), milestone: cleanNote(req.headers['x-milestone']) }); }
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

// Headers every response carries. The CSP is the main defence if a malicious design file ever manages to put markup on the page:
// scripts may only come from this server (no inline script, no eval) and styles from files only (no style attributes or style tags), and nothing can be framed, posted elsewhere or sent off-site.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function harden(req, res, api) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (api) res.setHeader('cache-control', 'no-store'); else { res.setHeader('content-security-policy', CSP); res.setHeader('cross-origin-resource-policy', 'same-origin'); }
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) res.setHeader('strict-transport-security', 'max-age=31536000');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const isMcp = url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'), isOauth = url.pathname.startsWith('/.well-known/oauth-') || url.pathname === '/oauth/register' || url.pathname === '/oauth/token', isApi = url.pathname.startsWith('/api/') || isOauth;
    harden(req, res, isMcp || isApi);
    if (!hostOk(req)) { log('bad_host', clientIp(req), String(req.headers.host || '').slice(0, 60)); res.setHeader('content-type', 'text/plain'); res.statusCode = 421; return res.end('This address is not one this server answers to. Set PUBLIC_URL or ALLOWED_HOSTS to the address you use.'); }
    const ip = clientIp(req), wait = rate((isMcp ? 'mcp:' : isApi ? 'api:' : 'static:') + ip, isMcp ? 600 : isApi ? 1500 : 900, 60e3);
    if (wait) { log('rate_limited', ip, url.pathname.slice(0, 40)); res.setHeader('retry-after', String(wait)); return send(res, 429, { error: 'Too many requests. Slow down.' }); }
    if (isMcp) return await mcpEndpoint(req, res, url);
    if (isOauth && await oauth.handle(req, res, url)) return;
    if (isApi) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); res.statusCode = 405; return res.end(); }
    const p = path.normalize(path.join(root, url.pathname === '/' || url.pathname === '/oauth/authorize' ? 'index.html' : url.pathname)); // the approval page is part of the app
    if (p !== root && !p.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
    const body = await fs.readFile(p).catch(() => null);
    if (!body) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
    if (p.startsWith(path.join(root, 'assets') + path.sep)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    else res.setHeader('cache-control', 'no-cache'); // the page itself is re-checked on every visit, so an upgrade shows up straight away
    res.end(body);
  } catch (e) { if (e.code === 413) res.setHeader('connection', 'close'); /* the unread upload makes the connection unusable */ if (e.code !== 413) console.error(`${new Date().toISOString()} server_error ${e.stack || e}`); const known = e.code === 413 || (e.code === 400 && e.msg); send(res, known ? e.code : 500, { error: known ? e.msg || 'File too large' : 'Server error' }); }
});
server.requestTimeout = 5 * 60e3; server.headersTimeout = 30e3; server.keepAliveTimeout = 5e3; server.maxHeadersCount = 100;
server.listen(port, () => { if (!STRICT_HOSTS) console.log('Host check: only IP addresses, localhost and local names are accepted. If you reach Sketchy by a public name, set PUBLIC_URL (or ALLOWED_HOSTS) to it.'); console.log(`Sketchy on :${port}, data in ${dataDir}, registration ${settings.allowRegistration ? 'open' : 'closed'}${TRUST_PROXY ? '' : ', proxy headers ignored'}`); });
process.on('unhandledRejection', (e) => console.error(`${new Date().toISOString()} unhandled_rejection ${e?.stack || e}`));
