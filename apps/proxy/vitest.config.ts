import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    reporters: ['dot'],
    passWithNoTests: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary', 'json', 'html'],
    },
    poolOptions: {
      workers: {
        miniflare: {
          bindings: {
            BODY_ENCRYPTION_ROOT_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            BODY_ENCRYPTION_KEY_ID: 'v1',
          },
        },
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
