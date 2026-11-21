/**
 * Tasks view DoD e2e (Playwright, web redesign W4/D6):
 *   - capture an activity → promote it into a project → it leaves the Inbox group
 *     and appears under that project's group (the tree-mirroring "By project" view);
 *   - a checklist step created on ANOTHER device syncs down and renders; a step
 *     added + toggled through the UI survives a reload (W3 task_steps round-trip).
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

async function register(page: Page, tag: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Tasks User');
  await page.getByTestId('email').fill(`e2e-tasks-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('an Inbox capture completes from the Inbox — as an unfocused task, or added to a project first', async ({ page }) => {
  await register(page, 'complete');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  for (const t of ['Water the plants', 'Draft the launch email']) {
    await page.getByTestId('activity-title').fill(t);
    await page.getByTestId('activity-add').click();
    await expect(page.getByTestId('inbox')).toContainText(t);
  }
  const rowId = async (title: string) =>
    ((await page.getByTestId('inbox').locator('li', { hasText: title }).getByRole('button', { name: 'Complete this capture' }).getAttribute('data-testid')) ?? '').replace('inbox-check-', '');

  // ── complete as an unfocused task: no project needed ──
  const plants = await rowId('Water the plants');
  await page.getByTestId(`inbox-check-${plants}`).click();
  await expect(page.getByTestId('inbox-complete-dialog')).toBeVisible();
  await page.getByTestId('inbox-complete-unfocused').click();
  await expect(page.getByTestId('inbox-complete-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inbox')).not.toContainText('Water the plants');

  // ── add to a project and complete ──
  const email = await rowId('Draft the launch email');
  await page.getByTestId(`inbox-check-${email}`).click();
  // the picker starts empty, so "Add & complete" waits for a choice
  const target = page.getByTestId('inbox-complete-target');
  await expect(target).toBeEnabled({ timeout: 30_000 });
  await expect(target).toContainText('Assign project');
  await expect(page.getByTestId('inbox-complete-promote')).toBeDisabled();
  await target.click();
  await page.getByTestId(`inbox-complete-target-opt-${ids.p}`).click();
  await expect(target).toHaveAttribute('data-value', ids.p);
  // Escape on the open picker closes only the picker, not the dialog
  await target.click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inbox-complete-dialog')).toBeVisible();
  await page.getByTestId('inbox-complete-promote').click();
  await expect(page.getByTestId('inbox')).not.toContainText('Draft the launch email');

  // ── both are done today; only the one without a project is marked unfocused ──
  await page.getByTestId('tasks-tab-bystatus').click();
  await expect(page.getByTestId(`done-${plants}`)).toContainText('unfocused');
  await expect(page.getByTestId(`done-${email}`)).toBeVisible();
  await expect(page.getByTestId(`done-${email}`).getByTestId('unfocused-tag')).toHaveCount(0);

  // …and the server kept both completions (survives a reload)
  await page.reload();
  await page.getByTestId('tasks-tab-bystatus').click();
  await expect(page.getByTestId(`done-${plants}`)).toContainText('unfocused', { timeout: 30_000 });
  await expect(page.getByTestId(`done-${email}`)).toBeVisible();
  await expect(page.getByTestId('status-inbox')).not.toContainText('Water the plants');
});

test('the capture bar can preselect a project; it sticks until you leave Tasks', async ({ page }) => {
  await register(page, 'preselect');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  const pick = page.getByTestId('capture-project');
  // the capture picker is a bubble picker: open it and click a choice
  const choose = async (id: string) => {
    await pick.click();
    await page.getByTestId(`capture-project-opt-${id === '' ? 'none' : id}`).click();
  };
  await expect(pick).toHaveAttribute('data-value', ''); // Inbox by default
  await expect(pick).toContainText('Inbox — assign later');
  await pick.click();
  await expect(page.getByTestId(`capture-project-opt-${ids.p}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`capture-project-opt-${ids.p}`).click();
  await expect(pick).toContainText('Launch');

  // two captures in a row: both go into the project, and the choice is still there
  for (const t of ['Book the venue', 'Order the banners']) {
    await page.getByTestId('activity-title').fill(t);
    await page.getByTestId('activity-add').click();
    await expect(page.getByTestId(`project-group-${ids.p}`)).toContainText(t);
  }
  await expect(pick).toHaveAttribute('data-value', ids.p);
  await expect(page.getByTestId('inbox')).not.toContainText('Book the venue');

  // other Tasks tabs keep it
  await page.getByTestId('tasks-tab-bystatus').click();
  await expect(pick).toHaveAttribute('data-value', ids.p);

  // back to Inbox: captures wait there again
  await choose('');
  await page.getByTestId('activity-title').fill('Stray thought');
  await page.getByTestId('activity-add').click();
  await expect(page.getByTestId('status-inbox')).toContainText('Stray thought');

  // leave Tasks and return: reset to Inbox
  await choose(ids.p);
  await goto(page, 'myday');
  await goto(page, 'tasks');
  await expect(page.getByTestId('capture-project')).toHaveAttribute('data-value', '');
});

test('every project picker can mint a project on the spot, and selects it', async ({ page }) => {
  await register(page, 'newproject');
  const ids = { v: randomUUID(), r: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  const pick = page.getByTestId('capture-project');

  // the capture bar: "+ New project" is offered even with no project yet; the new
  // one becomes the capture target (one roadmap → no roadmap choice is asked)
  await expect(pick).toBeEnabled({ timeout: 30_000 });
  await pick.click();
  await expect(page.getByTestId('capture-project-new-open')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('capture-project-new-open').click();
  await expect(page.getByTestId('capture-project-new-create')).toBeDisabled();
  await page.getByTestId('capture-project-new-name').fill('Brand refresh');
  await page.getByTestId('capture-project-new-name').press('Enter');
  await expect(pick).toContainText('Brand refresh');

  // an Inbox row and the complete dialog offer it too, and can add another
  await pick.click();
  await page.getByTestId('capture-project-opt-none').click();
  await page.getByTestId('activity-title').fill('Pick a typeface');
  await page.getByTestId('activity-add').click();
  const row = page.getByTestId('inbox').locator('li', { hasText: 'Pick a typeface' });
  const rowPick = row.getByTestId(/^promote-target-/);
  await rowPick.click();
  await expect(page.getByRole('option', { name: 'Brand refresh' })).toBeVisible();
  await page.getByTestId(/^promote-target-.*-new-open$/).click();
  await page.getByTestId(/^promote-target-.*-new-name$/).fill('Website');
  await page.getByTestId(/^promote-target-.*-new-create$/).click();
  await expect(rowPick).toContainText('Website');
  await expect(row.getByRole('button', { name: 'Assign', exact: true })).toBeEnabled();

  await row.getByTestId(/^inbox-check-/).click();
  const target = page.getByTestId('inbox-complete-target');
  await target.click();
  await page.getByTestId('inbox-complete-target-new-open').click();
  await page.getByTestId('inbox-complete-target-new-name').fill('Launch plan');
  await page.getByTestId('inbox-complete-target-new-create').click();
  await expect(target).toContainText('Launch plan');
  await expect(page.getByTestId('inbox-complete-promote')).toBeEnabled();
});

test('a task with details shows a notebook icon right after its title, in every list', async ({ page }) => {
  await register(page, 'notebook');
  await goto(page, 'tasks');
  await page.getByTestId('activity-title').fill('Plan the offsite');
  await page.getByTestId('activity-add').click();
  const row = page.getByTestId('inbox').locator('li', { hasText: 'Plan the offsite' });
  await expect(row).toBeVisible();
  const title = row.getByTestId(/^title-/);
  const mark = row.getByTestId(/^has-details-/);
  await expect(mark).toHaveCount(0); // no details yet, no icon

  // write some details in the card (click the empty part of the title line: it opens the card)
  const line = await row.locator('.px-t-title').boundingBox();
  await row.locator('.px-t-title').click({ position: { x: line!.width - 8, y: line!.height / 2 } });
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  if ((await page.getByTestId('td-details').count()) === 0) await page.getByTestId('td-add-details').click();
  await page.getByTestId('td-details').fill('Venue shortlist and budget.');
  await page.getByTestId('td-details').blur();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  // the icon follows the title on the same line, ahead of the project picker
  await expect(mark).toHaveCount(1);
  const [t, m, p] = await Promise.all([title.boundingBox(), mark.boundingBox(), row.getByTestId(/^promote-target-/).boundingBox()]);
  expect(m!.x).toBeGreaterThanOrEqual(t!.x + t!.width - 1);
  expect(m!.x + m!.width).toBeLessThanOrEqual(p!.x + 1);
  expect(Math.abs(m!.y + m!.height / 2 - (t!.y + t!.height / 2))).toBeLessThan(t!.height);

  // …and on the other tab
  await page.getByTestId('tasks-tab-bystatus').click();
  await expect(page.getByTestId('status-inbox').getByTestId(/^has-details-/)).toHaveCount(1);
});

test('the notebook icon stays to the right of a title that wraps onto several lines', async ({ page }) => {
  await register(page, 'notebookwrap');
  await goto(page, 'tasks');
  const long =
    'Prepare the full quarterly offsite agenda, book the venue and the catering, confirm travel for every attendee, ' +
    'and circulate the pre-read packet to the whole leadership team well before the first session starts';
  await page.getByTestId('activity-title').fill(long);
  await page.getByTestId('activity-add').click();
  const row = page.getByTestId('inbox').locator('li', { hasText: 'Prepare the full quarterly offsite agenda' });
  await expect(row).toBeVisible();

  // open the card from the keyboard (a long title leaves no empty spot to click) and add details
  await row.focus();
  await row.press('Enter');
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  if ((await page.getByTestId('td-details').count()) === 0) await page.getByTestId('td-add-details').click();
  await page.getByTestId('td-details').fill('Everything the offsite needs.');
  await page.getByTestId('td-details').blur();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  const title = row.getByTestId(/^title-/);
  const mark = row.getByTestId(/^has-details-/);
  await expect(mark).toHaveCount(1);
  const [t, m] = await Promise.all([title.boundingBox(), mark.boundingBox()]);
  // the title really did wrap (taller than one 13px line), and the mark sits to its right, on its height
  expect(t!.height).toBeGreaterThan(30);
  expect(m!.x).toBeGreaterThanOrEqual(t!.x + t!.width - 1);
  expect(m!.y).toBeGreaterThanOrEqual(t!.y - 1);
  expect(m!.y + m!.height).toBeLessThanOrEqual(t!.y + t!.height + 1);
});

test('the Inbox × asks before deleting — Keep and Escape leave the item, Delete removes it', async ({ page }) => {
  await register(page, 'delete');
  await goto(page, 'tasks');
  for (const t of ['Keep me', 'Drop me']) {
    await page.getByTestId('activity-title').fill(t);
    await page.getByTestId('activity-add').click();
    await expect(page.getByTestId('inbox')).toContainText(t);
  }
  const row = (t: string) => page.getByTestId('inbox').locator('li', { hasText: t });

  // the question opens right beside the ×; nothing is deleted yet
  await row('Drop me').getByRole('button', { name: 'delete' }).click();
  await expect(page.getByTestId('inbox-delete-confirm')).toBeVisible();
  await expect(page.getByTestId('inbox')).toContainText('Drop me');

  // Escape and Keep both dismiss it
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inbox-delete-confirm')).toHaveCount(0);
  await row('Drop me').getByRole('button', { name: 'delete' }).click();
  await page.getByTestId('inbox-delete-confirm').getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByTestId('inbox-delete-confirm')).toHaveCount(0);
  await expect(page.getByTestId('inbox')).toContainText('Drop me');

  // Delete removes only that item
  await row('Drop me').getByRole('button', { name: 'delete' }).click();
  await page.getByTestId('inbox-delete-yes').click();
  await expect(page.getByTestId('inbox')).not.toContainText('Drop me');
  await expect(page.getByTestId('inbox')).toContainText('Keep me');
});

test('capture → promote lands the task under its project group; the Inbox group clears', async ({ page }) => {
  await register(page, 'promote');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  await page.getByTestId('activity-title').fill('Sharpen the gouges');
  await page.getByTestId('activity-add').click();
  const inboxRow = page.getByTestId('inbox').locator('li', { hasText: 'Sharpen the gouges' });
  await expect(inboxRow).toBeVisible();

  // the picker starts empty ("Assign project"); wait for the seeded project to
  // sync so it is a promote target, choose it, then promote
  const picker = inboxRow.getByTestId(/^promote-target-/);
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await expect(picker).toContainText('Assign project');
  await expect(inboxRow.getByRole('button', { name: 'Assign', exact: true })).toBeDisabled();
  await picker.click();
  // (the picker's own bubbles — the capture bar's project <select> has a "Launch" option too)
  await page.locator('.px-ppick-opt', { hasText: 'Launch' }).click();
  await expect(picker).toContainText('Launch');
  await inboxRow.getByRole('button', { name: 'Assign', exact: true }).click();

  // it leaves the Inbox group and now lives under the "Launch" project group
  await expect(page.getByTestId('inbox')).not.toContainText('Sharpen the gouges');
  await expect(page.getByTestId(`project-group-${ids.p}`)).toContainText('Sharpen the gouges');
});

test('substeps: a synced step renders, and a UI-added + toggled step survives reload (W3/D4)', async ({ page }) => {
  await register(page, 'steps');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), task: randomUUID(), seededStep: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Build', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Lay the drip lines', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 120 }),
        // a step created on "another device" → proves cross-client down-sync
        cmd('step.add', { id: ids.seededStep, task_id: ids.task, title: 'Measure the runs', sort_order: 'a0' }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  await expect(page.getByTestId(`task-row-${ids.task}`)).toBeVisible({ timeout: 30_000 });
  // the seeded step is counted on the expander (down-sync)
  const toggle = page.getByTestId(`steps-toggle-${ids.task}`);
  await expect(toggle).toContainText('1 step', { timeout: 30_000 });

  await toggle.click();
  const panel = page.getByTestId(`substeps-${ids.task}`);
  await expect(panel.getByText('Measure the runs')).toBeVisible();

  // add a step through the UI (Enter to save)
  await page.getByTestId(`step-add-${ids.task}`).fill('Cut tubing to length');
  await page.getByTestId(`step-add-${ids.task}`).press('Enter');
  await expect(panel.getByText('Cut tubing to length')).toBeVisible();

  // toggle the new step done
  const added = panel.locator('.px-sstep', { hasText: 'Cut tubing to length' });
  await added.getByRole('button', { name: 'toggle step' }).click();
  await expect(added).toHaveClass(/px-sstep--done/);

  // reload → both steps survive, the toggled one is still done
  await page.reload();
  await goto(page, 'tasks');
  await page.getByTestId(`steps-toggle-${ids.task}`).click();
  const panel2 = page.getByTestId(`substeps-${ids.task}`);
  await expect(panel2.getByText('Measure the runs')).toBeVisible({ timeout: 30_000 });
  await expect(panel2.locator('.px-sstep', { hasText: 'Cut tubing to length' })).toHaveClass(/px-sstep--done/);
});

test('Completed lists finished tasks (the tick reopens); Recently deleted restores a task with its steps', async ({ page }) => {
  await register(page, 'archive');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), done: randomUUID(), doomed: randomUUID(), step: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Garden', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.done, node_type: 'task', title: 'Order mulch', sort_order: 'a0', parent_id: ids.p }),
        cmd('node.create', { id: ids.doomed, node_type: 'task', title: 'Lay the drip lines', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 60 }),
        cmd('step.add', { id: ids.step, task_id: ids.doomed, title: 'Measure the runs', sort_order: 'a0' }),
        cmd('node.check_off', { id: ids.done, completed_at: new Date().toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  await expect(page.getByTestId(`task-row-${ids.doomed}`)).toBeVisible({ timeout: 30_000 });

  // ── Completed: the finished task, under Today, with its project; the tick reopens it ──
  await page.getByTestId('tasks-tab-completed').click();
  const done = page.getByTestId(`completed-${ids.done}`);
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(done).toContainText('Garden');
  await expect(page.getByTestId('completed-list')).toContainText('Today');
  await page.getByTestId(`reopen-${ids.done}`).click();
  await expect(done).toHaveCount(0);

  // ── delete a task from its card… ──
  await page.getByTestId('tasks-tab-byproject').click();
  await page.getByTestId(`task-row-${ids.doomed}`).locator('.px-t-meta').click();
  await page.getByTestId('td-delete').click();
  await page.getByTestId('td-delete-confirm').click();
  await expect(page.getByTestId(`task-row-${ids.doomed}`)).toHaveCount(0);

  // ── …it waits in Recently deleted; Restore brings it back with its step ──
  await page.getByTestId('tasks-tab-deleted').click();
  const gone = page.getByTestId(`deleted-${ids.doomed}`);
  await expect(gone).toBeVisible({ timeout: 30_000 });
  await expect(gone).toContainText('Garden');
  await page.getByTestId(`restore-${ids.doomed}`).click();
  await expect(gone).toHaveCount(0, { timeout: 30_000 });

  await page.getByTestId('tasks-tab-byproject').click();
  await expect(page.getByTestId(`task-row-${ids.doomed}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`steps-toggle-${ids.doomed}`)).toHaveText('1 step', { timeout: 30_000 });

  // ── and the server kept it: still there after a reload ──
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-sync', 'synced', { timeout: 30_000 });
  await page.reload();
  await goto(page, 'tasks');
  await expect(page.getByTestId(`task-row-${ids.doomed}`)).toBeVisible({ timeout: 30_000 });
});
