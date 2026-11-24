/**
 * Breaks (Timers.tsx + break.ts) against the live stack: "Take a break" in the
 * clock-out review stops every running timer for 5–30 min (slider in steps of 5);
 * the topbar and My Day count it down and Clock in is off; with a minute left a
 * prompt (listing the tasks) offers to clock back in, and its countdown goes
 * negative past the end; 10 min past the end the break closes by itself with
 * nothing clocked in. Each break is recorded (`breaks`) and shown as an event in
 * the journal's day log — never written into the note's text.
 *
 * Time is moved by ageing the saved break (its start, in localStorage) — the app
 * reads it like any other tab's change.
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

import { goto } from './util/nav';

test.setTimeout(240_000);

const DB_URL = process.env.PRISMS_DB_TEST_URL ?? 'postgresql://prisms:prisms_dev_password@localhost:5434/prisms';
let seq = 0;
const cmd = (name: string, payload: unknown) => ({ id: randomUUID(), name, hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`, payload, schema_version: 1 });

/** Move the running break's start back by `ms` (as if that much time had passed) and tell the app. */
async function age(page: Page, ms: number): Promise<string> {
  return page.evaluate((by) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('prisms.break.'))!;
    const b = JSON.parse(localStorage.getItem(key)!);
    b.startedAt -= by;
    localStorage.setItem(key, JSON.stringify(b));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    return key.slice('prisms.break.'.length);
  }, ms);
}

test('take a break from the clock-out review, get asked back, and it is logged', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Break User');
  await page.getByTestId('email').fill(`e2e-break-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'V', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.a, node_type: 'task', title: 'Alpha Task', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.b, node_type: 'task', title: 'Beta Task', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.c, node_type: 'task', title: 'Gamma Task', sort_order: 'a2', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByTestId(`myday-row-${ids.b}`)).toBeVisible({ timeout: 30_000 });

  // two timers (split focus)
  await page.getByTestId(`clock-in-${ids.a}`).click();
  await expect(page.getByTestId('run-banner')).toHaveCount(1);
  await page.getByTestId(`clock-in-${ids.b}`).click();
  await page.getByTestId('clockin-split').click();
  await expect(page.getByTestId('run-banner')).toHaveCount(2);

  // Clock out all → the review → Take a break → the slider
  await page.getByTestId('timer-clock-out').click();
  await expect(page.getByTestId('review-save')).toBeVisible();
  await expect(page.getByTestId('break-picker')).toBeHidden(); // folded shut until Take a break
  // Take a break GROWS open (the card grows with it) rather than popping in: sampled on
  // every animation frame, the picker's height passes through values between 0 and its
  // full height. (Reduced-motion users skip the animation, so this pins the default.)
  const heights = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          out.push(document.querySelector('[data-testid=break-unfold]')!.getBoundingClientRect().height);
          if (performance.now() - t0 < 600) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.getByTestId('review-break').click();
  const sampled = await heights;
  const full = Math.max(...sampled);
  expect(full).toBeGreaterThan(100);
  expect(sampled.filter((h) => h > 2 && h < full - 2).length).toBeGreaterThanOrEqual(2);
  const slider = page.getByTestId('break-minutes');
  await expect(slider).toHaveAttribute('min', '5');
  await expect(slider).toHaveAttribute('max', '30');
  await expect(slider).toHaveAttribute('step', '5');
  await expect(page.getByTestId('break-minutes-label')).toHaveText('15 min');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('break-minutes-label')).toHaveText('20 min'); // jumps by 5
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('break-minutes-label')).toHaveText('5 min');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('break-minutes-label')).toHaveText('5 min'); // floor
  await expect(page.getByTestId('break-picker')).toContainText('Alpha Task');
  await expect(page.getByTestId('break-picker')).toContainText('Beta Task');
  await page.getByTestId('break-start').click();

  // on the break: both stopped, countdown in the topbar and on My Day, clock-in off
  await expect(page.getByTestId('review-save')).toHaveCount(0);
  await expect(page.getByTestId('run-banner')).toHaveCount(0);
  await expect(page.getByTestId('running-timer')).toHaveCount(0);
  await expect(page.getByTestId('break-pill')).toBeVisible();
  await expect(page.getByTestId('break-countdown')).toHaveText(/^[45]:\d\d$/);
  await expect(page.getByTestId('myday-break')).toContainText('Alpha Task');
  await expect(page.getByTestId('myday-break-countdown')).toHaveText(/^[45]:\d\d$/);
  const c = page.getByTestId(`clock-in-${ids.c}`);
  await expect(c).toBeDisabled();
  await expect(c).toHaveAttribute('title', /on a break/);

  // nothing is clocked in on the server either
  const sql = postgres(DB_URL, { max: 1 });
  try {
    const userId = await age(page, 0);
    const open = await sql`SELECT count(*)::int AS n FROM time_entries WHERE user_id = ${userId} AND ended_at IS NULL`;
    expect(open[0]!['n']).toBe(0);

    // a reload keeps the break
    await page.reload();
    await expect(page.getByTestId('break-pill')).toBeVisible({ timeout: 30_000 });

    // 4 min in: one minute left → the prompt, once, listing both tasks
    await age(page, 4 * 60_000 + 5_000);
    await expect(page.getByTestId('break-prompt')).toBeVisible();
    await expect(page.getByTestId('break-prompt-countdown')).toHaveText(/^0:[0-5]\d$/);
    await expect(page.getByTestId(`break-prompt-task-${ids.a}`)).toHaveText('Alpha Task');
    await expect(page.getByTestId(`break-prompt-task-${ids.b}`)).toHaveText('Beta Task');

    // past the end: the prompt's countdown goes negative, the pill turns red
    await age(page, 2 * 60_000);
    await expect(page.getByTestId('break-prompt-countdown')).toHaveText(/^-1:\d\d$/);
    await expect(page.getByTestId('break-countdown')).toHaveText(/^-1:\d\d$/);
    await expect(page.getByTestId('break-pill')).toHaveClass(/px-break-pill--over/);

    // Clock back in → both tasks running again
    await page.getByTestId('break-prompt-resume').click();
    await expect(page.getByTestId('break-pill')).toHaveCount(0);
    await expect(page.getByTestId('myday-break')).toHaveCount(0);
    await expect(page.getByTestId('run-banner')).toHaveCount(2);
    await expect(page.getByTestId(`clock-in-${ids.c}`)).toBeEnabled();
    await expect
      .poll(async () => (await sql`SELECT task_id FROM time_entries WHERE user_id = ${userId} AND ended_at IS NULL ORDER BY task_id`).map((r) => r['task_id']), { timeout: 20_000 })
      .toEqual([ids.a, ids.b].sort());
    // recorded as a break: ~6 min (5 planned + ~1 over) — and NOT as note text
    const breakMinutes = async () =>
      (await sql`SELECT round(extract(epoch FROM ended_at - started_at) / 60)::int AS m, planned_minutes AS p FROM breaks WHERE user_id = ${userId} AND deleted_at IS NULL ORDER BY started_at`).map((r) => `m${r['m']}/p${r['p']}`);
    await expect.poll(breakMinutes, { timeout: 20_000 }).toEqual(['m6/p5']);
    expect((await sql`SELECT count(*)::int AS n FROM journal_entries WHERE user_id = ${userId}`)[0]!['n']).toBe(0);

    // ── a second break that runs 10+ min over closes by itself, nothing clocked back in ──
    await page.getByTestId('timer-clock-out').click();
    await page.getByTestId('review-break').click();
    await page.getByTestId('break-minutes').focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('break-minutes-label')).toHaveText('5 min');
    await page.getByTestId('break-start').click();
    await expect(page.getByTestId('break-pill')).toBeVisible();
    await age(page, 4 * 60_000 + 10_000);
    await expect(page.getByTestId('break-prompt')).toBeVisible();
    await age(page, 11 * 60_000); // 10 min past the end
    await expect(page.getByTestId('break-prompt')).toHaveCount(0);
    await expect(page.getByTestId('break-pill')).toHaveCount(0);
    await expect(page.getByTestId('myday-break')).toHaveCount(0);
    await expect(page.getByTestId('run-banner')).toHaveCount(0);
    // the second break started earlier (it was aged further), so it lists first; capped at 5 + 10 min
    await expect.poll(breakMinutes, { timeout: 20_000 }).toEqual(['m15/p5', 'm6/p5']);
    expect((await sql`SELECT count(*)::int AS n FROM journal_entries WHERE user_id = ${userId}`)[0]!['n']).toBe(0);

    // ── the journal's day log shows both as events; the note itself stays empty ──
    await goto(page, 'journal');
    const breaks = page.getByTestId('daylog-breaks');
    await expect(breaks).toBeVisible({ timeout: 30_000 });
    await expect(breaks.locator('[data-testid^="daylog-break-"]').filter({ hasText: 'Break' })).toHaveCount(2);
    await expect(page.getByTestId('daylog-breaks-total')).toHaveText('21m');
    await expect(breaks).toContainText('10m over the 5m planned');
    await expect(breaks).toContainText('1m over the 5m planned');
    await expect(page.getByTestId('daylog')).not.toContainText('☕');
    const open2 = await sql`SELECT count(*)::int AS n FROM time_entries WHERE user_id = ${userId} AND ended_at IS NULL`;
    expect(open2[0]!['n']).toBe(0);
  } finally {
    await sql.end();
  }
});
