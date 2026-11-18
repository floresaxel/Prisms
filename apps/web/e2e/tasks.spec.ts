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
  await expect(page.getByTestId('inbox-complete-target').locator(`option[value="${ids.p}"]`)).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('inbox-complete-target').selectOption(ids.p);
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
  await expect(pick.locator(`option[value="${ids.p}"]`)).toHaveCount(1, { timeout: 30_000 });
  await expect(pick).toHaveValue(''); // Inbox by default
  await pick.selectOption(ids.p);

  // two captures in a row: both go into the project, and the choice is still there
  for (const t of ['Book the venue', 'Order the banners']) {
    await page.getByTestId('activity-title').fill(t);
    await page.getByTestId('activity-add').click();
    await expect(page.getByTestId(`project-group-${ids.p}`)).toContainText(t);
  }
  await expect(pick).toHaveValue(ids.p);
  await expect(page.getByTestId('inbox')).not.toContainText('Book the venue');

  // other Tasks tabs keep it
  await page.getByTestId('tasks-tab-bystatus').click();
  await expect(pick).toHaveValue(ids.p);

  // back to Inbox: captures wait there again
  await pick.selectOption('');
  await page.getByTestId('activity-title').fill('Stray thought');
  await page.getByTestId('activity-add').click();
  await expect(page.getByTestId('status-inbox')).toContainText('Stray thought');

  // leave Tasks and return: reset to Inbox
  await pick.selectOption(ids.p);
  await goto(page, 'myday');
  await goto(page, 'tasks');
  await expect(page.getByTestId('capture-project')).toHaveValue('');
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

  // wait for the seeded project to sync so it is a promote target, then promote
  await expect(inboxRow.locator('select')).toContainText('Launch', { timeout: 30_000 });
  await inboxRow.getByRole('button', { name: 'Assign' }).click();

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
