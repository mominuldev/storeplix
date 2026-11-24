import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { kpi } from '../support/analytics';
import { type CommerceShop } from '../support/commerce';
import { pageOverflow, watchConsole } from '../support/roles';
import {
  createPo,
  createSupplier,
  EMPTY_POS,
  lineFor,
  mUrl,
  NEW_PO,
  newPoButton,
  OMITTED,
  openPo,
  openPoList,
  openSuppliers,
  pay,
  purchasingShop,
  quickPurchaseButton,
  receive,
  receiveInputs,
  sendPo,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA visual + AC 5: Purchase orders `35:5619`, New PO `35:6210`, PO detail / Receive `36:6607` and
 * Suppliers `153:35999` at 1280, 390 and 375 px — no horizontal page overflow, no console errors, documented omissions
 * absent ("Receive at", Transfer stock, Stock count, approval note, "Approved by", "vs last month"), Figma
 * KPI tiles present; the empty state ("No purchase orders yet …") on a second, empty shop. Screenshots →
 * test-results/phase8-8b-visual/<width>/ (git-ignored) for the Figma review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-8b-visual');
const WIDTHS = [1280, 390, 375];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let empty: CommerceShop;
let partial: Json;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('pov', 'growth', 10);
  empty = await purchasingShop('pove', 'growth', 5);
  const a = await createSupplier(shop.s, { name: 'Karim Traders', city: 'Islampur, Dhaka', supplies: 'Cotton kurtas', lead_time_days: 5 });
  const b = await createSupplier(shop.s, { name: 'PackRight BD', phone: '01811000333', city: 'Tejgaon', supplies: 'Boxes, mailers', lead_time_days: 3 });
  const d1 = await createPo(shop.s, a.id, [
    { variant_id: shop.simple.variantId, unit_cost_amount: 25_000, quantity: 10 },
    { variant_id: shop.variable.variants[0].id, unit_cost_amount: 60_000, quantity: 5 },
  ], { shipping_amount: 12_100, discount_amount: 1_100 });
  partial = await sendPo(shop.s, d1.id, 'pdf');
  await receive(shop.s, partial.id, [
    { item_id: lineFor(partial, shop.simple.variantId).id, received: 4, damaged: 1 },
    { item_id: lineFor(partial, shop.variable.variants[0].id).id, received: 2 },
  ]);
  await pay(shop.s, a.id, 100_000, { purchase_order_id: partial.id });
  await createPo(shop.s, b.id, [{ variant_id: shop.variable.variants[1].id, unit_cost_amount: 80_000, quantity: 3 }]);
});
test.afterAll(() => {
  shop?.cleanup();
  empty?.cleanup();
});

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

async function noOmissions(page: Page, where: string) {
  for (const hidden of OMITTED) await expect(page.getByText(hidden), `${where}: omitted ${hidden}`).toHaveCount(0);
}

for (const width of WIDTHS) {
  test(`purchasing pages at ${width}px: no page overflow, no console errors, omissions absent`, async ({ page, context }) => {
    test.setTimeout(150_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await openPoList(page);
    for (const t of ['Open orders', 'Units coming', 'Owed to suppliers', 'Late deliveries']) await expect(kpi(page, t), t).toBeVisible();
    await expect(page.getByText(partial.number).first()).toBeVisible();
    await expect(newPoButton(page)).toBeVisible();
    await expect(quickPurchaseButton(page)).toBeVisible();
    await noOmissions(page, 'PO list');
    await shot(page, width, 'po-list', overflow);

    await page.goto(mUrl(NEW_PO));
    await expect(page.getByRole('heading', { name: /New purchase order/, level: 1 })).toBeVisible({ timeout: 20_000 });
    await noOmissions(page, 'New PO');
    await shot(page, width, 'po-new', overflow);

    await openPo(page, partial.id, partial.number);
    await expect(receiveInputs(page, 'QA Muslin Wrap').now).toBeVisible();
    await expect(page.getByText(/Karim Traders/).first()).toBeVisible();
    await noOmissions(page, 'PO receive');
    await shot(page, width, 'po-receive', overflow);

    await openSuppliers(page);
    for (const t of ['Suppliers', 'You owe', 'On the way', 'Bought this month']) await expect(kpi(page, t), t).toBeVisible();
    await expect(page.getByText('PackRight BD').first()).toBeVisible();
    await noOmissions(page, 'Suppliers');
    await shot(page, width, 'suppliers', overflow);

    await page.goto(mUrl('/inventory'));
    await expect(page.getByRole('columnheader', { name: /Incoming/i }).or(page.getByText(/^Incoming$/i)).first()).toBeVisible({ timeout: 20_000 });
    await noOmissions(page, 'Inventory');
    await shot(page, width, 'inventory', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}

test('empty shop: "No purchase orders yet" state at 390px', async ({ page, context }) => {
  test.setTimeout(90_000);
  mkdirSync(`${OUT}/390`, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  await signInDashboard(context, empty.s);
  await openPoList(page);
  await expect(page.getByText(EMPTY_POS).first()).toBeVisible({ timeout: 15_000 });
  expect(await pageOverflow(page)).toBeNull();
  await page.screenshot({ path: `${OUT}/390/po-list-empty.png`, fullPage: true });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
