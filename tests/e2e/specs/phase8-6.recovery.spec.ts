import { expect, test } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import {
  cartAdd,
  checkout,
  checkoutBody,
  connectFakeGateway,
  expectedTotal,
  expireHolds,
  merchantOrder,
  orderIdByNumber,
  placeOnlineOrder,
  randomPhone,
  sf,
  useCart,
} from '../support/commerce';
import { digits, type SinkMessage } from '../support/campaigns';
import {
  RECOVERY,
  ageContactCarts,
  autoSink,
  automationShop,
  cartCode,
  cartContact,
  checkoutNotice,
  detectAbandoned,
  mUrl,
  messageSteps,
  runsOf,
  startRecipe,
  waitRun,
  type AutomationShop,
} from '../support/automations';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-6 §13 QA `phase8-6.recovery` — AC 1 + AC 2 for `checkout_recovery` ("Win back unfinished orders"), end to end
 * on `SMS_DRIVER=log` + the dev sink (`CAMPAIGNS_DEV_SINK=true`), a worker on the `automations` queue:
 *  1. Starter shop (store tz → ~13:00 local, outside quiet hours) enables the recipe with `delay_minutes` 15.
 *  2. Storefront checkout: the phone notice shows under the field (§10.6); an invalid phone is not captured; a valid BD
 *     mobile on blur is stored on the cart (P86-12); no storefront endpoint echoes it (S132).
 *  3. The cart's last activity is moved 20 min back, `automations:detect-abandoned` runs → one run (subject cart) with
 *     step 1 `send_message` `done`, the run `waiting` for step 2; the sink has the reminder with `{cart_link}` and the
 *     opt-out footer. A second detect creates no second run (P86-4, S129).
 *  4. `/r/{code}` opened in a fresh browser context → 303 to `/checkout` with the cart's product, a new `sp_cart`
 *     (original token and cart untouched, S133); an unknown code → `/`.
 *  5. The restored cart is checked out with the same phone → run `stopped/converted` with the conversion's order;
 *     `/stats` credits step 1 (P86-15); the recovery page shows "Recovered" in Recent carts.
 *  6. Unfinished online order (`payment_timeout`, P86-13/Q165) by another phone → a recovery run with subject order.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: AutomationShop;
let recovery: Json;
const phone = randomPhone();
let cart = '';
let reminder: SinkMessage | undefined;
let code = '';
let restored = '';
let runId = '';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await automationShop('arc', 'starter', 13);
  recovery = await startRecipe(shop.s, 'checkout_recovery', { delay_minutes: 15 });
  expect(recovery.recipe).toBe('checkout_recovery');
});
test.afterAll(() => shop?.cleanup());

test('checkout notice + phone captured on blur (valid BD mobile only), never echoed (P86-12, §10.6, S132)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  const added = await cartAdd(shop.apiHost, shop.simple.variantId, 2);
  expect(added.r.status, JSON.stringify(added.r.json)).toBe(201);
  cart = added.cart;
  await useCart(context, shop, cart);
  await page.goto(`${shop.storefront}/checkout`);
  await expect(page.getByLabel('Mobile number')).toBeVisible({ timeout: 20_000 });
  await expect(checkoutNotice(page)).toBeVisible();

  await page.getByLabel('Full name').fill('Rina Recovery');
  await page.getByLabel('Mobile number').fill('01712');
  await page.getByLabel('Mobile number').blur();
  await page.waitForTimeout(1_500);
  expect(cartContact(cart)?.contact_phone ?? null, 'invalid phone not captured').toBeNull();

  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Mobile number').blur();
  await expect.poll(() => digits(String(cartContact(cart)?.contact_phone ?? '')), { timeout: 15_000 }).toBe(digits(phone));
  const stored = cartContact(cart)!;
  expect(stored.contact_phone, 'normalized 8801XXXXXXXXX').toMatch(/^8801\d{9}$/);
  expect(stored.contact_captured_at).toBeTruthy();

  const echoed = await sf(shop.apiHost, 'GET', '/cart', { cart });
  expect(echoed.status).toBe(200);
  expect(echoed.text, 'cart never echoes the contact').not.toContain(digits(phone));
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: PUT /storefront/cart/contact validates the phone and needs that cart (§7, S132)', async () => {
  const bad = await sf(shop.apiHost, 'PUT', '/cart/contact', { json: { phone: '12345' }, cart });
  expect([bad.status, bad.json.error?.code], bad.text).toEqual([422, 'validation_failed']);
  const noCart = await sf(shop.apiHost, 'PUT', '/cart/contact', { json: { phone: randomPhone() }, cart: 'not-a-real-cart-token-000000' });
  expect([noCart.status, noCart.json.error?.code], noCart.text).toEqual([404, 'cart_not_found']);
  expect(digits(String(cartContact(cart)?.contact_phone ?? '')), 'unchanged').toBe(digits(phone));
});

test('detect-abandoned → one run, step 1 SMS sent with {cart_link} + opt-out footer, run waits for step 2 (AC 1)', async () => {
  test.setTimeout(150_000);
  ageContactCarts(shop.s.storeId, 20);
  detectAbandoned();
  const run = await waitRun(shop.s, recovery.id, (r) => r.subject?.type === 'cart' && r.status === 'waiting' && messageSteps(r).some((x) => x.status === 'done'), 90_000);
  runId = run.id;
  expect(run.trigger).toBe('checkout.abandoned');
  expect(run.status, JSON.stringify(run)).toBe('waiting');
  expect(run.resume_at, 'step 2 wait').toBeTruthy();
  expect(String(run.contact?.masked_address ?? '')).not.toContain(digits(phone));
  const s1 = messageSteps(run)[0];
  expect([s1.status, s1.channel]).toEqual(['done', 'sms']);
  expect(s1.parts).toBeGreaterThanOrEqual(1);
  expect(s1.parts, '≤ 3 parts (P86-7)').toBeLessThanOrEqual(3);

  await expect.poll(async () => (await autoSink(shop.s, recovery.id, phone)).length, { timeout: 20_000 }).toBe(1);
  reminder = (await autoSink(shop.s, recovery.id, phone))[0];
  expect(reminder.channel).toBe('sms');
  expect(reminder.text.startsWith(`${shop.name}: `), `prefix: ${reminder.text}`).toBe(true);
  expect(reminder.text, 'opt-out footer').toMatch(/\/u\/[A-Za-z0-9]{10}/);
  code = cartCode(reminder) ?? '';
  expect(code, `cart link in: ${reminder.text}`).toMatch(/^[A-Za-z0-9]{10}$/);

  // Detection marks a cart once; a second pass creates no second run (P86-4, S129).
  detectAbandoned();
  await new Promise((r) => setTimeout(r, 3_000));
  expect((await runsOf(shop.s, recovery.id)).filter((r) => r.subject?.type === 'cart')).toHaveLength(1);
});

test('/r/{code} in a fresh context restores a copy of the cart at checkout; unknown code → / (P86-16, S133)', async ({ browser }) => {
  test.setTimeout(90_000);
  test.skip(!code, 'needs the reminder');
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const c = watchConsole(page);
    await page.goto(`${shop.storefront}/r/${code}`);
    await expect(page).toHaveURL(/\/checkout(\?|$)/, { timeout: 20_000 });
    await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 15_000 });
    const cookie = (await ctx.cookies()).find((k) => k.name === 'sp_cart');
    expect(cookie?.value, 'new sp_cart set').toBeTruthy();
    expect(cookie!.value, 'never the original token').not.toBe(cart);
    expect(cookie!.httpOnly).toBe(true);
    restored = cookie!.value;
    const copy = await sf(shop.apiHost, 'GET', '/cart', { cart: restored });
    expect(copy.status).toBe(200);
    expect((copy.json.data.items ?? copy.json.data.lines ?? []).length).toBe(1);
    expect(cartContact(cart)?.status, 'original cart untouched').toBe('active');
    expect(c.errors, c.errors.join('\n')).toEqual([]);

    await page.goto(`${shop.storefront}/r/AAAAAAAAAA`);
    await expect(page).toHaveURL(new RegExp(`^${shop.storefront.replace(/[.]/g, '\\.')}/?$`), { timeout: 15_000 });
    const raw = await sf(shop.apiHost, 'POST', '/carts/recover', { json: { code: 'AAAAAAAAAA' } });
    expect([raw.status, raw.json.error?.code], raw.text).toEqual([404, 'recovery_link_invalid']);
  } finally {
    await ctx.close();
  }
});

test('order from the restored cart by the same phone → run stopped/converted, conversion credited to step 1 (P86-14, P86-15)', async ({ page, context }) => {
  test.setTimeout(150_000);
  test.skip(!restored, 'needs the restored cart');
  const body = checkoutBody(0, { contact: { name: 'Rina Recovery', phone } });
  const expected = await expectedTotal(shop.apiHost, restored, body.shipping_address);
  const placed = await checkout(shop.apiHost, restored, { ...body, expected_total_amount: expected });
  expect(placed.status, placed.text).toBe(201);
  const orderId = await orderIdByNumber(shop.s, placed.json.data.order.number);

  const run = await waitRun(shop.s, recovery.id, (r) => r.id === runId && r.status === 'stopped', 60_000);
  expect(run.outcome_reason).toBe('converted');
  expect(run.conversion?.order?.id, JSON.stringify(run.conversion)).toBe(orderId);
  expect(run.conversion.order.total_amount).toBe((await merchantOrder(shop.s, orderId)).total_amount);
  expect(messageSteps(run), 'no step 2 after the order').toHaveLength(1);

  const stats = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/automations/${recovery.id}/stats?days=14`);
  expect(stats.status, JSON.stringify(stats.json)).toBe(200);
  const step1 = (stats.json.data.steps as Json[]).find((x) => x.step === 1)!;
  expect([step1.sent, step1.recovered]).toEqual([1, 1]);
  expect(step1.revenue_amount).toBeGreaterThan(0);

  await signInDashboard(context, shop.s);
  await page.goto(mUrl(RECOVERY));
  await expect(page.getByText(/Recovered\s*·\s*SMS/).first()).toBeVisible({ timeout: 20_000 });
});

test('unfinished online order (payment_timeout) feeds the same flow with subject order (P86-13, Q165)', async () => {
  test.setTimeout(150_000);
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  const other = randomPhone();
  const placed = await placeOnlineOrder(shop, shop.simple.variantId, 1, { contact: { name: 'Online Leaver', phone: other, email: null } });
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  const id = await orderIdByNumber(shop.s, placed.order.number);
  await expireHolds({ paymentId: placed.payment!.payment_id });
  await expect.poll(async () => (await merchantOrder(shop.s, id)).cancel_reason, { timeout: 30_000 }).toBe('payment_timeout');

  const run = await waitRun(shop.s, recovery.id, (r) => r.subject?.type === 'order' && r.subject?.id === id, 90_000);
  expect(run.trigger).toBe('checkout.abandoned');
  expect(['waiting', 'running', 'completed']).toContain(run.status);
  await expect.poll(async () => (await autoSink(shop.s, recovery.id, other)).length, { timeout: 30_000 }).toBe(1);
});
