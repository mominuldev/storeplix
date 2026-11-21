import { expect, test } from '@playwright/test';
import { urls } from '../playwright.config';

test('demo storefront renders the store name', async ({ page }) => {
  const res = await page.goto(urls.storefront);
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/demo store/i);
  await expect(page.getByRole('link', { name: /demo store home/i })).toBeVisible();
});

test('unknown host does not render another tenant', async ({ page }) => {
  const unknown = urls.storefront.replace('demo.', 'no-such-store-e2e.');
  const res = await page.goto(unknown);
  expect(res?.status()).toBe(404);
});
