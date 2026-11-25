/**
 * Places that only MENTION a task open its details card when the task is clicked:
 *   - a "Review later" session on the Review tab (its task's name, `sr-open-<entry>`);
 *   - the journal's day log — a Scheduled block's name (`daylog-sched-open-<block>`)
 *     and a Clocked task row (`daylog-clock-task-<task>`) — on the Journal screen
 *     and in the Agenda's note panel.
 * Closing the card leaves the page as it was (the review item is still there).
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, bucketDate, localInstant } from '@prisms/core';
import { expect, test, type Page } from '@playwright/test';

import { goto } from './util/nav';

const TZ = 'America/New_York'; // a fresh account's default timezone
const today = bucketDate(asEpochMillis(Date.now()), 4, TZ); // the Journal's (logical) day
const atLocal = (date: string, hh: number, mm = 0): string => new Date(localInstant(date, hh, TZ, mm)).toISOString();

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

async function upload(page: Page, commands: unknown[]): Promise<void> {
  const res = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { results?: { result: string }[] };
  expect((body.results ?? []).filter((r) => r.result !== 'applied')).toEqual([]);
}

/** The card is open on `title`; close it again (its Done button). */
async function cardShows(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  await expect(page.getByTestId('td-title')).toHaveValue(title);
  await page.getByTestId('td-done').click();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);
}

test('a task named in a review item or the day log opens its details card', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Open User');
  await page.getByTestId('email').fill(`e2e-open-task-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 30_000 });

  const [v, r, p, clocked, planned, block, entry] = Array.from({ length: 7 }, () => randomUUID());
  // a 20-minute session that ended 5 minutes ago, put off with "Review later" (never reviewed)
  const end = Date.now() - 5 * 60_000;
  await upload(page, [
    cmd('node.create', { id: v, node_type: 'vision', title: 'Health', sort_order: 'a0' }),
    cmd('node.create', { id: r, node_type: 'roadmap', title: 'Health roadmap', sort_order: 'a0', parent_id: v }),
    cmd('node.create', { id: p, node_type: 'project', title: 'Marathon', sort_order: 'a0', parent_id: r }),
    cmd('node.create', { id: clocked, node_type: 'task', title: 'Long run', sort_order: 'a0', parent_id: p }),
    cmd('node.create', { id: planned, node_type: 'task', title: 'Stretch routine', sort_order: 'a1', parent_id: p }),
    cmd('block.create', { id: block, task_id: planned, starts_at: atLocal(today, 11), ends_at: atLocal(today, 12) }),
    cmd('timer.clock_in', { entry_id: entry, task_id: clocked, started_at: new Date(end - 20 * 60_000).toISOString() }),
    cmd('timer.clock_out', { entry_id: entry, ended_at: new Date(end).toISOString() }),
  ]);

  // ── Review tab: the session review's task name ──
  await goto(page, 'review');
  const item = page.getByTestId(`session-review-${entry}`);
  await expect(item).toBeVisible({ timeout: 30_000 });
  const link = page.getByTestId(`sr-open-${entry}`);
  await expect(link).toHaveText('Long run');
  await expect(link).toHaveAttribute('aria-haspopup', 'dialog');
  await link.click();
  await cardShows(page, 'Long run');
  await expect(item).toBeVisible(); // opening the task reviews nothing

  // ── Journal: the Scheduled block's name, and the Clocked task row ──
  await goto(page, 'journal');
  await expect(page.getByTestId('daylog')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`daylog-sched-open-${block}`).click();
  await cardShows(page, 'Stretch routine');
  await page.getByTestId(`daylog-clock-task-${clocked}`).click();
  await cardShows(page, 'Long run');

  // ── Agenda's note panel: the same day log, the same links ──
  // (its note is the CALENDAR day; between midnight and the 4 AM reset that is
  // not the day the session landed on, so only check it past that)
  const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(Date.now()));
  if (localHour >= 5) {
    await goto(page, 'agenda');
    const row = page.getByTestId(`daylog-clock-task-${clocked}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await cardShows(page, 'Long run');
    await page.getByTestId(`daylog-sched-open-${block}`).click();
    await cardShows(page, 'Stretch routine');
  }
});
