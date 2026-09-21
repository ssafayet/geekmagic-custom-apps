import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env['GCA_DEV_API'] ?? 'http://127.0.0.1:3210';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages resolve to TypeScript source during development.
  resolve: { conditions: ['development'] },
  server: {
    port: 5173,
    strictPort: false,
    // The UI is same-origin in production; in dev Vite proxies to the Fastify process.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/internal': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
