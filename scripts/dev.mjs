// `npm run dev`: the same two pieces the Docker image runs, but with hot reload.
//   server.js  accounts, storage, folders, version history and the MCP endpoint (as in the container), on :8080
//   vite       the app with hot reload on :5173, proxying /api and /mcp to the server
// Designs are stored in ./data (git-ignored), just as the container stores them in its /data volume.
import { spawn } from 'node:child_process';

const children = [];
const run = (name, cmd, args, env = {}) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const tag = (d) => String(d).split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => { if (!stopping) { console.error(`[${name}] exited (${code}); stopping`); stop(code || 1); } });
  children.push(p);
};
let stopping = false;
const stop = (code = 0) => { stopping = true; children.forEach((c) => c.kill()); setTimeout(() => process.exit(code), 200); };
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('server', process.execPath, ['server.js'], { PORT: process.env.PORT || '8080', DATA_DIR: process.env.DATA_DIR || './data' });
run('app', process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], { PORT: process.env.PORT || '8080' });
