import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    // The architecture-lint regression test boots the ESLint engine, which is
    // slower than ordinary unit tests.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // ELK view-model builder shells out to elkjs in callers; index is a barrel.
      exclude: ['src/index.ts'],
      // §16 test floor: core is the highest-coverage package.
      thresholds: { lines: 90, functions: 90, statements: 90 },
      reporter: ['text-summary'],
    },
  },
});
