/**
 * The service worker after the bundle was split (load plan, phase 4).
 *
 * Every screen is now a chunk of its own that loads on demand, and the
 * precache keeps only the SQLite build the app runs. Both changes are only
 * safe if a device that goes offline still has everything it needs:
 *   - the precache holds the async wa-sqlite build and none of the three
 *     builds nothing loads;
 *   - after an OFFLINE reload — a fresh page with no screen in memory — every
 *     screen still opens, its chunk served from the precache.
 *
 * Requires the live stack, served as a BUILD (vite preview): only a build
 * precaches (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { goto, type NavKey } from './util/nav';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('PWA User');
  await page.getByTestId('email').fill(`e2e-pwa-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

/** Every screen in the sidebar, by its nav key. */
const SCREENS: NavKey[] = ['agenda', 'journal', 'projects', 'tasks', 'habits', 'dashboard', 'vision', 'roadmap', 'automations', 'review', 'settings', 'myday'];

test('the precache holds every screen and only the SQLite build that runs — and the app opens every screen offline', async ({
  page,
  context,
}) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Offline Task', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByText('Offline Task')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });

  // The worker controls the page only once it has activated, i.e. its precache is complete.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) paths.push(new URL(req.url).pathname);
    }
    return paths;
  });
  expect(cached.filter((p) => /\/assets\/wa-sqlite-async-[\w-]+\.wasm$/.test(p))).toHaveLength(1);
  expect(cached.filter((p) => /\/assets\/(?:mc-wa-sqlite|wa-sqlite-(?!async-))[\w-]*\.(?:wasm|js)$/.test(p))).toEqual([]);

  // Offline, and a FRESH page: nothing is in memory, so each screen's chunk has
  // to come out of the precache.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Offline Task')).toBeVisible({ timeout: 30_000 });
  for (const key of SCREENS) {
    await goto(page, key);
    await expect(page.getByTestId('screen-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('screen-failed')).toHaveCount(0);
  }
  await expect(page.getByText('Offline Task')).toBeVisible(); // back on My Day, still from local data
  await context.setOffline(false);
});
