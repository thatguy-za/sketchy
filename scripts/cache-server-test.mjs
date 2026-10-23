// The saved kernel cache on the server, end to end on a throwaway data folder: it is stored next to the design, only its owner can read
// it, it goes with the design (deleted, renamed), it counts toward the storage limit, and it gives way first when space runs short.
// Run with `npm run test:cache-server`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const port = 9300 + Math.floor(Math.random() * 400), base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketchy-cache-'));
const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_USER: 'boss', ADMIN_PASSWORD: 'correct-horse-battery', TRUST_PROXY: 'false', SKETCHY_MCP_SAVE_AFTER_MS: '50', SKETCHY_MCP_SAVE_EVERY_MS: '50', MAX_CACHE_MB: '1', USER_QUOTA_MB: '3', BIN_DAYS: '30', HIBP_URL: 'http://127.0.0.1:1/' };
const srv = spawn(process.execPath, [process.env.SERVER_FILE || 'server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 50 && !out.includes('Sketchy on'); i++) await new Promise((r) => setTimeout(r, 100));

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };
const session = () => {
  let cookie = '';
  return async (method, p, body, headers = {}, raw = false) => {
    const r = await fetch(base + p, { method, headers: { 'x-sketchy': '1', ...(cookie ? { cookie } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : raw || typeof body === 'string' ? body : JSON.stringify(body) });
    const ses = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('sketchy_session=')); if (ses) cookie = ses.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
    return { status: r.status, json, buf, text: buf.toString() };
  };
};
const doc = (name, pad = 0) => JSON.stringify({ format: 'sketchy', version: 1, name, features: [], marker: 0, nextId: 1, params: [], appearance: {}, units: 'mm', components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [], ...(pad ? { pad: 'x'.repeat(pad) } : {}) });
const gz = (n) => Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), crypto.randomBytes(n)]); // starts like a gzip file; the content is not looked at
const ownerDir = () => { const root = path.join(dir, 'projects'); return path.join(root, fs.readdirSync(root).find((d) => fs.readdirSync(path.join(root, d)).some((f) => f.endsWith('.json')) || fs.existsSync(path.join(root, d, '.bin')))); }; // the first account's folder (the second one is empty)
const urlOf = (n) => '/api/projects/' + encodeURIComponent(n) + '/cache';

try {
  const A = session(), B = session();
  check('signed in', (await A('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' })).status === 200);
  const put = (c, name, body, h = {}) => c('PUT', '/api/projects/' + encodeURIComponent(name), body, { 'if-match': '0', ...h });

  console.log('Storing and reading');
  await put(A, 'Part', doc('Part'));
  const blob = gz(200000);
  const p1 = await A('PUT', urlOf('Part'), blob, { 'content-type': 'application/octet-stream' }, true);
  check('a cache is stored', p1.status === 200 && p1.json.size === blob.length, p1.text);
  const g1 = await A('GET', urlOf('Part'));
  check('and read back byte for byte', g1.status === 200 && Buffer.compare(g1.buf, blob) === 0);
  check('a design with no cache says so', (await A('GET', urlOf('Nothing'))).status === 404);
  check('the cache does not appear as a design', !(await A('GET', '/api/projects')).json.some((d) => /cache/.test(d.name)) && (await A('GET', '/api/projects')).json.length === 1);
  const again = gz(1000);
  check('a newer cache replaces the old one', (await A('PUT', urlOf('Part'), again, {}, true)).status === 200 && Buffer.compare((await A('GET', urlOf('Part'))).buf, again) === 0);

  console.log('What is refused');
  check('something that is not gzip data', (await A('PUT', urlOf('Part'), Buffer.from('not gzip at all, plain text here'), {}, true)).status === 400);
  check('a cache for a design that does not exist', (await A('PUT', urlOf('Ghost'), gz(100), {}, true)).status === 404);
  check('a cache over the size limit (1 MB here)', (await A('PUT', urlOf('Part'), gz(1.2e6), {}, true)).status === 413);
  check('the refused ones changed nothing', Buffer.compare((await A('GET', urlOf('Part'))).buf, again) === 0);
  check('the CSRF header is required', (await fetch(base + urlOf('Part'), { method: 'PUT', body: gz(100) })).status === 403);
  check('a name that is not a design name', [400, 404].includes((await A('PUT', '/api/projects/' + encodeURIComponent('../evil') + '/cache', gz(100), {}, true)).status));

  console.log('Whose it is');
  await A('POST', '/api/admin/users', { username: 'friend', password: 'a-long-random-passphrase-9' });
  await B('POST', '/api/login', { username: 'friend', password: 'a-long-random-passphrase-9' });
  check('another account cannot read it', (await B('GET', urlOf('Part'))).status === 404);
  check('or replace it', (await B('PUT', urlOf('Part'), gz(100), {}, true)).status === 404);
  check('or delete it', (await B('DELETE', urlOf('Part'))).status === 200 && (await A('GET', urlOf('Part'))).status === 200);

  console.log('It goes with the design');
  check('a rename takes it along', (await A('POST', '/api/projects/Part/rename', { to: 'Renamed' })).status === 200 && (await A('GET', urlOf('Renamed'))).status === 200 && (await A('GET', urlOf('Part'))).status === 404);
  await A('DELETE', '/api/projects/Renamed');
  check('deleting the design removes it (it is not kept in the recycle bin)', (await A('GET', urlOf('Renamed'))).status === 404 && !fs.readdirSync(ownerDir()).some((f) => f.endsWith('.cache')));
  await put(A, 'Part', doc('Part')); await A('PUT', urlOf('Part'), gz(500), {}, true);
  check('it can be deleted on its own', (await A('DELETE', urlOf('Part'))).status === 200 && (await A('GET', urlOf('Part'))).status === 404);

  console.log('Storage limit (3 MB here)');
  const pdir = ownerDir();
  for (const n of ['One', 'Two', 'Three']) { await put(A, n, doc(n)); await A('PUT', urlOf(n), gz(900000), {}, true); await new Promise((r) => setTimeout(r, 30)); } // 2.7 MB of caches
  check('the caches count toward the storage used', (await A('GET', '/api/storage')).json.used > 2.6e6);
  await put(A, 'Binned', doc('Binned', 150000)); await A('DELETE', '/api/projects/Binned'); // a recycle-bin item of about 150 KB
  const big = await put(A, 'Big', doc('Big', 900000)); // needs about 0.9 MB: more than is free
  check('a save that needs room still works', big.status === 200, big.text);
  const left = fs.readdirSync(pdir).filter((f) => f.endsWith('.cache')).map((f) => f.slice(0, -6)).sort();
  check('it took the oldest caches, not the newest', !left.includes('One') && left.includes('Three'), JSON.stringify(left));
  check('and the recycle bin was left alone while caches could go', (await A('GET', '/api/bin')).json.items.some((x) => x.name === 'Binned'));
  check('the designs themselves are untouched', ['One', 'Two', 'Three', 'Big'].every((n) => fs.existsSync(path.join(pdir, n + '.json'))));

  console.log('An assistant\'s request (the MCP worker) saves and reuses the cache');
  const { bigDesign } = await import('./bench-brep.mjs');
  const heavy = JSON.stringify({ format: 'sketchy', version: 1, name: 'Heavy', ...bigDesign(), marker: 41, appearance: {}, faceAppearance: [], units: 'mm', components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [] });
  check('a heavy design is saved', (await put(A, 'Heavy', heavy)).status === 200);
  const tok = (await A('POST', '/api/mcp/tokens', { name: 'cache' })).json.token;
  const rpc = async (name, args) => (await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json();
  const vol = (r) => { try { return Math.round(JSON.parse(r.result.content[0].text).model.bodies.reduce((a, b) => a + b.volume_mm3, 0)); } catch { return null; } };
  let first = null; for (let i = 0; i < 4 && !vol(first || {}); i++) first = await rpc('inspect_design', { design: 'Heavy' }); // the first call also starts the kernel
  check('the assistant reads the design', vol(first) > 1e6, JSON.stringify(first).slice(0, 200));
  check('the build was saved next to the design', fs.existsSync(path.join(ownerDir(), 'Heavy.cache')) && fs.statSync(path.join(ownerDir(), 'Heavy.cache')).size > 1000);
  const savedFor = (await A('GET', urlOf('Heavy')));
  check('the app can read what the assistant saved', savedFor.status === 200 && savedFor.buf[0] === 0x1f && savedFor.buf[1] === 0x8b);
  const t0 = Date.now(); const second = await rpc('inspect_design', { design: 'Heavy' });
  check('the next request gives the same answer', vol(second) === vol(first), `${vol(second)} vs ${vol(first)}`);
  console.log(`      second request: ${Date.now() - t0} ms`);
  check('and the saved cache did not change the design', JSON.parse((await A('GET', '/api/projects/Heavy')).text).features.length === bigDesign().features.length);
} catch (e) {
  failed++; console.log('FAIL (error)', e);
} finally {
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
