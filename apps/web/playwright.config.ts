import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a live stack (web + worker + Postgres + Redis)
 * with MOCK_PROVIDER_ENABLED=true, e.g. `pnpm dev` in another terminal:
 *
 *   pnpm --filter @repeat/web test:e2e
 *
 * Set E2E_BASE_URL to target another instance.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
