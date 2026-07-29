/**
 * README screenshot capture — NOT part of the e2e gate.
 *
 * Unlike the other specs it cannot seed itself: the shots are only worth
 * publishing against a rich, hand-curated dataset (a week of blocks, weeks of
 * habit history, a burndown with actual slope), and some of that needs
 * backdated `created_at` values the server deliberately refuses to accept from
 * a client (R17). So it signs in to an account you prepared and skips unless
 * SHOT_CAPTURE=1, keeping `pnpm --filter @prisms/web e2e` green on any machine.
 *
 * Run:  SHOT_CAPTURE=1 pnpm --filter @prisms/web exec playwright test shots
 */
import { expect, test } from '@playwright/test';

import { goto } from './util/nav';

const EMAIL = process.env.SHOT_EMAIL ?? 'alex@prisms.test';
const PASSWORD = process.env.SHOT_PASSWORD ?? 'prisms-demo-shots-2026';
const OUT = '../../docs/screenshots';

// 1x is deliberate: GitHub renders README images at ~800 CSS px, so a 1440-wide
// capture is already ~1.8x there. deviceScaleFactor 2 tripled the repo payload
// for pixels nothing displays.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

test('capture', async ({ page }) => {
  test.skip(process.env.SHOT_CAPTURE !== '1', 'set SHOT_CAPTURE=1 to regenerate README screenshots');
  test.setTimeout(300_000);

  await page.goto('/');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();

  // wait for the replica to sync down (poll the local SQLite row count directly:
  // any given row may render inside a collapsed section, so DOM is a poor signal)
  await expect(page.getByTestId('sync-state')).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const db = (window as unknown as { __db?: { getAll: (q: string) => Promise<unknown[]> } }).__db;
          if (!db) return 0;
          const rows = (await db.getAll('SELECT count(*) AS n FROM nodes')) as { n: number }[];
          return rows[0]?.n ?? 0;
        }),
      { timeout: 90_000, intervals: [1000] },
    )
    .toBeGreaterThan(30);
  await page.waitForTimeout(4000);

  const shot = async (name: string) => {
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };

  await goto(page, 'myday');
  await shot('my-day');

  await goto(page, 'agenda');
  await shot('agenda');

  await goto(page, 'tasks');
  // expand one task's checklist so the substeps are visible in the shot
  await page
    .locator('li.px-trow', { hasText: 'Write the aggregation query layer' })
    .locator('[data-testid^="steps-toggle-"]')
    .click();
  await shot('tasks');

  await goto(page, 'projects');
  await shot('projects-board');

  // Timeline + Graph read the shared scope picker. The flowchart draws the
  // scope root's DIRECT children, so pick a project whose tasks hang straight
  // off it — "All projects" would only draw the two project boxes.
  await goto(page, 'timeline');
  await page.getByTestId('projects-scope').selectOption({ label: 'Analytics dashboard launch' });
  await shot('projects-timeline');

  await goto(page, 'graph');
  await page.getByTestId('projects-scope').selectOption({ label: 'Grow the team' });
  await page.waitForTimeout(800);
  await page.locator('.react-flow__controls-fitview').click(); // frame the whole DAG
  await shot('projects-graph');

  await goto(page, 'decisions');
  await shot('projects-decisions');

  await goto(page, 'dashboard');
  await shot('dashboard');

  await goto(page, 'habits');
  await shot('habits');

  await goto(page, 'journal');
  await shot('journal');

  await goto(page, 'automations');
  await shot('automations');
});
