// The image copies the server's root files by name, so a new one that the server imports is missing in the container and it does not
// start. This follows what server.js (and the worker it starts) imports and checks that the Dockerfile copies every root file among them,
// then starts the server from a folder holding only what the image would hold. Run with `npm run test:docker-files`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };

const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const finalStage = docker.slice(docker.lastIndexOf('\nFROM '));
const copied = new Set(finalStage.split('\n').filter((l) => /^COPY\s+(?!--)/.test(l) && !/\bsrc \.\/src\b/.test(l) && !/package\*\.json/.test(l)).flatMap((l) => l.replace(/^COPY\s+/, '').trim().split(/\s+/).slice(0, -1)));
const wholeDirs = new Set(finalStage.split('\n').map((l) => /^COPY\s+(?!--)(\S+)\s+\.\/\1\s*$/.exec(l)?.[1]).filter(Boolean)); // directories copied as a whole (src)
console.log(`  The image copies these root files: ${[...copied].join(' ')}; and these folders: ${[...wholeDirs].join(' ')}`);

// every file the server can load, following relative imports and the worker it starts
const seen = new Set(), todo = ['server.js', 'mcp-worker.js'];
const rel = /(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
while (todo.length) {
  const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
  const file = path.join(root, f); if (!fs.existsSync(file)) { check(`${f} exists`, false, 'imported but not in the repository'); continue; }
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(rel)) {
    const target = path.normalize(path.join(path.dirname(f), m[1]));
    if (/\.(js|mjs)$/.test(target)) todo.push(target);
  }
}
const needed = [...seen].filter((f) => !f.startsWith('src' + path.sep));
check('the server loads at least its known root files', ['server.js', 'mcp.js', 'mcp-tools.js'].every((f) => seen.has(f)), [...seen].join(' '));
for (const f of needed) check(`${f} is copied into the image`, copied.has(f), `${f} is imported at run time but missing from the Dockerfile's COPY line`);
for (const f of [...seen].filter((f) => f.startsWith('src' + path.sep))) if (!wholeDirs.has('src')) check(`${f} is copied into the image`, false, 'the src folder is not copied');

// the layout the image would have, started for real
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketchy-image-'));
for (const f of copied) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dir, f));
fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
if (fs.existsSync(path.join(root, 'dist'))) fs.cpSync(path.join(root, 'dist'), path.join(dir, 'dist'), { recursive: true });
const port = 9800 + Math.floor(Math.random() * 100), data = path.join(dir, 'data');
const srv = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_USER: 'boss', ADMIN_PASSWORD: 'correct-horse-battery', HIBP_URL: 'http://127.0.0.1:1/' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 60 && !out.includes('Sketchy on') && srv.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
check('the server starts from a folder holding only what the image holds', out.includes('Sketchy on'), out.split('\n').filter((l) => /Error|Cannot find/.test(l)).slice(0, 2).join(' | ') || out.slice(0, 200));
let health = null; try { health = await fetch(`http://127.0.0.1:${port}/api/me`).then((r) => r.status); } catch { /* not up */ }
check('and answers a request', health === 200, String(health));
// the assistant's worker starts too (it loads the kernel files)
let mcp = null; try { mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status); } catch { /* not up */ }
check('the MCP endpoint is there (it refuses without a token)', mcp === 401 || mcp === 403, String(mcp));
srv.kill(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
