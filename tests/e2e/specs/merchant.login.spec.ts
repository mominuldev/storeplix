import { expect, test } from '@playwright/test';
import { urls } from '../playwright.config';

test('merchant login page renders', async ({ page }) => {
  await page.goto(`${urls.merchant}/login`);
  await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /log ?in|sign ?in/i })).toBeVisible();
});
