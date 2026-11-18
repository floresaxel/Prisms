/**
 * The production build ships `/dev-sw.js` so a browser that last ran `vite dev`
 * on the same origin replaces its stale dev service worker instead of showing a
 * blank page (apps/web/retire-dev-sw.ts).
 */
import { describe, expect, it, vi } from 'vitest';

import { RETIRE_DEV_SW_FILE, RETIRE_DEV_SW_SOURCE, retireDevServiceWorker } from '../retire-dev-sw';

describe('retireDevServiceWorker', () => {
  it('emits dev-sw.js — the path the dev worker was registered at — in builds only', () => {
    const plugin = retireDevServiceWorker();
    expect(plugin.apply).toBe('build');
    const emitFile = vi.fn();
    (plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void).call({ emitFile });
    expect(emitFile).toHaveBeenCalledWith({ type: 'asset', fileName: 'dev-sw.js', source: RETIRE_DEV_SW_SOURCE });
    expect(RETIRE_DEV_SW_FILE).toBe('dev-sw.js');
  });

  it('takes over, unregisters itself and reloads its pages', async () => {
    const listeners: Record<string, (e: { waitUntil: (p: Promise<unknown>) => void }) => void> = {};
    const navigate = vi.fn(async () => undefined);
    const self = {
      skipWaiting: vi.fn(),
      addEventListener: (type: string, fn: (e: { waitUntil: (p: Promise<unknown>) => void }) => void) => (listeners[type] = fn),
      clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => [{ url: 'http://localhost:5173/', navigate }]) },
      registration: { unregister: vi.fn(async () => true) },
    };
    new Function('self', RETIRE_DEV_SW_SOURCE)(self);

    listeners['install']!({ waitUntil: () => undefined });
    expect(self.skipWaiting).toHaveBeenCalled();

    let done: Promise<unknown> = Promise.resolve();
    listeners['activate']!({ waitUntil: (p) => (done = p) });
    await done;
    expect(self.clients.claim).toHaveBeenCalled();
    expect(self.registration.unregister).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('http://localhost:5173/');
  });
});
