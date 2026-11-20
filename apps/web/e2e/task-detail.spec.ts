/**
 * Task details e2e (Playwright): on Tasks, clicking a task's TITLE renames it in
 * place; clicking anywhere else on the row opens the details card. Every field
 * the card edits — details, expected completion, hours budget, location, a
 * step, a dependency, the project — reaches the server and comes back after a
 * reload.
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
  await page.locator('input[autocomplete="name"]').fill('Detail User');
  await page.getByTestId('email').fill(`e2e-task-detail-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('rename a task in place, then edit every detail in its card — all of it survives a reload', async ({ page }) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p1: randomUUID(), p2: randomUUID(), task: randomUUID(), date: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Work', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Plan', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p1, node_type: 'project', title: 'Launch', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.p2, node_type: 'project', title: 'Garden', sort_order: 'a1', parent_id: ids.r }),
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'Write the press release', sort_order: 'a0', parent_id: ids.p1, estimate_minutes: 60 }),
        cmd('node.create', { id: ids.date, node_type: 'task', title: 'Pick a date', sort_order: 'a1', parent_id: ids.p1 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await goto(page, 'tasks');
  const row = page.getByTestId(`task-row-${ids.task}`);
  await expect(row).toBeVisible({ timeout: 30_000 });

  // ── click the title: it becomes an input right there; no card opens ──
  await page.getByTestId(`title-${ids.task}`).click();
  const inline = page.getByTestId(`title-input-${ids.task}`);
  await expect(inline).toBeFocused();
  // …with a bare caret, not the whole title selected
  expect(await inline.evaluate((el: HTMLInputElement) => el.selectionStart === el.selectionEnd)).toBe(true);
  await inline.fill('Write the launch note');
  await inline.press('Enter');
  await expect(page.getByTestId(`title-${ids.task}`)).toHaveText('Write the launch note');
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  // ── a drag across the title (selecting it) that ends on the row opens nothing ──
  await page.getByTestId(`title-${ids.task}`).hover({ position: { x: 4, y: 6 } });
  await page.mouse.down();
  await row.locator('.px-t-meta').hover();
  await page.mouse.up();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);
  await expect(page.getByTestId(`title-input-${ids.task}`)).toHaveCount(0);

  // ── click elsewhere on the row: the details card ──
  await row.locator('.px-t-meta').click();
  const card = page.getByTestId('td-dialog');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('td-title')).toHaveValue('Write the launch note');
  await expect(card).toContainText('Work › Plan › Launch');
  // the page behind it is blurred like every other dialog's — in the BUILT css
  // too, whose minifier once kept only `-webkit-backdrop-filter` (theme.css)
  expect(await page.locator('.px-scrim').evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur(');
  // compact: the empty fields wait behind "+" chips (the budget is set, so it shows)
  // — except Details, which is always there, empty or not
  await expect(page.getByTestId('td-add-details')).toHaveCount(0);
  await expect(page.getByTestId('td-details')).toBeVisible();
  // a focused text field gets a light grey outline, not the accent blue
  await page.getByTestId('td-details').focus();
  expect(await page.getByTestId('td-details').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(197, 203, 214)');
  await page.getByTestId('td-details').fill('Quote the mayor. Embargo until 9am.');
  await page.getByTestId('td-add-due').click();
  await page.getByTestId('td-due').fill('2026-12-01');
  await page.getByTestId('td-hours').fill('2.5');
  await page.getByTestId('td-add-location').click();
  await page.getByTestId('td-location').fill('Studio B');
  await page.getByTestId('td-location').press('Enter');

  await page.getByTestId('td-add-steps').click();
  await page.getByTestId('td-step-add').fill('Draft the quotes');
  await page.getByTestId('td-step-add').press('Enter');
  await expect(page.getByTestId('td-steps')).toContainText('Draft the quotes');

  await page.getByTestId('td-add-deps').click();
  await page.getByTestId('td-dep-add-before').selectOption(ids.date);
  await expect(page.getByTestId('td-deps')).toContainText('Pick a date');

  await page.getByTestId('td-project').selectOption(ids.p2);
  await expect(card).toContainText('Work › Plan › Garden');

  await page.getByTestId('td-done').click();
  await expect(page.getByTestId('td-dialog')).toHaveCount(0);

  // the row shows the move and the new facts
  const moved = page.getByTestId(`project-group-${ids.p2}`).getByTestId(`task-row-${ids.task}`);
  await expect(moved).toContainText('Studio B');
  await expect(moved).toContainText('due 12-01');

  // ── the server took all of it: reload and read it back ──
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-sync', 'synced', { timeout: 30_000 });
  await page.reload();
  await goto(page, 'tasks');
  const back = page.getByTestId(`project-group-${ids.p2}`).getByTestId(`task-row-${ids.task}`);
  await expect(back).toContainText('Write the launch note', { timeout: 30_000 });
  await back.locator('.px-t-meta').click();
  await expect(page.getByTestId('td-dialog')).toBeVisible();
  await expect(page.getByTestId('td-details')).toHaveValue('Quote the mayor. Embargo until 9am.');
  await expect(page.getByTestId('td-due')).toHaveValue('2026-12-01');
  await expect(page.getByTestId('td-hours')).toHaveValue('2.5');
  await expect(page.getByTestId('td-location')).toHaveValue('Studio B');
  await expect(page.getByTestId('td-steps')).toContainText('Draft the quotes', { timeout: 30_000 });
  await expect(page.getByTestId('td-deps')).toContainText('Pick a date');
});
