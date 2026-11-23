/**
 * A project's pentagon wears the colour of its vision (like the ones on Tasks and
 * My Day): the one in the task details card's breadcrumb, and the status
 * pentagons ("doors") on the Roadmap's flow cards, legend and details panel.
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

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Pentagon User');
  await page.getByTestId('email').fill(`e2e-pentagon-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

const RED = 'rgb(220, 38, 38)'; // #dc2626

test('the task card’s and the roadmap’s project pentagons wear their vision’s colour', async ({ page }) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0', attributes: { color: 'red' } }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Launch plan', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Brand refresh', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Pick a palette', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();
  const style = (loc: ReturnType<Page['locator']>, prop: 'backgroundColor' | 'stroke') => loc.evaluate((el, p) => getComputedStyle(el)[p as 'stroke'], prop);

  // ── the task details card: the breadcrumb's project pentagon ──
  await goto(page, 'tasks');
  const row = page.getByTestId(`task-row-${ids.t}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator('.px-t-meta').click();
  const card = page.getByTestId('td-dialog');
  await expect(card).toBeVisible();
  expect(await style(card.locator('.px-td-crumb .px-pdot'), 'backgroundColor')).toBe(RED);
  await page.getByTestId('td-done').click();

  // ── the roadmap: a project that can start has an outlined pentagon, in the vision's colour ──
  await goto(page, 'roadmap');
  await page.getByTestId('rm-list').getByText('Launch plan').click({ timeout: 30_000 });
  const board = page.getByTestId('rf');
  await expect(board).toHaveClass(/px-rb--vc/);
  const ready = board.locator('.px-rf-door--ready polygon');
  await expect(ready.first()).toBeVisible();
  expect(await style(ready.first(), 'stroke')).toBe(RED); // the card's, and the legend's, share it
  expect(await style(board.locator('.px-rf-door--ready polygon').last(), 'stroke')).toBe(RED);

  // ── the vision's colour chip is a pentagon too (not a rounded square), in the vision's colour ──
  const swatch = page.getByTestId('rm-vision-swatch');
  await expect(swatch).toBeVisible();
  expect(await style(swatch, 'backgroundColor')).toBe(RED);
  expect(await swatch.evaluate((el) => getComputedStyle(el).clipPath)).toContain('polygon(');
});
