/**
 * Boot as the remembered account, ask the server after (load plan, phase 3).
 *
 * The app now renders the last signed-in account straight from its local
 * database and checks the session in the background. These prove the three
 * things that makes true — and the two it must never cost:
 *   1. a reload shows local data while the session check is still unanswered,
 *      and NOTHING syncs (no PowerSync token, no upload) until it answers;
 *   2. a session that has ended sends the shell to the sign-in form and forgets
 *      the account, without a single sync attempt;
 *   3. if another account signed in on this browser meanwhile, the app switches
 *      to it — and the first account's queued change is never offered to the
 *      server under the second account's session.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

const PASSWORD = 'e2e-password-123';

async function register(page: Page, tag: string): Promise<string> {
  const email = `e2e-boot-${tag}-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Boot User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();
  return email;
}

/** A vision → roadmap → project → task tree (I3); returns the task id. */
async function seedTask(page: Page, title: string): Promise<string> {
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID(), t: randomUUID() };
  const res = await page.request.post('/sync/upload', {
    data: {
      device_id: 'e2e-seed',
      commands: [
        cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
        cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
        cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
        cmd('node.create', { id: ids.t, node_type: 'task', title, sort_order: 'a0', parent_id: ids.p, estimate_minutes: 30 }),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  return ids.t;
}

/** Every request that means "this page is syncing": the PowerSync token, and command uploads. */
function watchSyncRequests(context: BrowserContext): string[] {
  const seen: string[] = [];
  context.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/powersync/token') || (url.includes('/sync/upload') && r.method() === 'POST')) seen.push(url);
  });
  return seen;
}

test('a reload shows local data before the session check answers — and syncs only once it has', async ({ page, context }) => {
  await register(page, 'slow');
  await seedTask(page, 'Boot Task');
  await expect(page.getByText('Boot Task')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });

  // Hold the session check for as long as this test likes.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/api/auth/get-session', async (route) => {
    await held;
    await route.continue();
  });
  const syncing = watchSyncRequests(context);

  await page.reload();
  // the task is on screen from the local database, the check still unanswered…
  await expect(page.getByText('Boot Task')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-sync', 'connecting');
  // …and nothing has tried to sync: this device's queue waits for the server to say whose it is
  expect(syncing).toEqual([]);

  release();
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });
  expect(syncing.some((u) => u.includes('/api/powersync/token'))).toBe(true);
  await context.unroute('**/api/auth/get-session');
});

test('a session that has ended: the shell gives way to sign-in, the account is forgotten, nothing syncs', async ({ page, context }) => {
  await register(page, 'ended');
  await seedTask(page, 'Ended Task');
  await expect(page.getByText('Ended Task')).toBeVisible({ timeout: 30_000 });

  // The server no longer knows this browser (expired, revoked): drop the cookie.
  await context.clearCookies();
  const syncing = watchSyncRequests(context);

  await page.reload();
  await expect(page.getByTestId('submit')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Ended Task')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('prisms.user'))).toBeNull();
  expect(syncing).toEqual([]);
});

test('another account signed in meanwhile: the app switches to it and never offers it the first account’s queue', async ({
  page,
  context,
  baseURL,
}) => {
  await register(page, 'switch-a');
  const taskId = await seedTask(page, 'A Task');
  const row = page.getByTestId(`myday-row-${taskId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });

  // From here every upload the page attempts is recorded and refused, so a
  // change stays queued on this device — in A's queue — and anything offered to
  // the server later is caught even though nothing actually lands.
  const attempted: string[] = [];
  await context.route('**/sync/upload', async (route) => {
    if (route.request().method() === 'POST') attempted.push(route.request().postData() ?? '');
    await route.abort();
  });

  await row.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByTestId('running-timer')).toBeVisible();
  const queued = await page.evaluate(async () => {
    const db = (window as unknown as { __db: { getAll<T>(sql: string): Promise<T[]> } }).__db;
    return (await db.getAll<{ id: string }>("SELECT id FROM client_commands WHERE status = 'pending'")).map((r) => r.id);
  });
  expect(queued.length).toBeGreaterThan(0);
  // the capture works: A's own app did try to send it, under A's session
  await expect.poll(() => attempted.some((body) => queued.some((id) => body.includes(id)))).toBe(true);

  // B signs in on this browser (another tab, say): the session cookie is B's now,
  // while this tab still remembers A.
  const emailB = `e2e-boot-switch-b-${Date.now()}@prisms.test`;
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    data: { name: 'Boot B', email: emailB, password: PASSWORD },
    headers: { origin: new URL(baseURL!).origin },
  });
  expect(signUp.ok()).toBeTruthy();

  attempted.length = 0;
  await page.reload();

  // the app follows the server: B's account, B in the shell, none of A's rows or timer
  await expect(page.getByText(emailB)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });
  await expect(page.getByText('A Task')).toHaveCount(0);
  await expect(page.getByTestId('running-timer')).toHaveCount(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('prisms.user') ?? 'null') as { email?: string } | null)?.email)).toBe(emailB);

  // and not one of A's queued commands was offered to the server under B's session
  for (const body of attempted) for (const id of queued) expect(body).not.toContain(id);
  await context.unroute('**/sync/upload');
});
