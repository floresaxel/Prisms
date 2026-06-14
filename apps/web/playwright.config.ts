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
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
