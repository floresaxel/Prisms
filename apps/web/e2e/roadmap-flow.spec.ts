/**
 * Plan › Roadmap › Flow against the live stack: build a roadmap's outcomes, say
 * what each project delivers and what has to come first, switch a link to start
 * together, and lay it out by hand in Free flow — then reload and find every
 * edit still there, because each one went out as a real command:
 *
 *   outcomes          → the roadmap node's attributes (node.set_attributes)
 *   what a project
 *   delivers, size    → the project node's attributes
 *   links             → edge.create / edge.delete, FS or SS, project to project
 *   free-flow spots   → layout.set_position, the roadmap as the diagram
 *
 * The layout rules are unit tested in test/roadmap-flow*.test.ts; this proves
 * the builder's writes survive the round trip. Requires the live stack.
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
  await page.locator('input[autocomplete="name"]').fill('Flow User');
  await page.getByTestId('email').fill(`e2e-rmflow-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

/** Wait until every local write has gone up (the chip's attribute, not its lagging words). */
async function synced(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-sync', 'synced', { timeout: 30_000 });
}

test('Plan › Roadmap › Flow builds outcomes, order and a free layout that survive a reload', async ({ page }) => {
  test.setTimeout(120_000);
  await register(page);

  //   Open the studio (roadmap)
  //   ├─ Find the space      t1 DONE
  //   ├─ Lease & permits     t2           (t1 → t2: Lease waits on Find, through their tasks)
  //   ├─ Fit-out             t3
  //   └─ Course curriculum   t4
  const id = { v: randomUUID(), r: randomUUID(), p1: randomUUID(), p2: randomUUID(), p3: randomUUID(), p4: randomUUID(), t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID() };
  const project = (pid: string, title: string, sort: string) => cmd('node.create', { id: pid, node_type: 'project', title, sort_order: sort, parent_id: id.r });
  const task = (tid: string, parent: string, sort: string) => cmd('node.create', { id: tid, node_type: 'task', title: `Task ${sort}`, sort_order: sort, parent_id: parent, estimate_minutes: 60 });
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: id.v, node_type: 'vision', title: 'A studio that pays for itself', sort_order: 'a0', attributes: { color: 'blue' } }),
        cmd('node.create', { id: id.r, node_type: 'roadmap', title: 'Open the studio', sort_order: 'a0', parent_id: id.v }),
        project(id.p1, 'Find the space', 'a0'),
        project(id.p2, 'Lease & permits', 'a1'),
        project(id.p3, 'Fit-out', 'a2'),
        project(id.p4, 'Course curriculum', 'a3'),
        task(id.t1, id.p1, 'a0'),
        task(id.t2, id.p2, 'a1'),
        task(id.t3, id.p3, 'a2'),
        task(id.t4, id.p4, 'a3'),
        cmd('node.check_off', { id: id.t1, completed_at: new Date().toISOString() }),
        cmd('edge.create', { id: randomUUID(), predecessor_id: id.t1, successor_id: id.t2, edge_type: 'FS', lag_minutes: 0 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'roadmap');
  await page.getByTestId(`rm-item-${id.r}`).click({ timeout: 30_000 });
  const views = page.getByTestId('rm-views');
  await expect(views).toHaveAttribute('data-view', 'flow');
  const flow = views.getByTestId('rf');
  const card = (pid: string) => flow.getByTestId(`rf-card-${pid}`);
  const pick = (pid: string) => card(pid).locator('.px-rf-body').click();

  // --- Structured is the default; steps come from the synced task edge ---
  await expect(flow).toHaveAttribute('data-layout', 'structured');
  await expect(card(id.p2)).toHaveAttribute('data-step', '2', { timeout: 30_000 });
  await expect(card(id.p1)).toHaveAttribute('data-state', 'done');
  await expect(card(id.p4)).toHaveAttribute('data-step', 'any');

  // --- two outcomes: each becomes a row; the second is named in its panel ---
  await flow.getByTestId('rf-add-outcome').click();
  const nameField = flow.getByTestId('rf-o-name');
  await expect(nameField).toHaveValue('New outcome');
  await nameField.fill('Space');
  await nameField.press('Enter');
  await flow.getByTestId('rf-o-statement').fill('Studio open, safe and equipped');
  await flow.getByTestId('rf-o-statement').blur();
  await expect(flow.getByTestId('rf-outcomes')).toContainText('Space');
  await flow.getByTestId('rf-add-outcome-chip').click();
  await expect(nameField).toHaveValue('New outcome');
  await nameField.fill('Craft');
  await nameField.press('Enter');
  await expect(flow.getByTestId('rf-outcomes')).toContainText('Craft');
  await expect(flow.getByTestId('rf-gaps')).toContainText('doesn’t deliver an outcome');

  // --- say what each project delivers ---
  const outcomeIds = await flow.locator('[data-testid^="rf-ochip-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('rf-ochip-', '')));
  expect(outcomeIds).toHaveLength(2);
  const [space, craft] = outcomeIds as [string, string];
  for (const [pid, oid] of [[id.p1, space], [id.p2, space], [id.p3, space], [id.p4, craft]] as const) {
    await pick(pid);
    await flow.getByTestId('rf-p-outcome').selectOption(oid);
    await expect(card(pid)).toHaveAttribute('data-lane', oid);
  }
  await expect(flow.getByTestId('rf-gaps')).toHaveCount(0);

  // --- order: Fit-out waits on Lease, a project-to-project link added from the panel ---
  await pick(id.p3);
  await flow.getByTestId('rf-add-before').selectOption(id.p2);
  await expect(card(id.p3)).toHaveAttribute('data-step', '3');
  await expect(flow.getByTestId(`rf-dep-${id.p2}-${id.p3}`)).toContainText('finish → start');
  // …switched to start together: it shares Lease's step
  await flow.getByTestId(`rf-dep-kind-${id.p2}-${id.p3}`).click();
  await expect(flow.getByTestId(`rf-dep-${id.p2}-${id.p3}`)).toContainText('start together');
  await expect(card(id.p3)).toHaveAttribute('data-step', '2');
  // a link that would loop is not even offered
  await pick(id.p1);
  await expect(flow.getByTestId('rf-add-before').locator(`option[value="${id.p3}"]`)).toHaveCount(0);
  await pick(id.p3);
  await flow.getByTestId('rf-p-size-L').click();
  await expect(card(id.p3)).toContainText('L');

  // --- free flow: same roadmap, outcomes as groups; Tidy up writes every spot ---
  await flow.getByTestId('rf-layout-free').click();
  await expect(flow).toHaveAttribute('data-layout', 'free');
  await expect(flow.getByTestId(`rf-group-${space}`)).toBeVisible();
  await expect(flow.getByTestId(`rf-fcard-${id.p4}`)).toHaveAttribute('data-outcome', craft);
  await flow.getByTestId('rf-tidy').click();
  await expect(page.getByTestId('rf-toast')).toContainText('Lined up');

  // drag Course curriculum out of Craft and into the Space group. hover() scrolls
  // the card into view first (a bare boundingBox() can be off-screen).
  const target = flow.getByTestId(`rf-fcard-${id.p4}`);
  await target.hover({ position: { x: 40, y: 30 } });
  await page.mouse.down();
  const from = (await target.boundingBox())!;
  await page.mouse.move(from.x + 70, from.y + 10, { steps: 4 });
  const spaceBox = (await flow.getByTestId(`rf-group-${space}`).boundingBox())!;
  await page.mouse.move(spaceBox.x + spaceBox.width - 40, spaceBox.y + spaceBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(target).toHaveAttribute('data-outcome', space, { timeout: 15_000 });

  await synced(page);
  await page.reload();

  // --- everything came back from the synced rows ---
  const views2 = page.getByTestId('rm-views');
  await expect(views2).toHaveAttribute('data-view', 'flow', { timeout: 30_000 });
  const flow2 = views2.getByTestId('rf');
  await expect(flow2).toHaveAttribute('data-layout', 'free'); // remembered on this device
  await expect(flow2.getByTestId(`rf-fcard-${id.p4}`)).toHaveAttribute('data-outcome', space, { timeout: 30_000 });
  await expect(flow2.getByTestId(`rf-group-${craft}`)).toContainText('Nothing delivers this yet');
  await flow2.getByTestId('rf-layout-structured').click();
  await expect(flow2.getByTestId(`rf-card-${id.p3}`)).toHaveAttribute('data-step', '2');
  await expect(flow2.getByTestId(`rf-card-${id.p3}`)).toHaveAttribute('data-lane', space);
  await expect(flow2.getByTestId('rf-outcomes')).toContainText('Space');
  await expect(flow2.getByTestId(`rf-cap-${space}`)).toContainText('Studio open, safe and equipped');
  await flow2.getByTestId(`rf-card-${id.p3}`).locator('.px-rf-body').click();
  await expect(flow2.getByTestId(`rf-dep-${id.p2}-${id.p3}`)).toContainText('start together');
});
