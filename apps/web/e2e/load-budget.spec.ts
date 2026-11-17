/**
 * Load budgets (load plan, phase 5): the work that took a reload from 1.5 s on
 * the dev server (8.2 s on its first load) to well under a second stays done.
 *
 * Two kinds of check, because they fail for different reasons:
 *   - SIZE budgets are deterministic: they read the built files and fail the
 *     moment a change re-imports a screen eagerly, pulls a heavy library into
 *     the startup chunk, or puts the unused SQLite builds back in the precache.
 *   - The TIME budget is the goal itself: data on screen within 1 s of a reload.
 *     It is the median of five reloads, so one slow frame on a busy runner does
 *     not fail CI; every reload's time is logged either way.
 *
 * Budgets apply to the BUILT app (vite preview, as CI runs it). Against the dev
 * server — unbundled, compiled on demand — both kinds are skipped.
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/** The startup chunk, raw bytes. 722 KB at phase 4; 1.76 MB before it. */
const STARTUP_CHUNK_BUDGET = 900_000;
/** Everything the service worker precaches. 4.6 MB at phase 4; 9.8 MB before it. */
const PRECACHE_BUDGET = 6_000_000;
/** Reload → first My Day row, median of five. ~0.3–0.65 s locally at phase 4. */
const RELOAD_TO_DATA_BUDGET_MS = 1_000;
/**
 * Names that only the libraries phase 4 moved out of the startup chunk carry —
 * the journal editor, the graph library, the markdown renderer. Present in the
 * single-chunk build, absent since.
 */
const DEFERRED_LIBRARY_MARKERS = ['ProseMirror', 'react-flow__', 'micromark'];

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-e2e`,
  payload,
  schema_version: 1,
});

/** Skip on the dev server: its index.html loads the Vite client, not a bundle. */
async function skipUnlessBuilt(page: Page): Promise<string> {
  const html = await (await page.request.get('/')).text();
  test.skip(html.includes('/@vite/client'), 'load budgets apply to the built app (vite preview), not the dev server');
  return html;
}

test('size budgets: a small startup chunk without the deferred libraries, and a lean precache', async ({ page }) => {
  const html = await skipUnlessBuilt(page);

  const src = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
  expect(src, 'index.html names its startup chunk').toBeTruthy();
  const startup = (await (await page.request.get(src!)).body()).toString('utf8');
  test.info().annotations.push({ type: 'startup chunk', description: `${startup.length} bytes (budget ${STARTUP_CHUNK_BUDGET})` });
  expect(startup.length, `startup chunk ${src} is over budget`).toBeLessThanOrEqual(STARTUP_CHUNK_BUDGET);
  for (const marker of DEFERRED_LIBRARY_MARKERS) {
    expect(startup.includes(marker), `"${marker}" is back in the startup chunk — a screen or its library is imported eagerly`).toBe(false);
  }

  // The service worker's precache manifest is inlined in sw.js as {url:"…",revision:…}.
  const sw = await (await page.request.get('/sw.js')).text();
  const urls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThan(0);
  let precached = 0;
  for (const url of urls) precached += (await (await page.request.get(`/${url.replace(/^\//, '')}`)).body()).length;
  test.info().annotations.push({ type: 'precache', description: `${precached} bytes in ${urls.length} files (budget ${PRECACHE_BUDGET})` });
  expect(precached, 'the service-worker precache is over budget').toBeLessThanOrEqual(PRECACHE_BUDGET);
});

test(`time budget: My Day shows data within ${RELOAD_TO_DATA_BUDGET_MS} ms of a reload`, async ({ page, context }) => {
  await skipUnlessBuilt(page);
  test.setTimeout(120_000);

  // Mark, in each new document, the moment the first My Day row exists —
  // performance.now() counts from that document's navigation start.
  await context.addInitScript(() => {
    const w = window as unknown as { __firstRowAt?: number };
    const check = () => {
      if (w.__firstRowAt === undefined && document.querySelector('[data-testid^="myday-row-"]')) w.__firstRowAt = performance.now();
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Budget User');
  await page.getByTestId('email').fill(`e2e-budget-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  // A realistic small account: a vision → roadmap → project tree with 30 tasks.
  const ids = { v: randomUUID(), r: randomUUID(), p: randomUUID() };
  const commands = [
    cmd('node.create', { id: ids.v, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
    cmd('node.create', { id: ids.r, node_type: 'roadmap', title: 'Roadmap', sort_order: 'a0', parent_id: ids.v }),
    cmd('node.create', { id: ids.p, node_type: 'project', title: 'Project', sort_order: 'a0', parent_id: ids.r }),
  ];
  for (let i = 0; i < 30; i += 1) {
    commands.push(cmd('node.create', { id: randomUUID(), node_type: 'task', title: `Budget task ${i}`, sort_order: `a${String(i).padStart(2, '0')}`, parent_id: ids.p, estimate_minutes: 30 }));
  }
  const seed = await page.request.post('/sync/upload', { data: { device_id: 'e2e-seed', commands } });
  expect(seed.ok()).toBeTruthy();
  await expect(page.getByTestId('worklist').getByText('Budget task 0')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('synced', { timeout: 30_000 });
  // Measure the steady state: the shell served by an active service worker.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });

  const times: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __firstRowAt?: number }).__firstRowAt !== undefined, null, { timeout: 30_000 });
    times.push(Math.round(await page.evaluate(() => (window as unknown as { __firstRowAt: number }).__firstRowAt)));
  }
  const counted = times.slice(1); // the first reload warms caches the rest share
  const median = [...counted].sort((a, b) => a - b)[Math.floor(counted.length / 2)]!;
  const summary = `reload → first My Day row: median ${median} ms of [${counted.join(', ')}] ms (warm-up ${times[0]} ms; budget ${RELOAD_TO_DATA_BUDGET_MS} ms)`;
  test.info().annotations.push({ type: 'load time', description: summary });
  console.log(`[load-budget] ${summary}`);
  expect(median, summary).toBeLessThanOrEqual(RELOAD_TO_DATA_BUDGET_MS);
});
