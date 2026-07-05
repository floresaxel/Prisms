/**
 * Journal e2e (Playwright) against the live stack — J6 DoD + J7 WYSIWYG:
 *   1. create a note in the TipTap editor (emoji intact) → reload keeps it → edit
 *      → delete (dot gone); the day-panel Export .md downloads the stored markdown;
 *   2. FRESH-DEVICE LAZY-LOAD PROOF (asserted, not claimed): a note seeded in a
 *      PAST month is NOT in the local replica until that month is viewed, while
 *      the current month's note IS — proving the month-bucketed `journal_month`
 *      stream pulls zero journal rows until a month is opened;
 *   3. an offline write shows immediately (overlay) and syncs on reconnect —
 *      one row, no ghost;
 *   4. J7: toolbar formatting + an INTERACTIVE task checkbox round-trip through
 *      the markdown `content` field (`- [ ]` ⇄ `- [x]`), the headline J7 affordance.
 *
 * The store/server prove convergence + the D5 ack-rewrite deterministically
 * (packages/ui journal-overlay + apps/server journal.integration); this drives the
 * browser surface. Requires the live stack (see playwright.config.ts). `__db` is
 * exposed by the app behind a localhost guard (App.tsx — dev + CI vite-preview are
 * both localhost, never prod) so the lazy-load proof can page-eval the local replica.
 *
 * The editor is a TipTap contenteditable (`journal-rich`), NOT a form field, so we
 * drive it with click + keyboard.insertText (atomic unicode, unlike per-char type)
 * and assert on the SERVER-stored markdown / rendered nodes rather than `.fill`/
 * `.toHaveValue`. WYSIWYG serialization is normalized, so content checks use
 * containment, not byte-equality (byte-exact emoji is proven in the unit archive test).
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { addDays, asEpochMillis, bucketDate } from '@prisms/core';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const TZ = 'America/New_York'; // a fresh account's default day-reset timezone
const today = bucketDate(asEpochMillis(Date.now()), 0, TZ);
const daysAgo = (n: number): string => addDays(today, -n);
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
  await page.locator('input[autocomplete="name"]').fill('J6 User');
  await page.getByTestId('email').fill(`e2e-${label}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

/** Replace the TipTap editor's whole content with `text` (insertText = atomic unicode). */
async function setEditor(page: Page, text: string): Promise<Locator> {
  const editor = page.getByTestId('journal-rich');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
  return editor;
}

/** Count non-deleted local journal rows for a day (the LOCAL replica, via __db). */
const localCount = (page: Page, entryDate: string): Promise<number> =>
  page.evaluate(async (d) => {
    const db = (window as unknown as { __db: { getAll(sql: string, p: unknown[]): Promise<{ n: number }[]> } }).__db;
    const rows = await db.getAll('SELECT count(*) AS n FROM journal_entries WHERE entry_date = ? AND deleted_at IS NULL', [d]);
    return Number(rows[0]?.n ?? 0);
  }, entryDate);

/** All live journal days the SERVER holds for the signed-in user (source of truth). */
const serverDays = async (page: Page): Promise<string[]> => {
  const res = await page.request.get('/sync/journal/export');
  if (!res.ok()) return [];
  return ((await res.json()) as { entries: { entry_date: string }[] }).entries.map((e) => e.entry_date);
};

/** The SERVER-stored markdown for one day (undefined if absent) — the persisted truth. */
const serverContent = async (page: Page, entryDate: string): Promise<string | undefined> => {
  const res = await page.request.get('/sync/journal/export');
  if (!res.ok()) return undefined;
  const j = (await res.json()) as { entries: { entry_date: string; content: string }[] };
  return j.entries.find((e) => e.entry_date === entryDate)?.content;
};

test('create → reload → edit → delete (WYSIWYG) with emoji; day Export .md downloads it', async ({ page }) => {
  await register(page, 'journal-crud');
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByTestId('day-head-0').click(); // day-head-0 == today

  await expect(page.getByTestId('journal-rich')).toBeVisible();
  const editor = await setEditor(page, 'Standup notes 👨‍👩‍👧‍👦 shipped it');
  await editor.blur(); // flush the debounced save

  // the dot appears on today (overlay is instant) and the server persists it.
  await expect(page.getByTestId(`note-dot-${today}`)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => serverContent(page, today), { timeout: 30_000 }).toContain('Standup notes');
  const stored = (await serverContent(page, today))!;
  expect(stored).toContain('👨‍👩‍👧‍👦'); // ZWJ emoji byte-intact through the WYSIWYG (D6)

  // Export .md downloads exactly the stored markdown, named <today>.md.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('journal-export').click()]);
  expect(dl.suggestedFilename()).toBe(`${today}.md`);
  expect(await readFile(await dl.path(), 'utf8')).toBe(stored);

  // reload → the note survives (came back from the server) and renders in the editor.
  await page.reload();
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByTestId('day-head-0').click();
  await expect(page.getByTestId('journal-rich')).toContainText('Standup notes', { timeout: 30_000 });

  // edit (append) → converges as ONE row; then delete → the dot disappears.
  await page.getByTestId('journal-rich').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' — edited ✏️');
  await page.getByTestId('journal-rich').blur();
  await expect.poll(async () => (await serverDays(page)).length, { timeout: 30_000 }).toBe(1);
  await page.getByTestId('journal-delete').click();
  await expect(page.getByTestId(`note-dot-${today}`)).toHaveCount(0);
  await expect.poll(async () => (await serverDays(page)).length, { timeout: 30_000 }).toBe(0);
});

test('fresh-device lazy-load: a past-month note is NOT local until viewed; the .md archive is server-sourced', async ({ page }) => {
  await register(page, 'journal-lazy');
  const pastA = daysAgo(42); // ~6 weeks ago → a past month, exactly 6 weeks of week-prev away
  const monthA = pastA.slice(0, 7);
  const pastContent = 'from a past month 🇫🇷';
  // Seed one note TODAY (current month) and one in the PAST month, via the command API.
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('journal.write', { id: randomUUID(), entry_date: today, content: 'today note' }),
        cmd('journal.write', { id: randomUUID(), entry_date: pastA, content: pastContent }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // Open the Agenda: it subscribes the CURRENT week's month(s) only.
  await page.getByRole('link', { name: 'Agenda' }).click();
  // today's note syncs down (current month subscribed) …
  await expect.poll(() => localCount(page, today), { timeout: 30_000 }).toBe(1);
  // … but the PAST month's note is NOT local (its month was never subscribed).
  expect(await localCount(page, pastA)).toBe(0);

  // The Settings `.md` archive is SERVER-sourced, so it INCLUDES the never-synced
  // past month (a local "export all" would have truncated it).
  await page.getByRole('link', { name: 'Settings' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('journal-export-archive').click()]);
  expect(dl.suggestedFilename()).toMatch(/^prisms-journal_.*\.zip$/);
  const files = unzipSync(new Uint8Array(await readFile(await dl.path())));
  expect(strFromU8(files[`journal/${yearOf(pastA)}/${pastA}.md`]!)).toBe(pastContent);
  expect(Object.keys(files)).toContain(`journal/${yearOf(today)}/${today}.md`);

  // Now VIEW the past month on the Agenda (6 weeks back) → its rows sync lazily.
  await page.getByRole('link', { name: 'Agenda' }).click();
  for (let i = 0; i < 6; i++) await page.getByTestId('week-prev').click();
  await expect(page.getByTestId(`note-dot-${pastA}`)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => localCount(page, pastA), { timeout: 30_000 }).toBe(1); // NOW local (asserted)
  expect(monthA).not.toBe(today.slice(0, 7)); // sanity: it really was a different month
});

test('offline write shows immediately (overlay) and syncs on reconnect — one row, no ghost', async ({ page, context }) => {
  await register(page, 'journal-offline');
  await page.getByRole('link', { name: 'Agenda' }).click();

  await context.setOffline(true);
  await page.getByTestId('day-head-0').click();
  await setEditor(page, 'written offline 🌍');
  await page.getByTestId('journal-rich').blur();
  await expect(page.getByTestId(`note-dot-${today}`)).toBeVisible(); // overlay shows it WHILE offline

  await context.setOffline(false);
  await expect.poll(() => serverDays(page), { timeout: 30_000 }).toEqual([today]); // synced on reconnect

  await page.reload();
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByTestId('day-head-0').click();
  await expect(page.getByTestId('journal-rich')).toContainText('written offline', { timeout: 30_000 });
  expect(await localCount(page, today)).toBe(1); // exactly one row — no ghost duplicate
});

test('J7 WYSIWYG: toolbar task list + an interactive checkbox round-trip to markdown', async ({ page }) => {
  await register(page, 'journal-wysiwyg');
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByTestId('day-head-0').click();
  const editor = page.getByTestId('journal-rich');
  await expect(editor).toBeVisible();

  // Build a task item via the toolbar (deterministic — no reliance on input rules).
  await editor.click();
  await page.getByTestId('rt-task').click();
  await page.keyboard.insertText('buy milk');
  await editor.blur();

  // serialized as an UNCHECKED task in the stored markdown.
  await expect.poll(() => serverContent(page, today), { timeout: 30_000 }).toContain('[ ] buy milk');

  // Toggle the RENDERED checkbox → the stored markdown flips to CHECKED ([x]).
  await editor.getByRole('checkbox').first().click();
  await editor.blur();
  await expect.poll(() => serverContent(page, today), { timeout: 30_000 }).toContain('[x] buy milk');

  // reload → the checkbox comes back CHECKED (state persisted through markdown, not DOM).
  await page.reload();
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByTestId('day-head-0').click();
  await expect(page.getByTestId('journal-rich').getByRole('checkbox').first()).toBeChecked({ timeout: 30_000 });
});
