import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Reached via the nginx container, whose Host header is not `localhost`.
    allowedHosts: true,
    // Reached through the nginx reverse proxy in dev; the container's own
    // hostname differs from the browser's, so HMR needs the public address.
    hmr: { clientPort: Number(process.env['HTTP_PORT'] ?? 8080) },
    // Direct `pnpm dev` outside Docker still needs the API reachable.
    proxy: {
      '/api': {
        target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
