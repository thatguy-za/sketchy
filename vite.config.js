import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const api = `http://localhost:${process.env.PORT || 8080}`; // where server.js listens (npm run dev starts it)
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) }, // shown at the bottom of the designs panel
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true, port: 5173, proxy: { '/api': api, '/mcp': api } },
});
