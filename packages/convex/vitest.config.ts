import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['dot'],
    globals: true,
    environment: 'node',
    env: {
      TINYBIRD_ADMIN_TOKEN: 'test-admin-token',
      TINYBIRD_WORKSPACE_ID: 'test-workspace-id',
    },
    // @convex-dev/launchdarkly ships ESM imports without explicit .js extensions,
    // which Node's strict ESM resolver rejects. Inline the module so Vite/Rollup
    // performs the import resolution instead.
    server: {
      deps: {
        inline: [/@convex-dev\/launchdarkly/, /@launchdarkly\/js-server-sdk-common/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['__tests__/**', '_generated/**', 'migrations/**', 'vitest.config.ts'],
    },
  },
});
