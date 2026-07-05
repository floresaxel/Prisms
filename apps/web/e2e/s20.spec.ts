/**
 * S20 DoD e2e (Playwright): graph surfaces + editors.
 *   - create an edge in the flowchart; a cycle attempt is rejected with an
 *     E_CYCLE toast (local validateEdge);
 *   - a visual group + a node collapse persist across a reload;
 *   - the Gantt draws a dependency arrow matching an edge;
 *   - a rule built in the editor spawns a task when a matching task completes
 *     (server automation backstop → synced down; this run enables jobs).
 * Requires the live stack with PRISMS_JOBS_ENABLED unset (jobs on).
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
  await page.locator('input[autocomplete="name"]').fill('S20 User');
  await page.getByTestId('email').fill(`e2e-s20-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

const chain = (ids: { v: string; r: string; p: string }) => [
  cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
  cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
  cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
];

test('flowchart: add an edge, a cycle is rejected with E_CYCLE, group + collapse persist', async ({ page }) => {
  await register(page, 'flow');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t1: randomUUID(), t2: randomUUID(), t3: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...chain(ids),
        cmd('node.create', { id: ids.t1, node_type: 'task', title: 'Task A', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
        cmd('node.create', { id: ids.t2, node_type: 'task', title: 'Task B', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 60 }),
        cmd('node.create', { id: ids.t3, node_type: 'task', title: 'Task C', sort_order: 'a2', parent_id: ids.p, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'graph');
  await page.getByTestId('diagram-root').selectOption(ids.p);
  await expect(page.getByTestId(`flow-node-${ids.t1}`)).toBeVisible({ timeout: 30_000 });

  // add A → B
  await page.getByTestId('edge-pred').selectOption(ids.t1);
  await page.getByTestId('edge-succ').selectOption(ids.t2);
  await page.getByTestId('edge-add').click();
  await expect(page.getByTestId('edge-list')).toContainText('Dependencies (1)');

  // attempt B → A → would close a cycle → rejected with E_CYCLE, no new edge
  await page.getByTestId('edge-pred').selectOption(ids.t2);
  await page.getByTestId('edge-succ').selectOption(ids.t1);
  await page.getByTestId('edge-add').click();
  await expect(page.getByTestId('flow-toast')).toContainText('E_CYCLE');
  await expect(page.getByTestId('edge-list')).toContainText('Dependencies (1)');

  // group + collapse, then reload → both persist
  await page.getByTestId('new-group').click();
  await expect(page.getByTestId('group-count')).toHaveText('1 group(s)');
  await page.getByTestId(`collapse-${ids.t1}`).click();
  await expect(page.getByTestId(`collapse-${ids.t1}`)).toHaveText('expand');

  await page.reload();
  await page.getByTestId('diagram-root').selectOption(ids.p);
  await expect(page.getByTestId('group-count')).toHaveText('1 group(s)', { timeout: 20_000 });
  await expect(page.getByTestId(`collapse-${ids.t1}`)).toHaveText('expand');
  await expect(page.getByTestId('edge-list')).toContainText('Dependencies (1)');
});

test('gantt: a dependency arrow matches the edge between two dated tasks', async ({ page }) => {
  await register(page, 'gantt');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t1: randomUUID(), t2: randomUUID(), edge: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...chain(ids),
        cmd('node.create', { id: ids.t1, node_type: 'task', title: 'First', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 120, due_date: '2026-06-20' }),
        cmd('node.create', { id: ids.t2, node_type: 'task', title: 'Second', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 60, due_date: '2026-06-24' }),
        cmd('edge.create', { id: ids.edge, predecessor_id: ids.t1, successor_id: ids.t2, edge_type: 'FS', lag_minutes: 0 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'timeline');
  await page.getByTestId('gantt-project').selectOption(ids.p);
  await expect(page.getByTestId(`gantt-bar-${ids.t1}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`gantt-bar-${ids.t2}`)).toBeVisible();
  // the arrow matches the seeded edge
  await expect(page.getByTestId(`gantt-arrow-${ids.t1}-${ids.t2}`)).toBeVisible();
});

test('rules: a rule built in the editor spawns a task on completion', async ({ page }) => {
  await register(page, 'rule');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), lecture: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...chain(ids),
        cmd('node.create', { id: ids.lecture, node_type: 'task', title: 'Lecture', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // build a task_completed rule that spawns a follow-up
  await goto(page, 'rules');
  await page.getByTestId('rule-spawn-title').fill('Follow-up: {trigger.title}');
  await page.getByTestId('rule-spawn-estimate').fill('30');
  await page.getByTestId('rule-add').click();
  await expect(page.getByTestId('rules')).toContainText('task_completed');
  // let the rule.create reach the server before we trigger it
  await page.waitForTimeout(2000);

  // complete the Lecture in the worklist → backstop spawns "Follow-up: Lecture".
  // The Done button opens the completed/obsolete check-off modal; confirm "Completed".
  await goto(page, 'myday');
  await page.getByTestId(`check-${ids.lecture}`).click();
  await page.getByTestId('checkoff-completed').click();
  await expect(page.getByTestId('worklist')).toContainText('Follow-up: Lecture', { timeout: 30_000 });
});
