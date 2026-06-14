import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Dev: the API and /sync are reverse-proxied so the browser treats them as
 * same-origin (cookies + CSRF just work). PowerSync's wa-sqlite WASM is
 * excluded from dep optimization. vite-plugin-pwa generates the Workbox
 * app-shell service worker (§12.3).
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Enable the service worker in dev too so the airplane-mode reload path
      // (app shell from cache + data from OPFS) is exercisable by the e2e.
      devOptions: { enabled: true, type: 'module' },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // SPA offline: serve the cached shell for navigations (airplane mode),
        // but never intercept the proxied API/sync calls.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/sync/],
      },
      manifest: {
        name: 'Prisms',
        short_name: 'Prisms',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        icons: [],
      },
    }),
  ],
  optimizeDeps: { exclude: ['@journeyapps/wa-sqlite', '@powersync/web'] },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/sync': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
  // `vite preview` serves the production build (with the precaching SW) — the
  // e2e uses it so airplane-mode reload works; same proxy as dev.
  preview: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/sync': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
});
