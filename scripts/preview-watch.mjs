// `npm run preview:watch`: the server on $PORT serving the built app, and a build that re-runs whenever a source file changes, so a
// reload of the page shows the latest code. (npm run dev is the hot-reload alternative on two ports.)
import { spawn } from 'node:child_process';

const children = [];
let stopping = false;
const run = (name, args, env = {}) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const tag = (d) => String(d).split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => { if (!stopping) { console.error(`[${name}] exited (${code}); stopping`); stop(code || 1); } });
  children.push(p);
};
const stop = (code = 0) => { stopping = true; children.forEach((c) => c.kill()); setTimeout(() => process.exit(code), 200); };
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('server', ['server.js'], { DATA_DIR: process.env.DATA_DIR || './data' });
run('build', ['node_modules/vite/bin/vite.js', 'build', '--watch']);
