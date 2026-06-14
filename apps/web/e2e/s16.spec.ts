/**
 * S16 DoD e2e (Playwright). The full worklist/timer/inbox loop, performed
 * OFFLINE and then synced:
 *   create activity → promote → clock in → clock out → focus review →
 *   status transitions (available → ongoing → done).
 * Plus: the single global timer makes a second clock-in impossible in the UI.
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

test('inbox → promote → clock in/out → review, offline then synced; double-timer impossible', async ({ page, context }) => {
  const email = `e2e-s16-${Date.now()}@prisms.test`;

  // --- register through the UI -------------------------------------------
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('S16 User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  // --- seed a project (a promote target) + one existing task -------------
  const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), existing: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.vision }),
        cmd('node.create', { id: ids.project, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.roadmap }),
        cmd('node.create', { id: ids.existing, node_type: 'task', title: 'Existing Task', sort_order: 'a0', parent_id: ids.project, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // project + task synced down
  await expect(page.getByText('Existing Task')).toBeVisible({ timeout: 30_000 });

  // --- go offline: the whole loop must work locally ----------------------
  await context.setOffline(true);

  // create an activity in the inbox
  await page.getByRole('link', { name: 'Inbox' }).click();
  await page.getByTestId('activity-title').fill('Promoted Task');
  await page.getByTestId('activity-add').click();
  const inboxRow = page.getByTestId('inbox').locator('li', { hasText: 'Promoted Task' });
  await expect(inboxRow).toBeVisible();

  // promote it into the seeded project (only target → default selection)
  await inboxRow.getByRole('button', { name: 'Promote' }).click();
  await expect(page.getByTestId('inbox')).not.toContainText('Promoted Task');

  // --- worklist: the promoted task is now an available task --------------
  await page.getByRole('link', { name: 'Worklist' }).click();
  const promoted = page.getByTestId('worklist').locator('li', { hasText: 'Promoted Task' });
  await expect(promoted).toBeVisible();
  await expect(promoted.locator('.px-badge')).toHaveText('available');

  // clock in → ongoing + the single running-timer bar appears
  await promoted.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByTestId('running-timer')).toBeVisible();
  await expect(page.getByTestId('running-timer')).toContainText('Promoted Task');
  await expect(promoted.locator('.px-badge')).toHaveText('ongoing');

  // double-timer impossible: every other task's clock-in is disabled
  const existing = page.getByTestId('worklist').locator('li', { hasText: 'Existing Task' });
  await expect(existing.getByRole('button', { name: 'Clock in' })).toBeDisabled();

  // clock out → focus review modal
  await page.getByTestId('timer-clock-out').click();
  await expect(page.getByTestId('review-save')).toBeVisible();
  await page.getByTestId('review-focus').fill('0.8');
  await page.getByTestId('review-completed').check();
  await page.getByTestId('review-save').click();

  // status transition: completed → leaves the worklist; timer is gone
  await expect(page.getByTestId('running-timer')).toHaveCount(0);
  await expect(page.getByTestId('worklist')).not.toContainText('Promoted Task');

  // --- back online: queued commands sync, state persists -----------------
  await context.setOffline(false);
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });
  await page.reload();
  await expect(page.getByText('Existing Task')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('worklist')).not.toContainText('Promoted Task');
});
