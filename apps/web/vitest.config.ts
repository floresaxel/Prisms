import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // web has real unit tests (test/*.test.ts) — a glob/tsconfig regression that
    // discovers zero files must fail the gate, not silently pass (audit S1-F2).
    passWithNoTests: false,
    // Playwright owns e2e/*.spec.ts; keep them out of vitest.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
