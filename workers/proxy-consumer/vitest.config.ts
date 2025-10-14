import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    reporters: [['verbose', { summary: true }]],
    passWithNoTests: true,
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary', 'json', 'html'],
    },
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.toml',
        },
        miniflare: {
          queueConsumers: {
            'observe-requests-dev': {
              maxBatchSize: 100,
              maxBatchTimeout: 5,
              maxRetries: 5,
              deadLetterQueue: 'observe-requests-dlq-dev',
            },
          },
        },
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
