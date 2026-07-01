import { defineConfig, devices } from '@playwright/test';

const storageState = process.env.TRACE_FLOW_AGENTS_E2E_STORAGE_STATE || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.TRACE_FLOW_AGENTS_E2E_BASE_URL ?? 'http://localhost:3000',
    storageState,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
