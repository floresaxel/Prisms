/**
 * S18 DoD e2e (Playwright):
 *   - the daily-target ring fills during an OFFLINE clock-in on a skill task
 *     (the running timer folds into today's minutes — live incremental
 *     overlay, §7.2);
 *   - a kanban card dragged to another day re-dates the task and persists
 *     across a reload (node.set_dates).
 *
 * (The "streak flips at the day-reset hour" DoD item is a clock-injected core
 * unit test — packages/core/test/aggregates/streaks.test.ts.)
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

async function register(page: import('@playwright/test').Page, tag: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('S18 User');
  await page.getByTestId('email').fill(`e2e-s18-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('daily-target ring fills during an offline clock-in on a skill task', async ({ page, context }) => {
  await register(page, 'ring');

  const ids = { vision: randomUUID(), habit: randomUUID(), task: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'Wellness', sort_order: 'a0' }),
        cmd('habit.create', {
          id: ids.habit, vision_id: ids.vision, title: 'Piano', rrule: 'FREQ=DAILY',
          streak_mode: 'daily', daily_target_minutes: 1, level_thresholds_hours: [1, 10],
        }),
        // a parentless task justified by the habit (I3) — practice counts here
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Practice', sort_order: 'a0', habit_id: ids.habit, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // the skill task syncs down to the worklist
  await expect(page.getByText('Practice')).toBeVisible({ timeout: 30_000 });

  // ring starts empty
  await page.getByRole('link', { name: 'Habits' }).click();
  const ring = page.getByTestId(`ring-${ids.habit}`);
  await expect(ring).toHaveAttribute('data-fill', '0.000');

  // --- offline clock-in on the skill task ------------------------------
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Worklist' }).click();
  await page.getByTestId(`clock-in-${ids.task}`).click();
  await expect(page.getByTestId('running-timer')).toBeVisible();

  // back to habits — the ring fills live from the running timer
  await page.getByRole('link', { name: 'Habits' }).click();
  await expect.poll(async () => Number(await page.getByTestId(`ring-${ids.habit}`).getAttribute('data-fill')), { timeout: 10_000 }).toBeGreaterThan(0);

  await context.setOffline(false);
});

test('habit CRUD: create, edit (daily target), delete through the UI', async ({ page }) => {
  await register(page, 'crud');

  // a vision to attach habits to
  const vision = randomUUID();
  const seed = await page.request.post('/sync/upload', {
    data: { device_id: 'e2e-seed', commands: [cmd('node.create', { id: vision, node_type: 'vision', title: 'Wellness', sort_order: 'a0' })] },
  });
  expect(seed.ok()).toBeTruthy();

  await page.getByRole('link', { name: 'Habits' }).click();
  // wait for the vision to sync so the create form can attach to it
  await expect(page.getByTestId('habit-vision')).toContainText('Wellness', { timeout: 30_000 });

  // create
  await page.getByTestId('habit-title').fill('Read');
  await page.getByTestId('habit-target').fill('30');
  await page.getByTestId('habit-add').click();
  const row = page.getByTestId('habits').locator('li', { hasText: 'Read' });
  await expect(row).toContainText('30m today');

  // update — change the daily target via the edit modal
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('edit-target').fill('45');
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('habits').locator('li', { hasText: 'Read' })).toContainText('45m today');

  // delete
  await page.getByTestId('habits').locator('li', { hasText: 'Read' }).getByRole('button', { name: 'delete' }).click();
  await expect(page.getByTestId('habits')).not.toContainText('Read');
});

test('kanban: dragging a card to another day re-dates it and persists', async ({ page }) => {
  await register(page, 'kanban');

  const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.vision }),
        cmd('node.create', { id: ids.project, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.roadmap }),
        // no due_date → starts in the backlog column
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Move Me', sort_order: 'a0', parent_id: ids.project, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.getByRole('link', { name: 'Kanban' }).click();
  const card = page.getByTestId(`kanban-card-${ids.task}`);
  await expect(card).toBeVisible({ timeout: 30_000 });

  // it starts in the backlog (first column)
  const backlog = page.locator('.px-kanban-col').nth(0);
  await expect(backlog.getByTestId(`kanban-card-${ids.task}`)).toBeVisible();

  // drag it to the "tomorrow" column (backlog, today, +1 → index 2)
  const tomorrow = page.locator('.px-kanban-col').nth(2);
  await card.hover();
  await page.mouse.down();
  await tomorrow.hover();
  await page.mouse.up();

  // it moved out of the backlog into the tomorrow column
  await expect(tomorrow.getByTestId(`kanban-card-${ids.task}`)).toBeVisible();
  await expect(backlog.getByTestId(`kanban-card-${ids.task}`)).toHaveCount(0);

  // …and the re-dating persists across a reload (local OPFS + synced)
  await page.reload();
  await expect(page.locator('.px-kanban-col').nth(2).getByTestId(`kanban-card-${ids.task}`)).toBeVisible({ timeout: 20_000 });
});
