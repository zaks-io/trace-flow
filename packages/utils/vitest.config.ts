import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: [['verbose', { summary: true }]],
    globals: true,
    environment: 'node',
  },
});
