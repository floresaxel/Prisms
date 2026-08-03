/**
 * Journal day log e2e (Annex L) against the live stack.
 *
 *   1. schedule a task into today + complete it → the footer shows it as
 *      Scheduled [x] AND Completed; unchecking removes the line live;
 *   2. OFFLINE: completing another task updates the footer instantly, and after
 *      reconnect a page-eval proves NO day-log rows exist anywhere in the local
 *      replica — D1 asserted structurally, not narrated;
 *   3. the Automations → Built-in toggle hides the footer immediately (the
 *      optimistic settings effect) and restores everything on the way back —
 *      there is no catch-up machinery to test, it is a recomputation;
 *   4. exports: the day `.md` is the typed note verbatim + `### Day log`, and the
 *      Settings archive contains a LOG-ONLY past-month day whose month this
 *      device never subscribed — extending the J6 lazy-load proof to day logs.
 *
 * Requires the live stack (see playwright.config.ts). `__db` is exposed by the
 * app behind a localhost guard (App.tsx) so the replica can be page-evaluated.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { addDays, asEpochMillis, bucketDate } from '@prisms/core';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { goto } from './util/nav';

const TZ = 'America/New_York'; // a fresh account's default timezone
const today = bucketDate(asEpochMillis(Date.now()), 0, TZ);
const yearOf = (d: string): string => d.slice(0, 4);

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

async function register(page: Page, label: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Day Log User');
  await page.getByTestId('email').fill(`e2e-${label}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

/** I3: a task needs an ancestor project — the minimum legal tree. */
function tree(): { vision: string; roadmap: string; project: string; commands: ReturnType<typeof cmd>[] } {
  const vision = randomUUID();
  const roadmap = randomUUID();
  const project = randomUUID();
  return {
    vision,
    roadmap,
    project,
    commands: [
      cmd('node.create', { id: vision, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
      cmd('node.create', { id: roadmap, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: vision }),
      cmd('node.create', { id: project, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: roadmap }),
    ],
  };
}

/** An instant on `date` at `hh:mm` UTC. Both the block and the completion use these. */
const atUtc = (date: string, hh: number, mm = 0): string =>
  `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

const upload = async (page: Page, commands: unknown[]): Promise<void> => {
  const res = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { results?: { result: string; reject_reason?: string }[] };
  const rejected = (body.results ?? []).filter((r) => r.result !== 'applied');
  expect(rejected, JSON.stringify(rejected)).toEqual([]);
};

/** Open today's journal day (the Journal screen mounts the shared day panel). */
async function openToday(page: Page): Promise<void> {
  await goto(page, 'journal');
  await expect(page.getByTestId(`journal-${today}`)).toBeVisible({ timeout: 30_000 });
}

const footer = (page: Page) => page.getByTestId('daylog');

test('a scheduled + completed task shows in both sections; unchecking removes it live', async ({ page }) => {
  await register(page, 'daylog-live');
  const t = tree();
  const task = randomUUID();
  const block = randomUUID();
  await upload(page, [
    ...t.commands,
    cmd('node.create', { id: task, node_type: 'task', title: 'Write the release notes 🚀', sort_order: 'a0', parent_id: t.project }),
    cmd('block.create', { id: block, task_id: task, starts_at: atUtc(today, 15), ends_at: atUtc(today, 16, 30) }),
    cmd('node.check_off', { id: task, completed_at: atUtc(today, 16, 20) }),
  ]);

  await openToday(page);
  await expect(footer(page)).toBeVisible({ timeout: 30_000 });
  // Scheduled: the box is filled (done) and the block's local time range renders.
  const scheduled = page.getByTestId('daylog-scheduled');
  await expect(scheduled).toContainText('Write the release notes 🚀');
  await expect(scheduled).toContainText('11:00–12:30'); // 15:00Z–16:30Z in America/New_York
  await expect(scheduled.locator('.px-daylog-box--on')).toHaveCount(1);
  // Completed: the same task, marked planned (no "unplanned" chip).
  const completed = page.getByTestId('daylog-completed');
  await expect(completed).toContainText('12:20');
  await expect(completed.getByTestId('daylog-unplanned')).toHaveCount(0);

  // The footer is INERT: nothing in it can be typed into or clicked.
  expect(
    await footer(page).evaluate((el) => el.querySelectorAll('input,textarea,button,select,a,[contenteditable],[tabindex]').length),
  ).toBe(0);

  // Uncheck → the Completed line disappears and the box empties. That IS the
  // feature: the log is a snapshot of current facts, never history.
  await upload(page, [cmd('node.uncheck', { id: task })]);
  await expect(page.getByTestId('daylog-completed')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('daylog-scheduled').locator('.px-daylog-box--on')).toHaveCount(0);
  await expect(page.getByTestId('daylog-scheduled')).toContainText('Write the release notes 🚀');
});

test('offline: a completion updates the footer instantly, and NO day-log rows exist locally', async ({ page, context }) => {
  await register(page, 'daylog-offline');
  const t = tree();
  const task = randomUUID();
  await upload(page, [
    ...t.commands,
    cmd('node.create', { id: task, node_type: 'task', title: 'Fix the flaky test', sort_order: 'a0', parent_id: t.project }),
  ]);

  await openToday(page);
  await expect(footer(page)).toHaveCount(0); // nothing on the day yet

  // Let the seeded task sync DOWN first, then cut the network and check it off
  // through the app's own UI.
  await goto(page, 'tasks');
  await expect(page.getByTestId(`task-check-${task}`)).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  await page.getByTestId(`task-check-${task}`).click();

  // …the footer has it before anything reaches the server: the overlay already
  // patched the facts the computation reads, with zero day-log write code.
  await openToday(page);
  await expect(footer(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('daylog-completed')).toContainText('Fix the flaky test');

  await context.setOffline(false);
  await expect(page.getByTestId('daylog-completed')).toContainText('Fix the flaky test', { timeout: 30_000 });

  // D1, asserted: the local replica holds NO table that stores a day log — the
  // footer above was computed, not fetched.
  const tables = await page.evaluate(async () => {
    const db = (window as unknown as { __db: { getAll(sql: string, p: unknown[]): Promise<{ name: string }[]> } }).__db;
    const rows = await db.getAll("SELECT name FROM sqlite_master WHERE type IN ('table','view')", []);
    return rows.map((r) => r.name);
  });
  expect(tables.filter((n) => /day_?log/i.test(n))).toEqual([]);
});

test('the Built-in toggle hides the footer immediately and restores it on the way back', async ({ page }) => {
  await register(page, 'daylog-toggle');
  const t = tree();
  const first = randomUUID();
  await upload(page, [
    ...t.commands,
    cmd('node.create', { id: first, node_type: 'task', title: 'First thing', sort_order: 'a0', parent_id: t.project }),
    cmd('node.check_off', { id: first, completed_at: atUtc(today, 15) }),
  ]);

  await openToday(page);
  await expect(footer(page)).toBeVisible({ timeout: 30_000 });

  // Toggle OFF in Automations → Built-in. The optimistic settings effect flips
  // the merged row, so the footer is gone without waiting for the round-trip.
  await goto(page, 'built-in');
  await expect(page.getByTestId('builtin-daylog-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('builtin-daylog-toggle').click();
  await expect(page.getByTestId('builtin-daylog-toggle')).toHaveAttribute('aria-checked', 'false');
  await openToday(page);
  await expect(footer(page)).toHaveCount(0);

  // Complete something else WHILE the log is off — there is no catch-up to run.
  const second = randomUUID();
  await upload(page, [
    cmd('node.create', { id: second, node_type: 'task', title: 'Second thing', sort_order: 'a1', parent_id: t.project }),
    cmd('node.check_off', { id: second, completed_at: atUtc(today, 17) }),
  ]);
  await expect(footer(page)).toHaveCount(0);

  // Toggle back ON → BOTH completions are there, because it is a recomputation.
  await goto(page, 'built-in');
  await page.getByTestId('builtin-daylog-toggle').click();
  await openToday(page);
  await expect(page.getByTestId('daylog-completed')).toContainText('First thing', { timeout: 30_000 });
  await expect(page.getByTestId('daylog-completed')).toContainText('Second thing');
});

test('exports: the day .md carries the section, and the archive has a LOG-ONLY past-month day', async ({ page }) => {
  await register(page, 'daylog-export');
  const t = tree();
  // ~6 weeks back: a month the Journal screen never expands, so its rows never sync.
  const past = addDays(today, -42);
  const todayTask = randomUUID();
  const pastTask = randomUUID();
  await upload(page, [
    ...t.commands,
    cmd('node.create', { id: todayTask, node_type: 'task', title: 'Ship it 🚀', sort_order: 'a0', parent_id: t.project }),
    cmd('block.create', { id: randomUUID(), task_id: todayTask, starts_at: atUtc(today, 15), ends_at: atUtc(today, 16, 30) }),
    cmd('node.check_off', { id: todayTask, completed_at: atUtc(today, 16, 20) }),
    // the LOG-ONLY day: facts in a past month, and NO journal note for it
    cmd('node.create', { id: pastTask, node_type: 'task', title: 'Old work 🗓️', sort_order: 'a1', parent_id: t.project }),
    cmd('node.check_off', { id: pastTask, completed_at: atUtc(past, 15) }),
    cmd('journal.write', { id: randomUUID(), entry_date: today, content: 'Shipped it today.' }),
  ]);

  await openToday(page);
  await expect(footer(page)).toBeVisible({ timeout: 30_000 });

  // The day download: the note VERBATIM, then the section. Export lives behind
  // the note's corner "⋯" menu.
  await page.getByTestId('journal-menu').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('journal-export').click()]);
  expect(dl.suggestedFilename()).toBe(`${today}.md`);
  const md = await readFile(await dl.path(), 'utf8');
  expect(md.startsWith('Shipped it today.')).toBe(true);
  expect(md).toContain('\n\n---\n\n### Day log\n');
  expect(md).toContain('- [x] 11:00–12:30 Ship it 🚀');

  // The past month was never viewed, so its journal rows are not local…
  const localPastRows = await page.evaluate(async (d) => {
    const db = (window as unknown as { __db: { getAll(sql: string, p: unknown[]): Promise<{ n: number }[]> } }).__db;
    const rows = await db.getAll('SELECT count(*) AS n FROM journal_entries WHERE entry_date = ?', [d]);
    return Number(rows[0]?.n ?? 0);
  }, past);
  expect(localPastRows).toBe(0);

  // …yet the SERVER-sourced archive still carries that day, as a log-only file.
  await goto(page, 'settings');
  await page.getByTestId('settings-tab-data').click();
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByTestId('journal-export-archive').click()]);
  const files = unzipSync(new Uint8Array(await readFile(await zip.path())));
  const pastFile = strFromU8(files[`journal/${yearOf(past)}/${past}.md`]!);
  expect(pastFile.startsWith('### Day log\n')).toBe(true); // no note → the section alone
  expect(pastFile).toContain('Old work 🗓️');
  expect(strFromU8(files[`journal/${yearOf(today)}/${today}.md`]!)).toContain('Shipped it today.');
});
