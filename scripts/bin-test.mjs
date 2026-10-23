// The recycle bin, end to end against the real server on a throwaway data folder: deleting moves a design (with its versions and
// folder) to the bin, restoring brings it back, the bin counts toward the storage limit and gives way first, and one account can
// never see or touch another's bin. Run with `npm run test:bin`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 8800 + Math.floor(Math.random() * 400), base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketchy-bin-'));
const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_USER: 'boss', ADMIN_PASSWORD: 'correct-horse-battery', TRUST_PROXY: 'false', BIN_DAYS: '30', USER_QUOTA_MB: '2', HIBP_URL: 'http://127.0.0.1:1/' };
const srv = spawn(process.execPath, [process.env.SERVER_FILE || 'server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 50 && !out.includes('Sketchy on'); i++) await new Promise((r) => setTimeout(r, 100));

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };
const session = () => {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'x-sketchy': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const ses = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('sketchy_session=')); if (ses) cookie = ses.split(';')[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
};
const doc = (name, extra = 0) => JSON.stringify({ format: 'sketchy', version: 1, name, features: [], marker: 0, nextId: 1, params: [], appearance: {}, units: 'mm', components: [], bodyComp: {}, configs: [], activeConfig: null, canvases: [], ...(extra ? { pad: 'x'.repeat(extra) } : {}) });

try {
  const A = session(), B = session();
  const la = await A('POST', '/api/login', { username: 'boss', password: 'correct-horse-battery' });
  check('signed in', la.status === 200, la.text);
  await A('PUT', '/api/admin/users/boss/quota', { quotaMb: 2 });

  console.log('Deleting moves a design to the bin');
  const put = (c, name, body, h = {}) => c('PUT', '/api/projects/' + encodeURIComponent(name), body, { 'if-match': '0', ...h });
  check('a design is saved', (await put(A, 'Bracket', doc('Bracket'), { 'x-folder': encodeURIComponent('Work/Parts') })).status === 200);
  await A('PUT', '/api/projects/Bracket', doc('Bracket v2'), { 'if-match': '*' }); // a second save, so a version exists
  const del = await A('DELETE', '/api/projects/Bracket');
  check('deleting says it went to the bin', del.status === 200 && /^[a-f0-9]{16}$/.test(del.json?.binned || '') && del.json.days === 30, del.text);
  check('the design is gone from the list', !(await A('GET', '/api/projects')).json.some((d) => d.name === 'Bracket'));
  check('and cannot be opened', (await A('GET', '/api/projects/Bracket')).status === 404);
  const bin = (await A('GET', '/api/bin')).json;
  check('the bin lists it with its folder and expiry', bin.items.length === 1 && bin.items[0].name === 'Bracket' && bin.items[0].folder === 'Work/Parts' && bin.items[0].expiresAt > Date.now() + 29 * 864e5, JSON.stringify(bin));
  const id = bin.items[0].id;
  check('its name is free to use again', (await put(A, 'Bracket', doc('Bracket new'))).status === 200);

  console.log('Restoring');
  const clash = await A('POST', `/api/bin/${id}/restore`, {});
  check('restoring onto a taken name is refused with a suggestion', clash.status === 409 && clash.json.suggestion === 'Bracket (restored)', clash.text);
  const back = await A('POST', `/api/bin/${id}/restore`, { to: clash.json.suggestion });
  check('restoring under the suggested name works', back.status === 200 && back.json.name === 'Bracket (restored)' && back.json.folder === 'Work/Parts', back.text);
  const got = await A('GET', '/api/projects/' + encodeURIComponent('Bracket (restored)'));
  check('the design is back with its content', got.status === 200 && JSON.parse(got.text).name === 'Bracket v2');
  check('it is back in its folder', (await A('GET', '/api/projects')).json.find((d) => d.name === 'Bracket (restored)')?.folder === 'Work/Parts');
  check('and its version history came with it', (await A('GET', '/api/projects/' + encodeURIComponent('Bracket (restored)') + '/versions')).json.length >= 1);
  check('the bin is empty again', (await A('GET', '/api/bin')).json.items.length === 0);
  check('restoring twice is refused', (await A('POST', `/api/bin/${id}/restore`, {})).status === 404);

  console.log('Deleting for good');
  await A('DELETE', '/api/projects/' + encodeURIComponent('Bracket (restored)'));
  await A('DELETE', '/api/projects/Bracket');
  let items = (await A('GET', '/api/bin')).json.items;
  check('two designs wait in the bin', items.length === 2);
  check('one can be deleted for good', (await A('DELETE', `/api/bin/${items[0].id}`)).status === 200 && (await A('GET', '/api/bin')).json.items.length === 1);
  check('the bin can be emptied', (await A('DELETE', '/api/bin')).status === 200 && (await A('GET', '/api/bin')).json.items.length === 0);
  check('deleting a design that does not exist is harmless', (await A('DELETE', '/api/projects/Nothing')).status === 200 && (await A('GET', '/api/bin')).json.items.length === 0);

  console.log('Expiry');
  await put(A, 'Old', doc('Old')); await A('DELETE', '/api/projects/Old');
  const uid = fs.readdirSync(path.join(dir, 'projects'))[0], binRoot = path.join(dir, 'projects', uid, '.bin');
  const oldId = fs.readdirSync(binRoot)[0], itemFile = path.join(binRoot, oldId, 'item.json');
  const item = JSON.parse(fs.readFileSync(itemFile, 'utf8')); item.deletedAt = Date.now() - 31 * 864e5; fs.writeFileSync(itemFile, JSON.stringify(item));
  check('an item past 30 days is removed when the bin is read', (await A('GET', '/api/bin')).json.items.length === 0 && !fs.existsSync(path.join(binRoot, oldId)));

  console.log('Storage limit');
  const big = (n) => doc('Big ' + n, 700 * 1024);
  for (const n of [1, 2]) await put(A, 'Big' + n, big(n));
  await A('DELETE', '/api/projects/Big1'); await A('DELETE', '/api/projects/Big2');
  const used1 = (await A('GET', '/api/me')).json;
  const st = (await A('GET', '/api/storage')).json;
  check('the bin counts toward the storage used', (st?.used || 0) > 1.3e6, JSON.stringify(st));
  const bigSave = await put(A, 'Big3', big(3)); // 2 MB limit: 1.4 MB sits in the bin, so the oldest bin item has to give way
  check('a save that needs the room removes the oldest bin item instead of failing', bigSave.status === 200, bigSave.text);
  const left = (await A('GET', '/api/bin')).json.items.map((x) => x.name);
  check('the newest deletion is the one still in the bin', left.length === 1 && left[0] === 'Big2', JSON.stringify(left));

  console.log('Privacy');
  await A('POST', '/api/admin/users', { username: 'friend', password: 'a-long-random-passphrase-9' });
  const lb = await B('POST', '/api/login', { username: 'friend', password: 'a-long-random-passphrase-9' });
  check('a second account signs in', lb.status === 200, lb.text);
  check('it sees an empty bin', (await B('GET', '/api/bin')).json.items.length === 0);
  const mine = (await A('GET', '/api/bin')).json.items[0].id;
  check('it cannot restore, read or delete the first account\'s item', (await B('POST', `/api/bin/${mine}/restore`, {})).status === 404 && (await B('GET', `/api/bin/${mine}/thumb`)).status === 404 && (await B('DELETE', `/api/bin/${mine}`)).status === 404);
  check('the item is still there', (await A('GET', '/api/bin')).json.items.some((x) => x.id === mine));
  for (const bad of ['..', '%2e%2e%2f%2e%2e%2fx', 'zz', '%2e%2e', 'A'.repeat(16), '0123456789abcdeg']) check(`an id like "${bad}" is refused`, [404, 400, 403].includes((await A('POST', `/api/bin/${bad}/restore`, {})).status));
  check('a restore name cannot escape the folder', (await A('POST', `/api/bin/${mine}/restore`, { to: '../evil' })).status === 400);
  check('the CSRF header is required', (await fetch(base + '/api/bin', { method: 'DELETE', headers: { cookie: '' } })).status === 403);
  check('the bin is not served as a design name', (await A('GET', '/api/projects/.bin')).status === 400);
} catch (e) {
  failed++; console.log('FAIL (error)', e);
} finally {
  srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
