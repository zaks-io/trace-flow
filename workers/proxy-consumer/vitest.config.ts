import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    reporters: [['verbose', { summary: true }]],
    passWithNoTests: true,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
