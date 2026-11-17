import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The wa-sqlite builds this app never loads (load plan, phase 4).
 *
 * `@powersync/web` ships four: sync and async, each plain and Multiple-Ciphers
 * (`mc-`). Which one runs is decided by the VFS and the encryption key — the
 * default IndexedDB VFS with no key, as `createDb` opens it, loads ONLY
 * `wa-sqlite-async` (`DEFAULT_MODULE_FACTORIES` in its `vfs.js`). Precaching the
 * other three cost every first visit ~5 MB of WASM it would never run, so they
 * are left out of the precache — and the OPFS VFS glue goes with them.
 *
 * If `createDb` ever moves to an OPFS VFS or an encryption key, a different
 * build loads: the runtime rule below still caches it on first use, but update
 * this list so it is precached for offline too.
 */
export const UNUSED_SQLITE_ASSET =
  /\/assets\/(?:mc-wa-sqlite[\w-]*|wa-sqlite-(?!async-)[\w-]+|OPFSCoopSyncVFS-[\w-]+|OPFSWriteAheadVFS-[\w-]+|AccessHandlePoolVFS-[\w-]+)\.(?:wasm|js)$/;

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
        globPatterns: ['**/*.{js,css,html,wasm,png}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // every screen chunk stays precached (offline navigation); only the
        // SQLite builds nothing loads are dropped — see UNUSED_SQLITE_ASSET
        manifestTransforms: [
          async (entries) => ({ manifest: entries.filter((e) => !UNUSED_SQLITE_ASSET.test(`/${e.url.replace(/^\//, '')}`)), warnings: [] }),
        ],
        // …and should one of them ever load after all, keep it for next time
        runtimeCaching: [
          {
            urlPattern: ({ url }) => UNUSED_SQLITE_ASSET.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'prisms-sqlite-builds' },
          },
        ],
        // SPA offline: serve the cached shell for navigations (airplane mode),
        // but never intercept the proxied API/sync calls or the PowerSync
        // stream path (audit S10-F7).
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/sync/, /^\/powersync/],
      },
      manifest: {
        name: 'Prisms',
        short_name: 'Prisms',
        theme_color: '#ffffff',
        background_color: '#f6f7f9',
        display: 'standalone',
        // Installability requires real icons (audit S10-F7); generated under
        // apps/web/public/ (R1), maskable variant keeps the glyph in the safe zone.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
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
