import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    // Playwright owns e2e/*.spec.ts; keep them out of vitest.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
