import { expect, test } from '@playwright/test';
import { signInDashboard, urls } from '../support/api';
import { confirmedOrder, setPlan, setupShop, transition, type CommerceShop } from '../support/commerce';
import { changePlan, clock } from '../support/billing';
import { noHorizontalOverflow } from '../support/domains';

/**
 * PHASE-7-CONTRACT §8.3 "390 px" + §11 QA "mobile": Plan & billing (with an open invoice, so the table/cards render)
 * and each report tab at 390 × 844 have no horizontal scroll. Screenshots in test-results.
 */
let shop: CommerceShop;

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await setupShop('mob7', { stock: 20 });
  for (let i = 0; i < 2; i++) {
    const o = await confirmedOrder(shop, shop.simple.variantId, 1);
    expect((await transition(shop.s, o.id, 'ship', { carrier_name: 'Own rider' })).status).toBe(200);
    expect((await transition(shop.s, o.id, 'deliver')).status).toBe(200);
  }
});
test.afterAll(() => shop?.cleanup());

test('Plan & billing at 390 px (Free with an open Starter invoice)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await clock(shop.s, 'trial_ended');
  const c = await changePlan(shop.s, 'starter', 'month');
  expect(c.status, c.text).toBe(201);
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/settings/plan`);
  await expect(page.getByRole('heading', { name: 'Plan & billing' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(c.json.data.invoice.number).first()).toBeVisible({ timeout: 20_000 });
  await noHorizontalOverflow(page, 'plan-billing', (n) => test.info().outputPath(n));
  // Yearly chip still fits
  await page.getByRole('radio', { name: /^Yearly/ }).or(page.getByRole('tab', { name: /^Yearly/ })).or(page.getByRole('button', { name: /^Yearly/ })).first().click();
  await noHorizontalOverflow(page, 'plan-billing-yearly', (n) => test.info().outputPath(n));
});

for (const type of ['sales', 'profit', 'delivery'] as const) {
  test(`Reports → ${type} at 390 px`, async ({ page, context }) => {
    test.setTimeout(150_000);
    if (type === 'profit') setPlan(shop.s, 'growth');
    await signInDashboard(context, shop.s);
    await page.goto(`${urls.merchant}/reports/${type}`);
    await expect(page.getByRole('heading', { name: /Reports|Sales|Profit|Delivery/ }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForResponse((r) => r.url().includes(`/reports/${type}`), { timeout: 20_000 }).catch(() => undefined);
    // Diagnostics for the profit tab (a full-page screenshot never finished there in the first gate run).
    const sizes: number[][] = [];
    for (let i = 0; i < 3; i++) {
      sizes.push(await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight, document.documentElement.clientWidth]));
      await page.waitForTimeout(1_000);
    }
    test.info().annotations.push({ type: 'sizes', description: JSON.stringify(sizes) });
    console.log(`[reports-${type}] [scrollW, scrollH, clientW] over 3 s:`, JSON.stringify(sizes));
    expect(sizes.every(([w, , c]) => w <= c), `reports-${type}: horizontal overflow ${JSON.stringify(sizes)}`).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`reports-${type}-390-viewport.png`), timeout: 30_000 });
    await noHorizontalOverflow(page, `reports-${type}`, (n) => test.info().outputPath(n));
  });
}
