import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Intentionally vacuous: desktop has no vitest files yet (runtime coverage is
    // the tauri-driver flow in e2e/). Flip to false with the first real test.
    passWithNoTests: true,
  },
});
