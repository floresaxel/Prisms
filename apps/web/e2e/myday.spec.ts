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
  // the picker starts empty ("Assign project"); once the project has synced it is a choice
  const pick = page.getByTestId(`myday-promote-target-${activityId}`);
  await expect(pick).toBeEnabled({ timeout: 30_000 });
  await expect(pick).toContainText('Assign project');
  await expect(page.getByTestId(`myday-promote-${activityId}`)).toBeDisabled();
  await pick.click();
  await page.getByTestId(`myday-promote-target-${activityId}-opt-${ids.p}`).click();
  // picking a project hands focus to Assign, so Enter assigns
  await expect(page.getByTestId(`myday-promote-${activityId}`)).toBeFocused();
  await page.keyboard.press('Enter');
  const promoted = page.getByTestId(`myday-row-${activityId}`);
  await expect(promoted).toBeVisible({ timeout: 30_000 });
  await expect(promoted.locator('.px-due--today')).toHaveText('Today');
  await expect(page.getByTestId('myday-captured')).toHaveCount(0);
});

test('My Day: split focus — run two timers together, clock out of one, then switch', async ({ page }) => {
  await register(page, 'split');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), a: randomUUID(), b: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Split Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Split Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Split Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.a, node_type: 'task', title: 'Alpha Task', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.b, node_type: 'task', title: 'Beta Task', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByTestId(`myday-row-${ids.b}`)).toBeVisible({ timeout: 30_000 });

  // ── first timer: no question asked ──
  await page.getByTestId(`clock-in-${ids.a}`).click();
  await expect(page.getByTestId('clockin-dialog')).toHaveCount(0);
  await expect(page.getByTestId('run-banner')).toHaveCount(1);

  // ── second: the pop-up offers switch or split; split keeps both running ──
  await page.getByTestId(`clock-in-${ids.b}`).click();
  await expect(page.getByTestId('clockin-dialog')).toBeVisible();
  await expect(page.getByTestId(`clockin-stop-${ids.a}`)).toBeChecked();
  await page.getByTestId('clockin-split').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(2);
  await expect(page.getByTestId('split-note')).toContainText('2 timers');
  await expect(page.getByTestId('timer-more')).toHaveText('+1');

  // ── clicking the topbar timer lists every running timer in a small menu ──
  await expect(page.getByTestId('timer-menu')).toHaveCount(0);
  await page.getByTestId('timer-menu-toggle').click();
  await expect(page.getByTestId('timer-menu')).toBeVisible();
  await expect(page.getByTestId('timer-menu').getByRole('menuitem')).toHaveCount(2);
  await expect(page.getByTestId(`timer-menu-row-${ids.a}`)).toContainText('Alpha Task');
  await expect(page.getByTestId(`timer-menu-row-${ids.b}`)).toContainText('Beta Task');
  // hovering a row shows the task's whole title (its tooltip), not a generic hint
  await expect(page.getByTestId(`timer-menu-open-${ids.a}`)).toHaveAttribute('title', 'Alpha Task');
  await expect(page.getByTestId(`timer-menu-open-${ids.b}`)).toHaveAttribute('title', 'Beta Task');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('timer-menu')).toHaveCount(0);

  // ── clicking a task in the menu opens THAT task's details card (and closes the menu) ──
  await page.getByTestId('timer-menu-toggle').click();
  await page.getByTestId(`timer-menu-open-${ids.a}`).click();
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  await expect(page.getByTestId('td-title')).toHaveValue('Alpha Task');
  await expect(page.getByTestId('timer-menu')).toHaveCount(0);
  await page.getByTestId('td-done').click();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  // ── clock out of ONE from its own card: its review, the other keeps running ──
  await page.getByTestId(`run-clock-out-${ids.a}`).click();
  await expect(page.getByTestId('review-save')).toBeVisible();
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(1);
  await expect(page.getByTestId('run-banner')).toContainText('Beta Task');
  await expect(page.getByTestId('split-note')).toHaveCount(0);

  // ── switch: clock in to Alpha again, keep Beta ticked → Beta stops, Alpha runs ──
  await page.getByTestId(`clock-in-${ids.a}`).click();
  await expect(page.getByTestId(`clockin-stop-${ids.b}`)).toBeChecked();
  await page.getByTestId('clockin-switch').click();
  await expect(page.getByTestId('review-save')).toBeVisible(); // Beta's review
  await expect(page.getByTestId('review-cancel')).toHaveCount(0); // already stopped by the switch: nothing to cancel
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(1);
  await expect(page.getByTestId('run-banner')).toContainText('Alpha Task');
  await page.getByTestId('timer-clock-out').click();
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('running-timer')).toHaveCount(0);
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
  await page.getByTestId('review-save').click(); // the timer stops once the review is saved
  await expect(page.getByTestId('why-this-matters')).toHaveCount(0);
});

test('My Day: the running task has its own Clock out, which opens the session review', async ({ page }) => {
  await register(page, 'runout');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Own Clock Out Task', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await expect(page.getByTestId(`myday-row-${ids.t}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`run-clock-out-${ids.t}`)).toHaveCount(0);

  await page.getByTestId(`clock-in-${ids.t}`).click();
  await expect(page.getByTestId('run-banner')).toContainText('Own Clock Out Task');
  // the banner's mark is a pulsing circle in the project's colour, not the Prisms logo
  await expect(page.getByTestId('run-mark-core')).toHaveClass(/px-pdot--blue/);
  await expect(page.getByTestId('run-mark').locator('.px-run-wave')).toHaveCount(1); // the one trailing ring
  await expect(page.getByTestId('run-banner').locator('svg')).toHaveCount(1); // only the Clock out button's stop icon
  // the topbar pill wears the very same pulsing circle (white): same size, same ring
  await expect(page.getByTestId('timer-mark')).toBeVisible();
  await expect(page.getByTestId('timer-mark').locator('.px-run-wave')).toHaveCount(1);
  const sizeOf = (id: string) => page.getByTestId(id).evaluate((el) => `${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`);
  expect(await sizeOf('timer-mark')).toBe(await sizeOf('run-mark'));
  // …and both counters read the same time
  await expect
    .poll(async () => (await page.getByTestId('timer-elapsed').innerText()) === (await page.locator('.px-run-clock').innerText()))
    .toBe(true);
  await expect(page.getByTestId('running-timer').locator('svg')).toHaveCount(1); // only the stop icon

  // with one timer, the pill's task opens that task's details card; its tooltip is the whole title
  await expect(page.getByTestId('timer-open-task')).toHaveAttribute('title', 'Own Clock Out Task');
  await page.getByTestId('timer-open-task').click();
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  await expect(page.getByTestId('td-title')).toHaveValue('Own Clock Out Task');
  await page.getByTestId('td-done').click();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  // the task's own banner stops the timer — no need to reach for the topbar pill
  await page.getByTestId(`run-clock-out-${ids.t}`).click();
  await expect(page.getByTestId('review-save')).toBeVisible();
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(0);
  await expect(page.getByTestId('running-timer')).toHaveCount(0);
  await expect(page.getByTestId(`clock-in-${ids.t}`)).toBeEnabled();
});

test('My Day: a task with steps expands and collapses them, on its row and in its run card', async ({ page }) => {
  await register(page, 'steps');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), withSteps: randomUUID(), bare: randomUUID(), s1: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Steps Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Steps Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Steps Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.withSteps, node_type: 'task', title: 'Stepped Task', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.bare, node_type: 'task', title: 'Bare Task', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('step.add', { id: ids.s1, task_id: ids.withSteps, title: 'First step', sort_order: 'a0' }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByTestId(`myday-row-${ids.bare}`)).toBeVisible({ timeout: 30_000 });

  // only the task WITH steps gets the bubble
  const toggle = page.getByTestId(`steps-toggle-${ids.withSteps}`);
  await expect(toggle).toHaveText('1 step', { timeout: 30_000 });
  await expect(page.getByTestId(`steps-toggle-${ids.bare}`)).toHaveCount(0);

  // expand: the checklist shows; adding and ticking work here too; no card opens
  const panel = page.getByTestId(`substeps-${ids.withSteps}`);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText('First step')).toBeVisible();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);
  await page.getByTestId(`step-add-${ids.withSteps}`).fill('Second step');
  await page.getByTestId(`step-add-${ids.withSteps}`).press('Enter');
  await expect(panel.getByText('Second step')).toBeVisible();
  await page.getByTestId(`step-toggle-${ids.s1}`).click();
  await expect(toggle).toHaveText('1/2 steps');

  // collapse
  await toggle.click();
  await expect(panel).toHaveCount(0);

  // clocked in: the run card carries the same bubble
  await page.getByTestId(`clock-in-${ids.withSteps}`).click();
  const banner = page.getByTestId('run-banner');
  await expect(banner).toContainText('Stepped Task');
  await banner.getByTestId(`steps-toggle-${ids.withSteps}`).click();
  await expect(panel.getByText('Second step')).toBeVisible();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);
  await banner.getByTestId(`steps-toggle-${ids.withSteps}`).click();
  await expect(panel).toHaveCount(0);
});

test('My Day: project pentagons wear the colour of their vision; the run mark stays blue', async ({ page }) => {
  await register(page, 'vcolour');
  const ids = { v1: randomUUID(), r1: randomUUID(), p1: randomUUID(), a: randomUUID(), done: randomUUID(), v2: randomUUID(), r2: randomUUID(), p2: randomUUID(), b: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v1, node_type: 'vision', title: 'Work', sort_order: 'a0', attributes: { color: 'red' } }),
        cmd('node.create', { id: ids.r1, node_type: 'roadmap', title: 'Plan A', sort_order: 'a0', parent_id: ids.v1 }),
        cmd('node.create', { id: ids.p1, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r1 }),
        cmd('node.create', { id: ids.a, node_type: 'task', title: 'Write the note', sort_order: 'a0', parent_id: ids.p1, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.done, node_type: 'task', title: 'Already done', sort_order: 'a1', parent_id: ids.p1, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.v2, node_type: 'vision', title: 'Home', sort_order: 'a1', attributes: { color: 'teal' } }),
        cmd('node.create', { id: ids.r2, node_type: 'roadmap', title: 'Plan B', sort_order: 'a0', parent_id: ids.v2 }),
        cmd('node.create', { id: ids.p2, node_type: 'project', title: 'Garden', sort_order: 'a0', parent_id: ids.r2 }),
        cmd('node.create', { id: ids.b, node_type: 'task', title: 'Order mulch', sort_order: 'a0', parent_id: ids.p2, estimate_minutes: 30 }),
        cmd('node.check_off', { id: ids.done, completed_at: new Date().toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  const RED = 'rgb(220, 38, 38)';
  const TEAL = 'rgb(13, 148, 136)';
  // a project pentagon is an SVG (its colour is `fill`); the run mark is a plain span (`background`)
  const bg = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((el) => (el instanceof SVGElement ? getComputedStyle(el).fill : getComputedStyle(el).backgroundColor));
  const row = (id: string) => page.getByTestId(`myday-row-${id}`);
  await expect(row(ids.b)).toBeVisible({ timeout: 30_000 });

  // available rows, and the project filter chips
  expect(await bg(row(ids.a).locator('.px-pdot'))).toBe(RED);
  expect(await bg(row(ids.b).locator('.px-pdot'))).toBe(TEAL);
  expect(await bg(page.getByTestId(`filter-${ids.p1}`).locator('.px-pdot'))).toBe(RED);
  expect(await bg(page.getByTestId(`filter-${ids.p2}`).locator('.px-pdot'))).toBe(TEAL);

  // a done row (the Done-today section starts collapsed)
  if ((await page.getByTestId('sec-done').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('sec-done').click();
  expect(await bg(page.getByTestId(`myday-done-${ids.done}`).locator('.px-pdot'))).toBe(RED);

  // clocked in: the card's pentagon takes the vision colour…
  await page.getByTestId(`clock-in-${ids.b}`).click();
  const banner = page.getByTestId('run-banner');
  await expect(banner).toContainText('Order mulch');
  expect(await bg(banner.locator('.px-pdot'))).toBe(TEAL);
  // the pulsing mark is blue whichever project (and vision) the task is in
  expect(await bg(page.getByTestId('run-mark-core'))).toBe('rgb(47, 107, 255)');
});
