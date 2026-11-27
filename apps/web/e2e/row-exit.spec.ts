/**
 * A task taken out of a list collapses away instead of vanishing (row-exit.ts):
 * a ghost copy of the row stays where it was, fades and closes, and the rows
 * below slide up rather than jump. This samples the list on every animation
 * frame to prove it moves — on My Day (checked off through the check-off popup)
 * and on Tasks (checked off from its row).
 *
 * The real row is gone at once: tests and screen readers never see the ghost
 * (no test ids, aria-hidden, inert).
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

interface Sample {
  ghosts: number;
  ghostH: number;
  ghostOp: number;
  belowY: number;
  real: number;
}

/** Sample the list on every animation frame for `ms`, starting NOW (not awaited). */
function sample(page: Page, listTestId: string, goneTestId: string, belowTestId: string, ms: number): () => Promise<Sample[]> {
  const run = page.evaluate(
    ({ listTestId, goneTestId, belowTestId, ms }) =>
      new Promise<Sample[]>((resolve) => {
        const out: Sample[] = [];
        const t0 = performance.now();
        const tick = () => {
          const list = document.querySelector(`[data-testid="${listTestId}"]`);
          const ghost = list?.querySelector<HTMLElement>('.px-row-ghost') ?? null;
          const below = document.querySelector(`[data-testid="${belowTestId}"]`);
          out.push({
            ghosts: list?.querySelectorAll('.px-row-ghost').length ?? 0,
            ghostH: ghost ? Math.round(ghost.getBoundingClientRect().height * 10) / 10 : -1,
            ghostOp: ghost ? Number(getComputedStyle(ghost).opacity) : -1,
            belowY: below ? Math.round(below.getBoundingClientRect().top * 10) / 10 : -1,
            real: document.querySelectorAll(`[data-testid="${goneTestId}"]`).length,
          });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    { listTestId, goneTestId, belowTestId, ms },
  );
  return () => run;
}

/** The ghost closed through in-between heights and the row below slid up through in-between positions. */
function expectSlid(s: Sample[], from: number, to: number): void {
  const withGhost = s.filter((x) => x.ghosts > 0);
  expect(withGhost.length).toBeGreaterThanOrEqual(2);
  // (one in-between value each is proof enough: a busy CI runner drops frames)
  const heights = [...new Set(withGhost.map((x) => x.ghostH))];
  expect(heights.filter((h) => h > 2 && h < Math.max(...heights) - 2).length).toBeGreaterThanOrEqual(1);
  expect(withGhost.some((x) => x.ghostOp > 0.05 && x.ghostOp < 0.95)).toBe(true); // fading
  const ys = [...new Set(s.map((x) => x.belowY))];
  expect(ys.filter((y) => y < from - 2 && y > to + 2).length).toBeGreaterThanOrEqual(1); // slid, not jumped
  expect(Math.max(...s.map((x) => x.ghosts))).toBe(1);
  expect(s.at(-1)!.ghosts).toBe(0); // and then gone
  expect(withGhost.every((x) => x.real === 0)).toBe(true); // the real row went at once: only the ghost is left
}

test('a task leaving a list collapses away, and the rows below slide up', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Exit User');
  await page.getByTestId('email').fill(`e2e-row-exit-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 30_000 });

  const [v, r, p, a, b, c, d] = Array.from({ length: 7 }, () => randomUUID());
  const res = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: v, node_type: 'vision', title: 'V', sort_order: 'a0' }),
        cmd('node.create', { id: r, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: v }),
        cmd('node.create', { id: p, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: r }),
        cmd('node.create', { id: a, node_type: 'task', title: 'Alpha', sort_order: 'a0', parent_id: p, estimate_minutes: 30 }),
        cmd('node.create', { id: b, node_type: 'task', title: 'Bravo', sort_order: 'a1', parent_id: p, estimate_minutes: 30 }),
        cmd('node.create', { id: c, node_type: 'task', title: 'Charlie', sort_order: 'a2', parent_id: p, estimate_minutes: 30 }),
        cmd('node.create', { id: d, node_type: 'task', title: 'Delta', sort_order: 'a3', parent_id: p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();

  // ── My Day: check Bravo off ──
  const below = page.getByTestId(`myday-row-${c}`);
  await expect(below).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`check-${b}`).click();
  await expect(page.getByTestId('checkoff-completed')).toBeVisible();
  await page.waitForTimeout(400); // let the popup settle before measuring
  const from = (await below.boundingBox())!.y;
  const done = sample(page, 'worklist', `myday-row-${b}`, `myday-row-${c}`, 900);
  await page.getByTestId('checkoff-completed').click();
  const s = await done();
  const to = (await below.boundingBox())!.y;
  expect(to).toBeLessThan(from - 20); // Charlie took Bravo's place
  expectSlid(s, from, to);

  // ── Tasks: check Charlie off from its row ──
  await goto(page, 'tasks');
  const tBelow = page.getByTestId(`task-row-${d}`);
  await expect(tBelow).toBeVisible({ timeout: 30_000 });
  const list = await tBelow.evaluate((el) => {
    const ul = el.closest('ul')!;
    ul.setAttribute('data-testid', ul.getAttribute('data-testid') ?? 'e2e-task-list');
    return ul.getAttribute('data-testid')!;
  });
  const tFrom = (await tBelow.boundingBox())!.y;
  const tDone = sample(page, list, `task-row-${c}`, `task-row-${d}`, 900);
  await page.getByTestId(`task-check-${c}`).click();
  const t = await tDone();
  const tTo = (await tBelow.boundingBox())!.y;
  expect(tTo).toBeLessThan(tFrom - 20);
  expectSlid(t, tFrom, tTo);
});
