/**
 * S19 DoD e2e (Playwright):
 *   - the dashboard renders entirely from local data (and still renders after
 *     an offline reload);
 *   - changing a criterion weight reorders the decision-board ranking
 *     instantly (priority = Σ weight×score / Σ weight, computed in core);
 *   - the projection shows a freshness label (live client estimate until a
 *     server aggregate arrives).
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { goto } from './util/nav';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor rejection)
});

async function register(page: import('@playwright/test').Page, tag: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('S19 User');
  await page.getByTestId('email').fill(`e2e-s19-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('dashboard renders from local data offline, with a projection freshness label', async ({ page, context }) => {
  await register(page, 'dash');

  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t1: randomUUID(), t2: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t1, node_type: 'task', title: 'Task One', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 120 }),
        cmd('node.create', { id: ids.t2, node_type: 'task', title: 'Task Two', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 60 }),
        cmd('node.check_off', { id: ids.t2, completed_at: new Date().toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('burndown')).toBeVisible({ timeout: 30_000 });
  // completion bar for the project appears once seed syncs
  await expect(page.getByTestId('completion')).toContainText('Launch', { timeout: 30_000 });
  // no server aggregate yet → the projection labels itself a live client estimate
  await expect(page.getByTestId('projection-freshness')).toContainText('live');

  // --- offline reload still renders the dashboard from OPFS -------------
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('burndown')).toBeVisible();
  await expect(page.getByTestId('completion')).toContainText('Launch');
  await context.setOffline(false);
});

test('changing a criterion weight reorders the priority ranking instantly', async ({ page }) => {
  await register(page, 'decide');

  const ids = {
    v: randomUUID(), r: randomUUID(), pa: randomUUID(), pb: randomUUID(),
    board: randomUUID(), c1: randomUUID(), c2: randomUUID(),
  };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.pa, node_type: 'project', title: 'Project A', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.pb, node_type: 'project', title: 'Project B', sort_order: 'a1', parent_id: ids.r }),
        cmd('board.create', { id: ids.board, title: 'Priorities' }),
        cmd('criterion.create', { id: ids.c1, board_id: ids.board, label: 'Impact', weight: 5 }),
        cmd('criterion.create', { id: ids.c2, board_id: ids.board, label: 'Ease', weight: 1 }),
        // A wins on C1, B wins on C2
        cmd('score.set', { id: randomUUID(), criterion_id: ids.c1, project_id: ids.pa, score: 10 }),
        cmd('score.set', { id: randomUUID(), criterion_id: ids.c2, project_id: ids.pa, score: 0 }),
        cmd('score.set', { id: randomUUID(), criterion_id: ids.c1, project_id: ids.pb, score: 0 }),
        cmd('score.set', { id: randomUUID(), criterion_id: ids.c2, project_id: ids.pb, score: 10 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'decisions');
  const ranking = page.getByTestId(`ranking-${ids.board}`);
  // C1 (Impact) heavy → Project A ranks first
  await expect(ranking.locator('li').first()).toHaveAttribute('data-testid', `rank-${ids.pa}`, { timeout: 30_000 });

  // make Ease dominate → Project B should jump to the top instantly
  await page.getByTestId(`weight-${ids.c2}`).fill('50');
  await expect(ranking.locator('li').first()).toHaveAttribute('data-testid', `rank-${ids.pb}`);

  // and the dashboard priority list reflects the same ranking
  await goto(page, 'dashboard');
  await expect(page.getByTestId('priority-list').locator('li').first()).toContainText('Project B');
});
