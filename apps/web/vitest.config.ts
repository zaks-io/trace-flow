import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@convex': fileURLToPath(new URL('../../packages/convex', import.meta.url)),
    },
  },
  test: {
    reporters: ['dot'],
    globals: true,
    environment: 'node',
    passWithNoTests: true,
  },
});
