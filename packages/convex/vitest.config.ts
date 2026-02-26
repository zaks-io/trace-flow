import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: [['verbose', { summary: true }]],
    globals: true,
    environment: 'node',
    env: {
      TINYBIRD_ADMIN_TOKEN: 'test-admin-token',
      TINYBIRD_WORKSPACE_ID: 'test-workspace-id',
    },
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['__tests__/**', '_generated/**', 'migrations/**', 'vitest.config.ts'],
    },
  },
});
