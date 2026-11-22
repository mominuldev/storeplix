import { expect, test } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { GEO, cartAdd, checkout, checkoutBody, expectedTotal, placeOrder, setupShop, sf, transition, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5-CONTRACT §12 QA "coupons" and "shipping" (+ §15.3/15.4) on a throwaway shop:
 * a percentage coupon with a cap created in the UI; usage limit 1 → the second checkout gets the exact
 * error text; cancel releases the redemption; list shows usage and revenue. Zones resolve thana → district
 * → fallback; free delivery applies at the threshold after discount; free-shipping coupon.
 */
let shop: CommerceShop;
const CODE = `QAONE${Date.now() % 100000}`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('cpn', { stock: 30 });
});
test.afterAll(() => shop?.cleanup());

test('coupon editor: percentage 15 % capped at ৳ 150, total uses 1 → second checkout refused with the exact text', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/marketing/coupons/new`);
  await page.getByLabel('Code', { exact: true }).fill(CODE);
  await expect(page.getByText(`/discount/${CODE}`).first()).toBeVisible();
  await page.getByRole('radio', { name: /Percentage/ }).click();
  await page.getByLabel('Discount (%)').fill('15');
  await page.getByLabel('Maximum discount (optional)').fill('150');
  await page.getByLabel('Total uses').fill('1');
  await page.getByRole('button', { name: 'Publish coupon' }).click();
  await expect(page).toHaveURL(/\/marketing\/coupons(\/[0-9a-z]{26})?$/, { timeout: 15_000 });
  const list = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/coupons?q=${CODE}`);
  const c = list.json.data[0];
  expect([c.type, c.percent_bps, c.max_discount_amount, c.usage_limit, c.status, c.display_status]).toEqual(['percentage', 1500, 15000, 1, 'active', 'active']);

  // 15 % of 1,400 = 210 → capped at 150
  const first = await placeOrder(shop, shop.variable.variants[1].id, 1, { coupon: CODE });
  expect([first.order.discount_amount, first.order.coupon_code]).toEqual([15000, CODE]);
  const { cart } = await cartAdd(shop.apiHost, shop.variable.variants[1].id, 1);
  // the cart still accepts the code (used_count is checked at checkout under the row lock)…
  const put = await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: CODE }, cart });
  if (put.status === 422) {
    expect(put.json.error.details.code[0]).toBe('This code has been fully used.');
  } else {
    const body = checkoutBody(0);
    body.expected_total_amount = await expectedTotal(shop.apiHost, cart, body.shipping_address);
    const second = await checkout(shop.apiHost, cart, body);
    expect([second.status, second.json.error?.code, second.json.error?.details?.code?.[0]]).toEqual([422, 'coupon_invalid', 'This code has been fully used.']);
  }
  // list: usage 1 / 1 and revenue; derived status used_up
  await page.goto(`${urls.merchant}/marketing/coupons`);
  const row = page.getByRole('row', { name: new RegExp(CODE) });
  await expect(row).toContainText('1 / 1');
  await expect(row).toContainText('৳ 1,310'); // 1,400 − 150 + 60
  const after = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/coupons?q=${CODE}`)).json.data[0];
  expect([after.display_status, after.stats.used_count, after.stats.revenue_amount, after.stats.discount_amount]).toEqual(['used_up', 1, 131000, 15000]);
  // with a redemption the coupon can't be deleted, and code/type are frozen
  const del = await api(shop.s, 'DELETE', `/stores/${shop.s.storeId}/coupons/${c.id}`);
  expect([del.status, del.json.error?.code]).toEqual([409, 'coupon_in_use']);
  const frozen = await api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/coupons/${c.id}`, { revision: after.revision, code: `${CODE}X` });
  expect(frozen.status).toBe(422);
  // cancelling the order releases the redemption → usable again
  const id = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${first.order.number}`)).json.data[0].id;
  expect((await transition(shop.s, id, 'cancel', { reason: 'customer_request', notify_customer: false })).status).toBe(200);
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/coupons?q=${CODE}`)).json.data[0].stats.used_count).toBe(0);
  const again = await placeOrder(shop, shop.variable.variants[1].id, 1, { coupon: CODE });
  expect(again.order.discount_amount).toBe(15000);
});

test('coupon rules: per-customer phone limit, first order only, minimum, eligibility; cart notices', async () => {
  const s = shop.s;
  const mk = async (body: Record<string, unknown>) => {
    const r = await api(s, 'POST', `/stores/${s.storeId}/coupons`, { status: 'active', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.data;
  };
  await mk({ code: 'QAPHONE1', type: 'fixed', amount: 5000, usage_per_customer: 1 });
  await mk({ code: 'QAFIRST1', type: 'fixed', amount: 5000, first_order_only: true });
  await mk({ code: 'QAMIN1', type: 'fixed', amount: 5000, min_subtotal_amount: 300000 });
  await mk({ code: 'QAPROD1', type: 'percentage', percent_bps: 5000, applies_to: 'products', product_ids: [shop.simple.id] });
  const dup = await api(s, 'POST', `/stores/${s.storeId}/coupons`, { code: 'qaphone1', type: 'fixed', amount: 100 });
  expect(dup.json.error?.details?.code?.[0]).toBe('This code is already used.');

  const phone = `018${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const one = await placeOrder(shop, shop.simple.variantId, 1, { coupon: 'QAPHONE1', body: { contact: { phone } } });
  expect(one.order.discount_amount).toBe(5000);
  for (const [code, msg] of [['QAPHONE1', "You've already used this code."], ['QAFIRST1', 'This code is for first orders only.']] as const) {
    const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
    expect((await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code }, cart })).status).toBe(200);
    const body = checkoutBody(0, { contact: { phone } });
    body.expected_total_amount = await expectedTotal(shop.apiHost, cart, body.shipping_address);
    const r = await checkout(shop.apiHost, cart, body);
    expect([code, r.status, r.json.error?.details?.code?.[0]]).toEqual([code, 422, msg]);
  }
  const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  const min = await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: 'QAMIN1' }, cart });
  expect(min.json.error?.details?.code?.[0]).toBe('Spend ৳ 3,000 or more to use this code.');
  const unknown = await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: 'NOPE999' }, cart });
  expect(unknown.json.error?.details?.code?.[0]).toBe("This code doesn't exist.");
  // product-specific 50 %: only the wrap line is discounted (1 × 500 → 250)
  await cartAdd(shop.apiHost, shop.variable.variants[0].id, 1, cart);
  const prod = await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: 'QAPROD1' }, cart });
  expect(prod.status).toBe(200);
  expect(prod.json.data.discount_amount).toBe(25000);
  // removing the eligible line drops the coupon with a notice on the next read
  const wrapLine = (prod.json.data.lines as Array<{ id: string; variant_id: string }>).find((l) => l.variant_id === shop.simple.variantId)!;
  const del = await sf(shop.apiHost, 'DELETE', `/cart/items/${wrapLine.id}`, { cart });
  const read = await sf(shop.apiHost, 'GET', '/cart', { cart });
  expect(read.json.data.coupon).toBeNull();
  // the notice is returned once, on the response where the code was dropped
  expect([...(del.json.meta?.notices ?? []), ...(read.json.meta?.notices ?? [])].join(' ')).toContain('Code QAPROD1 was removed: This code doesn\u2019t apply to the items in your bag.'.replace('\u2019', "'"));
});

test('shipping: thana beats district beats fallback; free delivery after discount; free-shipping coupon', async () => {
  const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  const quote = async (a: { district_code: string; thana_code: string }) => (await sf(shop.apiHost, 'GET', `/cart/shipping-options?district_code=${a.district_code}&thana_code=${a.thana_code}`, { cart })).json.data;
  expect(await quote(GEO.dhanmondi)).toMatchObject({ zone_name: 'Inside Dhaka', amount: 6000, is_free: false }); // thana
  expect(await quote(GEO.savar)).toMatchObject({ zone_name: 'Dhaka outskirts', amount: 9000 }); // whole district
  expect(await quote(GEO.gazipur)).toMatchObject({ zone_name: 'Inside Dhaka', amount: 6000 }); // whole district in zone 1
  expect(await quote(GEO.chattogram)).toMatchObject({ zone_name: 'Outside Dhaka', amount: 12000 }); // fallback
  const bad = await sf(shop.apiHost, 'GET', '/cart/shipping-options?district_code=dhaka&thana_code=chattogram-bandar', { cart });
  expect(bad.status).toBe(422);
  // free delivery over ৳ 5,000: 4 × 1,400 = 5,600 ≥ 5,000 → free
  const big = await cartAdd(shop.apiHost, shop.variable.variants[1].id, 4);
  const c = await sf(shop.apiHost, 'GET', '/cart', { cart: big.cart });
  expect(c.json.data.free_delivery).toEqual({ threshold_amount: 500000, remaining_amount: 0 });
  const q = (await sf(shop.apiHost, 'GET', '/cart/shipping-options?district_code=chattogram&thana_code=chattogram-bandar', { cart: big.cart })).json.data;
  expect([q.charge_amount, q.amount, q.is_free]).toEqual([12000, 0, true]);
  // after a discount that drops it below the threshold, delivery is charged again (P5-9)
  await api(shop.s, 'POST', `/stores/${shop.s.storeId}/coupons`, { code: 'QABIG700', type: 'fixed', amount: 70000, status: 'active' });
  await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: 'QABIG700' }, cart: big.cart });
  const q2 = (await sf(shop.apiHost, 'GET', '/cart/shipping-options?district_code=chattogram&thana_code=chattogram-bandar', { cart: big.cart })).json.data;
  expect([q2.amount, q2.is_free]).toEqual([12000, false]);
  // free-shipping coupon: shipping 0, shipping_discount recorded
  await api(shop.s, 'POST', `/stores/${shop.s.storeId}/coupons`, { code: 'QASHIPFREE', type: 'free_shipping', status: 'active' });
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { coupon: 'QASHIPFREE', body: { shipping_address: GEO.chattogram } });
  expect([placed.order.shipping_amount, placed.order.total_amount, placed.order.delivery.zone_name]).toEqual([0, 50000, 'Outside Dhaka']);
  const id = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${placed.order.number}`)).json.data[0].id;
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data.shipping_discount_amount).toBe(12000);
  // an area can sit in one zone only
  const clash = await api(shop.s, 'PUT', `/stores/${shop.s.storeId}/shipping`, {
    free_delivery_over_amount: null,
    zones: [
      { name: 'A', kind: 'custom', charge_amount: 1, min_days: 1, max_days: 2, areas: [{ district_code: 'dhaka', thana_code: 'dhaka-mirpur' }] },
      { name: 'B', kind: 'custom', charge_amount: 1, min_days: 1, max_days: 2, areas: [{ district_code: 'dhaka', thana_code: 'dhaka-mirpur' }] },
      { name: 'Else', kind: 'fallback', charge_amount: 1, min_days: 1, max_days: 2 },
    ],
  });
  expect(clash.status).toBe(422);
  expect(JSON.stringify(clash.json.error.details)).toContain('Mirpur is already in A.');
  const noFallback = await api(shop.s, 'PUT', `/stores/${shop.s.storeId}/shipping`, { free_delivery_over_amount: null, zones: [{ name: 'A', kind: 'custom', charge_amount: 1, min_days: 1, max_days: 2, areas: [] }] });
  expect(noFallback.json.error?.details?.zones?.[0]).toBe('Keep one fallback zone for everywhere else.');
});
