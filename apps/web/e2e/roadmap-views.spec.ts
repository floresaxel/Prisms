/**
 * Plan › Roadmap's views against the live stack: a seeded roadmap whose projects
 * depend on each other through TASK-level edges (the way Projects › Graph links
 * them) is read from the SYNCED rows as steps of work, a partitioned list, an
 * outline and a mind map — and the chosen view survives a reload.
 *
 * The rules themselves (roll-up, steps, layout) are unit tested in
 * test/roadmap-*.test.ts; this proves they hold on real replicated data.
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
  schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor rejection)
});

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Roadmap User');
  await page.getByTestId('email').fill(`e2e-rmviews-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('Plan › Roadmap reads one roadmap four ways, by what blocks what', async ({ page }) => {
  await register(page);

  //   Finish the novel
  //   ├─ Research       t1 DONE                      ─┐
  //   ├─ Draft act two  t2 · t3      (t1 → t2)        ├→ Beta readers t5 (t3 → t5, t4 → t5)
  //   ├─ Revise act one t4           (t1 → t4)       ─┘
  //   ├─ Beta readers   t5
  //   └─ Writing habit  t6           (nothing links it)
  const id = {
    v: randomUUID(), r: randomUUID(),
    p1: randomUUID(), p2: randomUUID(), p3: randomUUID(), p4: randomUUID(), p5: randomUUID(),
    t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID(), t5: randomUUID(), t6: randomUUID(),
  };
  const now = new Date().toISOString();
  const project = (pid: string, title: string, sort: string) =>
    cmd('node.create', { id: pid, node_type: 'project', title, sort_order: sort, parent_id: id.r });
  const task = (tid: string, title: string, parent: string, sort: string, estimate: number) =>
    cmd('node.create', { id: tid, node_type: 'task', title, sort_order: sort, parent_id: parent, estimate_minutes: estimate });
  const edge = (pred: string, succ: string) =>
    cmd('edge.create', { id: randomUUID(), predecessor_id: pred, successor_id: succ, edge_type: 'FS', lag_minutes: 0 });
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: id.v, node_type: 'vision', title: 'Write a novel', sort_order: 'a0', attributes: { color: 'blue' } }),
        cmd('node.create', { id: id.r, node_type: 'roadmap', title: 'Finish the novel', sort_order: 'a0', parent_id: id.v }),
        project(id.p1, 'Research', 'a0'),
        project(id.p2, 'Draft act two', 'a1'),
        project(id.p3, 'Revise act one', 'a2'),
        project(id.p4, 'Beta readers', 'a3'),
        project(id.p5, 'Writing habit', 'a4'),
        task(id.t1, 'Harbour visit', id.p1, 'a0', 60),
        task(id.t2, 'Outline', id.p2, 'a0', 60),
        task(id.t3, 'Write ch. 11', id.p2, 'a1', 180),
        task(id.t4, 'Fix POV slips', id.p3, 'a0', 60),
        task(id.t5, 'Send manuscript', id.p4, 'a0', 60),
        task(id.t6, 'Morning pages', id.p5, 'a0', 30),
        cmd('node.check_off', { id: id.t1, completed_at: now }),
        edge(id.t1, id.t2),
        edge(id.t1, id.t4),
        edge(id.t3, id.t5),
        edge(id.t4, id.t5),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'roadmap');
  await page.getByTestId(`rm-item-${id.r}`).click({ timeout: 30_000 });
  await expect(page.getByTestId('rm-detail')).toHaveAttribute('data-roadmap', id.r);
  const views = page.getByTestId('rm-views');
  const order = (pid: string) => views.getByTestId(`rm-order-${pid}`);

  // --- Order is the default: steps from the synced edges, the rest any time ---
  await expect(views).toHaveAttribute('data-view', 'order');
  await expect(order(id.p4)).toHaveAttribute('data-step', '2', { timeout: 30_000 });
  await expect(order(id.p1)).toHaveAttribute('data-step', '0');
  await expect(order(id.p2)).toHaveAttribute('data-step', '1');
  await expect(order(id.p3)).toHaveAttribute('data-step', '1');
  await expect(order(id.p5)).toHaveAttribute('data-step', 'any');
  await expect(order(id.p1)).toContainText('✓ finished');
  await expect(order(id.p4)).toContainText('blocked by Draft act two, Revise act one');
  await expect(order(id.p3)).toContainText('ready to start');

  // --- picking a project puts it in the strip ---
  await order(id.p4).click();
  await expect(views.getByTestId('rm-strip')).toContainText('Beta readers');
  await expect(views.getByTestId('rm-strip')).toContainText('blocked by Draft act two, Revise act one');

  // --- List: can move now · blocked · finished ---
  await views.getByTestId('rm-view-list').click();
  await expect(views.getByTestId('rm-list-blocked')).toContainText('Beta readers');
  await expect(views.getByTestId('rm-list-done')).toContainText('Research');
  await expect(views.getByTestId('rm-list-open')).toContainText('Draft act two');
  await expect(views.getByTestId('rm-list-open')).toContainText('Writing habit');
  await expect(views.getByTestId(`rm-row-${id.p2}`)).toContainText('unblocks Beta readers');

  // --- Outline: a project opens into its tasks ---
  await views.getByTestId('rm-view-outline').click();
  await views.getByTestId(`rm-outline-toggle-${id.p2}`).click();
  await expect(views.getByTestId(`rm-outline-${id.t3}`)).toContainText('Write ch. 11');

  // --- Mind map: the roadmap in the middle, projects on both sides, foldable ---
  await views.getByTestId('rm-view-map').click();
  await expect(views.getByTestId('rm-map-root')).toContainText('Finish the novel');
  await expect(views.getByTestId(`rm-twig-${id.t3}`)).toBeVisible();
  await views.getByTestId(`rm-fold-${id.p2}`).click();
  await expect(views.getByTestId(`rm-twig-${id.t3}`)).toHaveCount(0);

  // --- the chosen view is remembered across a reload ---
  await page.reload();
  await expect(page.getByTestId('rm-views')).toHaveAttribute('data-view', 'map', { timeout: 30_000 });
});
