/**
 * Journal tags, sort-by-tag, clocked time in the day log, and the project /
 * vision filter — against the live stack.
 *
 * Seeds two visions each with a project, clocks time on a task in each, writes a
 * note, then drives the real UI: tag the note (it syncs and survives a reload),
 * group the Journal by tag, and narrow both the Journal list and the day-log
 * footer by project and vision.
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, bucketDate, localInstant } from '@prisms/core';
import { expect, test, type Page } from '@playwright/test';

import { goto } from './util/nav';

const TZ = 'America/New_York'; // a fresh account's default timezone
const DAY_RESET = 4; // …and its default day_reset_hour
const today = bucketDate(asEpochMillis(Date.now()), DAY_RESET, TZ);

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});
const atLocal = (date: string, hh: number, mm = 0): string => new Date(localInstant(date, hh, TZ, mm)).toISOString();

async function register(page: Page, label: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Tag User');
  await page.getByTestId('email').fill(`e2e-${label}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

const upload = async (page: Page, commands: unknown[]): Promise<void> => {
  const res = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { results?: { result: string; reject_reason?: string }[] };
  const rejected = (body.results ?? []).filter((r) => r.result !== 'applied');
  expect(rejected, JSON.stringify(rejected)).toEqual([]);
};

/** vision › roadmap › project › task, so a clocked task rolls up to both. */
function branch(visionTitle: string, projectTitle: string, taskTitle: string) {
  const vision = randomUUID();
  const roadmap = randomUUID();
  const project = randomUUID();
  const task = randomUUID();
  return {
    vision,
    project,
    task,
    commands: [
      cmd('node.create', { id: vision, node_type: 'vision', title: visionTitle, sort_order: 'a0' }),
      cmd('node.create', { id: roadmap, node_type: 'roadmap', title: `${visionTitle} roadmap`, sort_order: 'a0', parent_id: vision }),
      cmd('node.create', { id: project, node_type: 'project', title: projectTitle, sort_order: 'a0', parent_id: roadmap }),
      cmd('node.create', { id: task, node_type: 'task', title: taskTitle, sort_order: 'a0', parent_id: project }),
    ],
  };
}

const clock = (task: string, from: string, to: string) => {
  const entry = randomUUID();
  return [cmd('timer.clock_in', { entry_id: entry, task_id: task, started_at: from }), cmd('timer.clock_out', { entry_id: entry, ended_at: to })];
};

test('tag a note, sort the journal by tag, and filter the day log by project and vision', async ({ page }) => {
  await register(page, 'journal-tags');
  const health = branch('Health', 'Marathon', 'Long run');
  const craft = branch('Craft', 'Novel', 'Draft chapter');
  const noteId = randomUUID();
  const otherNote = randomUUID();
  const remoteNote = randomUUID();
  const otherDay = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const remoteDay = new Date(Date.parse(`${today}T12:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  await upload(page, [
    ...health.commands,
    ...craft.commands,
    // 1h30 on the run, 45m on the novel — both today
    ...clock(health.task, atLocal(today, 8), atLocal(today, 9, 30)),
    ...clock(craft.task, atLocal(today, 13), atLocal(today, 13, 45)),
    cmd('journal.write', { id: noteId, entry_date: today, content: '# Today\nfelt good' }),
    // a second, untagged note on another day
    cmd('journal.write', { id: otherNote, entry_date: otherDay, content: 'an untagged day' }),
    // a note tagged on ANOTHER device: its tags reach this one only through the
    // synced row, never the local overlay (they once never arrived at all — the
    // replica schema declared the column on the wrong table)
    cmd('journal.write', { id: remoteNote, entry_date: remoteDay, content: 'tagged elsewhere' }),
    cmd('journal.set_tags', { id: remoteNote, tags: ['travel'] }),
  ]);

  await goto(page, 'journal');
  const panel = page.getByTestId(`journal-${today}`);
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // --- the day log carries the clocked hours, rolled up to project and vision ---
  const footer = page.getByTestId('daylog');
  await expect(footer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('2h 15m');
  await expect(footer).toContainText('Long run');
  await expect(footer).toContainText('Health › Marathon');
  await expect(footer).toContainText('Craft › Novel');
  // …and nothing in the footer can be EDITED: the filter's selects live outside
  // it, and the Clocked section's buttons only change what is in view.
  expect(await footer.evaluate((el) => el.querySelectorAll('input,textarea,select,[contenteditable]').length)).toBe(0);

  // --- filter the log by project, then by vision (a view only) ---
  await page.getByTestId('daylog-filter-project').selectOption({ label: 'Novel' });
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('45m');
  await expect(footer).toContainText('Draft chapter');
  await expect(footer).not.toContainText('Long run');
  await page.getByTestId('daylog-filter-clear').click();
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('2h 15m');
  await page.getByTestId('daylog-filter-vision').selectOption({ label: 'Health' });
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('1h 30m');
  await expect(footer).not.toContainText('Draft chapter');
  await page.getByTestId('daylog-filter-clear').click();

  // --- tag the note; it persists across a reload (synced, not local state) ---
  const input = panel.getByTestId('journal-tag-input');
  await input.fill('Work');
  await input.press('Enter');
  await input.fill('health, deep focus');
  await input.press('Enter');
  await expect(panel.getByTestId('journal-tag-work')).toBeVisible();
  await expect(panel.getByTestId('journal-tag-health')).toBeVisible();
  await expect(panel.getByTestId('journal-tag-deep focus')).toBeVisible();
  // a repeat of an existing tag (different case) is not a second chip
  await input.fill('WORK');
  await input.press('Enter');
  await expect(panel.locator('[data-testid^="journal-tag-"]:not([data-testid*="remove"]):not([data-testid="journal-tag-input"])')).toHaveCount(3);

  await page.reload();
  await expect(page.getByTestId(`journal-${today}`).getByTestId('journal-tag-work')).toBeVisible({ timeout: 30_000 });

  // removing one syncs too
  await page.getByTestId(`journal-${today}`).getByTestId('journal-tag-remove-deep focus').click();
  await expect(page.getByTestId(`journal-${today}`).getByTestId('journal-tag-deep focus')).toHaveCount(0);

  // --- sort the Journal BY TAG: a note sits under each of its tags, untagged last ---
  await page.getByTestId('journal-view-tag').click();
  const groups = page.getByTestId('journal-tag-groups');
  await expect(groups.getByTestId('journal-group-work').getByTestId(`journal-day-${today}`)).toBeVisible({ timeout: 30_000 });
  await expect(groups.getByTestId('journal-group-health').getByTestId(`journal-day-${today}`)).toBeVisible();
  await expect(groups.getByTestId('journal-group-untagged').getByTestId(`journal-day-${otherDay}`)).toBeVisible();
  await expect(groups.getByTestId('journal-group-untagged').getByTestId(`journal-day-${today}`)).toHaveCount(0);
  await expect(groups.getByTestId('journal-group-travel').getByTestId(`journal-day-${remoteDay}`)).toBeVisible();

  // --- filter the list by tag ---
  await page.getByTestId('journal-filter-tag').selectOption('work');
  await expect(page.getByTestId(`journal-day-${otherDay}`)).toHaveCount(0);
  await expect(page.getByTestId(`journal-day-${today}`).first()).toBeVisible();
  await page.getByTestId('journal-filter-clear').click();

  // --- filter the list by project / vision: only days whose log touches it ---
  await page.getByTestId('journal-view-date').click();
  await page.getByTestId('journal-filter-project').selectOption({ label: 'Marathon' });
  await expect(page.getByTestId(`journal-day-${today}`)).toBeVisible();
  await expect(page.getByTestId(`journal-day-${otherDay}`)).toHaveCount(0); // that day has no clocked time at all
  // the choice is shared with the footer under the open note
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('1h 30m');
  await page.getByTestId('journal-filter-clear').click();
  await expect(page.getByTestId('daylog-clocked-total')).toHaveText('2h 15m');
});
