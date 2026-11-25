import { expect, test } from '@playwright/test';
import { apiCall, signInDashboard } from '../support/api';
import { randomPhone, sf } from '../support/commerce';
import { mUrl } from '../support/locations';
import { manualOrderQty, retryLocked, spath, today } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { cashSale, idem, ok, openSession, ordersWhere, orderDetail, posShop, quote, saleRaw, type PosShop } from '../support/pos';

/**
 * PHASE-8-8D §8 readers with till sales (S205, §16 AC 3), real API + merchant dashboard:
 *  - Orders: `filter[created_via]=pos` returns only till sales (with `pos.register_name`); the list shows the
 *    "POS · Register 1" tag and the "POS" quick chip (`?via=pos`) filters to till sales; order detail shows the tag, no
 *    Shipping card or delivery address, and the payments card "Till · Register 1".
 *  - Sales report includes till sales (channel `walk_in`) and skips them in the district breakdown; Profit & loss counts
 *    them as delivered revenue with no delivery cost; Delivery report is unchanged.
 *  - Storefront order tracking never finds a till sale (404); `label_4x6` refuses a till sale (422), invoices are allowed.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let manual: Json;
let walkIn: Json;
let withPhone: Json;
const phone = randomPhone();

const report = async (kind: 'sales' | 'profit' | 'delivery') =>
  ok(await retryLocked(() => apiCall(shop.s, 'GET', spath(shop.s, `/reports/${kind}?from=${today()}&to=${today()}`))), 200, `${kind} report`);

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pord', 'growth');
  manual = await manualOrderQty(shop, shop.wrap, 1);
  const sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 100000 });
  walkIn = await cashSale(shop.s, sess.id, [{ variant_id: shop.wrap, quantity: 1 }]);
  const q = await quote(shop.s, sess.id, [{ variant_id: shop.kurtaM, quantity: 1 }]);
  withPhone = await ok(
    await saleRaw(shop.s, {
      session_id: sess.id,
      lines: [{ variant_id: shop.kurtaM, quantity: 1 }],
      customer: { phone, name: 'QA Till Buyer' },
      expected_total_amount: q.total_amount,
      payments: [{ method: 'card', amount: q.total_amount, reference: 'A1' }],
      sms_receipt: false,
    }),
    201,
    'card sale with phone',
  );
});
test.afterAll(() => shop?.cleanup());

test('orders API: created_via filter, pos block; readers (sales, P&L, delivery); tracking 404; labels 422', async () => {
  const pos = await ordersWhere(shop.s, 'filter[created_via]=pos');
  expect(pos.map((o) => o.number).sort()).toEqual([walkIn.number, withPhone.number].sort());
  for (const o of pos) expect(o).toMatchObject({ created_via: 'pos', channel: 'walk_in', status: 'delivered', payment_status: 'paid', payment_method: 'pos', pos: { register_name: 'Register 1' } });
  const dash = await ordersWhere(shop.s, 'filter[created_via]=dashboard');
  expect(dash.map((o) => o.number)).toEqual([manual.number]);
  expect(dash[0].pos ?? null).toBeNull();

  // Reports are cached 120 s per range (PHASE-7 P7-18), so they are read once, after the sales. The only other order
  // is an unconfirmed manual order (no revenue, no shipment).
  // Sales report: the two till sales count (channel walk_in) and never reach the district breakdown.
  const sales = await report('sales');
  expect(sales.summary.sales_amount).toBeGreaterThanOrEqual(170000);
  expect((sales.channels as Json[]).find((c) => c.channel === 'walk_in')).toMatchObject({ orders_count: 2, sales_amount: 170000 });
  const districts = sales.areas.districts as Json[];
  expect(districts.map((d) => d.district_code), 'walk-in sentinel never in the district breakdown').not.toContain('');
  expect(districts.reduce((n, d) => n + d.orders_count, 0), 'till sales skipped in the district breakdown (only the manual order can be there)').toBeLessThanOrEqual(1);

  // Profit & loss: delivered by delivered_at → revenue ৳ 1,700 from two orders, no delivery cost, cost snapshot.
  const profit = await report('profit');
  expect(profit.summary).toMatchObject({ revenue_amount: 170000, delivered_orders_count: 2, delivery_cost_amount: 0 });
  expect(profit.summary.product_cost_amount, 'unit_cost snapshot: wrap ৳ 200 + kurta M ৳ 700').toBe(90000);

  // Delivery report: till sales have no shipment.
  const delivery = await report('delivery');
  expect(JSON.stringify(delivery.couriers)).toBe('[]');
  expect(delivery.returning).toEqual([]);

  // Storefront tracking (number + phone) never finds a till sale.
  const track = await retryLocked(() => sf(shop.apiHost, 'POST', '/orders/track', { json: { number: withPhone.number, phone } }));
  expect(track.status, track.text.slice(0, 200)).toBe(404);

  // Documents: label refused for a till sale, invoice / receipt allowed.
  const label = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, '/documents'), { json: { kind: 'label_4x6', order_ids: [walkIn.order_id] } }));
  expect([label.status, label.json.error?.code], label.text.slice(0, 200)).toEqual([422, 'validation_failed']);
  const invoice = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, '/documents'), { json: { kind: 'invoice_a4', order_ids: [walkIn.order_id] } }));
  expect([200, 201, 202], invoice.text.slice(0, 200)).toContain(invoice.status);

  // A courier booking on a till sale is refused (no shipment for walk-in sentinels).
  const book = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, `/orders/${walkIn.order_id}/shipments`), { json: {}, headers: idem() }));
  expect(book.status, `courier booking on a till sale: ${book.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
  expect((await orderDetail(shop.s, walkIn.order_id)).shipment).toBeNull();
});

test('orders UI: POS tag, POS chip (?via=pos), detail without delivery address, Till payments', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(mUrl('/orders'));
  const row = (n: string) => page.getByRole('row').filter({ hasText: n }).or(page.getByRole('listitem').filter({ hasText: n })).first();
  await expect(row(walkIn.number)).toBeVisible({ timeout: 20_000 });
  await expect(row(walkIn.number).getByTestId('order-pos-tag')).toHaveText('POS · Register 1');
  await expect(row(manual.number)).toBeVisible();
  await expect(row(manual.number).getByTestId('order-pos-tag')).toHaveCount(0);

  const filtered = page.waitForRequest((r) => /\/orders\?/.test(r.url()) && decodeURIComponent(r.url()).includes('filter[created_via]=pos'));
  await page.getByTestId('orders-pos-chip').click();
  await filtered;
  await expect(page).toHaveURL(/[?&]via=pos/);
  await expect(row(withPhone.number)).toBeVisible();
  await expect(row(manual.number), 'chip hides non-POS orders').toHaveCount(0);
  await page.goto(mUrl('/orders?via=pos'));
  await expect(row(walkIn.number)).toBeVisible({ timeout: 20_000 });
  await expect(row(manual.number)).toHaveCount(0);

  await page.goto(mUrl(`/orders/${walkIn.order_id}`));
  await expect(page.getByText(walkIn.number).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('order-pos-tag').first()).toHaveText('POS · Register 1');
  await expect(page.getByText('Delivery address'), 'no delivery address for a till sale').toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Shipping' }), 'no Shipping card').toHaveCount(0);
  await expect(page.getByText('Till · Register 1').first()).toBeVisible();
  await expect(page.getByText('Walk-in customer').first()).toBeVisible();
  // A normal order still shows its delivery address.
  await page.goto(mUrl(`/orders/${manual.id}`));
  await expect(page.getByText('Delivery address').first()).toBeVisible({ timeout: 20_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
