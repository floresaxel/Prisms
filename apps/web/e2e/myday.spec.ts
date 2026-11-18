/**
 * My Day DoD e2e (Playwright, web redesign W2/D5):
 *   - Available-now items order by PARENT-PROJECT priority from the decision board
 *     (the higher-priority project's task ranks first even though its title sorts
 *     alphabetically LAST — so only the priority join can produce the order);
 *   - a client-side project filter chip scopes the list to one project;
 *   - the "Done today" section is collapsed by default and expands on click.
 *
 * Requires the live stack (see playwright.config.ts). The priority math itself is
 * unit-tested in @prisms/core (rankProjects); this proves the My Day wiring.
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

async function register(page: Page, tag: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('My Day User');
  await page.getByTestId('email').fill(`e2e-myday-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('My Day: priority order, project filter, and the collapsed Done-today section', async ({ page }) => {
  await register(page, 'compose');
  const ids = {
    v: randomUUID(), r: randomUUID(),
    pHigh: randomUUID(), pLow: randomUUID(),
    board: randomUUID(), crit: randomUUID(),
    tHigh: randomUUID(), tLow: randomUUID(), tDone: randomUUID(),
  };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        // Zebra scores high, Apple scores low → Zebra has the higher priority even
        // though "Zebra Task" sorts after "Apple Task" alphabetically.
        cmd('node.create', { id: ids.pHigh, node_type: 'project', title: 'Zebra Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.pLow, node_type: 'project', title: 'Apple Project', sort_order: 'a1', parent_id: ids.r }),
        cmd('board.create', { id: ids.board, title: 'Priorities' }),
        cmd('criterion.create', { id: ids.crit, board_id: ids.board, label: 'Impact', weight: 5 }),
        cmd('score.set', { id: randomUUID(), criterion_id: ids.crit, project_id: ids.pHigh, score: 10 }),
        cmd('score.set', { id: randomUUID(), criterion_id: ids.crit, project_id: ids.pLow, score: 0 }),
        // one available task under each project (no due date, no blocker)
        cmd('node.create', { id: ids.tHigh, node_type: 'task', title: 'Zebra Task', sort_order: 'a0', parent_id: ids.pHigh, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.tLow, node_type: 'task', title: 'Apple Task', sort_order: 'a0', parent_id: ids.pLow, estimate_minutes: 30 }),
        // a task completed today → the "Done today" section
        cmd('node.create', { id: ids.tDone, node_type: 'task', title: 'Finished Task', sort_order: 'a1', parent_id: ids.pLow, estimate_minutes: 30 }),
        cmd('node.check_off', { id: ids.tDone, completed_at: new Date().toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // ── priority order: the higher-priority project's task ranks first ──
  await expect(page.getByTestId(`myday-row-${ids.tHigh}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`myday-row-${ids.tLow}`)).toBeVisible();
  const rows = page.getByTestId('worklist').locator('li');
  // retries until the decision board syncs and the priority join reorders the list
  await expect(rows.first()).toContainText('Zebra Task', { timeout: 30_000 });
  await expect(page.getByTestId(`myday-row-${ids.tHigh}`)).toContainText('prio');

  // ── project filter: the Apple chip scopes the list to Apple's task ──
  await page.getByTestId(`filter-${ids.pLow}`).click();
  await expect(page.getByTestId(`myday-row-${ids.tLow}`)).toBeVisible();
  await expect(page.getByTestId(`myday-row-${ids.tHigh}`)).toHaveCount(0);
  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId(`myday-row-${ids.tHigh}`)).toBeVisible();

  // ── Done today: present in the DOM but collapsed by default; expands on click ──
  await expect(page.getByTestId('sec-done')).toBeVisible();
  await expect(page.getByTestId('done-list')).toContainText('Finished Task');
  await expect(page.getByText('Finished Task')).toBeHidden();
  await page.getByTestId('sec-done').click();
  await expect(page.getByText('Finished Task')).toBeVisible();
});

test('My Day: a capture is due today, waits under the bar, and keeps its date when promoted', async ({ page }) => {
  await register(page, 'capture');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Capture Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Capture Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Capture Project', sort_order: 'a0', parent_id: ids.r }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // ── capture: no parent needed; it lands under the bar, dated today ──
  await page.getByTestId('myday-capture-title').fill('Call the plumber');
  await page.getByTestId('myday-capture-add').click();
  await expect(page.getByTestId('myday-capture-title')).toHaveValue('');
  const captured = page.getByTestId('myday-captured').locator('li', { hasText: 'Call the plumber' });
  await expect(captured).toBeVisible();
  await expect(captured).toContainText('Today');

  // ── the same item is in the Tasks Inbox (one Inbox, not a My Day copy) ──
  await page.getByTestId('nav-tasks').click();
  await expect(page.getByTestId('inbox')).toContainText('Call the plumber');
  await page.getByTestId('nav-myday').click();

  // ── promote into the project: it becomes a real task, due today, in Available now ──
  const row = page.getByTestId('myday-captured').locator('li', { hasText: 'Call the plumber' });
  const activityId = ((await row.getAttribute('data-testid')) ?? '').replace('myday-captured-', '');
  expect(activityId).not.toBe('');
  await expect(page.getByTestId(`myday-promote-target-${activityId}`).locator(`option[value="${ids.p}"]`)).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId(`myday-promote-target-${activityId}`).selectOption(ids.p);
  await page.getByTestId(`myday-promote-${activityId}`).click();
  const promoted = page.getByTestId(`myday-row-${activityId}`);
  await expect(promoted).toBeVisible({ timeout: 30_000 });
  await expect(promoted.locator('.px-due--today')).toHaveText('Today');
  await expect(page.getByTestId('myday-captured')).toHaveCount(0);
});

test('My Day: the running task walks back to its vision, one door per layer', async ({ page }) => {
  await register(page, 'trail');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), m: randomUUID(), t: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Trail Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Trail Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Trail Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.m, node_type: 'milestone', title: 'Trail Milestone', sort_order: 'a0', parent_id: ids.p }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Trail Task', sort_order: 'a0', parent_id: ids.m, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // nothing is running yet, so there is no chain to show
  await expect(page.getByTestId(`myday-row-${ids.t}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('why-this-matters')).toHaveCount(0);

  await page.getByTestId(`clock-in-${ids.t}`).click();
  await expect(page.getByTestId('running-timer')).toContainText('Trail Task');

  // vision first, the running task last — and only the running task is "now"
  const rows = page.getByTestId('why-this-matters').locator('li');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('Trail Vision');
  await expect(rows.nth(3)).toContainText('Trail Milestone');
  await expect(rows.nth(4)).toContainText('Trail Task');
  await expect(rows.nth(4)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('why-this-matters').locator('[aria-current]')).toHaveCount(1);

  await page.getByTestId('timer-clock-out').click();
  await expect(page.getByTestId('why-this-matters')).toHaveCount(0);
});
