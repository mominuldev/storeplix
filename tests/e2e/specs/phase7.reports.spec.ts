import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, signInDashboard, tinker, unique, urls, type ThrowawayMember } from '../support/api';
import {
  GEO,
  bookShipment,
  confirmedOrder,
  connectFakeCourier,
  fakeAdvance,
  merchantOrder,
  orderIdByNumber,
  placeOrder,
  setPlan,
  setupShop,
  shipmentDetail,
  transition,
  type CommerceShop,
} from '../support/commerce';
import { addDays, dhakaInstant, localDate, openReports, report } from '../support/billing';

/**
 * PHASE-7-CONTRACT §6.3, §6.4, §11 QA "reports": a fresh store whose orders are created through the real APIs
 * (storefront COD checkouts, merchant transitions, fake courier shipments, a refund), two of them moved across the
 * month boundary in Asia/Dhaka with a test-only `placed_at` write. Every expected figure is recomputed here from the
 * merchant order/shipment APIs, never copied from the report.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let shop: CommerceShop;
let staff: ThrowawayMember | undefined;
let tz: string;
let today: string;
let monthStart: string;
let prevStart: string;
let prevEnd: string;
const ids: Record<string, string> = {};
const shipmentIds: Record<string, string> = {};
let noCost: { id: string; variantId: string };

test.describe.configure({ mode: 'serial' });

const net = (o: Json) => (o.total_amount as number) - ((o.refunded_amount as number) ?? 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const share = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 10_000) / 10_000);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  shop = await setupShop('rep', { stock: 50 });
  // Starter trial: Sales + Delivery yes, Profit 402 (Growth only)
  const store = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}`)).json.data;
  tz = store.timezone ?? 'Asia/Dhaka';
  expect(tz, 'the boundary instants below assume Asia/Dhaka (+06:00, no DST)').toBe('Asia/Dhaka');
  today = localDate(new Date(), tz);
  monthStart = `${today.slice(0, 8)}01`;
  prevEnd = addDays(monthStart, -1);
  prevStart = `${prevEnd.slice(0, 8)}01`;

  const p = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/products`, {
    name: 'QA No-cost Scarf',
    status: 'active',
    variants: [{ sku: unique('QA-NC-').toUpperCase(), price_amount: 30000, initial_on_hand: 20 }],
  });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  noCost = { id: p.json.data.id, variantId: p.json.data.variants[0].id };

  await connectFakeCourier(shop.s, 'steadfast');

  // A: courier, delivered (2 units, Inside Dhaka)
  const a = await confirmedOrder(shop, shop.simple.variantId, 2);
  ids.A = a.id;
  const ba = await bookShipment(shop.s, a.id);
  expect(ba.status, ba.text).toBe(201);
  shipmentIds.A = ba.json.data.id;
  for (const st of ['in_transit', 'delivered']) expect((await fakeAdvance(shipmentIds.A, st)).status).toBe(200);

  // B: courier, returned (Chattogram)
  const b = await confirmedOrder(shop, shop.simple.variantId, 1, { body: { shipping_address: { ...GEO.chattogram } } });
  ids.B = b.id;
  const bb = await bookShipment(shop.s, b.id);
  expect(bb.status, bb.text).toBe(201);
  shipmentIds.B = bb.json.data.id;
  for (const st of ['in_transit', 'returning', 'returned']) {
    const r = await fakeAdvance(shipmentIds.B, st);
    expect(r.status, `${st}: ${r.text.slice(0, 200)}`).toBe(200);
  }

  // C: manual shipping, no-cost product, delivered, then ৳ 50 refunded
  const c = await confirmedOrder(shop, noCost.variantId, 1);
  ids.C = c.id;
  expect((await transition(shop.s, c.id, 'ship', { carrier_name: 'Own rider' })).status).toBe(200);
  expect((await transition(shop.s, c.id, 'deliver')).status).toBe(200);
  const refund = await apiCall(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/${c.id}/refunds`, { json: { amount: 5000, method: 'cash' }, headers: { 'Idempotency-Key': randomUUID() } });
  expect(refund.status, refund.text).toBe(201);

  // D: shipped by hand (sold, not delivered)
  const d = await confirmedOrder(shop, shop.simple.variantId, 1);
  ids.D = d.id;
  expect((await transition(shop.s, d.id, 'ship', { carrier_name: 'Own rider' })).status).toBe(200);

  // E: cancelled as a fake order; F: still pending
  const e = await placeOrder(shop, shop.simple.variantId, 1);
  ids.E = await orderIdByNumber(shop.s, e.order.number);
  expect((await transition(shop.s, ids.E, 'cancel', { reason: 'fake_order' })).status).toBe(200);
  const f = await placeOrder(shop, shop.simple.variantId, 1);
  ids.F = await orderIdByNumber(shop.s, f.order.number);

  // G: previous month's last local day (05:30 Dhaka = the day before in UTC); H: 1st of this month 00:15 Dhaka (UTC: last
  // day of the previous month). Both shipped by hand.
  for (const k of ['G', 'H'] as const) {
    const o = await confirmedOrder(shop, shop.simple.variantId, 1);
    ids[k] = o.id;
    expect((await transition(shop.s, o.id, 'ship', { carrier_name: 'Own rider' })).status).toBe(200);
  }
  const at = { G: dhakaInstant(prevEnd, '05:30'), H: dhakaInstant(monthStart, '00:15') };
  for (const [k, v] of Object.entries(at)) {
    if (!/^[0-9a-z]{26}$/i.test(ids[k])) throw new Error('bad id');
    // test-only: moves when the order was placed; nothing else about the order changes
    tinker(`DB::table('orders')->where('id','${ids[k]}')->update(['placed_at'=>Carbon\\CarbonImmutable::parse('${v}')]); echo 'ok';`);
  }
  staff = await createMember(shop.s, 'staff');
});

test.afterAll(async () => {
  await staff?.cleanup().catch(() => undefined);
  shop?.cleanup();
});

async function orders(): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const [k, id] of Object.entries(ids)) out[k] = await merchantOrder(shop.s, id);
  return out;
}

/** Independent recomputation of the Sales summary (§6.4) from merchant order data. */
function salesSummary(all: Json[], from: string, to: string) {
  const inRange = all.filter((o) => o.status !== 'pending_payment' && localDate(new Date(o.placed_at), tz) >= from && localDate(new Date(o.placed_at), tz) <= to);
  const sold = inRange.filter((o) => ['shipped', 'delivered'].includes(o.status));
  const sales = sold.reduce((n, o) => n + net(o), 0);
  const items = sold.reduce((n, o) => n + (o.items as Json[]).reduce((m, i) => m + (i.quantity as number), 0), 0);
  const cancelled = inRange.filter((o) => o.status === 'cancelled');
  return {
    orders_count: inRange.length,
    sold_orders_count: sold.length,
    sales_amount: sales,
    average_order_value_amount: sold.length ? Math.floor(sales / sold.length) : null,
    items_per_order: sold.length ? round1(items / sold.length) : null,
    cancelled_count: cancelled.length,
    fake_cancelled_count: cancelled.filter((o) => o.cancel_reason === 'fake_order').length,
  };
}

test('Sales: this month in Asia/Dhaka equals the recomputation; the 00:15 order is in, the previous-day order is not', async () => {
  const all = Object.values(await orders());
  expect(all.find((o) => o.id === ids.B)?.status, 'courier "returned" should end the order as returned').toBe('returned');
  const r = await report(shop.s, 'sales', monthStart, today);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.headers['cache-control'] ?? '').toMatch(/no-store/);
  expect(r.json.meta).toMatchObject({ from: monthStart, to: today, timezone: 'Asia/Dhaka', currency: 'BDT' });
  const expected = salesSummary(all, monthStart, today);
  expect(r.json.data.summary).toMatchObject(expected);
  // A, C, D, H sold; B returned; E cancelled (fake); F pending → 7 orders here, G belongs to last month
  expect([expected.orders_count, expected.sold_orders_count, expected.cancelled_count, expected.fake_cancelled_count]).toEqual([7, 4, 1, 1]);
  expect(r.json.data.summary.cancelled_rate).toBeCloseTo(1 / expected.orders_count, 4);

  const daily = r.json.data.daily as Json[];
  const days = Math.round((Date.parse(today) - Date.parse(monthStart)) / 86_400_000) + 1;
  expect(daily).toHaveLength(days);
  expect(daily[0].date).toBe(monthStart);
  const h = all.find((o) => o.id === ids.H)!;
  if (today !== monthStart) {
    expect(daily[0]).toMatchObject({ orders_count: 1, sold_orders_count: 1, sales_amount: net(h) });
    const t = daily.find((x) => x.date === today)!;
    expect(t.sales_amount).toBe(expected.sales_amount - net(h));
  }
  expect(daily.reduce((n, x) => n + x.sales_amount, 0)).toBe(expected.sales_amount);
  // previous = the equal-length period immediately before: G is on its last day
  expect(r.json.meta.previous_to).toBe(prevEnd);
  expect(r.json.data.previous.orders_count).toBe(1);
  expect(r.json.data.previous.sold_orders_count).toBe(1);
  // channels and areas over sold orders
  expect((r.json.data.channels as Json[]).reduce((n, c) => n + c.sales_amount, 0)).toBe(expected.sales_amount);
  const dhakaSales = all.filter((o) => ['shipped', 'delivered'].includes(o.status) && o.shipping_address.district_code === 'dhaka' && localDate(new Date(o.placed_at), tz) >= monthStart).reduce((n, o) => n + net(o), 0);
  expect(r.json.data.areas.inside_dhaka_share).toBeCloseTo(share(dhakaSales, expected.sales_amount)!, 4);
  // top products: units of the simple product among sold orders
  const units = all.filter((o) => ['shipped', 'delivered'].includes(o.status) && localDate(new Date(o.placed_at), tz) >= monthStart)
    .flatMap((o) => o.items as Json[]).filter((i) => i.product_id === shop.simple.id).reduce((n, i) => n + i.quantity, 0);
  expect((r.json.data.top_products as Json[]).find((p) => p.product_id === shop.simple.id)?.units).toBe(units);
  // S63: no phone / address in report payloads
  expect(r.text).not.toMatch(/01[3-9]\d{8}|address_line|"phone"/);
});

test('Sales: last month contains only the 05:30 order; range validation', async () => {
  const all = Object.values(await orders());
  const r = await report(shop.s, 'sales', prevStart, prevEnd);
  expect(r.status).toBe(200);
  expect(r.json.data.summary).toMatchObject(salesSummary(all, prevStart, prevEnd));
  expect(r.json.data.summary.orders_count).toBe(1);
  const bad = await report(shop.s, 'sales', today, prevStart);
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'validation_failed']);
  const long = await report(shop.s, 'sales', '2024-01-01', '2025-06-01');
  expect([long.status, long.json.error?.code]).toEqual([422, 'validation_failed']);
  const old = await report(shop.s, 'sales', '2019-12-31', '2020-01-02');
  expect(old.status).toBe(422);
  // `to` in the future is clipped to today
  const fut = await report(shop.s, 'sales', monthStart, addDays(today, 30));
  expect([fut.status, fut.json.meta?.to]).toEqual([200, today]);
});

test('Delivery: courier parcels booked this month (manual shipments excluded)', async () => {
  const sa = await shipmentDetail(shop.s, shipmentIds.A);
  const sb = await shipmentDetail(shop.s, shipmentIds.B);
  expect([sa.status, sb.status]).toEqual(['delivered', 'returned']);
  const r = await report(shop.s, 'delivery', monthStart, today);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.json.data.summary).toMatchObject({
    parcels_count: 2,
    delivered_count: 1,
    returned_count: 1,
    returning_count: 0,
    in_progress_count: 0,
    success_rate: 0.5,
    return_rate: 0.5,
    returning_charges_amount: (sb.delivery_fee_amount as number | null) ?? 0,
  });
  const c = (r.json.data.couriers as Json[]).find((x) => x.provider === 'steadfast');
  expect(c).toMatchObject({ parcels_count: 2, delivered_share: 0.5, returned_share: 0.5 });
  expect((r.json.data.districts as Json[]).reduce((n, d) => n + d.parcels_count, 0)).toBe(2);
  expect(r.text).not.toMatch(/01[3-9]\d{8}|address_line/);
  // S63: every key of returning[] is from the contract (names + district only)
  for (const row of r.json.data.returning as Json[]) {
    expect(Object.keys(row).sort()).toEqual(['customer_name', 'district_name', 'last_event_at', 'last_location', 'order_id', 'order_number', 'problem', 'provider', 'shipment_id']);
  }
});

test('Profit: staff 403, Starter 402 upgrade_plan [growth]; UI shows the upgrade card and hides the tab for staff', async ({ browser }) => {
  test.setTimeout(90_000);
  expect((await report(shop.s, 'profit', monthStart, today, staff!.session)).status).toBe(403);
  const st = await report(shop.s, 'profit', monthStart, today);
  expect([st.status, st.json.error?.code, st.json.error?.details?.upgrade_plan]).toEqual([402, 'feature_not_in_plan', ['growth']]);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInDashboard(ctx, shop.s);
  await openReports(page, 'profit');
  await expect(page.getByText(/Growth/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /Upgrade to Growth/ }).or(page.getByRole('link', { name: /Upgrade to Growth|See plans/ })).first()).toBeVisible();
  await ctx.close();

  const sctx = await browser.newContext();
  const sp = await sctx.newPage();
  await signInDashboard(sctx, staff!.session);
  await openReports(sp, 'sales');
  await expect(sp.getByRole('tab', { name: /Sales/ }).or(sp.getByRole('link', { name: /^Sales/ })).first()).toBeVisible({ timeout: 20_000 });
  await expect(sp.getByRole('tab', { name: /Profit/ }).or(sp.getByRole('link', { name: /^Profit/ }))).toHaveCount(0);
  await sctx.close();
});

test('Profit (Growth owner): delivered orders by delivery date, costs, data-quality notice', async ({ page, context }) => {
  test.setTimeout(90_000);
  setPlan(shop.s, 'growth'); // test-only; flushes the cache (after every fake courier advance)
  const all = await orders();
  const delivered = [all.A, all.C];
  expect(delivered.map((o) => o.status)).toEqual(['delivered', 'delivered']);
  const sa = await shipmentDetail(shop.s, shipmentIds.A);
  const revenue = delivered.reduce((n, o) => n + net(o), 0);
  const productCost = delivered.flatMap((o) => o.items as Json[]).reduce((n, i) => n + (i.unit_cost_amount ?? 0) * (i.quantity - (i.returned_quantity ?? 0)), 0);
  const delivery = (sa.delivery_fee_amount as number | null) ?? 0;
  const cod = (sa.cod_charge_amount as number | null) ?? 0;
  const r = await report(shop.s, 'profit', monthStart, today);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  const total = productCost + delivery + cod;
  expect(r.json.data.summary).toMatchObject({
    revenue_amount: revenue,
    delivered_orders_count: 2,
    product_cost_amount: productCost,
    delivery_cost_amount: delivery,
    cod_fee_amount: cod,
    gateway_fee_amount: null,
    ad_spend_amount: null,
    total_cost_amount: total,
    net_profit_amount: revenue - total,
    profit_per_order_amount: Math.floor((revenue - total) / 2),
  });
  expect(r.json.data.summary.margin).toBeCloseTo((revenue - total) / revenue, 4);
  expect(r.json.data.data_quality.items_without_cost).toBe(1);
  expect(r.json.data.data_quality.shipments_without_fee).toBeGreaterThanOrEqual(0);
  expect(r.json.data.weekly).toHaveLength(12);

  await signInDashboard(context, shop.s);
  await openReports(page, 'profit');
  await expect(page.getByText(/no cost price/).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath('profit.png'), fullPage: true });
});

test('UI: Sales tab shows the recomputed total; the range picker writes the URL and reloads the data', async ({ page, context }) => {
  test.setTimeout(90_000);
  const all = Object.values(await orders());
  const expected = salesSummary(all, monthStart, today);
  await signInDashboard(context, shop.s);
  await openReports(page, 'sales');
  const taka = (expected.sales_amount / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  await expect(page.getByText(new RegExp(`৳\\s?${taka.replace(/[.,]/g, '\\$&')}`)).first()).toBeVisible({ timeout: 20_000 });
  const lastMonthResp = page.waitForResponse((res) => res.url().includes('/reports/sales') && res.url().includes(`from=${prevStart}`));
  await page.getByRole('radio', { name: /^Last month/ }).or(page.getByRole('tab', { name: /^Last month/ })).or(page.getByRole('button', { name: /^Last month/ })).first().click();
  await expect(page).toHaveURL(new RegExp(`from=${prevStart}.*to=${prevEnd}|to=${prevEnd}.*from=${prevStart}`), { timeout: 10_000 });
  expect((await lastMonthResp).status()).toBe(200);
  await page.screenshot({ path: test.info().outputPath('sales-last-month.png'), fullPage: true });
});

test('S63: another store/tenant can\'t read these reports (404) — covered in phase7.billing-security; unknown store id 404', async () => {
  const r = await api(shop.s, 'GET', `/stores/01ARZ3NDEKTSV4RRFFQ69G5FAV/reports/sales`);
  expect(r.status).toBe(404);
  expect(urls.merchant).toBeTruthy();
});
