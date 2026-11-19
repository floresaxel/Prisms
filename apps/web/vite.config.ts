import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { RETIRE_DEV_SW_FILE, retireDevServiceWorker } from './retire-dev-sw';

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
    // a browser that last saw `vite dev` here keeps its dev worker — retire it
    retireDevServiceWorker(),
    VitePWA({
      registerType: 'autoUpdate',
      // Enable the service worker in dev too so the airplane-mode reload path
      // (app shell from cache + data from OPFS) is exercisable by the e2e.
      devOptions: { enabled: true, type: 'module' },
      workbox: {
        // woff2: the bundled brand fonts, so an offline reload keeps its type
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,woff2}'],
        // the dev-worker retirement script is for the browser's update check only
        globIgnores: [RETIRE_DEV_SW_FILE],
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
        theme_color: '#0e1726',
        background_color: '#f4f5f7',
        display: 'standalone',
        // Installability requires real icons (audit S10-F7); generated under
        // apps/web/public/ (R1), maskable variant keeps the glyph in the safe zone.
        // The simple (three-door) Threshold mark, drawn by scripts/render-brand.mjs.
        // New file names (not the old ones overwritten) so browsers and OS
        // launchers that cache install icons by URL pick it up.
        icons: [
          { src: '/icon-mark-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-mark-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-mark-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
