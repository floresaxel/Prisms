/**
 * Review tab e2e (Playwright). A session closed with "Review later" is a regular
 * review item at the top of the tab: set its focus multiple (kept in the row), then
 * Clear — which saves it and moves the session into the clock-in log below, whose
 * rows hold each REVIEWED session's multiple, step with arrows like the task card's
 * Duration, are saved at once, and survive a reload. The nav badge and the tab's
 * count include the pending sessions.
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

test('a session put off with "Review later" is a review item; Clear moves it into the log', async ({ page }) => {
  await register(page);
  const world = await seedWorld(page, ['Deep Work', 'Meetings']);
  const entries = { a: randomUUID(), b: randomUUID() };
  const end = Date.now() - 5 * 60_000;
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...world.commands,
        // 60 minutes on Deep Work, never reviewed (it was put off)
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
  const item = page.getByTestId(`session-review-${entries.a}`);
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toContainText('Deep Work');
  await expect(item).toContainText('1h 0m logged');
  await expect(item).toContainText('Session review');
  // a regular review item: counted in the tab's total and the nav badge
  await expect(page.getByTestId('review-count')).toHaveText('(1)');
  await expect(page.getByTestId('nav-review')).toContainText('1');
  // and filed under Info
  await page.getByTestId('review-filter-info').click();
  await expect(item).toBeVisible();
  await page.getByTestId('review-filter-error').click();
  await expect(item).toHaveCount(0);
  await page.getByTestId('review-filter-all').click();
  await expect(item).toBeVisible();

  // the log holds only the REVIEWED session — the pending one waits above
  await expect(page.getByTestId('clock-log-count')).toHaveText('(1)');
  await expect(page.getByTestId(`log-row-${entries.b}`)).toBeVisible();
  await expect(page.getByTestId(`log-row-${entries.a}`)).toHaveCount(0);
  await expect(page.getByTestId(`log-focus-${entries.b}`)).toHaveValue('0.8');

  // ── set the multiple in the item: it counts at 1.0 until then, and stepping does NOT clear it ──
  await expect(page.getByTestId(`sr-focus-${entries.a}`)).toHaveValue('1.0');
  await expect(page.getByTestId(`sr-counted-${entries.a}`)).toHaveText('1h 0m counted');
  await expect(page.getByTestId(`sr-up-${entries.a}`)).toBeDisabled(); // already at 1.0
  await page.getByTestId(`sr-down-${entries.a}`).click();
  await expect(page.getByTestId(`sr-focus-${entries.a}`)).toHaveValue('0.9');
  await expect(page.getByTestId(`sr-counted-${entries.a}`)).toHaveText('54m counted');
  const sf = page.getByTestId(`sr-focus-${entries.a}`);
  await sf.focus();
  await sf.press('ArrowDown');
  await expect(sf).toHaveValue('0.8');
  await sf.fill('lots'); // junk puts the last good value back
  await sf.press('Enter');
  await expect(sf).toHaveValue('0.8');
  await sf.fill('0.9');
  await sf.press('Enter');
  await expect(sf).toHaveValue('0.9');
  await page.waitForTimeout(500);
  await expect(item).toBeVisible(); // still an item, still in the list
  await expect(page.getByTestId(`log-row-${entries.a}`)).toHaveCount(0);

  // ── Clear: the item goes, the session joins the log at the chosen multiple ──
  await page.getByTestId(`sr-clear-${entries.a}`).click();
  await expect(item).toHaveCount(0);
  await expect(page.getByTestId('review-count')).toHaveText('(0)');
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect(page.getByTestId('clock-log-count')).toHaveText('(2)');
  await expect(page.getByTestId(`log-focus-${entries.a}`)).toHaveValue('0.9');
  await expect(page.getByTestId(`log-counted-${entries.a}`)).toHaveText('54m counted');
  // newest first
  const a = page.getByTestId(`log-row-${entries.a}`);
  const b = page.getByTestId(`log-row-${entries.b}`);
  expect(await a.evaluate((el, other) => !!(el.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING), await b.elementHandle())).toBe(true);

  // ── the log still steps a reviewed session: ↓ in the field, a typed value, and the floor ──
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
  await expect(page.getByTestId(`session-review-${entries.a}`)).toHaveCount(0);
});

test('a session closed with "Review later" shows up as a review item, and clearing it files it in the log', async ({ page }) => {
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
  const item = page.locator('[data-testid^="session-review-"]');
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await expect(item).toContainText('Later Task');
  await expect(page.getByTestId('clock-log-empty')).toBeVisible(); // nothing reviewed yet

  // review it (×0.9) and clear it: it leaves the list and lands in the log
  await item.locator('[data-testid^="sr-down-"]').click();
  await expect(item.locator('[data-testid^="sr-focus-"]')).toHaveValue('0.9');
  await item.locator('[data-testid^="sr-clear-"]').click();
  await expect(item).toHaveCount(0);
  const row = page.getByTestId('clock-log').locator('[data-testid^="log-row-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Later Task');
  await expect(row.locator('[data-testid^="log-focus-"]')).toHaveValue('0.9');
});