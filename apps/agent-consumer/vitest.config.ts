import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          TINYBIRD_TOKEN: 'tb-token',
          TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'snapshot-token',
          TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN: 'snapshot-token',
          SENTRY_DSN: '',
          TINYBIRD_AGENT_DELIVERY_READ_TOKEN: 'read-token',
          BODY_ENCRYPTION_ROOT_KEY: btoa('a'.repeat(32)),
        },
      },
    }),
  ],
  test: {
    reporters: ['dot'],
    passWithNoTests: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary', 'json', 'html'],
    },
  },
});
