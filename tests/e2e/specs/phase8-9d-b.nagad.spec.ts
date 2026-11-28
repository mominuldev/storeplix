import { expect, test, type Page } from '@playwright/test';
import { api, apiCall, signInDashboard } from '../support/api';
import {
  browserHost,
  cartAdd,
  clickFakeGateway,
  expectPaymentResultPage,
  fakeGatewayReturnUrl,
  fillCheckout,
  leaks,
  mapStoreHost,
  merchantOrder,
  orderIdByNumber,
  placeOnlineOrder,
  placeOrderButton,
  rawFetch,
  sf,
  useCart,
  type CommerceShop,
} from '../support/commerce';
import { mUrl, NAGAD_MERCHANT_ID, nagadKeys, recordRequests } from '../support/integrations';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-9D §16 QA part B — Nagad (PAYMENTS_FAKE=true: the Nagad account is real-validated on save — RSA ≥ 2048 PEM
 * keys, BD merchant number — and checkout runs on the fake hosted page, P5B-29):
 *  - Nagad page: client-side key checks (public key in the private-key field), then Save and connect with a 2048-bit
 *    pair → connected, keys write-only (masked + Replace, no BEGIN in the page), unsupported options greyed with
 *    "Not offered by Nagad yet", turn on "Pay with Nagad wallet".
 *  - Storefront: Nagad is a checkout method; Pay with Nagad → fake page → Pay → the order is paid ONLY after the
 *    signed return is verified (rule 8, S342): after the outcome POST and before the return, the order is unpaid; a
 *    tampered return pays nothing; the real return pays once; replaying it changes nothing.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const keys = nagadKeys();

test.beforeAll(async () => {
  test.setTimeout(150_000);
  shop = await purchasingShop('p89dng', 'starter', 20);
  browserHost(shop);
  mapStoreHost(shop);
});
test.afterAll(() => shop?.cleanup());

test('Nagad page: key checks, Save and connect, write-only keys, greyed options, enable checkout', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  const writes = recordRequests(page, '/payment-gateways/nagad');
  await page.goto(mUrl('/integrations/payments/nagad'));
  const form = page.getByRole('form', { name: 'Nagad credentials' });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Merchant ID').fill(NAGAD_MERCHANT_ID);
  await form.getByLabel('Merchant number').fill('01700');
  await form.getByLabel('Merchant private key').fill(keys.publicKey);
  await form.getByRole('button', { name: 'Save and connect' }).click();
  await expect(form.getByText(/11-digit Nagad number/)).toBeVisible();
  await expect(form.getByText(/This is a public key/)).toBeVisible();
  expect(writes.filter((w) => w.startsWith('PUT'))).toEqual([]);

  // API: a short key is refused (≥ 2048 bits) — never stored
  const weak = await apiCall(shop.s, 'PUT', `/stores/${shop.s.storeId}/payment-gateways/nagad`, {
    json: { mode: 'sandbox', credentials: { merchant_id: NAGAD_MERCHANT_ID, merchant_number: '01700000000', merchant_private_key: keys.publicKey, pg_public_key: keys.publicKey } },
  });
  expect(weak.status, weak.text.slice(0, 300)).toBe(422);

  await form.getByLabel('Merchant number').fill('01700000000');
  await form.getByLabel('Merchant private key').fill(keys.privateKey);
  await form.getByLabel('Nagad public key').fill(keys.publicKey);
  const put = page.waitForResponse((r) => r.url().endsWith('/payment-gateways/nagad') && r.request().method() === 'PUT');
  await form.getByRole('button', { name: 'Save and connect' }).click();
  const res = await put;
  expect(res.status(), await res.text()).toBe(200);
  const resText = await res.text();
  expect(leaks(resText, ['BEGIN PRIVATE KEY', keys.privateKey.split('\n')[2]!])).toEqual([]);

  const creds = page.getByRole('region', { name: 'Merchant credentials' });
  await expect(creds).toBeVisible({ timeout: 20_000 });
  await expect(creds.getByText(`••••${NAGAD_MERCHANT_ID.slice(-4)}`)).toBeVisible();
  await expect(creds.getByRole('button', { name: 'Replace Merchant private key' })).toBeVisible();
  await expect(creds.getByRole('button', { name: /^Show/ })).toHaveCount(0);
  expect(await page.content()).not.toContain('BEGIN PRIVATE KEY');

  const options = page.getByRole('region', { name: 'Checkout options' });
  for (const name of ['Pre-authorise advance', 'Agreement checkout', 'Remember the shopper’s number']) {
    await expect(options.getByRole('switch', { name })).toBeDisabled();
  }
  await expect(options.getByText('Not offered by Nagad yet')).toHaveCount(3);
  await expect(options.getByText(/Refund in the Nagad portal/)).toBeVisible();
  const wallet = options.getByRole('switch', { name: 'Pay with Nagad wallet' });
  if ((await wallet.getAttribute('aria-checked')) !== 'true') {
    const patch = page.waitForResponse((r) => r.url().endsWith('/payment-gateways/nagad') && r.request().method() === 'PATCH');
    await wallet.click();
    expect((await patch).status()).toBe(200);
  }
  await expect(wallet).toHaveAttribute('aria-checked', 'true');

  const list = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/payment-gateways`);
  const nagad = (list.json.data as { provider: string; status: string; enabled: boolean }[]).find((g) => g.provider === 'nagad');
  expect([nagad?.status, nagad?.enabled]).toEqual(['connected', true]);
  expect(leaks(list.json, [keys.privateKey.split('\n')[3]!, keys.publicKey.split('\n')[2]!])).toEqual([]);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: paid only after the verified return — outcome alone, a tampered return and a failed payment never pay', async () => {
  test.setTimeout(120_000);
  const cfg = await sf(shop.apiHost, 'GET', '/config');
  expect(JSON.stringify(cfg.json.data.commerce?.payment_methods)).toContain('nagad');

  const placed = await placeOnlineOrder(shop, shop.simple.variantId, 1, { payment_method: 'nagad' });
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  expect(placed.payment?.status).toBe('redirect');
  const orderId = await orderIdByNumber(shop.s, placed.order.number);
  const returnUrl = await fakeGatewayReturnUrl(placed.payment!.redirect_url, 'pay');
  // the shopper "paid" on the hosted page, but nothing has been verified yet
  let o = await merchantOrder(shop.s, orderId);
  expect([o.payment_method, o.payment_status, o.paid_amount]).toEqual(['nagad', 'unpaid', 0]);

  // tampered signature → refused, still unpaid
  const forged = new URL(returnUrl);
  forged.searchParams.set('signature', 'f'.repeat(64));
  const bad = await rawFetch(forged.toString(), { headers: { Accept: 'text/html' } });
  expect(bad.status).toBeGreaterThanOrEqual(300);
  o = await merchantOrder(shop.s, orderId);
  expect(o.payment_status).toBe('unpaid');

  // the signed return is verified server-side → paid once
  const ok = await rawFetch(returnUrl, { headers: { Accept: 'text/html' } });
  expect(ok.status, ok.text.slice(0, 200)).toBeGreaterThanOrEqual(300);
  o = await merchantOrder(shop.s, orderId);
  expect([o.status, o.payment_status, o.paid_amount]).toEqual(['confirmed', 'paid', o.total_amount]);
  const charges = (o.payments as { type: string; provider: string; status: string }[]).filter((p) => p.type === 'charge');
  expect(charges.map((p) => [p.provider, p.status])).toEqual([['nagad', 'succeeded']]);
  // replay → no second transition
  await rawFetch(returnUrl, { headers: { Accept: 'text/html' } });
  o = await merchantOrder(shop.s, orderId);
  expect((o.payments as { type: string }[]).filter((p) => p.type === 'charge')).toHaveLength(1);
  expect(o.paid_amount).toBe(o.total_amount);

  // a failed payment never pays
  const failed = await placeOnlineOrder(shop, shop.simple.variantId, 1, { payment_method: 'nagad' });
  expect(failed.status).toBe(201);
  const failUrl = await fakeGatewayReturnUrl(failed.payment!.redirect_url, 'fail');
  await rawFetch(failUrl, { headers: { Accept: 'text/html' } });
  const f = await merchantOrder(shop.s, await orderIdByNumber(shop.s, failed.order.number));
  expect([f.status, f.payment_status, f.paid_amount]).toEqual(['pending_payment', 'unpaid', 0]);
});

async function checkoutWithNagad(page: Page): Promise<void> {
  const { r, cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await useCart(page.context(), shop, cart);
  await page.goto(`${shop.storefront}/checkout`);
  await fillCheckout(page);
  const group = page.getByRole('radiogroup', { name: 'Payment method' });
  await expect(group.locator('input[type="radio"][value="nagad"]')).toHaveCount(1);
  await group.locator('label').filter({ has: page.locator('input[type="radio"][value="nagad"]') }).click();
  await expect(group.locator('input[type="radio"][value="nagad"]')).toBeChecked();
  await expect(group).toContainText('Nagad');
  await expect(placeOrderButton(page)).toHaveText(/Pay ৳\s?[\d,]+ with Nagad/);
  await placeOrderButton(page).click();
}

test('storefront: Pay with Nagad → fake page → Pay → paid result, order paid via nagad', async ({ page }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await checkoutWithNagad(page);
  await clickFakeGateway(page, 'pay');
  await expectPaymentResultPage(page);
  await expect(page.getByText(/Paid ৳\s?[\d,]+/).first()).toBeVisible({ timeout: 30_000 });
  const latest = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`)).json.data[0];
  const o = await merchantOrder(shop.s, latest.id);
  expect([o.status, o.payment_method, o.payment_status]).toEqual(['confirmed', 'nagad', 'paid']);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('nagad-paid-390.png'), fullPage: true });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
