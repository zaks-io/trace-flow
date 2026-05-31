import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          CONNECT_BASE_URL: 'https://connect.test',
          TINYBIRD_API_URL: 'https://api.tinybird.test',
          MCP_BACKEND_SHARED_SECRET: 'test-backend-secret',
          MCP_SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
        },
      },
      wrangler: {
        configPath: './wrangler.toml',
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
