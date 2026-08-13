/**
 * S17 DoD e2e (Playwright). The agenda surface:
 *   - drag a to-do task → valid time windows light up → drop creates a
 *     committed block;
 *   - an anchored block refuses the drag (I7);
 *   - a server-style suggested block accepts → promotes to committed (§2.6);
 *   - a block whose ancestry reaches no vision renders dark grey (§12.2).
 *
 * Suggested + unjustified states can't be produced through the command API
 * (suggestions are server-generated; the I1 trigger forbids orphan chains), so
 * those two rows are seeded straight into Postgres — they sync down like any
 * server write. Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
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

test('agenda: drag→valid windows→drop commits; anchored refuses; suggestion accepts; grey rule', async ({ page }) => {
  const sql = postgres(DB_URL);
  try {
    const email = `e2e-s17-${Date.now()}@prisms.test`;

    // --- register --------------------------------------------------------
    await page.goto('/');
    await page.getByRole('link', { name: 'Register' }).click();
    await page.locator('input[autocomplete="name"]').fill('S17 User');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill('e2e-password-123');
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('sync-state')).toBeVisible();

    // the app caches the session user — read our id without a DB round-trip
    const userId = await page.evaluate(() => {
      const raw = localStorage.getItem('prisms.user');
      return raw ? (JSON.parse(raw) as { id: string }).id : '';
    });
    expect(userId).not.toEqual('');

    // --- seed via the command API ---------------------------------------
    const ids = {
      vj: randomUUID(), rj: randomUUID(), pj: randomUUID(),
      vu: randomUUID(), ru: randomUUID(), pu: randomUUID(),
      t1: randomUUID(), t2: randomUUID(), t3: randomUUID(), tu: randomUUID(),
      anchored: randomUUID(), grey: randomUUID(), suggested: randomUUID(),
    };
    const seed = await page.request.post('/sync/upload', {
      data: {
        device_id: 'e2e-seed',
        commands: [
          // justified chain
          cmd('node.create', { id: ids.vj, node_type: 'vision', title: 'Vision J', sort_order: 'a0' }),
          cmd('node.create', { id: ids.rj, node_type: 'roadmap', title: 'Roadmap J', sort_order: 'a0', parent_id: ids.vj }),
          cmd('node.create', { id: ids.pj, node_type: 'project', title: 'Project J', sort_order: 'a0', parent_id: ids.rj }),
          cmd('node.create', { id: ids.t1, node_type: 'task', title: 'Drag Me', sort_order: 'a0', parent_id: ids.pj, estimate_minutes: 60 }),
          cmd('node.create', { id: ids.t2, node_type: 'task', title: 'Suggest Me', sort_order: 'a1', parent_id: ids.pj, estimate_minutes: 60 }),
          cmd('node.create', { id: ids.t3, node_type: 'task', title: 'Anchored Task', sort_order: 'a2', parent_id: ids.pj, estimate_minutes: 60 }),
          // a second chain we will orphan (soft-delete its vision) → unjustified
          cmd('node.create', { id: ids.vu, node_type: 'vision', title: 'Vision U', sort_order: 'a1' }),
          cmd('node.create', { id: ids.ru, node_type: 'roadmap', title: 'Roadmap U', sort_order: 'a0', parent_id: ids.vu }),
          cmd('node.create', { id: ids.pu, node_type: 'project', title: 'Project U', sort_order: 'a0', parent_id: ids.ru }),
          cmd('node.create', { id: ids.tu, node_type: 'task', title: 'Grey Task', sort_order: 'a0', parent_id: ids.pu, estimate_minutes: 60 }),
          // committed blocks: one anchored (drag refusal), one for the soon-to-be-grey task
          cmd('block.create', { id: ids.anchored, task_id: ids.t3, starts_at: dayISO(2, 14), ends_at: dayISO(2, 15), anchor_type: 'both' }),
          cmd('block.create', { id: ids.grey, task_id: ids.tu, starts_at: dayISO(1, 14), ends_at: dayISO(1, 15) }),
        ],
      },
    });
    expect(seed.ok()).toBeTruthy();

    await goto(page, 'agenda');
    await expect(page.getByTestId(`block-${ids.anchored}`)).toBeVisible({ timeout: 30_000 });

    // --- server-style rows via Postgres (sync down like any server write) ---
    await sql`UPDATE nodes SET deleted_at = now(), updated_at = now() WHERE id = ${ids.vu}`;
    await sql`
      INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, suggestion_reason, updated_at)
      VALUES (${ids.suggested}, ${userId}, ${ids.t2}, ${dayISO(1, 16)}, ${dayISO(1, 17)}, 'none', 'suggested', 'nightly_optimization', now())
    `;

    // --- DoD: grey rule (unjustified ancestry) --------------------------
    await expect(page.getByTestId(`block-${ids.grey}`)).toHaveClass(/px-cal-block--unjustified/, { timeout: 30_000 });

    // --- DoD: anchored block shows a lock and refuses the drag ----------
    const anchored = page.getByTestId(`block-${ids.anchored}`);
    await expect(anchored).toHaveClass(/px-cal-block--anchored/);
    await expect(anchored).toContainText('🔒');
    await anchored.hover();
    await page.mouse.down();
    await expect(page.locator('.px-cal-drop')).toHaveCount(0); // no drag started
    await page.mouse.up();

    // --- DoD: drag a to-do task → valid windows render → drop commits ----
    const todo = page.getByTestId(`todo-${ids.t1}`);
    await expect(todo).toBeVisible();
    await todo.hover();
    await page.mouse.down();
    // valid windows light up the moment the drag starts
    await expect(page.locator('.px-cal-drop').first()).toBeVisible({ timeout: 5000 });
    // col 5 (5 days out) is always free & in-window regardless of the UTC↔local
    // date offset (seeds only touch offsets 1–2 → cols ≤ 3).
    const cell = page.getByTestId('cell-5-9');
    await expect(cell).toHaveAttribute('data-valid', 'true');
    await expect(page.locator('.px-cal-cell--valid').first()).toBeVisible();

    // the grabbed item rides the cursor for as long as the drag is live
    await expect(page.getByTestId('drag-ghost')).toContainText('Drag Me');

    // …and the calendar shows where it would land. 7px into the 9am hour (44px
    // tall) is 9:09, which the default 15-minute grid rounds to 9:15 — the
    // outline says so, and the hour it falls in lights up, before the drop.
    // `hover` (not a raw mouse.move to a boundingBox) because the grid is often
    // scrolled out of view here: only hover scrolls to the cell before moving.
    await cell.hover({ position: { x: 20, y: 7 } });
    const outline = page.getByTestId('drop-preview-5');
    await expect(outline).toHaveAttribute('data-start-min', '195');
    await expect(outline).toHaveAttribute('data-valid', 'true');
    await expect(outline).toContainText('9:15am – 10:15am');
    await expect(cell).toHaveAttribute('data-hot', 'true');

    await page.mouse.up();
    await expect(outline).toHaveCount(0); // the drag furniture goes away with it
    await expect(page.getByTestId('drag-ghost')).toHaveCount(0);

    // the task leaves the to-do panel and now has a committed block
    await expect(page.getByTestId(`todo-${ids.t1}`)).toHaveCount(0);
    await expect(page.locator('.px-cal-block', { hasText: 'Drag Me' })).toBeVisible();

    // …and the outline was a promise about the drop: what reached Postgres
    // starts at :15, not on the hour the pointer happened to be inside.
    await expect
      .poll(
        async () => {
          const rows = await sql<{ starts_at: Date }[]>`
            SELECT starts_at FROM schedule_blocks WHERE task_id = ${ids.t1} AND deleted_at IS NULL`;
          return rows[0] ? new Date(rows[0].starts_at).getUTCMinutes() : null;
        },
        { timeout: 30_000 },
      )
      .toBe(15);

    // --- DoD: accept a suggestion → it promotes to committed ------------
    const suggested = page.getByTestId(`block-${ids.suggested}`);
    await expect(suggested).toHaveClass(/px-cal-block--suggested/);
    await page.getByTestId(`accept-${ids.suggested}`).click();
    await expect(page.getByTestId(`accept-${ids.suggested}`)).toHaveCount(0);
    await expect(page.getByTestId(`block-${ids.suggested}`)).not.toHaveClass(/px-cal-block--suggested/);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('agenda: a committed block moves to another day and resizes (block.move)', async ({ page }) => {
  const email = `e2e-s17b-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('S17 User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), task: randomUUID(), block: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Move Block', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
        // a 1-hour committed block on day+1 at ~10:00 local
        cmd('block.create', { id: ids.block, task_id: ids.task, starts_at: dayISO(1, 14), ends_at: dayISO(1, 15) }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'agenda');
  const block = page.getByTestId(`block-${ids.block}`);
  await expect(block).toBeVisible({ timeout: 30_000 });
  await expect(block).toHaveAttribute('data-duration-min', '60');

  // --- move: drag the block to col 5 at 09:00 (always free & in-window) ---
  await block.hover();
  await page.mouse.down();
  const cell = page.getByTestId('cell-5-9');
  await expect(cell).toHaveAttribute('data-valid', 'true');
  await cell.hover();
  await page.mouse.up();
  await expect(page.getByTestId('day-5').getByTestId(`block-${ids.block}`)).toBeVisible();

  // --- resize: drag the bottom edge down one hour → 120 min ------------
  const handle = page.getByTestId(`resize-${ids.block}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error('resize handle has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 44, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId(`block-${ids.block}`)).toHaveAttribute('data-duration-min', '120');
});

/**
 * The snap grid is a Settings preference and the calendar obeys it: one pixel,
 * held still, reads as 9:15 on the default 15-minute grid and 9:00 on an hourly
 * one. Proving it across a navigation also proves the preference outlives the
 * screen that set it.
 */
test('agenda: the drop preview snaps to the interval chosen in Settings', async ({ page }) => {
  const email = `e2e-s17c-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('S17 User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), task: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Snap Me', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'agenda');
  await expect(page.getByTestId(`todo-${ids.task}`)).toBeVisible({ timeout: 30_000 });

  /**
   * Hold the task 7px into the 9am hour (= 9:09) and report what the outline
   * says. `hover` rather than a mouse.move to a boundingBox: the grid is often
   * scrolled out of view, and only hover scrolls to the cell before moving.
   */
  async function previewStartMin(): Promise<string | null> {
    await page.getByTestId(`todo-${ids.task}`).hover();
    await page.mouse.down();
    await page.getByTestId('cell-5-9').hover({ position: { x: 20, y: 7 } });
    const min = await page.getByTestId('drop-preview-5').getAttribute('data-start-min');
    await page.mouse.move(4, 4); // off the calendar, so the release drops nothing
    await page.mouse.up();
    return min;
  }

  // default: a quarter-hour grid rounds 9:09 up to 9:15
  await expect(page.getByTestId('drag-hint')).toContainText('snap to 15 minutes');
  expect(await previewStartMin()).toBe('195');

  await goto(page, 'settings');
  await page.getByTestId('snap-60').click();
  await expect(page.getByTestId('snap-60')).toHaveAttribute('aria-pressed', 'true');

  // hourly: the same pixel now means 9:00
  await goto(page, 'agenda');
  await expect(page.getByTestId('drag-hint')).toContainText('snap to 1 hour');
  expect(await previewStartMin()).toBe('180');

  // and a 5-minute grid keeps the minute the pointer is actually on
  await goto(page, 'settings');
  await page.getByTestId('snap-5').click();
  await goto(page, 'agenda');
  expect(await previewStartMin()).toBe('190');

  // nothing was committed by any of that — the drops all landed off-calendar
  await expect(page.getByTestId(`todo-${ids.task}`)).toBeVisible();
});
