import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    // The integration suite migrates a throwaway database and talks to the
    // compose PowerSync instance.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
