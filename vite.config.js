import { defineConfig } from 'vite';
export default defineConfig({
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true, proxy: { '/api': 'http://localhost:8080' } },
});
