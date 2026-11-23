/**
 * Review tab › clock-in log e2e (Playwright): recent sessions are listed, each
 * with a focus multiple that steps with arrows like the task card's Duration,
 * is saved at once, and survives a reload; a session closed with "Later" in the
 * clock-out review turns up there as not yet reviewed.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { goto } from './util/nav';

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
  await page.locator('input[autocomplete="name"]').fill('Log User');
  await page.getByTestId('email').fill(`e2e-clock-log-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

async function seedWorld(page: Page, titles: string[]): Promise<{ tasks: string[]; commands: ReturnType<typeof cmd>[] }> {
  const v = randomUUID();
  const r = randomUUID();
  const p = randomUUID();
  const tasks = titles.map(() => randomUUID());
  const commands = [
    cmd('node.create', { id: v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
    cmd('node.create', { id: r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: v }),
    cmd('node.create', { id: p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: r }),
    ...titles.map((title, i) => cmd('node.create', { id: tasks[i]!, node_type: 'task', title, sort_order: `a${i}`, parent_id: p, estimate_minutes: 120 })),
  ];
  return { tasks, commands };
}

test('the Review tab logs recent sessions and steps each one’s focus multiple', async ({ page }) => {
  await register(page);
  const world = await seedWorld(page, ['Deep Work', 'Meetings']);
  const entries = { a: randomUUID(), b: randomUUID() };
  const end = Date.now() - 5 * 60_000;
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...world.commands,
        // 60 minutes on Deep Work, never reviewed
        cmd('timer.clock_in', { entry_id: entries.a, task_id: world.tasks[0], started_at: new Date(end - 60 * 60_000).toISOString() }),
        cmd('timer.clock_out', { entry_id: entries.a, ended_at: new Date(end).toISOString() }),
        // 30 minutes on Meetings, reviewed at ×0.8 an hour earlier
        cmd('timer.clock_in', { entry_id: entries.b, task_id: world.tasks[1], started_at: new Date(end - 150 * 60_000).toISOString() }),
        cmd('timer.clock_out', { entry_id: entries.b, ended_at: new Date(end - 120 * 60_000).toISOString() }),
        cmd('timer.review', { entry_id: entries.b, focus_factor: 0.8, completed_session: false }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'review');
  const a = page.getByTestId(`log-row-${entries.a}`);
  const b = page.getByTestId(`log-row-${entries.b}`);
  await expect(a).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('clock-log-count')).toHaveText('(2)');
  await expect(a).toContainText('Deep Work');
  await expect(a).toContainText('1h 0m logged');
  // newest first
  expect(await a.evaluate((el, other) => !!(el.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING), await b.elementHandle())).toBe(true);

  // never reviewed: it counts in full until a multiple is set
  await expect(page.getByTestId(`log-pending-${entries.a}`)).toBeVisible();
  await expect(page.getByTestId(`log-focus-${entries.a}`)).toHaveValue('1.0');
  await expect(page.getByTestId(`log-counted-${entries.a}`)).toHaveText('1h 0m counted');
  await expect(page.getByTestId(`log-pending-${entries.b}`)).toHaveCount(0);
  await expect(page.getByTestId(`log-focus-${entries.b}`)).toHaveValue('0.8');

  // ── the arrows step by a tenth and save at once ──
  await expect(page.getByTestId(`log-up-${entries.a}`)).toBeDisabled(); // already at 1.0
  await page.getByTestId(`log-down-${entries.a}`).click();
  await expect(page.getByTestId(`log-focus-${entries.a}`)).toHaveValue('0.9');
  await expect(page.getByTestId(`log-counted-${entries.a}`)).toHaveText('54m counted');
  await expect(page.getByTestId(`log-pending-${entries.a}`)).toHaveCount(0);
  await expect(page.getByTestId('clock-log')).not.toContainText('not reviewed yet'); // nothing left to review

  // ── ↓ in the field, a typed value, and the floor ──
  const f = page.getByTestId(`log-focus-${entries.b}`);
  await f.focus();
  await f.press('ArrowDown');
  await expect(f).toHaveValue('0.7');
  await f.fill('0.1');
  await f.press('Enter');
  await expect(f).toHaveValue('0.5'); // clamped
  await expect(page.getByTestId(`log-counted-${entries.b}`)).toHaveText('15m counted');
  await expect(page.getByTestId(`log-down-${entries.b}`)).toBeDisabled();

  // junk puts the stored value back; Escape abandons a half-typed edit
  await f.fill('lots');
  await f.press('Enter');
  await expect(f).toHaveValue('0.5');
  await f.fill('0.9');
  await f.press('Escape');
  await expect(f).toHaveValue('0.5');

  // ── it all survives a reload (it went through timer.review) ──
  await page.reload();
  await expect(page.getByTestId(`log-focus-${entries.a}`)).toHaveValue('0.9', { timeout: 30_000 });
  await expect(page.getByTestId(`log-focus-${entries.b}`)).toHaveValue('0.5');
  await expect(page.getByTestId(`log-pending-${entries.a}`)).toHaveCount(0);
});

test('a session closed with "Later" shows up in the log, not yet reviewed', async ({ page }) => {
  await register(page);
  const world = await seedWorld(page, ['Later Task']);
  const seed = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands: world.commands } });
  expect(seed.ok()).toBeTruthy();

  await expect(page.getByTestId(`clock-in-${world.tasks[0]}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`clock-in-${world.tasks[0]}`).click();
  await expect(page.getByTestId('run-banner')).toContainText('Later Task');
  await page.getByTestId(`run-clock-out-${world.tasks[0]}`).click();
  await page.getByTestId('review-later').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(0);

  await goto(page, 'review');
  const row = page.getByTestId('clock-log').locator('[data-testid^="log-row-"]');
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText('Later Task');
  await expect(row.locator('[data-testid^="log-pending-"]')).toBeVisible();

  // setting its multiple from there marks it reviewed
  await row.locator('[data-testid^="log-down-"]').click();
  await expect(row.locator('[data-testid^="log-focus-"]')).toHaveValue('0.9');
  await expect(row.locator('[data-testid^="log-pending-"]')).toHaveCount(0);
});
