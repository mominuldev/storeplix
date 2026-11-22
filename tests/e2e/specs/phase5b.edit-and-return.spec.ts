import { expect, test } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { connectFakeGateway, inventoryOf, paymentLinks, placeOrder, setupShop, transition, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "edit-and-return" on a throwaway shop, all through the dashboard UI:
 * 1. Edit items on a confirmed order (+1 M): stock is committed by the difference, total and COD due re-priced,
 *    `items_edited` in the timeline, revision bumped.
 * 2. Ship + deliver (API), then "Create return" → Exchange 1 × M for L → Approve → Mark received (M restocked
 *    with an `return_restock`-style ledger row) → Create exchange order: a new order tagged `exchange` with
 *    `source_order_id`, the returned value as credit, L committed, the price difference due on delivery.
 *    With a fake bKash gateway connected (5b-2) the dialog sends a payment link for the ৳ 200 difference.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('ret', { stock: 10 });
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
});
test.afterAll(() => shop?.cleanup());

const orderId = async (number: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${number}`)).json.data[0].id as string;
const order = async (id: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;

test('edit items on a confirmed order → deliver → exchange → receive → exchange order', async ({ page, context }) => {
  test.setTimeout(180_000);
  const [m, l] = shop.variable.variants;
  const placed = await placeOrder(shop, m.id, 1, { body: { contact: { name: 'Nusrat Jahan' } } });
  const id = await orderId(placed.order.number);
  expect((await transition(shop.s, id, 'confirm')).status).toBe(200);
  const before = await order(id);
  let inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect([inv.on_hand, inv.committed]).toEqual([10, 1]);

  // 1. Edit items in the UI: one more M.
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/${id}`);
  await page.getByRole('link', { name: 'Edit items' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/orders/${id}/edit$`));
  await page.getByRole('button', { name: 'More QA Cotton Kurta' }).click();
  await expect(page.getByLabel('QA Cotton Kurta quantity')).toHaveText('2');
  await page.getByLabel('Reason').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${id}$`), { timeout: 15_000 });

  const edited = await order(id);
  expect(edited.items.map((i: { quantity: number }) => i.quantity)).toEqual([2]);
  expect(edited.subtotal_amount).toBe(2 * 120000);
  expect(edited.total_amount).toBe(before.total_amount + 120000);
  expect(edited.due_amount).toBe(edited.total_amount);
  expect(edited.revision).toBeGreaterThan(before.revision);
  inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect([inv.on_hand, inv.committed]).toEqual([10, 2]);
  await expect(page.getByText(/changed the items/).first()).toBeVisible();
  await expect(page.getByText('QA Cotton Kurta 1 → 2').first()).toBeVisible();

  // 2. Ship + deliver, then create the exchange from the order page.
  expect((await transition(shop.s, id, 'ready')).status).toBe(200);
  expect((await transition(shop.s, id, 'ship', { carrier_name: 'Steadfast', tracking_code: 'SF-RET-1' })).status).toBe(200);
  expect((await transition(shop.s, id, 'deliver')).status).toBe(200);
  inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect([inv.on_hand, inv.committed]).toEqual([8, 0]);

  await page.reload();
  await page.getByRole('button', { name: 'Create return' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Exchange' }).or(dialog.getByRole('tab', { name: 'Exchange' })).or(dialog.getByRole('button', { name: 'Exchange', exact: true })).first().click();
  await dialog.getByLabel('Reason').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Fewer QA Cotton Kurta' }).click(); // 2 → 1 coming back
  await dialog.getByLabel('Wants instead · QA Cotton Kurta').selectOption(l.id);
  await dialog.getByRole('button', { name: 'Create exchange' }).click();
  await expect(page).toHaveURL(/\/returns\/[0-9a-z]{26}$/, { timeout: 15_000 });
  const returnId = page.url().split('/').pop()!;
  const ret = async () => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/returns/${returnId}`)).json.data;
  expect([(await ret()).type, (await ret()).status]).toEqual(['exchange', 'requested']);

  const panel = page.getByRole('region', { name: 'Return detail' });
  await panel.getByRole('button', { name: 'Approve exchange' }).click();
  await expect.poll(async () => (await ret()).status).toBe('approved');
  await panel.getByRole('button', { name: 'Mark received' }).click();
  await expect.poll(async () => (await ret()).status).toBe('received');
  inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect(inv.on_hand).toBe(9); // the returned M is back on the shelf

  // 3. Exchange order: L at ৳1,400 against the returned M worth ৳1,200 → the customer pays ৳200 + delivery.
  await panel.getByRole('button', { name: 'Create exchange order' }).click();
  const ex = page.getByRole('dialog', { name: 'Create exchange order' });
  await expect(ex.getByText(/The customer pays ৳\s?200 more on delivery\./)).toBeVisible();
  await ex.getByRole('checkbox', { name: /Send a payment link for/ }).check(); // label says ৳ 200; the link asks the full due (QA 5b-2 F-3)
  await expect(ex.getByLabel('Collect with')).toHaveValue('bkash');
  await ex.getByRole('button', { name: 'Create order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-z]{26}$/, { timeout: 15_000 });
  const newId = page.url().split('/').pop()!;
  expect(newId).not.toBe(id);

  const exchange = await order(newId);
  expect(exchange.tags).toContain('exchange');
  expect(exchange.source_order_id ?? exchange.source_order?.id).toBe(id);
  expect(exchange.items.map((i: { variant_id: string; quantity: number }) => [i.variant_id, i.quantity])).toEqual([[l.id, 1]]);
  expect(exchange.subtotal_amount).toBe(140000);
  expect(exchange.discount_amount).toBe(120000);
  expect(exchange.total_amount).toBe(20000 + exchange.shipping_amount);
  const lInv = await inventoryOf(shop.s, shop.variable.id, l.id);
  expect(lInv.committed).toBe(1);
  await expect.poll(async () => (await ret()).exchange_order_id ?? (await ret()).exchange_order?.id).toBe(newId);
  // 5b-2 (closes 5b-4/5 QA L-2): the difference went out as an active payment link on the exchange order
  const [link] = await paymentLinks(shop.s, newId);
  // PO decision 2026-11-22: the link charges only the price difference (৳ 200); delivery stays cash on delivery.
  expect([link?.status, link?.provider, link?.amount_kind, link?.amount]).toEqual(['active', 'bkash', 'custom', 20000]);
});
