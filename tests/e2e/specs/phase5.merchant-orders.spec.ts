import { expect, test, type Page } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { inventoryOf, movements, placeOrder, setupShop, transition, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5-CONTRACT §12 QA "merchant-orders" on a throwaway shop: a storefront order appears in the
 * dashboard; confirm → pack → ship (tracking) → deliver → record refund through the UI; the ledger gets
 * `order_shipped`, customer counters move; cancelling another order releases `committed`; a return
 * restocks with `order_returned`. Deliver and refund were never exercised live by WEB.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('ord', { stock: 10 });
});
test.afterAll(() => shop?.cleanup());

const orderId = async (number: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${number}`)).json.data[0].id as string;
const order = async (id: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;

async function clickAction(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
}

test('orders UI: confirm → pack → ship → deliver → refund, with ledger and customer counters', async ({ page, context }) => {
  test.setTimeout(120_000);
  const m = shop.variable.variants[0];
  const placed = await placeOrder(shop, m.id, 2, { body: { contact: { name: 'Karim Ahmed' } } });
  const id = await orderId(placed.order.number);
  let inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect([inv.on_hand, inv.committed, inv.available]).toEqual([10, 2, 8]);

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders`);
  const row = page.getByText(placed.order.number).first();
  await expect(row).toBeVisible();
  await expect(page.getByRole('tab', { name: /Pending/ }).or(page.getByRole('button', { name: /Pending/ })).first()).toContainText('1');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/orders/${id}$`));
  await expect(page.getByRole('heading', { name: placed.order.number })).toBeVisible();
  await expect(page.getByText('Karim Ahmed').first()).toBeVisible();

  await clickAction(page, 'Confirm');
  await expect.poll(async () => (await order(id)).status).toBe('confirmed');
  await clickAction(page, 'Mark packed');
  await expect.poll(async () => (await order(id)).status).toBe('ready_to_ship');

  await clickAction(page, 'Mark shipped');
  const ship = page.getByRole('dialog');
  await ship.getByLabel('Courier').fill('Steadfast');
  await ship.getByLabel('Tracking code (optional)').fill('SF-QA-1');
  await ship.getByLabel('Tracking link (optional)').fill('http://not-https.example/x');
  await expect(ship.getByText('Use a link that starts with https://')).toBeVisible();
  await ship.getByLabel('Tracking link (optional)').fill('https://steadfast.com.bd/t/SF-QA-1');
  await ship.getByRole('button', { name: 'Mark shipped' }).click();
  await expect.poll(async () => (await order(id)).status).toBe('shipped');
  const shipped = await order(id);
  expect([shipped.shipment.carrier_name, shipped.shipment.tracking_code, shipped.shipment.cod_amount]).toEqual(['Steadfast', 'SF-QA-1', shipped.total_amount]);
  inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect([inv.on_hand, inv.committed]).toEqual([8, 0]);
  const ledger = (await movements(shop.s, 'order_shipped')).filter((r) => r.variant_id === m.id || r.variant?.id === m.id);
  expect(ledger).toHaveLength(1);
  expect(ledger[0].delta ?? ledger[0].quantity_delta ?? ledger[0].change).toBe(-2);

  await clickAction(page, 'Mark delivered');
  await expect.poll(async () => (await order(id)).status).toBe('delivered');
  const delivered = await order(id);
  expect([delivered.payment_status, delivered.paid_amount, delivered.due_amount]).toEqual(['paid', delivered.total_amount, 0]);
  expect(delivered.customer.delivered_orders_count).toBe(1);
  expect(delivered.customer.total_spent_amount).toBe(delivered.total_amount);
  await expect(page.getByText('Delivered').first()).toBeVisible();

  await page.getByRole('button', { name: 'Record refund' }).click();
  const refund = page.getByRole('dialog');
  await refund.getByLabel('Amount').fill('500');
  await refund.getByLabel('Paid back by').selectOption('bkash_personal');
  await refund.getByLabel('TrxID or reference (optional)').fill('TRXQA1');
  await refund.getByRole('button', { name: 'Record refund' }).click();
  await expect.poll(async () => (await order(id)).refunded_amount).toBe(50000);
  const refunded = await order(id);
  expect(refunded.payment_status).toBe('partially_refunded');
  expect(refunded.customer.total_spent_amount).toBe(refunded.total_amount - 50000);
  const types = (refunded.events as Array<{ type: string; to_status: string | null }>).flatMap((e) => [e.type, e.to_status ?? '']);
  for (const t of ['placed', 'confirmed', 'ready_to_ship', 'shipped', 'delivered', 'refund']) expect(types).toContain(t);
  await expect(page.getByText('TRXQA1').first()).toBeVisible();
});

test('cancel through the UI releases committed stock and the customer count; return restocks with order_returned', async ({ page, context }) => {
  test.setTimeout(120_000);
  const v = shop.simple.variantId;
  const placed = await placeOrder(shop, v, 3);
  const id = await orderId(placed.order.number);
  let inv = await inventoryOf(shop.s, shop.simple.id, v);
  expect(inv.committed).toBe(3);
  const countBefore = (await order(id)).customer.orders_count;

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/${id}`);
  await page.getByRole('button', { name: 'Cancel order' }).first().click();
  const dlg = page.getByRole('dialog');
  // PR #3 (UI parity): the reason is a radio list, the note is "Note for your team (optional)"
  await dlg.getByRole('radio', { name: /Couldn[’']t reach the customer/ }).check();
  await dlg.getByLabel(/^Note.*\(optional\)/).fill('No answer 3 times');
  await dlg.getByRole('button', { name: 'Cancel order' }).click();
  await expect.poll(async () => (await order(id)).status).toBe('cancelled');
  inv = await inventoryOf(shop.s, shop.simple.id, v);
  expect(inv.committed).toBe(0);
  const cancelled = await order(id);
  expect(cancelled.customer.orders_count).toBe(countBefore - 1);
  expect(cancelled.cancel_reason).toBe('unreachable');
  expect((await transition(shop.s, id, 'confirm')).status).toBe(409);

  // return: ship 2, return with restock of 1 (UI stepper), on_hand +1 with ledger order_returned
  const r2 = await placeOrder(shop, v, 2);
  const id2 = await orderId(r2.order.number);
  expect((await transition(shop.s, id2, 'confirm')).status).toBe(200);
  expect((await transition(shop.s, id2, 'ship', {})).status).toBe(200);
  const onHandShipped = (await inventoryOf(shop.s, shop.simple.id, v)).on_hand;
  await page.goto(`${urls.merchant}/orders/${id2}`);
  await page.getByRole('button', { name: 'Returned', exact: true }).click();
  const ret = page.getByRole('dialog');
  await ret.getByRole('button', { name: /^Fewer / }).click();
  await ret.getByRole('button', { name: 'Mark returned' }).click();
  await expect.poll(async () => (await order(id2)).status).toBe('returned');
  inv = await inventoryOf(shop.s, shop.simple.id, v);
  expect(inv.on_hand).toBe(onHandShipped + 1);
  expect((await movements(shop.s, 'order_returned')).length).toBe(1);
  const returned = await order(id2);
  expect(returned.items[0].restocked_quantity).toBe(1);
  expect(returned.customer.returned_orders_count).toBe(1);
  expect(returned.payments.find((p: { type: string }) => p.type === 'charge').status).toBe('cancelled');
});

test('orders list: bulk confirm skips invalid states; dashboard and customer counters follow', async ({ page, context }) => {
  const a = await placeOrder(shop, shop.variable.variants[1].id, 1);
  const b = await placeOrder(shop, shop.variable.variants[1].id, 1);
  const ids = [await orderId(a.order.number), await orderId(b.order.number)];
  expect((await transition(shop.s, ids[1], 'confirm')).status).toBe(200);
  const bulk = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/bulk`, { action: 'confirm', ids });
  expect(bulk.status).toBe(200);
  expect(bulk.json.data.updated).toBe(1);
  expect(bulk.json.data.skipped).toEqual([{ id: ids[1], reason: 'invalid_state_transition' }]);
  const dash = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/dashboard`);
  const o = dash.json.data.orders;
  expect(o.this_month.count).toBeGreaterThanOrEqual(5);
  expect(o.this_month.delivered_count).toBe(1);
  expect(o.this_month.returned_count).toBe(1);
  expect(o.this_month.delivery_success_rate).toBeCloseTo(0.5, 5);
  expect(o.best_sellers[0].units).toBeGreaterThan(0);
  expect(o.plan.used).toBe(o.this_month.count); // new tenants start on a trial plan (limit 500)
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/`);
  await expect(page.getByText(/Confirm \d+ orders?|Pack \d+ orders?/).first()).toBeVisible();
  await page.goto(`${urls.merchant}/customers`);
  await expect(page.getByText('Rahim Uddin').first()).toBeVisible();
});
