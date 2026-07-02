import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Intentionally vacuous: mobile has no vitest files yet (runtime coverage is
    // the Maestro flow in .maestro/). Flip to false with the first real test.
    passWithNoTests: true,
  },
});
