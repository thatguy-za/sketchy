import { defineConfig } from 'vite';
const api = `http://localhost:${process.env.PORT || 8080}`; // where server.js listens (npm run dev starts it)
export default defineConfig({
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true, port: 5173, proxy: { '/api': api, '/mcp': api } },
});
