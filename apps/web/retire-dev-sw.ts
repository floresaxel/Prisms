import type { Plugin } from 'vite';

/**
 * Retire a dev-server service worker when the production build takes over the
 * same origin.
 *
 * `vite dev` registers its own worker (`devOptions` in vite.config — the e2e
 * needs one) at `/dev-sw.js?dev-sw`, serving the DEV app shell (`/@vite/client`,
 * `/src/main.tsx`). Serve the production build on the same origin afterwards —
 * the desktop launcher does exactly that on :5173 — and that registration
 * lives on: the browser's update check gets the SPA fallback (index.html, not
 * JavaScript), so the old worker is never replaced, and it keeps answering
 * navigations with a shell whose dev-only modules no longer exist. The page
 * stays blank until someone unregisters it by hand.
 *
 * The production build therefore ships a real `/dev-sw.js`: a worker whose only
 * job is to take over, unregister itself and reload its pages, after which the
 * normal app loads and registers its own `/sw.js`. Build only — in dev the PWA
 * plugin serves the real dev worker at that path.
 */
export const RETIRE_DEV_SW_SOURCE = `// Retires a leftover dev-server service worker (apps/web/retire-dev-sw.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await self.registration.unregister();
    const pages = await self.clients.matchAll({ type: 'window' });
    await Promise.all(pages.map((page) => page.navigate(page.url).catch(() => undefined)));
  })());
});
`;

export const RETIRE_DEV_SW_FILE = 'dev-sw.js';

export function retireDevServiceWorker(): Plugin {
  return {
    name: 'prisms:retire-dev-service-worker',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: RETIRE_DEV_SW_FILE, source: RETIRE_DEV_SW_SOURCE });
    },
  };
}
