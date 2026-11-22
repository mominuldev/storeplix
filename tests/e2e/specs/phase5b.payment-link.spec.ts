import { expect, test, type Page } from '@playwright/test';
import { signInDashboard, urls } from '../support/api';
import {
  browserHost,
  clickFakeGateway,
  connectFakeGateway,
  createPaymentLink,
  expectPaymentResultPage,
  expireHolds,
  inventoryOf,
  linkToken,
  mapStoreHost,
  merchantOrder,
  orderIdByNumber,
  paymentLinks,
  placeOrder,
  setupShop,
  sf,
  type CommerceShop,
} from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "payment-link" (P5B-22/23, Figma 144:46081) with the fake gateway:
 * 1. Merchant opens a COD order → "Ask for an advance" → Delivery charge, bKash, 2 h, cancel if unpaid → Send.
 *    Shopper opens `/pay/{token}` on the store host → pays on the fake page → order confirmed, due reduced by ৳ 60,
 *    `partially_paid`, link `paid`; the same link then shows "This payment link isn't valid any more".
 * 2. API: one active link per order (409), link expiry with cancel-if-unpaid → order cancelled
 *    (`payment_link_expired`), stock released; the expired token is an identical 404.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('lnk', { stock: 10 });
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  browserHost(shop);
  mapStoreHost(shop);
});
test.afterAll(() => shop?.cleanup());

/** WEB "Ask for an advance" dialog (Figma 144:46081, orders/payments.tsx). Every selector for it lives here. */
async function askForAdvance(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Ask for an advance/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /Delivery charge/i }).check();
  await dialog.getByLabel('Collect with').selectOption('bkash');
  await expect(dialog.getByLabel('Link expires in')).toHaveValue('120');
  await expect(dialog.getByRole('switch', { name: /Cancel if not paid in time/i }).or(dialog.getByRole('checkbox', { name: /Cancel if not paid in time/i })).first()).toBeChecked();
  await expect(dialog.getByLabel('SMS preview')).toContainText(/60/);
  await dialog.getByRole('button', { name: 'Send payment link' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test('merchant sends a delivery-charge link → shopper pays on /pay/{token} → order confirmed, due reduced', async ({ page, context, browser }) => {
  test.setTimeout(150_000);
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Sumaiya Akter' } } });
  const id = await orderIdByNumber(shop.s, placed.order.number);
  const before = await merchantOrder(shop.s, id);
  expect([before.status, before.total_amount, before.shipping_amount, before.due_amount]).toEqual(['pending', 56000, 6000, 56000]);

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/${id}`);
  await askForAdvance(page);
  await expect(page.getByRole('region', { name: 'Payment link' })).toContainText(/Link sent by SMS|Link created/, { timeout: 15_000 });

  const [link] = await paymentLinks(shop.s, id);
  expect([link.status, link.amount_kind, link.amount, link.provider, link.cancel_if_unpaid]).toEqual(['active', 'delivery_charge', 6000, 'bkash', true]);
  expect(Date.parse(link.expires_at) - Date.parse(link.created_at)).toBeGreaterThan(119 * 60_000);
  expect(Date.parse(link.expires_at) - Date.parse(link.created_at)).toBeLessThan(121 * 60_000);
  const token = linkToken(link.url);
  expect(token).toMatch(/^[0-9A-Za-z]{12}$/);
  expect(link.url).toContain(`/pay/${token}`);
  const timeline = (await merchantOrder(shop.s, id)).events as { type: string }[];
  expect(timeline.some((e) => e.type === 'payment_link')).toBe(true);

  // shopper: fresh browser, store host
  const shopper = await browser.newContext();
  const sp = await shopper.newPage();
  const res = await sp.goto(`${shop.storefront}/pay/${token}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control'] ?? '').toMatch(/no-store/);
  await expect(sp.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(sp.getByText(new RegExp(`Pay ৳\\s?60 to confirm order ${placed.order.number}`)).first()).toBeVisible();
  await sp.getByRole('button', { name: /bKash|Pay/ }).first().click();
  await clickFakeGateway(sp, 'pay');
  await expectPaymentResultPage(sp, true);
  await expect(sp.getByText(/Paid|Payment received|Thank you/i).first()).toBeVisible({ timeout: 30_000 });

  await expect.poll(async () => (await merchantOrder(shop.s, id)).status, { timeout: 20_000 }).toBe('confirmed');
  const o = await merchantOrder(shop.s, id);
  expect([o.payment_status, o.paid_amount, o.due_amount]).toEqual(['partially_paid', 6000, 50000]);
  const charge = (o.payments as { purpose: string; status: string; payment_link_id: string | null; amount: number }[]).find((p) => p.payment_link_id === link.id);
  expect([charge?.purpose, charge?.status, charge?.amount]).toEqual(['link', 'succeeded', 6000]);
  expect((await paymentLinks(shop.s, id))[0].status).toBe('paid');

  // the link is used up: the page says so, and the API answers with the generic 404
  await sp.goto(`${shop.storefront}/pay/${token}`);
  await expect(sp.getByText("This payment link isn't valid any more").first()).toBeVisible();
  const view = await sf(shop.apiHost, 'GET', `/payment-links/${token}`);
  expect([view.status, view.json.error?.code]).toEqual([404, 'not_found']);
  await sp.screenshot({ path: test.info().outputPath('link-used.png'), fullPage: true });
  await shopper.close();

  // dashboard reflects the paid link and the new due
  await page.reload();
  await expect(page.getByText(/৳\s?500/).first()).toBeVisible();
});

test('API: one active link per order; expiry with cancel-if-unpaid cancels the order and releases stock', async () => {
  test.setTimeout(90_000);
  const [, l] = shop.variable.variants;
  const before = await inventoryOf(shop.s, shop.variable.id, l.id);
  const placed = await placeOrder(shop, l.id, 1);
  const id = await orderIdByNumber(shop.s, placed.order.number);

  const created = await createPaymentLink(shop.s, id, { amount_kind: 'percent', percent_bps: 2500, cancel_if_unpaid: true });
  expect(created.status, created.text).toBe(201);
  const link = created.json.data;
  expect(link.amount).toBe(Math.round((146000 * 2500) / 10000)); // 25 % of the due (1,400 + 60)
  const second = await createPaymentLink(shop.s, id, { amount_kind: 'full' });
  expect([second.status, second.json.error?.code]).toEqual([409, 'payment_link_active']);
  const tooMuch = await createPaymentLink(shop.s, id, { amount_kind: 'custom', amount: 999999999 });
  expect(tooMuch.status).toBeGreaterThanOrEqual(409);

  const token = linkToken(link.url);
  const view = await sf(shop.apiHost, 'GET', `/payment-links/${token}`);
  expect(view.status, view.text).toBe(200);
  expect(Object.keys(view.json.data).sort()).toEqual(['amount', 'currency', 'expires_at', 'order_number', 'provider', 'shop_name', 'status'].sort());

  await expireHolds({ linkId: link.id });
  await expect.poll(async () => (await merchantOrder(shop.s, id)).status, { timeout: 30_000 }).toBe('cancelled');
  const o = await merchantOrder(shop.s, id);
  expect(o.cancel_reason).toBe('payment_link_expired');
  expect((await paymentLinks(shop.s, id))[0].status).toBe('expired');
  expect((await inventoryOf(shop.s, shop.variable.id, l.id)).committed).toBe(before.committed);

  const unknown = await sf(shop.apiHost, 'GET', '/payment-links/ZZZZZZZZZZZZ');
  const expired = await sf(shop.apiHost, 'GET', `/payment-links/${token}`);
  expect(expired.status).toBe(404);
  expect(expired.text).toBe(unknown.text); // S28: byte-identical
});
