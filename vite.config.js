import { defineConfig } from 'vite';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const api = `http://localhost:${process.env.PORT || 8080}`; // where server.js listens (npm run dev starts it)
const wasmBytes = statSync(new URL('./node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url)).size; // for the loading screen's progress

/** At build time: preload the CAD kernel file from the page, and write the service worker (src/sw.js) with this version and the list of build files. */
function appShell() {
  return {
    name: 'sketchy-app-shell',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const wasm = ctx.bundle && Object.keys(ctx.bundle).find((k) => /replicad_single-[^/]*\.wasm$/.test(k));
        return wasm ? html.replace('</head>', `  <link rel="preload" href="/${wasm}" as="fetch" type="application/wasm" crossorigin>\n</head>`) : html;
      },
    },
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((k) => k.startsWith('assets/') && !k.endsWith('.map'));
      const list = ['/', ...files.map((k) => '/' + k)];
      const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8').replace('__SW_VERSION__', `${version}-${createHash('sha1').update(list.join('|')).digest('hex').slice(0, 10)}` /* changes only when a build file does */).replace('__SW_PRECACHE__', JSON.stringify(list));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version), __WASM_BYTES__: wasmBytes }, // the version is shown at the bottom of the designs panel
  plugins: [appShell()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true, port: 5173, proxy: { '/api': api, '/mcp': api } },
});
