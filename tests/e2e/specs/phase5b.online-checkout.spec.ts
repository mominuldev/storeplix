import { expect, test, type Page } from '@playwright/test';
import { api } from '../support/api';
import {
  browserHost,
  cartAdd,
  choosePayment,
  clickFakeGateway,
  confirmation,
  connectFakeGateway,
  expectPaymentResultPage,
  expireHolds,
  fakeGatewayOutcome,
  fillCheckout,
  inventoryOf,
  mapStoreHost,
  merchantOrder,
  orderIdByNumber,
  payOrder,
  paymentOption,
  placeOrderButton,
  placeAndPay,
  placeOnlineOrder,
  placeOrder,
  setCodAdvance,
  setupShop,
  sf,
  useCart,
  type CommerceShop,
} from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "online-checkout" with the fake gateway (PAYMENTS_FAKE=true, P5B-29), on a throwaway shop:
 * 1. Checkout offers COD and bKash; bKash → fake page → Pay → payment result "Paid", order confirmed + paid (P5B-14/16).
 * 2. Fail → "Payment didn't go through" → Try again → Pay → paid (P5B-17).
 * 3. Cancel → "Pay on delivery instead" → order `pending`, COD, charge cancelled (P5B-17).
 * 4. API: the hold expires (P5B-21) → order cancelled `payment_timeout`, stock released, retry 409 `payment_not_pending`.
 * 5. API: advance delivery charge (P5B-13): COD without `advance_gateway` 422, with it → pay the ৳ 60 → confirmed,
 *    partially paid, due = total − 60.
 * Prices: M ৳ 1,200, simple ৳ 500, Inside Dhaka (Dhanmondi) ৳ 60.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('pay', { stock: 10 });
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  browserHost(shop);
  mapStoreHost(shop);
});
test.afterAll(() => shop?.cleanup());

/** API cart in the browser → checkout → choose a method → Place order. Returns the shopper phone. */
async function checkoutInBrowser(page: Page, method: 'cod' | 'bkash', variantId = shop.simple.variantId): Promise<string> {
  const { r, cart } = await cartAdd(shop.apiHost, variantId, 1);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await useCart(page.context(), shop, cart);
  await page.goto(`${shop.storefront}/checkout`);
  const phone = await fillCheckout(page);
  await expect(paymentOption(page, 'cod')).toHaveCount(1);
  await expect(paymentOption(page, 'bkash')).toHaveCount(1);
  await choosePayment(page, method);
  await expect(placeOrderButton(page)).toHaveText(method === 'cod' ? /Place order — ৳\s?560/ : /Pay ৳\s?560 with bKash/);
  await placeOrderButton(page).click();
  return phone;
}

const latestOrder = async () => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`)).json.data[0];

test('bKash on the fake page: Pay → "Paid" → order confirmed and paid; COD stays available', async ({ page, context }) => {
  test.setTimeout(120_000);

  // the storefront advertises both methods
  const cfg = await sf(shop.apiHost, 'GET', '/config');
  expect(cfg.status).toBe(200);
  expect(JSON.stringify(cfg.json.data.commerce?.payment_methods)).toMatch(/cod[\s\S]*bkash|bkash[\s\S]*cod/);

  await checkoutInBrowser(page, 'bkash');
  await clickFakeGateway(page, 'pay');
  await expectPaymentResultPage(page);
  await expect(page.getByText(/Paid ৳\s?560/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/bKash/).first()).toBeVisible();

  const o = await merchantOrder(shop.s, (await latestOrder()).id);
  expect([o.status, o.payment_status, o.payment_method, o.paid_amount, o.due_amount]).toEqual(['confirmed', 'paid', 'bkash', 56000, 0]);
  const charge = (o.payments as { type: string; provider: string; status: string; purpose: string; provider_trx_id: string | null }[]).find((p) => p.type === 'charge' && p.provider === 'bkash');
  expect([charge?.status, charge?.purpose]).toEqual(['succeeded', 'order']);
  expect(charge?.provider_trx_id).toBeTruthy();
  expect(o.events.some((e: { type: string }) => e.type === 'payment')).toBe(true);
  expect(o.events.some((e: { type: string; to_status: string | null; actor: { type: string } }) => e.type === 'status_changed' && e.to_status === 'confirmed' && e.actor.type === 'system')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('paid.png'), fullPage: true });
});

test('Fail → "Payment didn\'t go through" → Try again → Pay → paid', async ({ page, context }) => {
  test.setTimeout(120_000);
  await checkoutInBrowser(page, 'bkash');
  await clickFakeGateway(page, 'fail');
  await expectPaymentResultPage(page);
  await expect(page.getByText("Payment didn't go through").first()).toBeVisible({ timeout: 30_000 });
  const first = await latestOrder();
  expect(first.status).toBe('pending_payment');

  await page.getByRole('button', { name: /Try again/i }).first().click();
  await clickFakeGateway(page, 'pay');
  await expectPaymentResultPage(page);
  await expect(page.getByText(/Paid ৳\s?560/).first()).toBeVisible({ timeout: 30_000 });

  const o = await merchantOrder(shop.s, first.id);
  expect([o.status, o.payment_status, o.paid_amount]).toEqual(['confirmed', 'paid', 56000]);
  const charges = (o.payments as { type: string; status: string }[]).filter((p) => p.type === 'charge').map((p) => p.status).sort();
  expect(charges).toEqual(['failed', 'succeeded']);
});

test('Cancel → "Pay on delivery instead" → order pending, COD, charge cancelled', async ({ page, context }) => {
  test.setTimeout(120_000);
  await checkoutInBrowser(page, 'bkash');
  await clickFakeGateway(page, 'cancel');
  await expectPaymentResultPage(page);
  await page.getByRole('button', { name: /Pay on delivery instead/i }).first().click();
  await expect(page).toHaveURL(/\/checkout\/thank-you/, { timeout: 20_000 });
  await expect(page.getByText(/Cash to pay on delivery/).first()).toBeVisible();

  const o = await merchantOrder(shop.s, (await latestOrder()).id);
  expect([o.status, o.payment_method, o.payment_status, o.paid_amount, o.due_amount]).toEqual(['pending', 'cod', 'unpaid', 0, 56000]);
  const online = (o.payments as { type: string; provider: string; status: string }[]).filter((p) => p.provider === 'bkash');
  expect(online.every((p) => p.status === 'cancelled')).toBe(true);
});

test('API: hold expiry cancels the order (payment_timeout), releases stock; retry → 409 payment_not_pending', async () => {
  test.setTimeout(90_000);
  const [m] = shop.variable.variants;
  const before = await inventoryOf(shop.s, shop.variable.id, m.id);
  const placed = await placeOnlineOrder(shop, m.id, 2);
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  expect(placed.order.status).toBe('pending_payment');
  expect([placed.payment?.status, placed.payment?.provider, placed.payment?.amount]).toEqual(['redirect', 'bkash', 246000]);
  expect(placed.payment?.redirect_url).toMatch(/\/api\/v1\/dev\/fake-gateway\/[0-9A-Z]{26}/i);
  const id = await orderIdByNumber(shop.s, placed.order.number);
  let inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect(inv.committed).toBe(before.committed + 2); // stock committed as in 5a
  const held = await merchantOrder(shop.s, id);
  expect(held.payment_expires_at).toBeTruthy();
  expect(Date.parse(held.payment_expires_at) - Date.parse(held.placed_at)).toBeGreaterThan(29 * 60_000);
  const state = await confirmation(shop, placed.token);
  expect([state.payment?.status, state.payment?.can_retry, state.payment?.can_switch_to_cod]).toEqual(['pending', true, true]);

  await expireHolds({ paymentId: placed.payment!.payment_id });
  await expect.poll(async () => (await merchantOrder(shop.s, id)).status, { timeout: 30_000 }).toBe('cancelled');
  const o = await merchantOrder(shop.s, id);
  expect(o.cancel_reason).toBe('payment_timeout');
  expect((o.payments as { provider: string; status: string; failure_code: string | null }[]).filter((p) => p.provider === 'bkash').map((p) => [p.status, p.failure_code])).toEqual([['cancelled', 'expired']]);
  inv = await inventoryOf(shop.s, shop.variable.id, m.id);
  expect(inv.committed).toBe(before.committed);

  const retry = await payOrder(shop, placed.token, 'bkash');
  expect([retry.status, retry.json.error?.code]).toEqual([409, 'payment_not_pending']);
  // paying the stale fake page afterwards never revives the order (S31 is covered by Pest; here: no confirm)
  await fakeGatewayOutcome(placed.payment!.redirect_url, 'pay').catch(() => undefined);
  expect((await merchantOrder(shop.s, id)).status).toBe('cancelled');
});

test('API: advance delivery charge — COD needs advance_gateway; paying ৳ 60 confirms, rest due on delivery', async () => {
  test.setTimeout(90_000);
  await setCodAdvance(shop.s, 'delivery_charge');
  try {
    await expect.poll(async () => (await sf(shop.apiHost, 'GET', '/config')).json.data?.commerce?.cod_advance, { timeout: 10_000 }).toBe('delivery_charge');

    const refused = await placeOnlineOrder(shop, shop.simple.variantId, 1, { payment_method: 'cod' });
    expect([refused.status, refused.json.error?.code]).toEqual([422, 'advance_required']);

    const paid = await placeAndPay(shop, shop.simple.variantId, 1, { payment_method: 'cod', advance_gateway: 'bkash' });
    expect(paid.order.status).toBe('pending_payment');
    expect(paid.payment?.amount).toBe(6000);
    expect(paid.result.finalUrl).toMatch(/\/checkout\/payment-result\?payment=[0-9A-Z]{26}$/i);
    await expect.poll(async () => (await merchantOrder(shop.s, paid.orderId)).status, { timeout: 20_000 }).toBe('confirmed');
    const o = await merchantOrder(shop.s, paid.orderId);
    expect([o.payment_method, o.payment_status, o.paid_amount, o.due_amount]).toEqual(['cod', 'partially_paid', 6000, 50000]);
    expect((o.payments as { purpose: string; status: string }[]).find((p) => p.purpose === 'advance')?.status).toBe('succeeded');

    // switching to COD is not offered while the advance is required
    const again = await placeOnlineOrder(shop, shop.simple.variantId, 1, { payment_method: 'cod', advance_gateway: 'bkash' });
    expect(again.status).toBe(201);
    expect((await confirmation(shop, again.token)).payment?.can_switch_to_cod).toBe(false);
    const sw = await payOrder(shop, again.token, 'cod');
    expect(sw.status).toBeGreaterThanOrEqual(400);
  } finally {
    await setCodAdvance(shop.s, 'none');
  }

  // plain COD still works and has no payment
  const cod = await placeOrder(shop, shop.simple.variantId, 1);
  expect(cod.order.status).toBe('pending');
  expect((await confirmation(shop, cod.token)).payment ?? null).toBeNull();
});
