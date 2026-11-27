/**
 * The account's timezone follows the device's (device-timezone.ts) — including
 * while a task is clocked in — and the change never adds or removes logged time:
 *   - the browser starts in New York (the account's default), so that is only
 *     remembered as this device's zone, and nothing moves;
 *   - with a 90-minute session running, the device moves to Los Angeles (Chrome's
 *     own timezone override, the same thing an OS change does);
 *   - the account follows: the topbar clock now reads Los Angeles;
 *   - the running timer neither jumps nor resets (elapsed is instants, not clock
 *     times), and once clocked out the session is exactly 1h 30m;
 *   - the journal day log's "All logs" lists the change, in time order, among the
 *     sessions.
 *
 * Requires the live stack (see playwright.config.ts).
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
  schema_version: 1,
});

/** "1:30:05" / "4:07" → seconds. */
const seconds = (text: string): number => text.trim().split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
const elapsed = async (page: Page) => seconds((await page.getByTestId('timer-elapsed').textContent()) ?? '');

test('the account follows the device’s timezone mid-session; logged time stays exact; All logs notes it', async ({ page }) => {
  test.setTimeout(150_000);
  // the device's zone, driven through ONE DevTools session (Chrome refuses a second
  // override while another is active, so Playwright's own `timezoneId` is not used)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Zone User');
  await page.getByTestId('email').fill(`e2e-tz-follow-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 30_000 });

  const [v, r, p, task, entry] = Array.from({ length: 5 }, () => randomUUID());
  const startedAt = new Date(Date.now() - 90 * 60_000).toISOString(); // clocked in 90 minutes ago
  const res = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: v, node_type: 'vision', title: 'V', sort_order: 'a0' }),
        cmd('node.create', { id: r, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: v }),
        cmd('node.create', { id: p, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: r }),
        cmd('node.create', { id: task, node_type: 'task', title: 'Write the report', sort_order: 'a0', parent_id: p, estimate_minutes: 180 }),
        cmd('timer.clock_in', { entry_id: entry, task_id: task, started_at: startedAt }),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();

  // ── New York: the account's zone already; the device's is only remembered ──
  const clock = page.getByTestId('now-clock');
  await expect(clock).toHaveAttribute('title', /New York/);
  await expect(page.getByTestId('timer-elapsed')).toBeVisible({ timeout: 30_000 });
  const before = await elapsed(page);
  expect(before).toBeGreaterThanOrEqual(90 * 60 - 5);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(300);
  await expect(clock).toHaveAttribute('title', /New York/); // nothing moved

  // ── the device moves to Los Angeles, mid-session ──
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // (or the next 15 s poll)
  await expect(clock).toHaveAttribute('title', /Los Angeles/, { timeout: 10_000 });

  // the running session kept counting the same seconds: no 3-hour jump, no reset
  const after = await elapsed(page);
  expect(after).toBeGreaterThanOrEqual(before);
  expect(after - before).toBeLessThan(60);

  // ── clock out: the session is exactly what was worked ──
  await page.getByTestId('timer-clock-out').click();
  await page.getByTestId('review-later').click();
  await expect(page.getByTestId('timer-elapsed')).toHaveCount(0);

  // ── the day log: All logs lists the change among the sessions ──
  await goto(page, 'journal');
  await expect(page.getByTestId('daylog-clocked')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('daylog-clock-all').click();
  const pop = page.getByTestId('daylog-clock-popup');
  await expect(pop.getByTestId(`daylog-clock-${entry}`)).toContainText('1h 30m');
  const zone = pop.locator('[data-testid^="daylog-tz-"]');
  await expect(zone).toHaveCount(1);
  await expect(zone).toContainText('Timezone changed · New York → Los Angeles');
  await expect(zone).toContainText('this device moved');
  // in time order: the change came after the session started
  const order = await pop.locator('[data-testid^="daylog-clock-"], [data-testid^="daylog-tz-"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid') ?? '').filter((id) => id !== 'daylog-clock-popup' && id !== 'daylog-clock-popup-bar' && !id.startsWith('daylog-clock-close')),
  );
  expect(order.indexOf(`daylog-clock-${entry}`)).toBeLessThan(order.findIndex((id) => id.startsWith('daylog-tz-')));
  await expect(page.getByRole('dialog')).toContainText('1 timezone change');
});
