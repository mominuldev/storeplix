import { expect, test } from '@playwright/test';
import { demoSession, signInDashboard, urls, type Session } from '../support/api';

/**
 * Phase 4 §9.3 / §15.9 (task 4.8): every Phase 4 screen at 390×844 has no horizontal scroll, and the bottom
 * tab bar has Products. Screenshots go to test-results/ for the Figma comparison in the QA review.
 * Read-only on the demo store.
 */
let s: Session;
test.beforeAll(async () => {
  s = await demoSession();
});

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const SCREENS: Array<[string, string, RegExp]> = [
  ['dashboard', '/', /Needs you today|Today/i],
  ['products', '/products', /Products/],
  ['product-new', '/products/new', /Product name/i],
  ['categories', '/products/categories', /categor/i],
  ['import', '/products/import', /Upload|CSV/i],
  ['inventory', '/inventory', /Stock/i],
  ['customers', '/customers', /Customers/],
  ['onboarding-05', '/onboarding/products', /Product 1 of 3|Add manually/i],
];

for (const [name, path, marker] of SCREENS) {
  test(`390 px: ${name} has no horizontal overflow`, async ({ page, context }, info) => {
    await signInDashboard(context, s);
    await page.goto(`${urls.merchant}${path}`);
    await expect(page.getByText(marker).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    await page.screenshot({ path: info.outputPath(`${name}-390.png`), fullPage: true });
    expect(scrollWidth, `${path}: scrollWidth ${scrollWidth} > ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
  });
}

test('390 px: bottom tab bar has Products with an active state on /products', async ({ page, context }) => {
  await signInDashboard(context, s);
  await page.goto(`${urls.merchant}/products`);
  const tabbar = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: /^Products$/ }) }).last();
  const products = tabbar.getByRole('link', { name: /^Products$/ });
  await expect(products).toBeVisible();
  await expect(products).toHaveAttribute('aria-current', 'page');
  // Mobile products list: filter chips, no bulk select (§9.3, Figma 139:1077).
  for (const chip of ['All', 'Active', 'Low stock', 'Sold out']) await expect(page.getByRole('button', { name: new RegExp(`^${chip}`) }).or(page.getByRole('tab', { name: new RegExp(`^${chip}`) })).first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /select all/i })).toHaveCount(0);
});
