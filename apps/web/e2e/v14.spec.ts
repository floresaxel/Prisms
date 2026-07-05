/**
 * M12 DoD e2e (Playwright) — the loading-aware, stale-while-revalidate read layer
 * (§7.15, Fix C):
 *   - tab-away-and-back returns the prior rows synchronously with NO empty/skeleton
 *     flash, explicitly across Decisions, Habits, and Flowchart (the screen-local
 *     tables the v1.4 Table→Owner Matrix keeps screen-scoped);
 *   - a fresh account's confirmed-empty screens render the empty branch (not a
 *     stuck skeleton) once the initial sync completes.
 *
 * Data is seeded through the real command API (`/sync/upload`) so it streams down
 * like any server write. Requires the live stack (see playwright.config.ts). The
 * deterministic hook-level proof of the skeleton/cache logic lives in
 * apps/web/test/loading-aware.test.ts.
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

async function register(page: Page, label: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('M12 User');
  await page.getByTestId('email').fill(`e2e-${label}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('warm revisit: Decisions / Habits / Flowchart return prior rows with no empty-or-skeleton flash', async ({ page }) => {
  await register(page, 'm12-warm');
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID(), h: randomUUID(), b: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Task One', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
        cmd('habit.create', { id: ids.h, vision_id: ids.v, title: 'Morning Run', rrule: 'FREQ=DAILY', streak_mode: 'daily' }),
        cmd('board.create', { id: ids.b, title: 'Priorities' }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // ── Decisions (decision_* screen-local) ────────────────────────────────────
  await goto(page, 'decisions');
  await expect(page.getByTestId(`board-${ids.b}`)).toBeVisible({ timeout: 30_000 });
  // away, then back — the board must be present again, and NEITHER the skeleton
  // nor the confirmed-empty branch may show (the SWR cache serves it synchronously).
  await goto(page, 'myday');
  await goto(page, 'decisions');
  await expect(page.getByTestId(`board-${ids.b}`)).toBeVisible();
  await expect(page.getByTestId('decisions-skeleton')).toHaveCount(0);
  await expect(page.getByText('No boards yet')).toHaveCount(0);

  // ── Habits (habits screen-local) ───────────────────────────────────────────
  await goto(page, 'habits');
  await expect(page.getByText('Morning Run')).toBeVisible({ timeout: 30_000 });
  await goto(page, 'myday');
  await goto(page, 'habits');
  await expect(page.getByText('Morning Run')).toBeVisible();
  await expect(page.getByTestId('list-skeleton')).toHaveCount(0);
  await expect(page.getByText('No habits yet')).toHaveCount(0);

  // ── Flowchart (diagram_* screen-local + provider tree) ─────────────────────
  await goto(page, 'graph');
  await page.getByTestId('diagram-root').selectOption(ids.p);
  await expect(page.getByTestId(`flow-node-${ids.t}`)).toBeVisible({ timeout: 30_000 });
  await goto(page, 'myday');
  await goto(page, 'graph');
  await page.getByTestId('diagram-root').selectOption(ids.p);
  await expect(page.getByTestId(`flow-node-${ids.t}`)).toBeVisible();
  await expect(page.getByTestId('edge-skeleton')).toHaveCount(0);
});

test('fresh account: confirmed-empty screens render the empty branch (not a stuck skeleton) after sync', async ({ page }) => {
  await register(page, 'm12-empty');

  // Rules — no automation rules; once the (empty) initial sync completes, the
  // hydrated empty branch renders and the skeleton is gone.
  await goto(page, 'rules');
  await expect(page.getByText('No automation rules yet.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('list-skeleton')).toHaveCount(0);

  // Review inbox — nothing to review.
  await goto(page, 'review');
  await expect(page.getByTestId('review-empty')).toBeVisible({ timeout: 30_000 });

  // Decisions — no boards yet.
  await goto(page, 'decisions');
  await expect(page.getByText('No boards yet')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('decisions-skeleton')).toHaveCount(0);
});
