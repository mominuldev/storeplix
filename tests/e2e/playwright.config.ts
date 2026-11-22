import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke E2E for Store Plix. Assumes the stack is already running (docker compose up, or the
 * individual dev servers) and the dev seed has run (store slug `demo`).
 *
 * Override targets with env: API_URL, MERCHANT_URL, ADMIN_URL, STOREFRONT_URL.
 * Chromium resolves *.localhost to loopback, so http://demo.localhost:3000 needs no hosts entry.
 */
export const urls = {
  api: process.env.API_URL ?? 'http://localhost:8000',
  merchant: process.env.MERCHANT_URL ?? 'http://localhost:5173',
  admin: process.env.ADMIN_URL ?? 'http://localhost:5174',
  storefront: process.env.STOREFRONT_URL ?? 'http://demo.localhost:3000',
};

export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  // The local stack is single-threaded (php artisan serve + sqlite + one queue worker): give UI assertions headroom.
  expect: { timeout: 10_000 },
  // The flow specs mutate the shared demo store (theme, menus, SEO, logo): run files one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testMatch: /api\..*\.spec\.ts/ },
    {
      name: 'chromium',
      testIgnore: /api\..*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
