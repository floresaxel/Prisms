import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    // The architecture-lint regression test boots the ESLint engine, which is
    // slower than ordinary unit tests.
    testTimeout: 30_000,
  },
});
