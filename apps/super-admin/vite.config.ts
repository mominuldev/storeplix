/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Phase 4.7 (contract §7.1): same-origin API. /api and /sanctum are proxied to Laravel so the session and XSRF-TOKEN
// cookies are host-only for localhost. Host is kept (changeOrigin: false) so Sanctum sees the SPA as a stateful origin.
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_PROXY_TARGET || 'http://localhost:8010';
  const proxy = { target, changeOrigin: false, xfwd: true };
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5184, strictPort: true, proxy: { '/api': proxy, '/sanctum': proxy } },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
