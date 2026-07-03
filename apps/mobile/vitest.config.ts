import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // S9-F2 added the first real mobile vitest file (crypto-polyfill registration).
    // Broader runtime coverage is still the Maestro flow in .maestro/.
    passWithNoTests: false,
  },
});
