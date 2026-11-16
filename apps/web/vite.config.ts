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
        // woff2: the bundled brand fonts, so an offline reload keeps its type
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // SPA offline: serve the cached shell for navigations (airplane mode),
        // but never intercept the proxied API/sync calls or the PowerSync
        // stream path (audit S10-F7).
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/sync/, /^\/powersync/],
      },
      manifest: {
        name: 'Prisms',
        short_name: 'Prisms',
        theme_color: '#0e1726',
        background_color: '#f4f5f7',
        display: 'standalone',
        // Installability requires real icons (audit S10-F7); generated under
        // apps/web/public/ (R1), maskable variant keeps the glyph in the safe zone.
        // The Threshold mark; new file names (not the old ones overwritten) so
        // browsers and OS launchers that cache install icons by URL pick it up.
        icons: [
          { src: '/icon-threshold-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-threshold-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-threshold-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    // Never inline a font as a data: URL. Some bundled font subsets are under
    // Vite's 4 KB inline limit, and production serves `font-src 'self'`
    // (infra/nginx/web.conf), which refuses data: fonts. Everything else keeps
    // the default limit.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
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
