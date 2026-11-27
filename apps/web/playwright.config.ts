import { defineConfig, devices } from '@playwright/test';

/**
 * S15 DoD e2e. Assumes the full stack is already up:
 *   - compose postgres + powersync (wsl docker compose up -d)
 *   - apps/server on :3001 with BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173
 *   - apps/web dev server on :5173 (pnpm --filter @prisms/web dev)
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // The suite shares ONE live stack (server + PowerSync + postgres); parallel
  // spec files each drive a full browser session, and sync-down latency under
  // that load blows the visibility timeouts. Serial on CI's small runner;
  // developers keep the local parallel default for speed.
  workers: process.env.CI ? 1 : undefined,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // The account's timezone follows the device by default (device-timezone.ts), and a
    // fresh account starts in New York — so the browser is in New York too, or every
    // spec's account would move to the runner's zone (UTC on CI) the moment it opens.
    timezoneId: 'America/New_York',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
