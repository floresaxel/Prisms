/**
 * The topbar timer pill is animated as one thing (GlobalTimer.tsx, `.px-timer-pill`),
 * and this samples it on every animation frame to prove it MOVES instead of jumping:
 *   - it GROWS in when a timer starts, and SHRINKS away when the last one stops;
 *   - its width follows its content (a second timer adds "+1" and "Clock out all");
 *   - its colour eases blue → amber when a break begins, amber → red when it runs over;
 *   - switching running ⇄ break crossfades, and never shows two Clock-out buttons (the
 *     outgoing "ghost" has no test ids);
 *   - Resume goes straight from the break to the running timers — the pill does not
 *     shrink away and grow back in the moment between.
 * Reduced-motion users skip all of it, so this pins the default.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

interface Sample {
  w: number;
  op: number;
  bg: string;
  id: string;
  clockOuts: number;
}

/** Sample the pill on every animation frame for `ms`, starting NOW (not awaited). */
function sample(page: Page, ms: number): () => Promise<Sample[]> {
  const run = page.evaluate(
    (ms) =>
      new Promise<Sample[]>((resolve) => {
        const out: Sample[] = [];
        const t0 = performance.now();
        const tick = () => {
          const pill = document.querySelector('.px-timer-pill') as HTMLElement | null;
          if (pill) {
            const cs = getComputedStyle(pill);
            out.push({
              w: Math.round(pill.getBoundingClientRect().width * 10) / 10,
              op: Number(cs.opacity),
              bg: cs.backgroundColor,
              id: pill.getAttribute('data-testid') ?? '',
              clockOuts: document.querySelectorAll('[data-testid=timer-clock-out]').length,
            });
          } else out.push({ w: -1, op: -1, bg: '', id: '', clockOuts: 0 });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
  return () => run;
}

const distinct = <T,>(xs: T[]) => [...new Set(xs)];
const between = (xs: number[], lo: number, hi: number) => xs.filter((x) => x > lo + 2 && x < hi - 2);

test('the topbar pill grows, changes colour, crossfades and shrinks — it never jumps', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Pill User');
  await page.getByTestId('email').fill(`e2e-pill-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), a: randomUUID(), b: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'V', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.a, node_type: 'task', title: 'Answer email', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
        cmd('node.create', { id: ids.b, node_type: 'task', title: 'Write the quarterly report', sort_order: 'a1', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByTestId(`clock-in-${ids.b}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.px-timer-pill')).toHaveCount(0);

  // ── appears: grows in, fading up ──
  let done = sample(page, 700);
  await page.getByTestId(`clock-in-${ids.a}`).click();
  let s = (await done()).filter((x) => x.id);
  const full = Math.max(...s.map((x) => x.w));
  expect(between(s.map((x) => x.w), 0, full).length).toBeGreaterThanOrEqual(2); // grew through in-between widths
  expect(s.some((x) => x.op > 0.05 && x.op < 0.95)).toBe(true); // …fading up
  await expect(page.getByTestId('running-timer')).toHaveAttribute('data-shown', 'true');

  // ── a second timer: its width follows ("+1", "Clock out all", a longer name) ──
  const one = (await page.locator('.px-timer-pill').boundingBox())!.width;
  done = sample(page, 700);
  await page.getByTestId(`clock-in-${ids.b}`).click();
  await page.getByTestId('clockin-split').click();
  s = await done();
  const two = Math.max(...s.map((x) => x.w));
  expect(two).toBeGreaterThan(one + 20);
  expect(between(s.map((x) => x.w), one, two).length).toBeGreaterThanOrEqual(2);

  // ── a break: blue → amber, crossfading, never two Clock out buttons ──
  await page.getByTestId('timer-clock-out').click();
  await page.getByTestId('review-break').click();
  await page.waitForTimeout(350); // the picker's own unfold
  done = sample(page, 900);
  await page.getByTestId('break-start').click();
  s = await done();
  expect(s.map((x) => x.id)).toContain('break-pill');
  expect(distinct(s.filter((x) => x.bg).map((x) => x.bg)).length).toBeGreaterThanOrEqual(4); // eased, not switched
  expect(Math.max(...s.map((x) => x.clockOuts))).toBeLessThanOrEqual(1); // the outgoing ghost has no test ids
  await expect(page.getByTestId('break-pill')).toBeVisible();
  const breakWidth = (await page.locator('.px-timer-pill').boundingBox())!.width;

  // ── over time: amber → red ──
  done = sample(page, 700);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('prisms.break.'))!;
    const br = JSON.parse(localStorage.getItem(key)!);
    br.startedAt -= (br.minutes * 60 + 20) * 1000;
    localStorage.setItem(key, JSON.stringify(br));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  s = await done();
  expect(distinct(s.map((x) => x.bg)).length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('break-pill')).toHaveClass(/px-break-pill--over/);

  // ── resume (from the "break is over" prompt): break → running with NO gap in between ──
  done = sample(page, 1000);
  await page.getByTestId('break-prompt-resume').click();
  s = await done();
  expect(s.map((x) => x.id)).toContain('running-timer');
  expect(s.filter((x) => x.op >= 0 && x.op < 0.5)).toHaveLength(0); // never faded out
  expect(Math.min(...s.filter((x) => x.w > 0).map((x) => x.w))).toBeGreaterThan(breakWidth * 0.8); // never shrank away
  expect(Math.max(...s.map((x) => x.clockOuts))).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('running-timer')).toBeVisible();

  // ── disappears: shrinks away once the last timer stops ──
  await page.getByTestId('timer-clock-out').click();
  await expect(page.getByTestId('review-later')).toBeVisible();
  done = sample(page, 1000);
  await page.getByTestId('review-later').click();
  await page.getByTestId('review-later').click(); // the second timer's review
  s = await done();
  const gone = s.filter((x) => x.w > 0);
  const start = gone[0]!.w;
  expect(between(gone.map((x) => x.w), 3, start).length).toBeGreaterThanOrEqual(2); // shrank through in-between widths
  await expect(page.locator('.px-timer-pill')).toHaveCount(0, { timeout: 5000 });
});
