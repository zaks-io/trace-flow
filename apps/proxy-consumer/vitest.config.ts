import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.toml',
      },
      miniflare: {
        queueConsumers: {
          'trace-flow-requests-dev': {
            maxBatchSize: 100,
            maxBatchTimeout: 5,
            maxRetries: 5,
            deadLetterQueue: 'trace-flow-requests-dlq-dev',
          },
        },
      },
      isolatedStorage: false,
      singleWorker: true,
    }),
  ],
  test: {
    globals: true,
    reporters: ['dot'],
    passWithNoTests: true,
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary', 'json', 'html'],
    },
  },
});
