import { defineConfig, devices } from '@playwright/test';
import { agentsE2eBaseUrl, agentsStorageState } from './e2e/agents-e2e-config';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: agentsE2eBaseUrl,
    storageState: agentsStorageState,
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
