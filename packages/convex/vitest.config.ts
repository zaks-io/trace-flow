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
  },
});
