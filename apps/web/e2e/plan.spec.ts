/**
 * Plan section e2e — the two levels above Projects now have their own screens
 * (Plan › Vision, Plan › Roadmap), and each is where that level is managed
 * individually:
 *   - a vision's name, description, colour and dateless timeline are all
 *     editable AFTER creation (previously they could only be set in the create
 *     dialog), and each edit survives a reload — i.e. the server took it, the
 *     overlay did not roll back;
 *   - a roadmap is created, filled with a project, and re-homed under another
 *     vision, which re-tints it;
 *   - the Roadmap tab is gone from the Projects hub, and the old
 *     `/projects#roadmap` deep link redirects to the new route.
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
  schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor rejection)
});

async function register(page: Page, tag: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Plan User');
  await page.getByTestId('email').fill(`e2e-plan-${tag}-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

/** A rejected command rolls the overlay back — so nothing may land in the toast. */
async function expectNoRejection(page: Page): Promise<void> {
  await expect(page.getByTestId('rejection-toast')).toHaveCount(0);
}

test('Plan › Vision manages one vision at a time: create, rename, re-colour, re-time, describe', async ({ page }) => {
  await register(page, 'vision');
  const ids = { v: randomUUID(), r: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', {
          id: ids.v,
          node_type: 'vision',
          title: 'Build a company',
          sort_order: 'a0',
          description: 'the original description',
          attributes: { color: 'blue', horizon: { unit: 'years', amount: 3 } },
        }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'First roadmap', sort_order: 'a0', parent_id: ids.v }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // --- the nav item exists, in the Plan group, ABOVE Projects ---
  await goto(page, 'vision');
  await expect(page.getByTestId('vis-detail')).toHaveAttribute('data-vision', ids.v, { timeout: 30_000 });
  await expect(page.getByTestId('vis-title')).toHaveValue('Build a company');
  await expect(page.getByTestId('vis-color')).toHaveText('Blue');
  await expect(page.getByTestId('vis-edit-horizon')).toHaveText('3 years');

  // --- rename ---
  await page.getByTestId('vis-title').fill('Build a studio');
  await page.getByTestId('vis-title').press('Enter');

  // --- describe (saved on blur) ---
  await page.getByTestId('vis-description').fill('A studio that ships one good thing a year.');
  await page.getByTestId('vis-title').click(); // blur the textarea

  // --- re-colour: the swatch a vision wears is content, editable after creation ---
  await page.getByTestId('vis-edit-swatch-emerald').click();
  await expect(page.getByTestId('vis-color')).toHaveText('Emerald');

  // --- re-time: a unit switch re-seeds the amount to that unit's first preset ---
  await page.getByTestId('vis-edit-unit-months').click();
  await expect(page.getByTestId('vis-edit-horizon')).toHaveText('3 months');
  await page.getByTestId('vis-edit-preset-9').click();
  await expect(page.getByTestId('vis-edit-horizon')).toHaveText('9 months');

  await expectNoRejection(page);

  // --- all four survive a reload: the server took them, nothing rolled back ---
  await page.reload();
  await expect(page.getByTestId('vis-title')).toHaveValue('Build a studio', { timeout: 30_000 });
  await expect(page.getByTestId('vis-description')).toHaveValue('A studio that ships one good thing a year.');
  await expect(page.getByTestId('vis-color')).toHaveText('Emerald');
  await expect(page.getByTestId('vis-edit-horizon')).toHaveText('9 months');

  // --- the create dialog still creates from here, and the new vision is selected ---
  await expect(page.getByTestId('vis-count')).toHaveText('1 of 10');
  await page.getByTestId('vis-new').click();
  await page.getByTestId('vision-dialog-title').fill('Stay healthy');
  await page.getByTestId('vision-dialog-description').fill('Move every day.');
  await page.getByTestId('vision-dialog-unit-decades').click();
  await page.getByTestId('vision-dialog-create').click();
  await expect(page.getByTestId('vis-count')).toHaveText('2 of 10');
  await expect(page.getByTestId('vis-title')).toHaveValue('Stay healthy');
  await expect(page.getByTestId('vis-no-roadmaps')).toBeVisible(); // brand new: nothing under it yet

  // --- a vision's roadmap chip hands the roadmap over to Plan › Roadmap ---
  await page.getByTestId(`vis-item-${ids.v}`).click();
  await page.getByTestId(`vis-roadmap-${ids.r}`).click();
  await expect(page).toHaveURL(new RegExp(`/roadmap#${ids.r}$`));
  await expect(page.getByTestId('rm-detail')).toHaveAttribute('data-roadmap', ids.r);
  await expectNoRejection(page);
});

test('Plan › Roadmap manages one roadmap at a time: create, fill, re-home under another vision', async ({ page }) => {
  await register(page, 'roadmap');
  const ids = { work: randomUUID(), side: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.work, node_type: 'vision', title: 'Work', sort_order: 'a0', attributes: { color: 'blue' } }),
        cmd('node.create', { id: ids.side, node_type: 'vision', title: 'Side', sort_order: 'a1', attributes: { color: 'amber' } }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  // --- with no roadmap yet, the screen offers to make one rather than dead-end ---
  await goto(page, 'roadmap');
  await expect(page.getByTestId('roadmap-empty')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('rm-new-roadmap-title').fill('Ship v1');
  await page.getByTestId('rm-roadmap-vision').selectOption({ label: 'Work' });
  await page.getByTestId('rm-create-roadmap').click();

  const detail = page.getByTestId('rm-detail');
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('rm-title')).toHaveValue('Ship v1');
  await expect(page.getByTestId('rm-vision')).toHaveValue(ids.work);
  await expect(page.getByTestId('rm-no-projects')).toBeVisible();

  // --- a project added here lands under the roadmap, in the graph ---
  await page.getByTestId('rm-new-project-title').fill('Landing page');
  await page.getByTestId('rm-add-project').click();
  await expect(page.getByTestId('rm-project-count')).toHaveText('1 project');
  await expect(page.getByTestId('roadmap-canvas').getByText('Landing page')).toBeVisible();

  // --- describe + rename ---
  await page.getByTestId('rm-description').fill('Everything the first release needs.');
  await page.getByTestId('rm-title').click();
  await page.getByTestId('rm-title').fill('Ship v1.0');
  await page.getByTestId('rm-title').press('Enter');

  // --- re-home under the other vision: I1 keeps the parent a vision, and the
  //     roadmap re-tints because colour comes from whichever vision owns it ---
  await page.getByTestId('rm-vision').selectOption(ids.side);
  await expect(page.getByTestId('rm-vision-swatch')).toHaveAttribute('data-color', 'amber');
  await expectNoRejection(page);

  await page.reload();
  await expect(page.getByTestId('rm-title')).toHaveValue('Ship v1.0', { timeout: 30_000 });
  await expect(page.getByTestId('rm-description')).toHaveValue('Everything the first release needs.');
  await expect(page.getByTestId('rm-vision')).toHaveValue(ids.side);
  await expect(page.getByTestId('rm-project-count')).toHaveText('1 project');

  // --- the old deep link follows the tab to its new route. A COLD load (a
  //     different pathname), the way a bookmark arrives: the redirect runs at
  //     boot, so a same-document hash change would never trigger it ---
  await page.goto('/projects#roadmap');
  await expect(page).toHaveURL(/\/roadmap$/);
  await expect(page.getByTestId('rm-detail')).toBeVisible({ timeout: 30_000 });

  // --- and the hub it left no longer carries the tab ---
  await goto(page, 'projects');
  await expect(page.getByTestId('tab-roadmap')).toHaveCount(0);
  await expect(page.getByTestId('tab-board')).toBeVisible();

  // --- delete takes the subtree with it, and says so first ---
  await goto(page, 'roadmap');
  page.once('dialog', (d) => {
    expect(d.message()).toContain('1 project');
    void d.accept();
  });
  await page.getByTestId('rm-delete').click();
  await expect(page.getByTestId('roadmap-empty')).toBeVisible();
  await expectNoRejection(page);
});
