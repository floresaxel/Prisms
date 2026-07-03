/**
 * M13 DoD e2e (Playwright) — import/export through the Settings UI (§13.1):
 *   - export downloads a passphrase-ENCRYPTED prisms-export file;
 *   - re-importing it needs the passphrase (a wrong/blank one is rejected);
 *   - the dry-run preview reports the collisions with the already-present rows;
 *   - restore runs (LWW keeps the identical rows) and reports back.
 *
 * The full server-side restore-after-loss + monotonicity contracts are proven in
 * apps/server/test/m13-portability.integration.test.ts; this drives the browser
 * surface end-to-end. Requires the live stack (see playwright.config.ts).
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor rejection)
});

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('M13 User');
  await page.getByTestId('email').fill(`e2e-m13-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
}

test('encrypted export downloads, re-imports with the passphrase, and restores', async ({ page }) => {
  await register(page);
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const seed = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title: 'Task One', sort_order: 'a0', parent_id: ids.p, estimate_minutes: 60 }),
      ],
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('portability')).toBeVisible();
  // let the seed sync down so the export includes it
  await page.getByRole('link', { name: 'Worklist' }).click();
  await expect(page.getByText('Task One')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Settings' }).click();

  // --- DoD: encrypted export downloads ---
  await page.getByTestId('export-passphrase').fill('backup-pass-123');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-download').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.enc\.json$/);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  const envelope = JSON.parse(text) as { format: string; ciphertext?: string };
  expect(envelope.format).toBe('prisms-export-enc');
  expect(text).not.toContain('Task One'); // encrypted at rest
  await expect(page.getByTestId('portability-status')).toContainText('encrypted');

  // --- DoD: re-import needs the passphrase ---
  await page.getByTestId('import-file').setInputFiles({ name: 'prisms-export.enc.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.getByTestId('import-validate').click();
  await expect(page.getByTestId('portability-status')).toContainText(/passphrase/i);

  // with the passphrase, the dry-run reports collisions against the present rows
  await page.getByTestId('import-passphrase').fill('backup-pass-123');
  await page.getByTestId('import-validate').click();
  await expect(page.getByTestId('import-report')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('import-conflicts')).not.toHaveText('0');

  // --- DoD: restore runs (LWW keeps the identical rows) and reports back ---
  await page.getByTestId('import-restore').click();
  await expect(page.getByTestId('portability-status')).toContainText(/Restored|conflict/i, { timeout: 15_000 });
});
