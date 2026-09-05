import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          ARCHIVE_KEY_WRAPPING_SECRET: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        },
      },
    }),
  ],
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
