/**
 * M9 DoD e2e (Playwright) — the 1.3 interaction surfaces:
 *   - accept a valid suggestion → it promotes to committed AND the flexible
 *     block it replaces resolves (§7.5);
 *   - accepting a stale (superseded) suggestion → the machine-readable rejection
 *     surfaces (friendly toast) and a durable review item appears (§7.13);
 *   - provenance "why does this exist?" explains user- vs automation-created
 *     tasks (§7.8);
 *   - a blocked task offers force clock-in, after which it shows `ongoing` (§8).
 *
 * Suggestions, supersession, and automation provenance can't be produced through
 * the user command API, so those rows are seeded/mutated straight in Postgres —
 * they sync down like any server write (same approach as s17). Requires the live
 * stack (see playwright.config.ts).
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

/** ISO at `offset` days from today, `hourUtc` (→ a daytime hour in America/New_York). */
const dayISO = (offset: number, hourUtc: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

async function register(page: Page, label: string): Promise<string> {
  const email = `e2e-${label}-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('M9 User');
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

/** A justified vision→roadmap→project→task chain via the command API. */
function chain(taskTitle: string, estimate = 60) {
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const commands = [
    cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
    cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
    cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
    cmd('node.create', { id: ids.t, node_type: 'task', title: taskTitle, sort_order: 'a0', parent_id: ids.p, estimate_minutes: estimate }),
  ];
  return { ids, commands };
}

test('suggestion: accept promotes it AND the replaced flexible block resolves (§7.5)', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    const userId = await register(page, 'm9-accept');
    const { ids, commands } = chain('Plan Me');
    const replaced = randomUUID();
    const suggested = randomUUID();
    const seed = await page.request.post('/sync/upload', {
      data: {
        device_id: 'e2e-seed',
        commands: [
          ...commands,
          // a committed FLEXIBLE block the suggestion will replace
          cmd('block.create', { id: replaced, task_id: ids.t, starts_at: dayISO(1, 14), ends_at: dayISO(1, 15) }),
        ],
      },
    });
    expect(seed.ok()).toBeTruthy();

    await goto(page, 'agenda');
    await expect(page.getByTestId(`block-${replaced}`)).toBeVisible({ timeout: 30_000 });

    // a server-generated suggestion that replaces the committed block (sync down)
    await sql`
      INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, suggestion_reason, replaces_block_id, source_kind, updated_at)
      VALUES (${suggested}, ${userId}, ${ids.t}, ${dayISO(1, 16)}, ${dayISO(1, 17)}, 'none', 'suggested', 'nightly_optimization', ${replaced}, 'scheduler', now())
    `;

    const suggestedEl = page.getByTestId(`block-${suggested}`);
    await expect(suggestedEl).toHaveClass(/px-cal-block--suggested/, { timeout: 30_000 });

    // --- DoD: accept → promotes to committed AND the replaced block resolves ---
    await page.getByTestId(`accept-${suggested}`).click();
    await expect(page.getByTestId(`accept-${suggested}`)).toHaveCount(0);
    await expect(page.getByTestId(`block-${suggested}`)).not.toHaveClass(/px-cal-block--suggested/);
    // the flexible block it replaced is soft-deleted (resolves) — optimistically and after sync.
    await expect(page.getByTestId(`block-${replaced}`)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('suggestion: accepting a stale (superseded) one surfaces the rejection + a review item (§7.13)', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    const userId = await register(page, 'm9-stale');
    const { ids, commands } = chain('Stale Plan');
    const stale = randomUUID();
    const seed = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
    expect(seed.ok()).toBeTruthy();

    await goto(page, 'agenda');
    await expect(page.getByTestId(`todo-${ids.t}`)).toBeVisible({ timeout: 30_000 });

    // a suggestion that is ALREADY superseded server-side (a newer batch won).
    await sql`
      INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, suggestion_reason, superseded_at, source_kind, updated_at)
      VALUES (${stale}, ${userId}, ${ids.t}, ${dayISO(1, 16)}, ${dayISO(1, 17)}, 'none', 'suggested', 'nightly_optimization', now(), 'scheduler', now())
    `;

    // --- DoD: supersession is reflected in the UI ---
    await expect(page.getByTestId(`superseded-${stale}`)).toBeVisible({ timeout: 30_000 });

    // --- DoD: accepting the stale suggestion is rejected (machine-readable) + a review item appears ---
    await page.getByTestId(`accept-${stale}`).click();
    await expect(page.getByTestId('rejection-toast')).toContainText('superseded by a newer plan', { timeout: 30_000 });
    await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 30_000 });
    // the overlay rolled back → the block is suggested + superseded again.
    await expect(page.getByTestId(`superseded-${stale}`)).toBeVisible();
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('provenance: "why does this exist?" explains user- vs automation-created tasks (§7.8)', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    await register(page, 'm9-prov');
    const mine = chain('My Task');
    const auto = chain('Automated Task');
    const seed = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands: [...mine.commands, ...auto.commands] } });
    expect(seed.ok()).toBeTruthy();

    // turn the second task into an automation-spawned row (server-assigned provenance).
    const detail = JSON.stringify({ trigger_node_id: mine.ids.t, action_slot: 0, rule_version: 2, template_version: 1 });
    await sql`
      UPDATE nodes
      SET source_kind = 'automation', source_id = ${randomUUID()},
          source_detail = ${detail}::jsonb,
          updated_at = now()
      WHERE id = ${auto.ids.t}
    `;

    await expect(page.getByTestId(`why-task-${mine.ids.t}`)).toBeVisible({ timeout: 30_000 });

    // --- DoD: a user-created task explains itself as user-created ---
    await page.getByTestId(`why-task-${mine.ids.t}`).click();
    await expect(page.getByTestId(`why-task-${mine.ids.t}-summary`)).toHaveText('You created this.');

    // --- DoD: an automation-created task explains itself as automation ---
    // open once; the summary re-derives reactively as the provenance update syncs down.
    await page.getByTestId(`why-task-${auto.ids.t}`).click();
    await expect(page.getByTestId(`why-task-${auto.ids.t}-summary`)).toHaveText('Created by an automation rule.', { timeout: 30_000 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('force clock-in: a blocked task overrides the blocker and shows ongoing (§8)', async ({ page }) => {
  await register(page, 'm9-force');
  const { ids, commands } = chain('Blocked Task');
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        ...commands,
        // an always-true blocker over all tasks → the task is blocked.
        cmd('blocker.create', { id: randomUUID(), scope: { node_types: ['task'] }, predicate: { all: [] }, label: 'Always blocked', enabled: true }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // the blocked task is kept out of the worklist and listed under "Blocked"
  // (collapsed by default in My Day, W2 — expand it to reach the force affordance).
  await expect(page.getByTestId('sec-blocked')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sec-blocked').click();
  await expect(page.getByTestId(`force-clock-in-${ids.t}`)).toBeVisible();
  await expect(page.getByTestId('running-timer')).toHaveCount(0);

  // --- DoD: force clock-in opens a timer → the task becomes `ongoing` (wins precedence) ---
  await page.getByTestId(`force-clock-in-${ids.t}`).click();
  const timer = page.getByTestId('running-timer');
  await expect(timer).toBeVisible({ timeout: 30_000 });
  await expect(timer).toContainText('Blocked Task');
  // it left the Blocked list (ongoing, not blocked).
  await expect(page.getByTestId(`force-clock-in-${ids.t}`)).toHaveCount(0);
});
