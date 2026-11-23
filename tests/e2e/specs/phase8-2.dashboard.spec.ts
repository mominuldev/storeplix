import { expect, test } from '@playwright/test';
import { apiCall } from '../support/api';
import { addDays, subscription } from '../support/billing';
import { orderIdByNumber, placeOrder, setupShop, transition, type CommerceShop } from '../support/commerce';
import { adminApi, adminLogin, adminUrl, findTenant, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import {
  STAFF,
  aggregate,
  avoidDhakaMidnight,
  card,
  count,
  dataAsOf,
  dayMonth,
  dhakaToday,
  isSelected,
  kpi,
  moneyPattern,
  openAdmin,
  orderTotals,
  overview,
  rangeTab,
  revenueNav,
  seedStaff,
  settled,
  tenantMetrics,
} from '../support/analytics';

/**
 * PHASE-8-2-CONTRACT §10 QA `phase8-2.dashboard` (§3 P82-11/P82-12, §6.2 AdminAnalyticsOverview, §7.1 dashboard `15:123`,
 * S83): a fresh shop places three storefront COD orders, one is cancelled → `POST /dev/analytics/aggregate` → platform
 * GMV and orders grow by exactly the two kept orders (gross `total_amount`, cancelled excluded), the shop's own 30-day
 * metrics equal them, the KPI row shows them; range tabs drive `?range=`; Support gets 403 and no analytics tiles,
 * Read-only gets 200, merchant and guest sessions are refused.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let admin: AdminSession;
let shop: CommerceShop;
let tenantId: string;
let today: string;
let before: Json;
let after: { data: Json; meta: Json };
let keptGmv = 0;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-p82-dashboard');
  shop = await setupShop('p82d');
  tenantId = (await findTenant(admin, shop.t.email)).id as string;
});
test.afterAll(() => shop?.cleanup());

test('orders placed today → aggregate → platform GMV/orders grow by exactly the kept orders (P82-11)', async () => {
  test.setTimeout(150_000);
  await avoidDhakaMidnight();
  today = dhakaToday();

  // Baseline: today's rows exist (this shop included, trialing, no orders yet).
  const base = await aggregate(admin);
  expect(base.as_of).toBe(today);
  expect(base.days).toContain(today);
  before = (await overview(admin, { range: '30d' })).data;

  // Three COD orders through the storefront API; one is cancelled (excluded from GMV and orders).
  const a = await placeOrder(shop, shop.simple.variantId, 1);
  const b = await placeOrder(shop, shop.variable.variants[0].id as string, 1);
  const c = await placeOrder(shop, shop.variable.variants[1].id as string, 1);
  const cancel = await transition(shop.s, await orderIdByNumber(shop.s, c.order.number as string), 'cancel', { reason: 'customer_request', notify_customer: false });
  expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
  const [ta, tb] = await orderTotals(shop.s, [a.order.number as string, b.order.number as string]);
  keptGmv = ta + tb;
  expect(keptGmv).toBeGreaterThan(0);

  const run = await aggregate(admin);
  expect(run.as_of).toBe(today);
  after = await overview(admin, { range: '30d' });

  // Meta (§6.2 AnalyticsMeta, P82-17): 30 days ending as_of, Dhaka, BDT.
  expect(after.meta).toMatchObject({ as_of: today, range: '30d', to: today, from: addDays(today, -29), timezone: 'Asia/Dhaka', currency: 'BDT' });
  expect(after.meta.computed_at).toBeTruthy();
  expect(after.meta.data_starts_on <= today).toBe(true);

  // Flows restated on the re-run: exact deltas from this spec's orders (workers: 1, nothing else orders meanwhile).
  const g = after.data.gmv;
  expect(g.amount - before.gmv.amount, 'GMV delta = the two kept orders').toBe(keptGmv);
  expect(g.orders_count - before.gmv.orders_count, 'orders delta = 2 (cancelled excluded)').toBe(2);
  expect(g.aov_amount).toBe(g.orders_count > 0 ? Math.floor(g.amount / g.orders_count) : null);
});

test('overview identities hold (§3: ARR, partition, plan mix, series)', async () => {
  const d = after.data;
  if (d.mrr.amount !== null) expect(d.mrr.arr_amount).toBe(d.mrr.amount * 12);
  const s = d.active_shops;
  expect(s.paying + s.trialing + s.comp + s.free, 'active = paying + trialing + comp + free (P82-12)').toBe(s.total);
  expect(s.past_due).toBeLessThanOrEqual(s.paying);
  expect(d.trial_conversion.trialing_now).toBe(s.trialing);
  expect((d.plan_mix as Json[]).reduce((n, p) => n + p.count, 0), 'plan mix sums to active shops').toBe(s.total);
  const last = (d.mrr_series as Json[]).at(-1)!;
  expect(last.bucket_end).toBe(today);
  expect(last.mrr_amount).toBe(d.mrr.amount);
  expect(Object.values(last.by_plan as Record<string, number>).reduce((n, v) => n + v, 0), 'MRR = Σ by plan').toBe(d.mrr.amount);
  expect((d.mrr_series as Json[]).length, '30d → daily buckets').toBe(30);
  const rate = d.revenue_churn;
  if (rate.rate !== null) expect(rate.rate).toBeCloseTo(rate.churned_amount / rate.opening_mrr_amount, 3);
});

test("the shop's own 30-day metrics equal its orders (P82-11, trialing → 0 MRR)", async () => {
  const { data, meta } = await tenantMetrics(admin, tenantId);
  expect(meta.as_of).toBe(today);
  const sub = await subscription(shop.s);
  expect(sub.status).toBe('trialing');
  expect(data).toMatchObject({
    mrr_amount: 0,
    is_comp: false,
    plan_code: sub.plan.code,
    orders_30d: 2,
    gmv_30d_amount: keptGmv,
    aov_30d_amount: Math.floor(keptGmv / 2),
    gmv_month_amount: keptGmv,
  });
});

test('UI: KPI row, MRR chart and plan mix show the aggregated numbers', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInAdminApp(context, admin);
  await openAdmin(page, '/');
  await settled(page);
  const d = after.data;
  await expect(dataAsOf(page)).toContainText(dayMonth(today));

  await expect(kpi(page, 'Merchant GMV')).toContainText(moneyPattern(d.gmv.amount));
  await expect(kpi(page, 'Merchant GMV')).toContainText(`${count(d.gmv.orders_count)} orders`);
  const mrr = kpi(page, 'MRR');
  await expect(mrr).toContainText(d.mrr.amount === null ? '—' : moneyPattern(d.mrr.amount));
  await expect(mrr).toContainText(/ARR/);
  const shops = kpi(page, 'Active shops');
  await expect(shops).toContainText(count(d.active_shops.total));
  await expect(shops).toContainText(`${count(d.active_shops.paying)} paying · ${count(d.active_shops.free)} free`);
  await expect(kpi(page, 'Trial → paid')).toContainText(`${count(d.trial_conversion.trialing_now)} trials running`);
  // cancellations is null while the window's opening day (from − 1) has no snapshot (P82-9) → the UI prints "—".
  const cancellations = d.revenue_churn.cancellations === null ? '—' : count(d.revenue_churn.cancellations);
  await expect(kpi(page, 'Revenue churn')).toContainText(`${cancellations} cancellations`);

  await expect(card(page, 'Monthly recurring revenue by plan')).toBeVisible();
  await expect(card(page, 'Plan mix')).toContainText(count(d.active_shops.total));
  // Hidden, never faked (§Scope, Q106/Q109/Q111).
  await expect(page.getByText('Integration health')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Export/ })).toHaveCount(0);
  await expect(page.getByText(/\bPro\b/)).toHaveCount(0);
});

test('UI: range tabs switch ?range= and the numbers (P82-17)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInAdminApp(context, admin);
  await openAdmin(page, '/');
  await settled(page);
  for (const [label, range] of [
    ['Quarter', 'quarter'],
    ['12 months', '12m'],
    ['30 days', '30d'],
  ] as const) {
    await rangeTab(page, label).click();
    if (range === '30d') await expect(page).toHaveURL(/(\?|&)range=30d|^[^?]*$/);
    else await expect(page).toHaveURL(new RegExp(`[?&]range=${range}(&|$)`));
    await settled(page);
    const o = (await overview(admin, { range })).data;
    await expect(kpi(page, 'Merchant GMV')).toContainText(moneyPattern(o.gmv.amount));
    await expect(kpi(page, 'Merchant GMV')).toContainText(`${count(o.gmv.orders_count)} orders`);
  }
  // Deep link keeps the range.
  await page.goto(`${adminUrl}/?range=quarter`);
  await expect.poll(() => isSelected(rangeTab(page, 'Quarter'))).toBe(true);
});

test('S83: Support → 403 on /admin/analytics/* and no analytics tiles; per-shop metrics stay visible (Q108)', async ({ page, context }) => {
  test.setTimeout(120_000);
  seedStaff(STAFF.support);
  const support = await adminLogin('admin-p82-support', STAFF.support);
  for (const path of ['/admin/analytics/overview', '/admin/analytics/revenue?range=12m']) {
    const r = await adminApi(support, 'GET', path);
    expect(r.status, `${path}: ${r.text}`).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
  }
  const own = await adminApi(support, 'GET', `/admin/tenants/${tenantId}/metrics`);
  expect(own.status, own.text).toBe(200);
  expect(own.json.data.orders_30d).toBe(2);

  await signInAdminApp(context, support);
  await openAdmin(page, '/');
  await settled(page);
  await expect(kpi(page, 'Active shops')).toBeVisible(); // 8.1 tile stays for every role
  for (const label of ['MRR', 'Merchant GMV', 'Trial → paid', 'Revenue churn']) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Monthly recurring revenue by plan' })).toHaveCount(0);
  await expect(revenueNav(page)).toHaveCount(0);
});

test('S83: Read-only gets the analytics; merchant and guest sessions are refused', async () => {
  test.setTimeout(90_000);
  seedStaff(STAFF.readOnly);
  const ro = await adminLogin('admin-p82-readonly', STAFF.readOnly);
  const r = await adminApi(ro, 'GET', '/admin/analytics/overview');
  expect(r.status, r.text).toBe(200);

  const merchant = await apiCall(shop.s, 'GET', '/admin/analytics/overview');
  expect([401, 403], merchant.text).toContain(merchant.status);
  const guest = await apiCall(null, 'GET', '/admin/analytics/overview');
  expect(guest.status).toBe(401);
});
