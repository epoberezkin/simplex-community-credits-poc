import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export default defineConfig({
  testDir: './tests',
  timeout: 5 * 60 * 1000,         // proving + tx round-trips can be slow
  expect: { timeout: 60 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // globalSetup runs FIRST (chopsticks + deploy), then webServer is started
  // by Playwright (which waits for readiness), then tests execute.
  globalSetup: './global-setup.mjs',
  globalTeardown: './global-teardown.mjs',
  webServer: [
    {
      command: 'pnpm --filter @community-credits/purchaser run dev',
      cwd: REPO_ROOT,
      port: 5173,
      reuseExistingServer: true,
      timeout: 60 * 1000,
    },
    {
      command: 'pnpm --filter @community-credits/chat run dev',
      cwd: REPO_ROOT,
      port: 5174,
      reuseExistingServer: true,
      timeout: 60 * 1000,
    },
    {
      command: 'pnpm --filter @community-credits/relay run dev',
      cwd: REPO_ROOT,
      port: 5175,
      reuseExistingServer: true,
      timeout: 60 * 1000,
    },
  ],
});
