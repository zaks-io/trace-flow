import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
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
    // Feeding malformed gzip into workerd's DecompressionStream rejects an
    // internal stream promise with "Decompression failed". The handler catches
    // it correctly (returns 400 — see the gzip-bomb-guard test), but workerd
    // also surfaces it as an unhandled rejection, which Vitest 4 escalates to a
    // run-fatal error. Suppress ONLY that exact workerd artifact; everything
    // else still fails the run.
    onUnhandledError(error) {
      if (error.message === 'Decompression failed.') {
        return false;
      }
    },
  },
});
