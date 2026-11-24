import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT } from '../support/api';
import {
  browserHost,
  cartAdd,
  choosePayment,
  clickFakeGateway,
  connectFakeGateway,
  expectPaymentResultPage,
  fillCheckout,
  mapStoreHost,
  orderIdByNumber,
  paymentOption,
  placeOrderButton,
  randomPhone,
  useCart,
  type CommerceShop,
} from '../support/commerce';
import {
  blockNumber,
  buildRecord,
  checkoutAgain,
  COD_UNAVAILABLE,
  codCheckout,
  fillOtp,
  guardEvents,
  guardShop,
  LIMIT_REACHED,
  logMark,
  otpHelp,
  placeCod,
  readOtp,
  requestOtp,
  waitGuard,
} from '../support/fraud-guard';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-8 §13 QA storefront checkout rules (§7, §10.4; P88-9, P88-11, P88-13; S159, S160; AC 3):
 *  - blocked number: COD checkout → 422 `cod_unavailable` for every phone spelling (`017…`, `+88017…`, `88017…`); online
 *    payment → 201; in the browser the COD option turns disabled with the neutral message, online is preselected and
 *    the fake gateway payment completes;
 *  - daily limit: three storefront COD orders of one phone today → the 4th → 422 `order_limit_reached` + the P88-11
 *    message on the checkout page; paying online still works;
 *  - new number: COD without a code → 422 `otp_required`; `/checkout/otp` sends a 6-digit SMS (read from the dev message
 *    sink); a wrong code → 422 `otp_invalid`; the right code → order placed, not held; the `/otp` answer has the same
 *    shape for a blocked number (no oracle);
 *  - new number in the browser at 390 px: OTP step → code from the sink → order placed (screenshot).
 * Blocked and limit phones get one delivered parcel first, so they are "known" and the OTP rule never applies to them.
 */
test.describe.configure({ mode: 'serial' });

const OUT = resolve(E2E_ROOT, 'test-results/phase8-8-visual/390');
let shop: CommerceShop;
const blocked = randomPhone();
const limited = randomPhone();

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await guardShop('fgc', 'growth');
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  // cache-flushing setup first (the dev sink is a cache list)
  browserHost(shop);
  mapStoreHost(shop);
  await buildRecord(shop, blocked, 1, 0);
  await buildRecord(shop, limited, 1, 0);
  await blockNumber(shop.s, blocked, 'QA: fake orders');
});
test.afterAll(() => shop?.cleanup());

/** API cart in the browser → checkout page → contact + Dhanmondi address. */
async function openCheckout(page: Page, phone: string, variantId = shop.simple.variantId): Promise<void> {
  const { r, cart } = await cartAdd(shop.apiHost, variantId, 1);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  await useCart(page.context(), shop, cart);
  await page.goto(`${shop.storefront}/checkout`);
  await fillCheckout(page, 'Shopper QA', phone);
}

test('blocked number: COD → 422 cod_unavailable for every spelling; online payment → 201 (S159)', async () => {
  const local = blocked;
  for (const spelling of [local, `+88${local}`, `88${local}`]) {
    const r = await codCheckout(shop, spelling);
    expect([r.status, r.json.error?.code], `${spelling}: ${r.text.slice(0, 200)}`).toEqual([422, 'cod_unavailable']);
    expect(r.json.error?.message ?? '', 'neutral message, never "blocked"').not.toMatch(/block/i);
  }
  const online = await codCheckout(shop, blocked, shop.simple.variantId, { payment_method: 'bkash' });
  expect(online.status, online.text.slice(0, 300)).toBe(201);
  expect(online.json.data?.payment?.status).toBe('redirect');
  expect((await guardEvents(shop.s, 'blocked_checkout')).length).toBeGreaterThanOrEqual(1);
});

test('blocked number in the browser: COD disabled with the neutral message, online preselected, fake bKash pays', async ({ page }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await openCheckout(page, blocked);
  if (await paymentOption(page, 'cod').isEnabled()) {
    await choosePayment(page, 'cod');
    await placeOrderButton(page).click();
  }
  await expect(page.getByText(COD_UNAVAILABLE).first()).toBeVisible({ timeout: 15_000 });
  await expect(paymentOption(page, 'cod')).toBeDisabled();
  await expect(paymentOption(page, 'bkash')).toBeChecked();
  await expect(placeOrderButton(page)).toHaveText(/Pay ৳/);
  await placeOrderButton(page).click();
  await clickFakeGateway(page, 'pay');
  await expectPaymentResultPage(page);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('daily limit: 3 COD orders today, the 4th → 422 order_limit_reached + checkout message; online still works (P88-11)', async ({ page }) => {
  test.setTimeout(150_000);
  // different variants, so none of them is a duplicate (P88-12)
  const variants = [shop.variable.variants[0].id as string, shop.variable.variants[1].id as string, shop.simple.variantId];
  for (const v of variants) await placeCod(shop, limited, v);
  const fourth = await codCheckout(shop, limited, shop.simple.variantId);
  expect([fourth.status, fourth.json.error?.code], fourth.text.slice(0, 300)).toEqual([422, 'order_limit_reached']);
  expect(fourth.json.error?.message).toMatch(LIMIT_REACHED);

  const c = watchConsole(page);
  await openCheckout(page, limited, shop.variable.variants[0].id as string);
  if (await paymentOption(page, 'cod').isEnabled()) {
    await choosePayment(page, 'cod');
    await placeOrderButton(page).click();
  }
  await expect(page.getByText(LIMIT_REACHED).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/checkout(\?|$)/);
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  const online = await codCheckout(shop, limited, shop.simple.variantId, { payment_method: 'bkash' });
  expect(online.status, online.text.slice(0, 300)).toBe(201);
  expect((await guardEvents(shop.s, 'limit_reached')).length).toBeGreaterThanOrEqual(1);
});

test('new number (API): otp_required → SMS code via the sink → otp_invalid → right code → placed, not held (S160)', async () => {
  test.setTimeout(120_000);
  const phone = randomPhone();
  const first = await codCheckout(shop, phone);
  expect([first.status, first.json.error?.code], first.text.slice(0, 300)).toEqual([422, 'otp_required']);

  const mark = logMark();
  const otp = await requestOtp(shop, phone, first.cart);
  expect(otp.status, otp.text.slice(0, 300)).toBe(200);
  expect(otp.json.data.required).toBe(true);
  expect(otp.json.data.expires_at).toBeTruthy();
  expect(otp.json.data.resend_after_seconds).toBeGreaterThan(0);
  expect(JSON.stringify(otp.json), 'the code never comes back in the response').not.toMatch(/"(code|otp|dev_otp)"/);
  const code = await readOtp(shop.s, phone, mark);
  expect(code).toMatch(/^\d{6}$/);

  const wrong = await checkoutAgain(shop, first.cart, phone, { otp_code: code === '000000' ? '111111' : '000000' });
  expect([wrong.status, wrong.json.error?.code], wrong.text.slice(0, 300)).toEqual([422, 'otp_invalid']);
  const right = await checkoutAgain(shop, first.cart, phone, { otp_code: code });
  expect(right.status, right.text.slice(0, 300)).toBe(201);

  const id = await orderIdByNumber(shop.s, right.json.data.order.number as string);
  const o = await waitGuard(shop.s, id);
  expect(o.guard).toMatchObject({ tier: 'new', hold: null });

  // no oracle (S160): a blocked number gets an answer of the same shape
  const probe = await requestOtp(shop, blocked);
  expect(probe.status).toBe(200);
  expect(Object.keys(probe.json.data).sort()).toEqual(Object.keys(otp.json.data).sort());
});

test('new number in the browser at 390 px: OTP step → code from the sink → order placed (screenshot)', async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const c = watchConsole(page);
  const phone = randomPhone();
  await openCheckout(page, phone, shop.variable.variants[1].id as string);
  await choosePayment(page, 'cod');
  const mark = logMark();
  await placeOrderButton(page).click();
  const send = page.getByRole('button', { name: /^(Send|Get) code$/ });
  if (await send.first().isVisible().catch(() => false)) await send.first().click();
  await expect(otpHelp(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Resend (code|in \d:\d{2})/).first()).toBeVisible();
  const code = await readOtp(shop.s, phone, mark);
  expect(await pageOverflow(page), 'no horizontal page scroll at 390 px').toBeNull();
  await page.screenshot({ path: `${OUT}/storefront-otp.png`, fullPage: true });

  await fillOtp(page, code);
  if (!/\/checkout\/thank-you/.test(page.url())) {
    const btn = placeOrderButton(page);
    if (await btn.isVisible().catch(() => false)) await btn.click();
  }
  await expect(page).toHaveURL(/\/checkout\/thank-you/, { timeout: 30_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
