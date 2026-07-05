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
