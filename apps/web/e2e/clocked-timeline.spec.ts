/**
 * The day log's Clocked section against the live stack: collapsed per-task rows
 * beside a day bar, the "All logs" popup, and the hover / click highlighting
 * across rows and bar regions.
 *
 * Set CLOCKED_SHOTS=<dir> to also save screenshots of each state there.
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, bucketDate, localInstant } from '@prisms/core';
import { expect, test, type Page } from '@playwright/test';

import { goto } from './util/nav';

const TZ = 'America/New_York'; // a fresh account's default timezone
const today = bucketDate(asEpochMillis(Date.now()), 4, TZ);
const SHOTS = process.env.CLOCKED_SHOTS;

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});
const atLocal = (date: string, hh: number, mm = 0): string => new Date(localInstant(date, hh, TZ, mm)).toISOString();

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Clock User');
  await page.getByTestId('email').fill(`e2e-clocked-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 30_000 });
}

async function upload(page: Page, commands: unknown[]): Promise<void> {
  const res = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { results?: { result: string }[] };
  expect((body.results ?? []).filter((r) => r.result !== 'applied')).toEqual([]);
}

function branch(visionTitle: string, projectTitle: string, taskTitle: string) {
  const [vision, roadmap, project, task] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  return {
    task,
    commands: [
      cmd('node.create', { id: vision, node_type: 'vision', title: visionTitle, sort_order: 'a0' }),
      cmd('node.create', { id: roadmap, node_type: 'roadmap', title: `${visionTitle} roadmap`, sort_order: 'a0', parent_id: vision }),
      cmd('node.create', { id: project, node_type: 'project', title: projectTitle, sort_order: 'a0', parent_id: roadmap }),
      cmd('node.create', { id: task, node_type: 'task', title: taskTitle, sort_order: 'a0', parent_id: project }),
    ],
  };
}

function clock(task: string, from: string, to: string) {
  const entry = randomUUID();
  return {
    entry,
    commands: [cmd('timer.clock_in', { entry_id: entry, task_id: task, started_at: from }), cmd('timer.clock_out', { entry_id: entry, ended_at: to })],
  };
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test('Clocked collapses to tasks + a day bar; hover follows a task, click singles out a session', async ({ page }) => {
  await register(page);
  const run = branch('Health', 'Marathon', 'Long run');
  const novel = branch('Craft', 'Novel', 'Draft chapter');
  const a1 = clock(run.task, atLocal(today, 7), atLocal(today, 8, 30)); // 1h30
  const b1 = clock(novel.task, atLocal(today, 10), atLocal(today, 10, 45)); // 45m
  const a2 = clock(run.task, atLocal(today, 13), atLocal(today, 14)); // 1h
  await upload(page, [
    ...run.commands,
    ...novel.commands,
    ...a1.commands,
    ...b1.commands,
    ...a2.commands,
    cmd('journal.write', { id: randomUUID(), entry_date: today, content: 'a good day' }),
  ]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(page, 'journal');
  const clocked = page.getByTestId('daylog-clocked');
  await expect(clocked).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('3h 15m');
  // let the note itself land first: its arrival re-lays out the panel, and a
  // hover started before that would be measured against a moving target
  await expect(page.getByTestId(`journal-day-${today}`)).toBeVisible({ timeout: 30_000 });

  // --- collapsed: one row per task with its total, and the bar ---
  const rows = clocked.locator('[data-testid^="daylog-clock-task-"]');
  await expect(rows).toHaveCount(2);
  const runRow = page.getByTestId(`daylog-clock-task-${run.task}`);
  const novelRow = page.getByTestId(`daylog-clock-task-${novel.task}`);
  await expect(runRow).toContainText('Long run');
  await expect(runRow).toContainText('2h 30m');
  await expect(runRow).toContainText('2 sessions');
  await expect(runRow).toContainText('Health › Marathon');
  await expect(novelRow).toContainText('45m');
  const bar = page.getByTestId('daylog-clock-bar');
  await expect(bar.locator('.px-cbar-seg')).toHaveCount(3);
  // regions sit where the sessions happened: the 07:00 one above the 13:00 one
  const top = async (id: string) => (await page.getByTestId(`daylog-seg-${id}`).boundingBox())!.y;
  expect(await top(a1.entry)).toBeLessThan(await top(b1.entry));
  expect(await top(b1.entry)).toBeLessThan(await top(a2.entry));
  await clocked.scrollIntoViewIfNeeded();
  await shot(page, '1-collapsed');

  // --- hover a task row: its regions stay lit, the rest greys ---
  await runRow.hover();
  await expect(page.getByTestId(`daylog-seg-${a1.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-seg-${a2.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-seg-${b1.entry}`)).toHaveAttribute('data-state', 'dim');
  await expect(novelRow).toHaveAttribute('data-state', 'dim');
  // greyed means greyed — not just an attribute. Polled: the dim FADES in over
  // 120ms, and a single read taken the instant data-state flips still sees 1
  // (CI's faster runner did exactly that).
  await expect
    .poll(() => novelRow.evaluate((el) => Number(getComputedStyle(el).opacity)))
    .toBeLessThan(0.5);
  await shot(page, '2-hover-task');
  await page.mouse.move(5, 5);
  await expect(novelRow).toHaveAttribute('data-state', 'none');

  // --- the popup: every session, a taller bar ---
  await page.getByTestId('daylog-clock-all').click();
  const pop = page.getByTestId('daylog-clock-popup');
  await expect(pop).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('3h 15m total · 3 sessions · 2 tasks');
  const logs = pop.locator('[data-testid^="daylog-clock-"][aria-pressed]');
  await expect(logs).toHaveCount(3);
  await expect(page.getByTestId(`daylog-clock-${a1.entry}`)).toContainText('07:00–08:30');
  await expect(page.getByTestId(`daylog-clock-${a1.entry}`)).toContainText('1h 30m');
  await shot(page, '3-popup');

  // hover one log → every log of that task lights, in the list and on the bar
  await page.getByTestId(`daylog-clock-${a1.entry}`).hover();
  await expect(page.getByTestId(`daylog-clock-${a2.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-clock-${b1.entry}`)).toHaveAttribute('data-state', 'dim');
  await expect(page.getByTestId(`daylog-popup-seg-${a2.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-popup-seg-${b1.entry}`)).toHaveAttribute('data-state', 'dim');
  await shot(page, '4-popup-hover');

  // click it → only that session and its region; the same task's other session greys
  await page.getByTestId(`daylog-clock-${a1.entry}`).click();
  await expect(page.getByTestId(`daylog-clock-${a1.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-clock-${a2.entry}`)).toHaveAttribute('data-state', 'dim');
  await expect(page.getByTestId(`daylog-popup-seg-${a1.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-popup-seg-${a2.entry}`)).toHaveAttribute('data-state', 'dim');
  await shot(page, '5-popup-click');

  // clicking a region on the bar picks that session instead
  await page.getByTestId(`daylog-popup-seg-${b1.entry}`).click();
  await expect(page.getByTestId(`daylog-clock-${b1.entry}`)).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId(`daylog-clock-${a1.entry}`)).toHaveAttribute('data-state', 'dim');

  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  // nothing in the day log can be edited
  expect(await page.getByTestId('daylog').evaluate((el) => el.querySelectorAll('input,textarea,select,[contenteditable]').length)).toBe(0);
});
