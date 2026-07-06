/**
 * M10 DoD e2e (Playwright) — the web review inbox + freshness:
 *   - a synced server rejection shows in the review inbox screen; resolving and
 *     dismissing items closes them (optimistically AND server-side, §7.13);
 *   - the "N items need review" banner links to the inbox;
 *   - the dashboard projection carries a freshness label from the server
 *     aggregate's computed_at (§7.4).
 *
 * Review items can only be produced by the server (a command rejection), so they
 * are generated through the real /sync/upload path and stream down like any
 * server write. Aggregates are seeded straight in Postgres (server-owned).
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

import { goto } from './util/nav';

const DB_URL = process.env.PRISMS_DB_TEST_URL ?? 'postgresql://prisms:prisms_dev_password@localhost:5434/prisms';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor rejection)
});

async function register(page: Page, label: string): Promise<string> {
  const email = `e2e-${label}-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('M10 User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
  const userId = await page.evaluate(() => {
    const raw = localStorage.getItem('prisms.user');
    return raw ? (JSON.parse(raw) as { id: string }).id : '';
  });
  expect(userId).not.toEqual('');
  return userId;
}

/** Upload a command that the server rejects, returning the review item it creates. */
async function seedRejection(page: Page): Promise<string> {
  // node.rename on a non-existent node → E_NOT_FOUND → a command_rejection item.
  const res = await page.request.post('/sync/upload', {
    data: { device_id: 'e2e-seed', commands: [cmd('node.rename', { id: randomUUID(), title: 'ghost' })] },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { results: { result: string; review_item_ids?: string[] }[] };
  const item = body.results[0];
  expect(item.result).toBe('rejected');
  expect(item.review_item_ids?.[0]).toBeTruthy();
  return item.review_item_ids![0]!;
}

test('review inbox: a synced rejection shows; resolve + dismiss close items (§7.13)', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    await register(page, 'm10-inbox');
    const idA = await seedRejection(page);
    const idB = await seedRejection(page);

    // the banner points at the inbox once the items sync down.
    const banner = page.getByTestId('review-banner');
    await expect(banner).toContainText('2 items need review', { timeout: 30_000 });

    // --- DoD: the banner links to the review inbox ---
    await banner.click();
    await expect(page.getByTestId('review-inbox')).toBeVisible();
    await expect(page.getByTestId(`review-item-${idA}`)).toBeVisible();
    await expect(page.getByTestId(`review-item-${idB}`)).toBeVisible();

    // --- DoD: resolve closes an item (optimistic + server-persisted) ---
    await page.getByTestId(`resolve-${idA}`).click();
    await expect(page.getByTestId(`review-item-${idA}`)).toHaveCount(0);
    await expect
      .poll(async () => (await sql`SELECT status FROM sync_review_items WHERE id = ${idA}`)[0]?.['status'], { timeout: 30_000 })
      .toBe('resolved');

    // --- DoD: dismiss closes the other ---
    await page.getByTestId(`dismiss-${idB}`).click();
    await expect(page.getByTestId(`review-item-${idB}`)).toHaveCount(0);
    await expect
      .poll(async () => (await sql`SELECT status FROM sync_review_items WHERE id = ${idB}`)[0]?.['status'], { timeout: 30_000 })
      .toBe('dismissed');

    // the inbox is now empty (both closed).
    await expect(page.getByTestId('review-empty')).toBeVisible();

    // closes persist across a reload (they synced down as resolved/dismissed).
    await page.reload();
    await goto(page, 'review');
    await expect(page.getByTestId('review-empty')).toBeVisible({ timeout: 30_000 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('dashboard: the projection freshness label reflects the server aggregate computed_at (§7.4)', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    const userId = await register(page, 'm10-fresh');

    await goto(page, 'dashboard');
    // before any server aggregate, the projection is a live client estimate.
    await expect(page.getByTestId('projection-freshness')).toContainText('live', { timeout: 30_000 });

    // a server-computed projection aggregate (server-owned) syncs down.
    await sql`
      INSERT INTO computed_aggregates (id, user_id, subject_kind, subject_id, metric, value, computed_at, computed_by, updated_at)
      VALUES (${randomUUID()}, ${userId}, 'user', NULL, 'projection', '{}'::jsonb, now(), 'server', now())
    `;

    // --- DoD: the label flips to the server aggregate's freshness ---
    await expect(page.getByTestId('projection-freshness')).toContainText('updated', { timeout: 30_000 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
