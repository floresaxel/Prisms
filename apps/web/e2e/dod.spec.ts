/**
 * S15 DoD e2e (Playwright). Register → seed data renders from local SQLite
 * (PowerSync sync-down) → airplane-mode reload still works → an optimistic
 * edit the server rejects (a 5th vision, I2) visibly rolls back.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
});

test('login → seed renders, airplane reload, optimistic rollback', async ({ page, context }) => {
  const email = `e2e-${Date.now()}@prisms.test`;

  // --- register through the UI -------------------------------------------
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('E2E User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();

  // app shell renders once authenticated
  await expect(page.getByTestId('sync-state')).toBeVisible();

  // --- seed this user's data via the command API (shares the cookie) -----
  const ids = {
    v1: randomUUID(), v2: randomUUID(), v3: randomUUID(), v4: randomUUID(),
    roadmap: randomUUID(), project: randomUUID(), t1: randomUUID(), t2: randomUUID(),
  };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v1, node_type: 'vision', title: 'Wellness', sort_order: 'a0' }),
        cmd('node.create', { id: ids.v2, node_type: 'vision', title: 'Work', sort_order: 'a1' }),
        cmd('node.create', { id: ids.v3, node_type: 'vision', title: 'Knowledge', sort_order: 'a2' }),
        cmd('node.create', { id: ids.v4, node_type: 'vision', title: 'Expression', sort_order: 'a3' }),
        cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v2 }),
        cmd('node.create', { id: ids.project, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.roadmap }),
        cmd('node.create', { id: ids.t1, node_type: 'task', title: 'Task One', sort_order: 'a0', parent_id: ids.project, estimate_minutes: 60 }),
        cmd('node.create', { id: ids.t2, node_type: 'task', title: 'Task Two', sort_order: 'a1', parent_id: ids.project, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // --- DoD 1: seed renders from local SQLite (synced down) ---------------
  await expect(page.getByText('Task One')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Task Two')).toBeVisible();

  // --- DoD 2: airplane-mode reload still works (app shell + OPFS) --------
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Task One')).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);

  // --- DoD 3: an optimistic edit rejected by the server rolls back -------
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByTestId('vision-count')).toHaveText('(4)');
  await page.getByTestId('new-vision').click();
  // optimistic insert briefly shows 5; the server rejects (E_MAX_VISIONS) and
  // the unchanged truth syncs back → reverts to 4, with a rejection toast.
  await expect(page.getByTestId('rejection-toast')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('vision-count')).toHaveText('(4)');
});
