import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: [['verbose', { summary: true }]],
    passWithNoTests: true,
  },
});
