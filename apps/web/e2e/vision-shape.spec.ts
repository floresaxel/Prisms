/**
 * Plan › Vision's Shape card against the live stack: a seeded vision is charted
 * from the SYNCED rows (not from anything the page wrote itself), zooms into a
 * roadmap and back out, re-sizes by time left, switches to the sunburst view (and
 * remembers it across a reload), and hands a task off to the Roadmap screen.
 *
 * The rules themselves (counting, layout, the sentence) are unit tested in
 * test/vision-shape*.test.ts; this proves they hold on real replicated data —
 * check-offs, an obsolete task and a milestone included.
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
  await page.locator('input[autocomplete="name"]').fill('Shape User');
  await page.getByTestId('email').fill(`e2e-shape-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('Plan › Vision charts where the work sits, and zooms into it', async ({ page }) => {
  await register(page);

  //   Write a novel
  //   ├─ Finish the draft      Draft act two: t1 3h DONE · t2 6h · t3 6h · t4 (no estimate)
  //   │                        └─ Climax (milestone): t5 2h
  //   └─ Build an audience     Newsletter: t6 1h · t7 10h OBSOLETE
  const id = {
    v: randomUUID(), r1: randomUUID(), r2: randomUUID(), p1: randomUUID(), p2: randomUUID(), m1: randomUUID(),
    t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID(), t5: randomUUID(), t6: randomUUID(), t7: randomUUID(),
  };
  const now = new Date().toISOString();
  const task = (tid: string, title: string, parent: string, sort: string, estimate?: number) =>
    cmd('node.create', {
      id: tid, node_type: 'task', title, sort_order: sort, parent_id: parent,
      ...(estimate ? { estimate_minutes: estimate } : {}),
    });
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: id.v, node_type: 'vision', title: 'Write a novel', sort_order: 'a0', attributes: { color: 'indigo' } }),
        cmd('node.create', { id: id.r1, node_type: 'roadmap', title: 'Finish the draft', sort_order: 'a0', parent_id: id.v }),
        cmd('node.create', { id: id.r2, node_type: 'roadmap', title: 'Build an audience', sort_order: 'a1', parent_id: id.v }),
        cmd('node.create', { id: id.p1, node_type: 'project', title: 'Draft act two', sort_order: 'a0', parent_id: id.r1 }),
        cmd('node.create', { id: id.p2, node_type: 'project', title: 'Newsletter', sort_order: 'a0', parent_id: id.r2 }),
        task(id.t1, 'Outline', id.p1, 'a0', 180),
        task(id.t2, 'Write ch. 11', id.p1, 'a1', 360),
        task(id.t3, 'Write ch. 12', id.p1, 'a2', 360),
        task(id.t4, 'Pick a title', id.p1, 'a3'),
        cmd('node.create', { id: id.m1, node_type: 'milestone', title: 'Climax', sort_order: 'a4', parent_id: id.p1 }),
        task(id.t5, 'Write the fight', id.m1, 'a0', 120),
        task(id.t6, 'Write issue 2', id.p2, 'a0', 60),
        task(id.t7, 'Second newsletter', id.p2, 'a1', 600),
        cmd('node.check_off', { id: id.t1, completed_at: now }),
        cmd('node.check_off', { id: id.t7, completed_at: now, disposition: 'obsolete' }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'vision');
  await expect(page.getByTestId('vis-detail')).toHaveAttribute('data-vision', id.v, { timeout: 30_000 });
  const shape = page.getByTestId('vis-shape');
  const note = shape.getByTestId('shape-note');
  const crumb = (nodeId: string) => shape.getByTestId(`shape-crumb-${nodeId}`);
  const cell = (nodeId: string) => shape.getByTestId(`shape-cell-${nodeId}`);

  // --- the whole vision, sized by open tasks: draft 4 (t2 t3 t4 t5), audience 1 (t6) ---
  // (counted from the SYNCED rows: the check-off and the obsolete task included)
  await expect(cell(id.v)).toContainText('5 open', { timeout: 30_000 });
  await expect(cell(id.r1)).toContainText('4 open');
  await expect(cell(id.r2)).toContainText('1 open');
  await expect(crumb(id.v)).toHaveAttribute('aria-current', 'location'); // the path: just the vision
  await expect(shape.getByTestId('shape-insight')).toHaveCount(0);
  await expect(shape.getByTestId('shape-up')).toHaveCount(0);
  await expect(cell(id.t7)).toHaveCount(0); // obsolete: descoped, never drawn
  await expect(cell(id.t1)).toHaveClass(/px-shape-cell--off/); // done: no open width to show
  await expect(cell(id.t5)).toHaveAttribute('data-row', '4'); // under the milestone, a row lower

  // --- zoom into the draft: it becomes the top row, the other roadmap leaves ---
  await cell(id.r1).click();
  await expect(cell(id.r1)).toHaveAttribute('data-row', '0');
  await expect(cell(id.r2)).toHaveCount(0);
  await expect(crumb(id.r1)).toHaveAttribute('aria-current', 'location');
  await expect(crumb(id.v)).toBeEnabled(); // a step back up the path

  // --- time left: the unestimated task cannot be drawn, and the card says so ---
  await shape.getByTestId('shape-metric-time').click();
  await expect(note).toHaveText('1 open task has no estimate, so it is not shown at this width.');

  // --- the path goes back: into the project, then click the vision's step ---
  await cell(id.p1).click();
  await expect(cell(id.p1)).toHaveAttribute('data-row', '0');
  await crumb(id.v).click();
  await expect(cell(id.v)).toHaveAttribute('data-row', '0');

  // --- and Esc goes back up a level ---
  await cell(id.r1).click();
  await cell(id.r1).focus();
  await page.keyboard.press('Escape');
  await expect(cell(id.v)).toHaveAttribute('data-row', '0');

  // --- the same chart as a sunburst: the vision in the centre, roadmaps in ring 1 ---
  const arc = (nodeId: string) => shape.getByTestId(`shape-arc-${nodeId}`);
  const center = shape.getByTestId('shape-center');
  await expect(shape.getByTestId('shape-view-icicle')).toHaveAttribute('aria-checked', 'true'); // the default
  await shape.getByTestId('shape-view-sunburst').click();
  await expect(cell(id.r1)).toHaveCount(0);
  await expect(arc(id.r1)).toHaveAttribute('data-ring', '1');
  await expect(arc(id.t5)).toHaveAttribute('data-ring', '4');
  await expect(center).toContainText('Vision');
  await expect(note).toContainText('so it is not shown at this size.');

  // zoom by the list beside the chart, then back up by the centre
  await shape.getByTestId(`shape-row-${id.r1}`).click();
  await expect(center).toContainText('Roadmap');
  await expect(arc(id.r2)).toHaveCount(0);
  await expect(arc(id.p1)).toHaveAttribute('data-ring', '1');
  await center.click();
  await expect(center).toContainText('Vision');

  // the choice outlives a reload, and the icicle is one click away
  await page.reload();
  await expect(page.getByTestId('vis-detail')).toHaveAttribute('data-vision', id.v, { timeout: 30_000 });
  await expect(arc(id.r1)).toBeVisible({ timeout: 30_000 });
  await shape.getByTestId('shape-view-icicle').click();
  await expect(cell(id.v)).toHaveAttribute('data-row', '0');

  // --- pin a task, then open the roadmap it sits under ---
  await cell(id.t2).click();
  await expect(shape.getByTestId('shape-detail')).toContainText('Write ch. 11');
  await shape.getByTestId('shape-open-roadmap').click();
  await expect(page).toHaveURL(new RegExp(`/roadmap#${id.r1}$`));
});
