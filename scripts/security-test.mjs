// Starts the real server on a throwaway data folder and checks the security behaviour end to end.
// Needs `npm run build` first (the server serves dist/). Run with `npm run test:security`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import zlib from 'node:zlib';

const port = 8300 + Math.floor(Math.random() * 500), base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketchy-sec-'));
const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_USER: 'boss', ADMIN_PASSWORD: 'correct-horse-battery', MAX_DESIGN_MB: '1', TRUST_PROXY: 'false', MCP_RATE_PER_MIN: '90', AUTH_ATTEMPTS_PER_15MIN: '300', MAX_SESSIONS_PER_USER: '3', MCP_ALLOWED_ORIGINS: 'https://allowed.example' };
// A stand-in for the Have I Been Pwned range API: one known leaked password, and one prefix on which the "service" is down
const sha1 = (t) => crypto.createHash('sha1').update(t).digest('hex').toUpperCase();
const LEAKED = 'leaked-password-123', OFFLINE = 'offline-pass-1234';
const seen = [];
const fake = http.createServer((req, res) => {
  const prefix = req.url.split('/').pop(); seen.push(prefix);
  if (prefix === sha1(OFFLINE).slice(0, 5)) { res.statusCode = 500; return res.end('down'); }
  res.end(`${sha1(LEAKED).slice(5)}:41\r\n0123456789ABCDEF0123456789ABCDEF012:0\r\n`);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
env.HIBP_URL = `http://127.0.0.1:${fake.address().port}/range/`;
const srv = spawn(process.execPath, [process.env.SERVER_FILE || 'server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 50 && !out.includes('Sketchy on'); i++) await new Promise((r) => setTimeout(r, 100));


// TOTP, written independently of server.js so the two can disagree
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = (str) => { let bits = ''; for (const c of str) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
const hotp = (key, step, digits = 6) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', key).update(m).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0'); };
const codeFor = (secret, offset = 0) => hotp(unb32(secret), Math.floor(Date.now() / 30e3) + offset);

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };
let cookie = '';
const call = async (method, p, body, headers = {}, raw = false) => {
  const r = await fetch(base + p, { method, headers: { 'x-sketchy': '1', ...(cookie ? { cookie } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() || [];
  const ses = sc.find((c) => c.startsWith('sketchy_session=')); if (ses) cookie = ses.split(';')[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
};

try {
  console.log('Headers');
  const page = await call('GET', '/');
  check('page has a CSP without unsafe-inline scripts', /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval';/.test(page.headers.get('content-security-policy') || '') && !/script-src[^;]*unsafe-inline/.test(page.headers.get('content-security-policy') || ''));
  check('frames are refused', page.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''));
  check('nosniff and no-referrer', page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('referrer-policy') === 'no-referrer');
  const me = await call('GET', '/api/me');
  check('API responses are not cached', me.headers.get('cache-control') === 'no-store');
  const tls = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
  check('HSTS only over https', !!tls.headers.get('strict-transport-security') && !page.headers.get('strict-transport-security'));

  console.log('Static files');
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/assets/../../server.js', '/%00']) {
    const r = await call('GET', p);
    check(`no traversal via ${p}`, !/createMcp/.test(r.text), String(r.status));
  }
  check('POST to a static path is refused', (await call('POST', '/index.html', '{}', {}, true)).status === 405);

  console.log('Accounts');
  check('first account comes from ADMIN_USER', (await call('GET', '/api/me')).json.setup === false);
  check('registration is closed', (await call('POST', '/api/register', { username: 'mallory', password: 'zzzz-yyyy-xxxx' })).status === 403);
  check('POST without the CSRF header is refused', (await fetch(base + '/api/login', { method: 'POST', body: '{}' })).status === 403);
  const bad = await call('POST', '/api/login', { username: 'boss', password: 'wrong-password' });
  check('wrong password is 401', bad.status === 401);
  const login = await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('login works and sets an HttpOnly Strict cookie', login.status === 200 && /HttpOnly/.test(login.headers.getSetCookie().join(';')) && /SameSite=Strict/.test(login.headers.getSetCookie().join(';')));
  check('GET logout is refused', (await call('GET', '/api/logout')).status === 405);
  for (const username of ['__proto__', 'constructor']) check(`admin cannot create "${username}"`, (await call('POST', '/api/admin/users', { username, password: 'a-fine-password-1' })).status === 400);
  check('"password" is rejected', (await call('POST', '/api/admin/users', { username: 'weak', password: 'password' })).status === 400);
  check('password equal to the username is rejected', (await call('POST', '/api/admin/users', { username: 'samesame', password: 'samesame' })).status === 400);
  check('a good password is accepted', (await call('POST', '/api/admin/users', { username: 'friend', password: 'a-fine-password-1' })).status === 200);


  console.log('Two-step sign-in');
  check('TOTP matches the RFC 6238 test vector', hotp(Buffer.from('12345678901234567890'), 1, 8) === '94287082');
  await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('setup needs the password', (await call('POST', '/api/totp/setup', { password: 'nope-nope-nope' })).status === 401);
  const setup = await call('POST', '/api/totp/setup', { password: 'correct-horse-battery' });
  check('setup returns a key and an otpauth link', setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.json.secret) && setup.json.uri.startsWith('otpauth://totp/'));
  check('a wrong code does not turn it on', (await call('POST', '/api/totp/enable', { code: '000000' })).status === 400);
  const en = await call('POST', '/api/totp/enable', { code: codeFor(setup.json.secret) });
  check('the right code turns it on and gives 8 recovery codes', en.status === 200 && en.json.recoveryCodes.length === 8);
  const secret = setup.json.secret, rec = en.json.recoveryCodes;
  cookie = '';
  const step1 = await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('password alone no longer signs in', step1.json.totp === true && !cookie && !!step1.json.ticket);
  check('no session without the second step', (await call('GET', '/api/projects')).status === 401);
  check('a wrong code is refused', (await call('POST', '/api/login/totp', { ticket: step1.json.ticket, code: '123456' })).status === 401);
  const okCode = codeFor(secret, 1); // the next step: the one after the code used to enable (which is now spent)
  const done = await call('POST', '/api/login/totp', { ticket: step1.json.ticket, code: okCode });
  check('the right code signs in', done.status === 200 && !!cookie, String(done.status));
  cookie = '';
  const step1b = await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('the same code cannot be used twice', (await call('POST', '/api/login/totp', { ticket: step1b.json.ticket, code: okCode })).status === 401);
  const viaRecovery = await call('POST', '/api/login/totp', { ticket: step1b.json.ticket, code: rec[0] });
  check('a recovery code signs in once', viaRecovery.status === 200 && viaRecovery.json.recoveryLeft === 7);
  cookie = '';
  const step1c = await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('a used recovery code is dead', (await call('POST', '/api/login/totp', { ticket: step1c.json.ticket, code: rec[0] })).status === 401);
  check('a made-up ticket is refused', (await call('POST', '/api/login/totp', { ticket: 'x', code: rec[1] })).status === 401);
  const ok2 = await call('POST', '/api/login/totp', { ticket: step1c.json.ticket, code: rec[1] });
  check('another recovery code works', ok2.status === 200);
  check('disable needs password and code', (await call('POST', '/api/totp/disable', { password: 'correct-horse-battery', code: '111111' })).status === 401);
  const dis = await call('POST', '/api/totp/disable', { password: 'correct-horse-battery', code: rec[2] });
  check('disable works with a recovery code', dis.status === 200 && (await call('GET', '/api/totp')).json.enabled === false);

  console.log('Storage allocation');
  const list = (await call('GET', '/api/admin/users')).json;
  const bossRow = list.find((u) => u.name === 'boss');
  check('the user list shows the quota and whether 2FA is on', bossRow && 'effectiveQuotaMb' in bossRow && 'totp' in bossRow);
  check('the admin can set one person\'s quota', (await call('PUT', '/api/admin/users/friend/quota', { quotaMb: 1 })).json.effectiveQuotaMb === 1);
  check('a bad quota is refused', (await call('PUT', '/api/admin/users/friend/quota', { quotaMb: -5 })).status === 400);
  check('"use the default" works', (await call('PUT', '/api/admin/users/friend/quota', { quotaMb: null })).json.quotaMb === null);
  check('the default can be changed', (await call('PUT', '/api/admin/settings', { defaultQuotaMb: 3 })).json.defaultQuotaMb === 3);
  await call('PUT', '/api/admin/users/boss/quota', { quotaMb: 1 });
  const chunk = JSON.stringify({ features: [], pad: 'x'.repeat(600e3) });
  const w1 = await call('PUT', '/api/projects/q1', chunk, {}, true), w2 = await call('PUT', '/api/projects/q2', chunk, {}, true);
  check('writes stop at the account limit', w1.status === 200 && w2.status === 413, `${w1.status}/${w2.status}`);
  check('the admin can lift it (0 = no limit)', (await call('PUT', '/api/admin/users/boss/quota', { quotaMb: 0 })).json.effectiveQuotaMb === 0 && (await call('PUT', '/api/projects/q2', chunk, {}, true)).status === 200);
  const st = (await call('GET', '/api/storage')).json;
  check('a person can see their own usage', st.used > 1e6 && st.quota === 0);

  console.log('Design names and storage');
  for (const n of ['..%2F..%2Fusers', '..', '.hidden', '__proto__']) check(`REST refuses name ${n}`, [400, 404].includes((await call('GET', `/api/projects/${n}`)).status));
  const big = JSON.stringify({ features: [], pad: 'x'.repeat(1.2e6) });
  check('a design over the size limit is refused', (await call('PUT', '/api/projects/huge', big, {}, true)).status === 413);
  check('a normal design saves', (await call('PUT', '/api/projects/small', { features: [] })).status === 200);


  console.log('Version descriptions');
  cookie = ''; await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  await call('PUT', '/api/projects/Noted', { features: [], v: 1 }, { 'x-note': encodeURIComponent('First pass\u0000\nwith "quotes" <b>') });
  const lst1 = (await call('GET', '/api/projects')).json.find((x) => x.name === 'Noted');
  check('the description is stored, one line, controls removed', lst1.note === 'First pass with "quotes" <b>', JSON.stringify(lst1.note));
  await call('PUT', '/api/projects/Noted', { features: [], v: 1, x: 1 }, { 'x-autosave': '1' });
  check('an autosave keeps the description of that version', (await call('GET', '/api/projects')).json.find((x) => x.name === 'Noted').note === 'First pass with "quotes" <b>');
  await call('PUT', '/api/projects/Noted', { features: [], v: 2 }, { 'x-note': encodeURIComponent('x'.repeat(500)) });
  const vers = (await call('GET', '/api/projects/Noted/versions')).json;
  check('the older version keeps its description in the history', vers[0].rev === 1 && vers[0].note === 'First pass with "quotes" <b>', JSON.stringify(vers[0]));
  const v1 = (await call('GET', '/api/projects/Noted/versions/1')).json;
  check('a kept version holds what was saved, not the autosaves made after it', v1 && v1.v === 1 && v1.x === undefined, JSON.stringify(v1));
  check('descriptions are capped at 200 characters', (await call('GET', '/api/projects')).json.find((x) => x.name === 'Noted').note.length === 200);
  await call('PUT', '/api/projects/Noted', { features: [], v: 3 });
  await call('PUT', '/api/projects/Noted', { features: [], v: 4 }, { 'x-milestone': encodeURIComponent('Release') });
  check('a milestone name is stored with the version', (await call('GET', '/api/projects')).json.find((x) => x.name === 'Noted').milestone === 'Release');
  check('a save without a description has none', (await call('GET', '/api/projects')).json.find((x) => x.name === 'Noted').note === '');

  console.log('Design structure limits');
  const put = (name, obj, raw) => call('PUT', '/api/projects/' + encodeURIComponent(name), raw ?? obj, {}, !!raw);
  const feat = (i, extra = {}) => ({ id: 'f' + i, type: 'primitive', name: 'F' + i, params: { shape: 'box', ...extra } });
  const many = await put('Many', { format: 'sketchy', features: Array.from({ length: 2500 }, (_, i) => feat(i)) });
  check('too many features are refused with a reason', many.status === 400 && /2500 features/.test(many.json?.error || ''), many.text);
  const pat = await put('Pat', { features: [{ id: 'p', type: 'pattern', name: 'P', params: { count: 1e9 } }] });
  check('a pattern of a billion copies is refused', pat.status === 400 && /count/.test(pat.json?.error || ''), pat.text);
  check('the reserved key __proto__ is refused', (await put('Proto', null, '{"features":[],"a":{"__proto__":{"x":1}}}')).status === 400);
  let deep = {}; for (let i = 0; i < 40; i++) deep = { a: deep };
  check('deep nesting is refused', (await put('Deep', { features: [], x: deep })).status === 400);
  check('a feature list that is not a list is refused', (await put('Notlist', { features: { a: 1 } })).status === 400);
  check('a feature with no id or type is refused', (await put('Noid', { features: [{ name: 'x' }] })).status === 400);
  check('an expression that is far too long is refused', (await put('Longexpr', { features: [{ ...feat(1), exprs: { distance: 'a+'.repeat(2000) } }] })).status === 400);
  const imp = await put('Imp', { features: [{ id: 'i', type: 'import', name: 'Part', params: { tris: 1, data: 'A'.repeat(5000) } }] });
  check('an imported mesh that carries more data than it claims is refused', imp.status === 400 && /more data/.test(imp.json?.error || ''), imp.text);
  const bigMesh = await put('Bigmesh', { features: [{ id: 'i', type: 'import', name: 'Part', params: { tris: 9e6, data: 'A' } }] });
  check('too many imported triangles are refused', bigMesh.status === 400 && /triangles/.test(bigMesh.json?.error || ''), bigMesh.text);
  check('an ordinary design with expressions and an import is accepted', (await put('Fine', { format: 'sketchy', features: [feat(1), { id: 'i', type: 'import', name: 'Part', params: { tris: 2, data: 'A'.repeat(96) } }, { ...feat(2), exprs: { sx: 'width*2' } }], params: [{ name: 'width', expr: '10', unit: 'length' }] })).status === 200);
  check('autosave drafts are checked too', (await call('PUT', '/api/drafts/Many', { features: Array.from({ length: 2500 }, (_, i) => feat(i)) })).status === 400);
  // a design that is already on disk (saved by an older version, or put there by hand) must not be handed to the replay workers either.
  // This uses its own account so the calls do not count against the other MCP tests' rate limits.
  await call('POST', '/api/admin/users', { username: 'viewer', password: 'quiet-purple-walrus-9912' });
  const adminCookie = cookie; cookie = '';
  await call('POST', '/api/login', { username: 'viewer', password: 'quiet-purple-walrus-9912' });
  const tok0 = (await call('POST', '/api/mcp/tokens', { name: 'limits' })).json.token;
  cookie = adminCookie;
  const uid = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).viewer.id;
  fs.mkdirSync(path.join(dir, 'projects', uid), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', uid, 'Crafty.json'), JSON.stringify({ format: 'sketchy', features: Array.from({ length: 2500 }, (_, i) => feat(i)) }));
  const g0 = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok0}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_design', arguments: { design: 'Crafty' } } }) })).json();
  check('an assistant is not handed a crafted design on disk to replay', /cannot be opened by an assistant/.test(JSON.stringify(g0)), JSON.stringify(g0).slice(0, 200));

  // An assistant's edits change a design in place. Only the Save button adds a numbered revision.
  const rpcV = async (name, args) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok0}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json());
  await rpcV('create_design', { name: 'Assistant made' });
  for (let i = 0; i < 3; i++) await rpcV('add_feature', { design: 'Assistant made', kind: 'box' });
  const mcpList = await rpcV('list_designs', {});
  let rows = []; try { rows = JSON.parse(mcpList.result.content[0].text); } catch { /* shown below */ }
  check('three assistant edits leave the design on revision 1', rows.find((x) => x.name === 'Assistant made')?.revision === 1, JSON.stringify(mcpList).slice(0, 300));
  const verList = fs.existsSync(path.join(dir, 'projects', uid, '.versions', 'Assistant made')) ? fs.readdirSync(path.join(dir, 'projects', uid, '.versions', 'Assistant made')).filter((f) => f.endsWith('.json')) : [];
  check('and made no more than the one kept copy of the original', verList.length <= 1, verList.join(','));

  console.log('Host header');
  const withHost = (h, port0 = port) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: port0, path: '/api/me', headers: { host: h } }, (rs) => { rs.resume(); rs.on('end', () => resolve(rs.statusCode)); }); r.on('error', reject); r.end(); });
  check('a public-looking name is refused (DNS rebinding)', (await withHost('evil.example.com')) === 421);
  check('localhost, an IP address and a one-word name are accepted', (await withHost('localhost')) === 200 && (await withHost('192.168.1.5:8080')) === 200 && (await withHost('nas')) === 200 && (await withHost('printer.local')) === 200 && (await withHost('[::1]:8080')) === 200);
  const rawStatus = (reqText) => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => c.write(reqText)); let d = ''; c.on('data', (x) => { d += x; if (d.includes('\r\n')) { c.destroy(); resolve(+d.split(' ')[1]); } }); c.on('error', () => resolve(0)); });
  check('a request with an empty or missing Host is refused', (await rawStatus('GET /api/me HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n')) === 421);
  const port2 = port + 700, dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sketchy-host-'));
  const srv2 = spawn(process.execPath, ['server.js'], { env: { ...env, PORT: String(port2), DATA_DIR: dir2, PUBLIC_URL: 'https://sketchy.example.com', ALLOWED_HOSTS: 'extra.example.org, Other.Example.Net' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out2 = ''; srv2.stdout.on('data', (d) => (out2 += d)); srv2.stderr.on('data', (d) => (out2 += d));
  for (let i = 0; i < 50 && !out2.includes('Sketchy on'); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    check('with PUBLIC_URL set, that name is accepted', (await withHost('sketchy.example.com', port2)) === 200 && (await withHost('SKETCHY.example.com:443', port2)) === 200);
    check('ALLOWED_HOSTS adds more names', (await withHost('extra.example.org', port2)) === 200 && (await withHost('other.example.net', port2)) === 200);
    check('localhost still works for the health check', (await withHost('127.0.0.1:8080', port2)) === 200 && (await withHost('localhost', port2)) === 200);
    check('any other name or IP is refused', (await withHost('evil.example.com', port2)) === 421 && (await withHost('192.168.1.5', port2)) === 421 && (await withHost('nas', port2)) === 421);
  } finally { srv2.kill(); }

  console.log('Password hygiene');
  cookie = ''; await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  const mk = (u, pw) => call('POST', '/api/admin/users', { username: u, password: pw });
  check('breach checking is off by default', (await call('GET', '/api/admin/settings')).json.breachCheck === false && (await mk('pwoff', LEAKED)).status === 200);
  check('an admin can turn it on', (await call('PUT', '/api/admin/settings', { breachCheck: true })).json.breachCheck === true);
  const b1 = await mk('pwon', LEAKED);
  check('a leaked password is refused, with a reason', b1.status === 400 && /data breach/.test(b1.json?.error || ''), b1.text);
  check('a password that has not leaked is accepted', (await mk('pwfine', 'quiet-purple-walrus-7731')).status === 200);
  check('a generated password is not sent for checking', (await call('POST', '/api/admin/users', { username: 'pwgen' })).status === 200);
  check('choosing a leaked password when changing it is refused', (await call('POST', '/api/password', { current: 'correct-horse-battery', next: LEAKED })).status === 400);
  check('if the service is down the password is accepted', (await mk('pwdown', OFFLINE)).status === 200);
  check('the check only sends the first five characters of the hash', seen.length > 0 && seen.every((x) => /^[0-9A-F]{5}$/.test(x)), JSON.stringify(seen));
  await call('PUT', '/api/admin/settings', { breachCheck: false });

  console.log('Idle sign-out');
  check('a bad idle time is refused', (await call('PUT', '/api/admin/settings', { idleMinutes: -3 })).status === 400 && (await call('PUT', '/api/admin/settings', { idleMinutes: 'x' })).status === 400);
  check('the idle time can be set', (await call('PUT', '/api/admin/settings', { idleMinutes: 0.02 })).json.idleMinutes === 0.02);
  cookie = ''; await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('a device in use stays signed in', !!(await call('GET', '/api/me')).json.user);
  await new Promise((r) => setTimeout(r, 700));
  check('still signed in while active', !!(await call('GET', '/api/me')).json.user);
  await new Promise((r) => setTimeout(r, 1700));
  check('a device left alone is signed out', !(await call('GET', '/api/me')).json.user);
  cookie = ''; await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('and the admin can switch the timeout off again', (await call('PUT', '/api/admin/settings', { idleMinutes: 0 })).json.idleMinutes === 0);

  console.log('MCP');
  const tok = (await call('POST', '/api/mcp/tokens', { name: 'test' })).json.token;
  const rpc = async (name, args) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json());
  const usersBefore = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  for (const design of ['../../users', '../../settings', '..\\..\\users', '/etc/passwd']) {
    const g = await rpc('get_design', { design });
    check(`get_design cannot read "${design}"`, /No design|Invalid|rror/i.test(JSON.stringify(g)) && !/salt|hash/.test(JSON.stringify(g)));
    await rpc('add_feature', { design, kind: 'box' });
  }
  check('users.json untouched by traversal attempts', fs.readFileSync(path.join(dir, 'users.json'), 'utf8') === usersBefore);
  const r401 = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  check('bad token is 401', r401.status === 401);


  console.log('MCP hardening');
  const post = (body, headers = {}, p = '/mcp') => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const call2 = async (name, args) => (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tok}` })).json());
  const txt = (r) => JSON.stringify(r);
  check('a token in the URL path is refused', (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, `/mcp/${tok}`)).status === 401);
  check('a token in the query string is refused', (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, `/mcp?token=${tok}`)).status === 401);
  check('an oversized batch is refused', /at most 20/.test(txt(await (await post(Array.from({ length: 25 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' })), { authorization: `Bearer ${tok}` })).json())));
  check('the header still works', (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${tok}` })).status === 200);
  const evil = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${tok}`, origin: 'https://evil.example' });
  check('a browser page on another origin is refused', evil.status === 403 && !evil.headers.get('access-control-allow-origin'));
  const good = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${tok}`, origin: 'https://allowed.example' });
  check('a listed origin gets CORS headers', good.status === 200 && good.headers.get('access-control-allow-origin') === 'https://allowed.example');
  check('CORS is not "*" by default', good.headers.get('access-control-allow-origin') !== '*');
  const created = await call2('create_design', { name: 'Robot' });
  check('create_design works', !txt(created).includes('isError'), txt(created).slice(0, 160));
  const added = await call2('add_feature', { design: 'Robot', kind: 'box', params: { sx: 30, sy: 20, sz: 10 } });
  check('add_feature runs in the worker and returns the model', /Box1/.test(txt(added)) && /volume/.test(txt(added)) && !txt(added).includes('isError'), txt(added).slice(0, 200));
  check('get_design works', /Robot/.test(txt(await call2('get_design', { design: 'Robot' }))));
  console.log('Assistant features: events, requests, Stop, new tools');
  const tokA = (await call('POST', '/api/mcp/tokens', { name: 'assistant-features' })).json.token; // its own rate budget
  const callA = async (name, args) => (await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tokA}` })).json());
  for (const [m, u] of [['GET', '/api/events'], ['GET', '/api/requests'], ['POST', '/api/requests'], ['POST', '/api/mcp/hold']]) {
    const r = await fetch(base + u, { method: m, headers: { 'x-sketchy': '1', 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    check(`${m} ${u} needs a signed-in person`, r.status === 401, String(r.status));
  }
  check('a request cannot be made without the custom header (CSRF)', (await fetch(base + '/api/requests', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"text":"x"}' })).status === 403);
  const rq = await call('POST', '/api/requests', { text: 'a'.repeat(5000) + '\u0001', design: '../../users', context: { summary: 'x' } });
  check('a request is stored with its text trimmed and a bad design name dropped', rq.json.text.length === 2000 && rq.json.design === '', JSON.stringify(rq.json).slice(0, 120));
  for (let i = 0; i < 25; i++) await call('POST', '/api/requests', { text: 'again ' + i });
  const openList = (await call('GET', '/api/requests')).json.filter((x) => x.status === 'open');
  check('only 20 requests can wait at once', openList.length === 20, String(openList.length));
  const lr = JSON.parse((await callA('list_requests', {})).result.content[0].text);
  check('an assistant reads them with list_requests', lr.requests.length === 20 && lr.requests.every((x) => x.id.startsWith('r')));
  const stream = await fetch(base + '/api/events', { headers: { cookie } });
  check('the event stream opens as text/event-stream', stream.status === 200 && /text\/event-stream/.test(stream.headers.get('content-type')));
  const reader = stream.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
  check('and starts with a hello event carrying no design data', /"type":"hello"/.test(first) && !/features/.test(first), first.slice(0, 80));
  await call('POST', '/api/mcp/hold', { on: true });
  check('while stopped, an assistant change is refused', /pressed Stop/.test(txt(await callA('add_feature', { design: 'Robot', kind: 'box' }))));
  check('and looking is still allowed', !txt(await callA('inspect_design', { design: 'Robot' })).includes('pressed Stop'));
  await call('POST', '/api/mcp/hold', { on: false });
  check('after Resume changes work again', !txt(await callA('add_feature', { design: 'Robot', kind: 'cylinder' })).includes('pressed Stop'));
  reader.cancel().catch(() => {});
  for (const design of ['../../users', '/etc/passwd']) {
    for (const tool of ['list_versions', 'find_faces', 'save_version', 'export_model']) {
      const out = txt(await callA(tool, { design, ...(tool === 'find_faces' ? { body: 'f1' } : {}) }));
      check(`${tool} cannot reach "${design}"`, /No design|Invalid|rror/i.test(out) && !/salt|hash/.test(out));
    }
  }
  check('duplicate_design refuses a path as the new name', /Invalid name/.test(txt(await callA('duplicate_design', { design: 'Robot', new_name: '../../x' }))));
  const rr = await post({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'sketchy://design/../../users' } }, { authorization: `Bearer ${tokA}` });
  check('a resource address cannot climb out of the designs', /error/i.test(await rr.text()));
  const img = await callA('render_view', { design: 'Robot', width: 200, height: 150 });
  check('render_view returns an image to an assistant', img.result?.content?.some((c) => c.type === 'image'));
  console.log('Add-ins');
  for (const [m, u] of [['GET', '/api/addins'], ['PUT', '/api/addins/demo'], ['DELETE', '/api/addins/demo']]) {
    const r = await fetch(base + u, { method: m, headers: { 'x-sketchy': '1', 'content-type': 'application/json' }, body: m === 'PUT' ? '{}' : undefined });
    check(`${m} ${u} needs a signed-in person`, r.status === 401, String(r.status));
  }
  const pkg = (over = {}, files = { 'main.js': 'export function activate(){}' }) => ({ manifest: { id: 'demo', name: 'Demo', version: '1.0.0', permissions: [], ...over }, files });
  check('a valid add-in installs', (await call('PUT', '/api/addins/demo', pkg())).status === 200);
  const lst = await call('GET', '/api/addins');
  check('the list has the manifest only', lst.json.addins.some((a) => a.manifest.id === 'demo') && !JSON.stringify(lst.json).includes('activate'));
  check('the package can be fetched back by its owner', (await call('GET', '/api/addins/demo')).json.files['main.js'].includes('activate'));
  check('an install without the custom header is refused (CSRF)', (await fetch(base + '/api/addins/demo', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(pkg()) })).status === 403);
  check('the id in the address must match the manifest', (await call('PUT', '/api/addins/other', pkg())).status === 400);
  for (const bad of ['../../users', 'A', 'x', 'UPPER', '..%2F..%2Fusers']) check(`an add-in id of "${bad}" is refused`, [400, 404].includes((await call('GET', '/api/addins/' + bad)).status));
  check('an unknown permission is refused', (await call('PUT', '/api/addins/demo', pkg({ permissions: ['network'] }))).status === 400);
  check('a file path that climbs out is refused', (await call('PUT', '/api/addins/demo', pkg({}, { 'main.js': 'x', '../evil.js': 'y' }))).status === 400);
  check('a binary-looking file type is refused', (await call('PUT', '/api/addins/demo', pkg({}, { 'main.js': 'x', 'payload.exe': 'y' }))).status === 400);
  check('a missing main file is refused', (await call('PUT', '/api/addins/demo', pkg({ main: 'start.js' }))).status === 400);
  check('an oversized file is refused', (await call('PUT', '/api/addins/demo', pkg({}, { 'main.js': 'x'.repeat(2e6) }))).status === 400);
  check('an exporter without document.read is refused', (await call('PUT', '/api/addins/demo', pkg({ contributes: { exporters: [{ id: 'e', label: 'E', extension: 'txt' }] } }))).status === 400);
  const sb = await fetch(base + '/addin-sandbox.html');
  const csp = sb.headers.get('content-security-policy') || '';
  check('the sandbox page allows no network and only its own hashed script', /connect-src 'none'/.test(csp) && /script-src 'sha256-/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && /frame-ancestors 'self'/.test(csp), csp);
  check('and carries no X-Frame-Options that would block it', !sb.headers.get('x-frame-options'));
  check('the rest of the app still refuses to be framed', (await fetch(base + '/')).headers.get('x-frame-options') === 'DENY');
  await call('PUT', '/api/admin/settings', { allowAddins: false });
  check('with add-ins switched off, installing is refused', (await call('PUT', '/api/addins/demo', pkg())).status === 403);
  check('but existing ones can still be listed and removed', (await call('GET', '/api/addins')).json.enabled === false && (await call('DELETE', '/api/addins/demo')).status === 200);
  await call('PUT', '/api/admin/settings', { allowAddins: true });
  const inv = [
    ['unknown argument', 'get_design', { design: 'Robot', extra: 1 }],
    ['wrong type', 'add_feature', { design: 'Robot', kind: 5 }],
    ['missing required', 'get_design', {}],
    ['too-long name', 'create_design', { name: 'x'.repeat(200) }],
    ['bad position', 'add_feature', { design: 'Robot', kind: 'box', position: 'first' }],
    ['prototype pollution key', 'add_feature', { design: 'Robot', kind: 'box', params: JSON.parse('{"__proto__":{"x":1}}') }],
    ['absurd nesting', 'add_feature', { design: 'Robot', kind: 'box', params: JSON.parse('{"a":'.repeat(12) + '1' + '}'.repeat(12)) }],
    ['huge array', 'add_feature', { design: 'Robot', kind: 'box', params: { pts: new Array(6000).fill(1) } }],
    ['infinite number', 'set_parameters', { design: 'Robot', parameters: [{ name: 'w', expr: 'x'.repeat(600) }] }],
  ];
  for (const [label, name, args] of inv) check(`refuses ${label}`, /Invalid arguments/.test(txt(await call2(name, args))), txt(await call2(name, args)).slice(0, 140));
  // per-token limit and automatic pause (30 calls a minute here; 5 strikes pause the token)
  const tok2 = (await call('POST', '/api/mcp/tokens', { name: 'noisy' })).json;
  let paused = false, saw429 = 0;
  for (let i = 0; i < 160 && !paused; i++) {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${tok2.token}` });
    if (r.status === 429) saw429++;
    if (r.status === 403) paused = true;
  }
  check('a token over its rate limit is throttled', saw429 >= 1);
  check('a token that keeps hammering is paused', paused);
  check('the other token still works', (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${tok}` })).status !== 403);
  const listed = (await call('GET', '/api/mcp/tokens')).json.tokens.find((t) => t.id === tok2.id);
  check('the owner sees it as paused', !!listed?.paused);
  check('the owner can resume it', (await call('POST', `/api/mcp/tokens/${tok2.id}/resume`, {})).status === 200 && !(await call('GET', '/api/mcp/tokens')).json.tokens.find((t) => t.id === tok2.id).paused);


  console.log('Sessions and cookies');
  cookie = '';
  const l1 = await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  const sc = l1.headers.getSetCookie().join(';');
  check('plain HTTP uses the normal cookie name, 30-day lifetime', /^sketchy_session=/.test(sc) && /Max-Age=2592000/.test(sc) && !/Secure/.test(sc), sc);
  const s2 = await fetch(base + '/api/login', { method: 'POST', headers: { 'x-sketchy': '1', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ username: 'boss', password: 'correct-horse-battery' }) });
  const sc2 = s2.headers.getSetCookie().join(';');
  check('over HTTPS the cookie is __Host-, Secure, Path=/ and has no Domain', /^__Host-sketchy_session=/.test(sc2) && /Secure/.test(sc2) && /Path=\//.test(sc2) && !/Domain/i.test(sc2), sc2);
  const cookies = [];
  for (let i = 0; i < 5; i++) { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'x-sketchy': '1', 'content-type': 'application/json', 'x-device-label': 'Device ' + i }, body: JSON.stringify({ username: 'boss', password: 'correct-horse-battery' }) }); cookies.push(r.headers.getSetCookie()[0].split(';')[0]); }
  const sessList = async (c) => (await (await fetch(base + '/api/sessions', { headers: { 'x-sketchy': '1', cookie: c } })).json());
  const mine = await sessList(cookies.at(-1));
  check('at most 3 devices stay signed in (the oldest are signed out)', mine.length === 3, String(mine.length));
  check('the newest device is marked current', mine.find((x) => x.current)?.device === 'Device 4');
  check('the oldest session no longer works', (await fetch(base + '/api/projects', { headers: { 'x-sketchy': '1', cookie: cookies[0] } })).status === 401);
  const other = mine.find((x) => !x.current);
  check('a device can be signed out one by one', (await fetch(base + `/api/sessions/${other.id}`, { method: 'DELETE', headers: { 'x-sketchy': '1', cookie: cookies.at(-1) } })).status === 200 && (await sessList(cookies.at(-1))).length === 2);
  check('"sign out other devices" leaves only this one', (await fetch(base + '/api/sessions/others', { method: 'POST', headers: { 'x-sketchy': '1', cookie: cookies.at(-1) } })).status === 200 && (await sessList(cookies.at(-1))).length === 1);
  cookie = cookies.at(-1);


  console.log('OAuth for connectors');
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  check('protected-resource metadata points at /mcp and this server', meta.resource === `${base}/mcp` && meta.authorization_servers[0] === base, JSON.stringify(meta));
  const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check('authorization-server metadata: PKCE S256, public clients, registration', asm.code_challenge_methods_supported?.[0] === 'S256' && asm.token_endpoint_auth_methods_supported?.[0] === 'none' && asm.registration_endpoint === `${base}/oauth/register`);
  const noauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('an unauthenticated /mcp request points the client at the metadata', noauth.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(noauth.headers.get('www-authenticate') || ''));
  let probesOk = true; for (let i = 0; i < 30; i++) if ((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status !== 401) probesOk = false;
  check('token-less discovery requests are never rate limited as failures', probesOk);
  const regPost = (body) => fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const bad of ['javascript:alert(1)', 'http://evil.example/cb', 'https://x.example/cb#frag', 'data:text/html,hi']) check(`registration refuses redirect ${bad}`, (await regPost({ client_name: 'X', redirect_uris: [bad] })).status === 400);
  const reg = await (await regPost({ client_name: '<b>Claude</b>', redirect_uris: ['https://claude.example/callback'] })).json();
  check('a client registers (name is cleaned)', /^skc_/.test(reg.client_id) && !/[<>]/.test(reg.client_name) && reg.token_endpoint_auth_method === 'none');
  check('the approval page is served by the app', /<div id="app"|<script/.test(await (await fetch(`${base}/oauth/authorize?client_id=x`)).text()));
  // sign in again (the lock-out section comes later)
  cookie = ''; await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  const verifier = crypto.randomBytes(48).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const approve = (o) => call('POST', '/api/oauth/approve', { client_id: reg.client_id, redirect_uri: 'https://claude.example/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', ...o });
  check('the consent page can look the client up', (await call('GET', `/api/oauth/client?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://claude.example/callback')}`)).json.host === 'claude.example');
  check('an unregistered redirect address is refused', (await approve({ redirect_uri: 'https://evil.example/cb' })).status === 400);
  check('a request without PKCE is refused', (await approve({ code_challenge: undefined })).status === 400 && (await approve({ code_challenge_method: 'plain' })).status === 400);
  check('an unknown client is refused', (await approve({ client_id: 'skc_nope' })).status === 400);
  const denied = new URL((await approve({ deny: true })).json.redirect);
  check('"Cancel" returns access_denied with the state', denied.searchParams.get('error') === 'access_denied' && denied.searchParams.get('state') === 'st8' && !denied.searchParams.get('code'));
  const ok = new URL((await approve({})).json.redirect);
  const code = ok.searchParams.get('code');
  check('"Allow" returns a code with the state, to the registered address', !!code && ok.searchParams.get('state') === 'st8' && ok.origin === 'https://claude.example');
  const tokenPost = (o) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  const base2 = { grant_type: 'authorization_code', client_id: reg.client_id, redirect_uri: 'https://claude.example/callback' };
  check('a wrong PKCE verifier is refused', (await tokenPost({ ...base2, code, code_verifier: 'x'.repeat(50) })).status === 400);
  check('and that spent the code', (await tokenPost({ ...base2, code, code_verifier: verifier })).status === 400);
  const code2 = new URL((await approve({})).json.redirect).searchParams.get('code');
  check('a different redirect address at the token step is refused', (await tokenPost({ ...base2, redirect_uri: 'https://claude.example/other', code: code2, code_verifier: verifier })).status === 400);
  const code3 = new URL((await approve({})).json.redirect).searchParams.get('code');
  const tr = await tokenPost({ ...base2, code: code3, code_verifier: verifier });
  const t1 = await tr.json();
  check('the right code and verifier give tokens', tr.status === 200 && /^skm_/.test(t1.access_token) && /^skr_/.test(t1.refresh_token) && t1.expires_in === 3600 && tr.headers.get('cache-control') === 'no-store');
  const mcpPing = (tk) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  check('the access token works on /mcp', (await mcpPing(t1.access_token)).status === 200);
  const listApps = (await call('GET', '/api/mcp/tokens')).json.tokens.filter((t) => t.app);
  check('it shows up as a connected app the owner can revoke', listApps.length === 1 && /connected app/.test(listApps[0].name));
  const r1 = await (await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id })).json();
  check('a refresh token gives a new pair', /^skm_/.test(r1.access_token) && r1.access_token !== t1.access_token);
  check('the old access token stops working', (await mcpPing(t1.access_token)).status === 401);
  check('the new one works', (await mcpPing(r1.access_token)).status === 200);
  const replay = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: reg.client_id });
  check('replaying an old refresh token is refused', replay.status === 400);
  check('and it ends the whole connection', (await mcpPing(r1.access_token)).status === 401 && (await call('GET', '/api/mcp/tokens')).json.tokens.filter((t) => t.app).length === 0);

  let limited = false;
  for (let i = 0; i < 25; i++) if ((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope' + i, 'content-type': 'application/json' }, body: '{}' })).status === 429) limited = true;
  check('repeated bad tokens get rate limited', limited);

  console.log('Static files, compression and the service worker');
  {
    const html = (await call('GET', '/')).text, wasm = /rel="preload" href="(\/assets\/replicad_single-[^"]+\.wasm)"/.exec(html)?.[1];
    check('the page preloads the hashed CAD kernel file', !!wasm, html.slice(0, 200));
    const get = (u, ae, extra = {}) => new Promise((res, rej) => http.get(base + u, { headers: { 'accept-encoding': ae, ...extra } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
    const id = await get(wasm, 'identity'), br = await get(wasm, 'br, gzip'), gz = await get(wasm, 'gzip');
    check('the kernel file is immutable and varies by encoding', /immutable/.test(br.headers['cache-control']) && /max-age=31536000/.test(br.headers['cache-control']) && /accept-encoding/i.test(br.headers.vary || ''), JSON.stringify(br.headers));
    check('brotli is used when offered, and is much smaller', br.headers['content-encoding'] === 'br' && br.body.length < id.body.length / 3, `${br.body.length} vs ${id.body.length}`);
    check('and decodes to exactly the same bytes', Buffer.compare(zlib.brotliDecompressSync(br.body), id.body) === 0);
    check('gzip is used when brotli is not offered, and decodes to the same bytes', gz.headers['content-encoding'] === 'gzip' && Buffer.compare(zlib.gunzipSync(gz.body), id.body) === 0);
    check('a client that accepts nothing gets the plain file', !id.headers['content-encoding'] && id.headers['content-type'] === 'application/wasm');
    const dist = new URL('../dist/assets/', import.meta.url), usesEval = fs.readdirSync(dist).filter((f) => f.endsWith('.js')).filter((f) => /new Function\(/.test(fs.readFileSync(new URL(f, dist), 'utf8')));
    check('the page CSP allows eval exactly because the built files need it (OpenCascade\'s glue), so the app boots under it', usesEval.length === 0 || /script-src[^;]*'unsafe-eval'/.test((await call('GET', '/')).headers.get('content-security-policy') || ''), usesEval.join());
    check('and the CSP still has no inline scripts, no off-site connections, no framing', (c => !/script-src[^;]*unsafe-inline/.test(c) && /connect-src 'self' blob:/.test(c) && /frame-ancestors 'none'/.test(c) && /object-src 'none'/.test(c))((await call('GET', '/')).headers.get('content-security-policy') || ''));
    const sw = await get('/sw.js', 'identity');
    check('the service worker is never cached by the browser and may control the whole site', /no-cache/.test(sw.headers['cache-control']) && sw.headers['service-worker-allowed'] === '/' && /javascript/.test(sw.headers['content-type']));
    check('it carries the same CSP as the app (no inline script, no off-site connections)', /connect-src 'self'/.test(sw.headers['content-security-policy'] || '') && !/unsafe-inline/.test(sw.headers['content-security-policy'] || ''));
    check('API responses are still never stored and not compressed by the static path', /no-store/.test((await get('/api/me', 'br')).headers['cache-control'] || ''));
    const text = sw.body.toString();
    check('the worker file has its version and file list filled in', !/__SW_/.test(text) && /const VERSION = '[\w.-]+'/.test(text) && text.includes(wasm));

    // run the worker in a sandbox with a fake browser and ask it about every kind of request
    const makeWorld = (version) => {
      const src = text.replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`);
      const stores = new Map(), fetched = [], handlers = {}, posted = [];
      const key = (r) => (typeof r === 'string' ? new URL(r, 'https://app.test').href : r.url);
      const cacheApi = {
        open: async (name) => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name); return { put: async (r, res) => { m.set(key(r), res); }, match: async (r) => m.get(key(r)) }; },
        keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n),
        match: async (r, o) => (o?.cacheName ? stores.get(o.cacheName)?.get(key(r)) : [...stores.values()].map((m) => m.get(key(r))).find(Boolean)),
      };
      let net = (r) => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      const self_ = { location: new URL('https://app.test/sw.js'), addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => { fetched.push('skipWaiting'); }, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] } };
      const ctx = vm.createContext({ self: self_, caches: cacheApi, fetch: async (r) => { fetched.push(key(r)); const res = net(r); Object.defineProperty(res, 'type', { value: 'basic' }); return res; }, Request: class extends Request { constructor(u, i) { super(typeof u === 'string' ? new URL(u, 'https://app.test').href : u, i); } }, Response, URL, Promise, console });
      vm.runInContext(src, ctx);
      const event = (url, init = {}, mode = 'cors') => { let p = null; const req = new Request(new URL(url, 'https://app.test').href, init); Object.defineProperty(req, 'mode', { value: mode }); return { ev: { request: req, respondWith: (x) => { p = Promise.resolve(x); }, waitUntil: (x) => { p = Promise.resolve(x); } }, got: () => p }; };
      return { handlers, stores, fetched, posted, setNet: (f) => { net = f; }, event };
    };
    const w = makeWorld('v1');
    const inst = w.event('/'); await w.handlers.install(inst.ev); await inst.got();
    const precached = [...w.stores.get('sketchy-v1').keys()];
    check('install keeps the app page and every build file, bypassing the browser cache', precached.includes('https://app.test/') && precached.some((u) => /\/assets\/.*\.wasm$/.test(u)) && precached.every((u) => !/\/(api|mcp)\//.test(u)), precached.slice(0, 3).join());
    for (const url of ['/api/projects', '/api/login', '/mcp', '/mcp/x', '/oauth/authorize', '/oauth/token', '/.well-known/oauth-authorization-server', '/addin-sandbox.html', '/addins/index.json', '/addins/openscad/main.js', '/sw.js']) {
      const t = w.event(url, {}, url === '/oauth/authorize' ? 'navigate' : 'cors'); w.handlers.fetch(t.ev);
      check(`${url} is left to the network (never answered or kept by the worker)`, t.got() === null);
    }
    for (const [label, url, init] of [['a POST', '/assets/a.js', { method: 'POST' }], ['a request with an Authorization header', '/assets/a.js', { headers: { authorization: 'Bearer x' } }], ['a range request', '/assets/a.js', { headers: { range: 'bytes=0-9' } }], ['another origin', 'https://elsewhere.test/assets/a.js', {}], ['a file outside /assets/', '/data.json', {}]]) {
      const t = w.event(url, init); w.handlers.fetch(t.ev);
      check(`${label} is not touched`, t.got() === null);
    }
    w.fetched.length = 0;
    let t = w.event('/assets/app-1.js'); w.handlers.fetch(t.ev); const first = await t.got();
    t = w.event('/assets/app-1.js'); w.handlers.fetch(t.ev); const again = await t.got();
    check('a build file is fetched once and then served from the kept copy', (await first.text()) === 'ok' && (await again.text()) === 'ok' && w.fetched.filter((u) => u.endsWith('/assets/app-1.js')).length === 1);
    w.setNet(() => new Response('secret', { status: 200, headers: { 'cache-control': 'no-store' } }));
    t = w.event('/assets/private.js'); w.handlers.fetch(t.ev); await t.got();
    w.setNet(() => new Response('cookie', { status: 200, headers: { 'set-cookie': 'a=b' } }));
    t = w.event('/assets/cookie.js'); w.handlers.fetch(t.ev); await t.got();
    w.setNet(() => new Response('gone', { status: 404 }));
    t = w.event('/assets/missing.js'); w.handlers.fetch(t.ev); await t.got();
    const kept = [...w.stores.get('sketchy-v1').keys()];
    check('responses that say no-store, set a cookie or are not a plain 200 are never kept', !kept.some((u) => /private|cookie|missing/.test(u)), kept.join());
    w.setNet(() => new Response('<html>page</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    t = w.event('/', {}, 'navigate'); w.handlers.fetch(t.ev); await t.got();
    w.setNet(() => { throw new TypeError('offline'); });
    t = w.event('/', {}, 'navigate'); w.handlers.fetch(t.ev); const off = await t.got();
    check('offline, the page opens from the kept copy', (await off.text()).includes('page'));
    t = w.event('/api/projects', {}, 'cors'); w.handlers.fetch(t.ev);
    check('and the API is still not answered from anywhere', t.got() === null);
    // an update: a new version removes the old kept files and tells open pages
    const w2 = makeWorld('v2');
    w2.stores.set('sketchy-v1', new Map([['https://app.test/', new Response('old')]])); w2.stores.set('other-site-cache', new Map());
    const act = w2.event('/'); await w2.handlers.activate(act.ev); await act.got();
    check('a new version deletes the old version\'s files and leaves other caches alone', !w2.stores.has('sketchy-v1') && w2.stores.has('other-site-cache'));
    check('and tells the open page to reload', w2.posted.some((m) => m.type === 'sketchy-updated'));
    const w3 = makeWorld('v3'); const act3 = w3.event('/'); await w3.handlers.activate(act3.ev); await act3.got();
    check('a first install does not announce an update', w3.posted.length === 0);
  }

  console.log('Lock-out');
  cookie = '';
  let locked = false;
  for (let i = 0; i < 7; i++) if ((await call('POST', '/api/login', { username: 'friend', password: 'wrong-wrong-' + i })).status === 429) locked = true;
  check('repeated wrong passwords lock the account', locked);
  const spoof = await call('POST', '/api/login', { username: 'friend', password: 'a-fine-password-1' }, { 'x-forwarded-for': '203.0.113.9' });
  check('a spoofed X-Forwarded-For does not escape the lock-out (TRUST_PROXY=false)', spoof.status === 429, String(spoof.status));
} finally {
  srv.kill(); fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log('\nServer log:\n' + out.split('\n').slice(-15).join('\n'));
process.exit(failed ? 1 : 0);
