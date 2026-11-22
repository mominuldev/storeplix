import { expect, test, type Page } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import {
  bookShipment,
  browserHost,
  confirmedOrder,
  connectFakeCourier,
  connectFakeGateway,
  fakeAdvance,
  createPaymentLink,
  fakeGatewayOutcome,
  linkToken,
  mapStoreHost,
  orderIdByNumber,
  placeOnlineOrder,
  placeOrder,
  setupShop,
  transition,
  type CommerceShop,
} from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "mobile" for the increments built so far (5b-4 documents, 5b-5 order changes):
 * Returns list, return detail, Edit items and Invoices & labels at 390 × 844 have no horizontal overflow
 * (screenshots → test-results/). 5b-2: the storefront payment result (paid + failed) and `/pay/{token}` at 390 px.
 * 5b-3: Shipments list (KPIs, problems, table) and shipment detail at 390 px.
 */
let shop: CommerceShop;
let confirmedId: string;
let returnId: string;

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('m5b', { stock: 10 });
  const orderId = async (number: string) => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${number}`)).json.data[0].id as string;
  const [m] = shop.variable.variants;

  const a = await placeOrder(shop, m.id, 2, { body: { contact: { name: 'মোছাম্মৎ ফারজানা আক্তার চৌধুরী' } } });
  confirmedId = await orderId(a.order.number);
  expect((await transition(shop.s, confirmedId, 'confirm')).status).toBe(200);

  const b = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Delivered Customer With A Long Name' } } });
  const delivered = await orderId(b.order.number);
  for (const step of ['confirm', 'ready', 'ship', 'deliver'] as const) {
    expect((await transition(shop.s, delivered, step, step === 'ship' ? { carrier_name: 'Steadfast' } : {})).status).toBe(200);
  }
  const item = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${delivered}`)).json.data.items[0];
  const ret = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/${delivered}/returns`, {
    type: 'return',
    reason: 'damaged',
    customer_note: 'The wrap arrived torn along one edge',
    lines: [{ order_item_id: item.id, quantity: 1 }],
  });
  expect(ret.status, JSON.stringify(ret.json)).toBe(201);
  returnId = ret.json.data.id;
});
test.afterAll(() => shop?.cleanup());

async function noOverflow(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const { scroll, client, culprits } = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const culprits = [...document.querySelectorAll('body *')]
      .filter((e) => !(e instanceof SVGElement) && e.getBoundingClientRect().right > w + 0.5 && getComputedStyle(e).position !== 'fixed')
      .slice(0, 6)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 80)} "${(e.textContent ?? '').trim().slice(0, 40)}" right=${Math.round(e.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, client: w, culprits };
  });
  if (scroll > client) console.log(`[${name}] overflow:`, culprits.join(' | '));
  await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
  expect(scroll, `${name}: scrollWidth ${scroll} > clientWidth ${client}`).toBeLessThanOrEqual(client);
}

test('5b-4/5b-5 dashboard screens at 390 px: returns, return detail, edit items, invoices & labels', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInDashboard(context, shop.s);

  await page.goto(`${urls.merchant}/returns`);
  await expect(page.getByRole('heading', { name: 'Returns' }).first()).toBeVisible();
  await noOverflow(page, 'returns-list');

  await page.goto(`${urls.merchant}/returns/${returnId}`);
  await expect(page.getByRole('region', { name: 'Return detail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve return' })).toBeVisible();
  await noOverflow(page, 'return-detail');

  await page.goto(`${urls.merchant}/orders/${confirmedId}/edit`);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await noOverflow(page, 'order-edit-items');

  await page.goto(`${urls.merchant}/orders/print`);
  await expect(page.getByRole('heading', { name: 'Invoices & labels' })).toBeVisible();
  await expect(page.locator('iframe[title="Document preview"]')).toBeVisible({ timeout: 15_000 });
  await noOverflow(page, 'invoices-labels');
});

test('5b-2 storefront at 390 px: payment result (paid, failed) and /pay/{token}', async ({ page, context }) => {
  test.setTimeout(150_000);
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  browserHost(shop);
  mapStoreHost(shop);

  // paid / failed result pages, reached exactly as the gateway return does (API redirect → store host)
  for (const [outcome, name, text] of [
    ['pay', 'payment-result-paid', /Paid ৳/],
    ['fail', 'payment-result-failed', /Payment didn't go through/],
  ] as const) {
    const placed = await placeOnlineOrder(shop, shop.simple.variantId, 1, { contact: { name: 'মোছাম্মৎ ফারজানা আক্তার চৌধুরী' } });
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    const r = await fakeGatewayOutcome(placed.payment!.redirect_url, outcome);
    const u = new URL(r.finalUrl);
    // the shopper's browser holds sp_order (set by the checkout action); without it the page shows the minimal card
    await context.addCookies([{ name: 'sp_order', value: placed.token, domain: shop.localHost, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${shop.storefront}${u.pathname}${u.search}`);
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 30_000 });
    await noOverflow(page, name);
  }

  const placed = await placeOrder(shop, shop.simple.variantId, 1);
  const link = await createPaymentLink(shop.s, await orderIdByNumber(shop.s, placed.order.number), { amount_kind: 'delivery_charge' });
  expect(link.status, link.text).toBe(201);
  await page.goto(`${shop.storefront}/pay/${linkToken(link.json.data.url)}`);
  await expect(page.getByText(new RegExp(`to confirm order ${placed.order.number}`)).first()).toBeVisible();
  await noOverflow(page, 'pay-link');
  await page.goto(`${shop.storefront}/pay/ZZZZZZZZZZZZ`);
  await expect(page.getByText("This payment link isn't valid any more").first()).toBeVisible();
  await noOverflow(page, 'pay-link-invalid');
});

test('5b-3 Shipments list and shipment detail at 390 px', async ({ page, context }) => {
  test.setTimeout(150_000);
  await connectFakeCourier(shop.s, 'steadfast');
  const ids: string[] = [];
  for (const [name, status] of [
    ['মোছাম্মৎ ফারজানা আক্তার চৌধুরী', 'out_for_delivery'],
    ['Problem Parcel Customer With A Long Name', 'delivery_failed'],
  ] as const) {
    const o = await confirmedOrder(shop, shop.simple.variantId, 1, { body: { contact: { name } } });
    const b = await bookShipment(shop.s, o.id);
    expect(b.status, b.text).toBe(201);
    expect((await fakeAdvance(b.json.data.id, 'in_transit')).status).toBe(200);
    expect((await fakeAdvance(b.json.data.id, status)).status).toBe(200);
    ids.push(b.json.data.id);
  }
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/shipments/${ids[1]}`);
  await expect(page.getByText(/Delivery failed|delivery failed|Failed attempt/i).first()).toBeVisible({ timeout: 15_000 });
  await noOverflow(page, 'shipment-detail');
  await page.goto(`${urls.merchant}/shipments`);
  await expect(page.getByRole('heading', { name: 'Shipments' }).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Shipment KPIs' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Needs attention' }).getByText('Problem Parcel Customer With A Long Name')).toBeVisible();
  await noOverflow(page, 'shipments-list');
});
