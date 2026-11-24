/**
 * A task with a live timer wears the pulsing dot in front of its title in the task
 * lists: Tasks (By project and By status) and Agenda (To schedule and All tasks).
 * Other tasks have none, and it goes when the timer stops.
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

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Dot User');
  await page.getByTestId('email').fill(`e2e-runningdot-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('the pulsing dot marks the clocked-in task in the Tasks and Agenda lists', async ({ page }) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), a: randomUUID(), b: randomUUID(), entry: randomUUID() };
  const upload = (commands: unknown[]) => page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  const seed = await upload([
    cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
    cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Plan', sort_order: 'a0', parent_id: ids.v }),
    cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
    cmd('node.create', { id: ids.a, node_type: 'task', title: 'Write the note', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
    cmd('node.create', { id: ids.b, node_type: 'task', title: 'Book the venue', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 30 }),
    cmd('timer.clock_in', { entry_id: ids.entry, task_id: ids.a, started_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
  ]);
  expect(seed.ok()).toBeTruthy();
  const dot = '[data-testid="running-dot"]';

  // ── Tasks › By project ──
  await goto(page, 'tasks');
  const rowA = page.getByTestId(`task-row-${ids.a}`);
  await expect(rowA).toBeVisible({ timeout: 30_000 });
  await expect(rowA.locator(dot)).toHaveCount(1);
  await expect(page.getByTestId(`task-row-${ids.b}`).locator(dot)).toHaveCount(0);

  // ── Tasks › By status ──
  await page.getByTestId('tasks-tab-bystatus').click();
  const statusA = page.getByTestId('status-available').locator('li', { hasText: 'Write the note' });
  await expect(statusA.locator(dot)).toHaveCount(1);
  await expect(page.getByTestId('status-available').locator('li', { hasText: 'Book the venue' }).locator(dot)).toHaveCount(0);

  // ── Agenda: both lists ──
  await goto(page, 'agenda');
  await expect(page.getByTestId(`alltask-${ids.a}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`alltask-${ids.a}`).locator(dot)).toHaveCount(1);
  await expect(page.getByTestId(`alltask-${ids.b}`).locator(dot)).toHaveCount(0);
  const todoA = page.getByTestId(`todo-${ids.a}`);
  if ((await todoA.count()) > 0) await expect(todoA.locator(dot)).toHaveCount(1);

  // ── stopping the timer takes the dot away ──
  const stop = await upload([cmd('timer.clock_out', { entry_id: ids.entry, ended_at: new Date().toISOString() })]);
  expect(stop.ok()).toBeTruthy();
  await expect(page.getByTestId(`alltask-${ids.a}`).locator(dot)).toHaveCount(0, { timeout: 30_000 });
});

test('the dot sits to the left of a title that wraps onto several rows, level with its first row', async ({ page }) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID(), entry: randomUUID() };
  const long =
    'Make the auto generated note title from the journal a grey color so that the user is more enticed to change it, and keep going for long enough that it takes several rows';
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Plan', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: long, sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('timer.clock_in', { entry_id: ids.entry, task_id: ids.t, started_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  const row = page.getByTestId(`task-row-${ids.t}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const dot = row.getByTestId('running-dot');
  await expect(dot).toHaveCount(1);
  const title = row.getByTestId(`title-${ids.t}`);
  const [d, t] = await Promise.all([dot.boundingBox(), title.boundingBox()]);
  expect(d).not.toBeNull();
  expect(t).not.toBeNull();
  expect(t!.height).toBeGreaterThan(30); // the title really takes several rows
  expect(d!.x + d!.width).toBeLessThanOrEqual(t!.x + 1); // to the LEFT of the title, not above it
  expect(d!.y).toBeGreaterThanOrEqual(t!.y - 2); // level with the first row…
  expect(d!.y + d!.height).toBeLessThanOrEqual(t!.y + 22); // …not centred down the whole title
});