/**
 * My Day shows the time logged against a task even when it has no estimate (so
 * there is no progress bar to fill). Requires the live stack.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

test('My Day: an unestimated task still shows what has been logged in it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Logged User');
  await page.getByTestId('email').fill(`e2e-myday-logged-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), worked: randomUUID(), fresh: randomUUID(), est: randomUUID() };
  const entry = randomUUID();
  const end = Date.now() - 60_000;
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        // no estimate on either of these two
        cmd('node.create', { id: ids.worked, node_type: 'task', title: 'Worked Task', sort_order: 'a0', parent_id: ids.p }),
        cmd('node.create', { id: ids.fresh, node_type: 'task', title: 'Fresh Task', sort_order: 'a1', parent_id: ids.p }),
        cmd('node.create', { id: ids.est, node_type: 'task', title: 'Estimated Task', sort_order: 'a2', parent_id: ids.p, estimate_minutes: 30 }),
        // 45 minutes against the first one
        cmd('timer.clock_in', { entry_id: entry, task_id: ids.worked, started_at: new Date(end - 45 * 60_000).toISOString() }),
        cmd('timer.clock_out', { entry_id: entry, ended_at: new Date(end).toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await expect(page.getByTestId(`myday-row-${ids.worked}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`logged-${ids.worked}`)).toHaveText('45m logged');
  await expect(page.getByTestId(`logged-${ids.fresh}`)).toHaveText('nothing logged');
  // a task WITH an estimate keeps its progress bar, not this cell
  await expect(page.getByTestId(`logged-${ids.est}`)).toHaveCount(0);
  await expect(page.getByTestId(`progress-${ids.est}`)).toBeAttached(); // 0% wide, so not "visible"

  // while it runs, the banner carries the same figure
  await page.getByTestId(`clock-in-${ids.worked}`).click();
  await expect(page.getByTestId('run-banner').getByTestId(`logged-${ids.worked}`)).toContainText('logged');
});
