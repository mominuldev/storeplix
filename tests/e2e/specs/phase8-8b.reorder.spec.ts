import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import {
  createPo,
  createSupplier,
  lineFor,
  manualOrderQty,
  mUrl,
  openPoList,
  po,
  poList,
  purchasingShop,
  receive,
  reorderSuggestions,
  sendPo,
  shipOrder,
  waitApi,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA reorder suggestions (§7, P88B-16, §10.1, §10.2):
 *  - a new shop with no shipped units → no suggestions (card hidden);
 *  - the wrap is bought from a supplier with lead time 5 (PO 2 received → on hand 8), then 3 orders × 2 are shipped
 *    (`order_shipped` movements) → on hand 2, daily = 6 ÷ 30; days_left = floor(2 ÷ 0.2) = 10 ≤ 5 + 7 → suggested
 *    ceil(0.2 × 30) − 2 − 0 = 4, grouped under that supplier; the kurta variants (never shipped) are not suggested;
 *  - UI: the PO list and Inventory show the Reorder suggestions card; "Create PO for 1 item" creates a draft for the
 *    supplier with the suggested quantity.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let sup: Json;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('por', 'growth', 6);
  sup = await createSupplier(shop.s, { name: `QA Islampur Cloth ${Date.now().toString(36).slice(-4)}`, lead_time_days: 5 });
});
test.afterAll(() => shop?.cleanup());

test('no shipped units → no suggestions', async () => {
  expect(await reorderSuggestions(shop.s)).toEqual([]);
});

test('after shipped orders: the wrap is suggested under its last supplier with the §7 numbers', async () => {
  test.setTimeout(180_000);
  const d = await createPo(shop.s, sup.id, [{ variant_id: shop.simple.variantId, unit_cost_amount: 25_000, quantity: 2 }]);
  const o = await sendPo(shop.s, d.id, 'manual');
  await receive(shop.s, o.id, [{ item_id: lineFor(o, shop.simple.variantId).id, received: 2 }]);
  for (let i = 0; i < 3; i++) {
    const order = await manualOrderQty(shop, shop.simple.variantId, 2, `0171100088${i}`);
    await shipOrder(shop.s, order.id as string);
  }
  const groups = await reorderSuggestions(shop.s);
  expect(groups).toHaveLength(1);
  expect(groups[0].supplier).toMatchObject({ id: sup.id, lead_time_days: 5 });
  expect(groups[0].items).toHaveLength(1);
  expect(groups[0].items[0]).toMatchObject({ variant_id: shop.simple.variantId, available: 2, incoming: 0, sold_30d: 6, days_left: 10, suggested_quantity: 4, last_unit_cost_amount: 25_000 });
});

test('UI: Reorder suggestions card on the PO list and Inventory; "Create PO for 1 item" creates the draft', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/inventory'));
  await expect(page.getByText(/Reorder suggestion/i).first()).toBeVisible({ timeout: 20_000 });

  await openPoList(page);
  await expect(page.getByText(/Reorder suggestion/i).first()).toBeVisible();
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible();
  await expect(page.getByText(/Sells out in 10 days/).first()).toBeVisible();
  const created = waitApi(page, 'POST', /\/purchase-orders$/);
  await page.getByRole('button', { name: /^Create PO for 1 item$/ }).first().click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const draft = await po(shop.s, (await res.json()).data.id);
  expect(draft).toMatchObject({ status: 'draft', supplier: { id: sup.id } });
  expect(lineFor(draft, shop.simple.variantId)).toMatchObject({ quantity_ordered: 4, unit_cost_amount: 25_000 });
  expect((await poList(shop.s, 'filter[status]=draft')).data.map((x) => x.id)).toContain(draft.id);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
