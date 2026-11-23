import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_ROOT, api, cookieLogin } from '../support/api';
import { PRICE, clock, invoice, subscribe, waitBillingPayment } from '../support/billing';
import { placeOrder, setupShop, type CommerceShop } from '../support/commerce';
import { adminApi, adminLogin, adminUrl, findTenant, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import {
  aggregate,
  avoidDhakaMidnight,
  dhakaToday,
  gmvCard,
  kpi,
  merchantCell,
  merchantsTable,
  moneyPattern,
  orderTotals,
  resetLastActive,
  settled,
  sortMerchants,
  tenantMetrics,
  tenantSummary,
  tenantsList,
} from '../support/analytics';

/**
 * PHASE-8-2-CONTRACT §10 QA `phase8-2.merchant-metrics` (§6.1 `/admin/tenants` sorts + `metrics`, §6.2
 * AdminTenantMetrics, P82-16 last active, §7.1 Merchants `32:5527` and Merchant detail `33:4851`): a fresh shop pays
 * Starter monthly and takes two COD orders → aggregate → list metrics, sorts and detail tiles equal those numbers; "Last
 * active" is "—" after a reset and moves when the merchant signs in.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MRR = PRICE.starter.month;
const PASSWORD = 'E2eTenant12345'; // createTenant()
let admin: AdminSession;
let shop: CommerceShop;
let tenantId: string;
let today: string;
let gmv = 0;
let paidTotal = 0;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-p82-metrics');
  await avoidDhakaMidnight(8);
  today = dhakaToday();
  shop = await setupShop('p82m');
  tenantId = (await findTenant(admin, shop.t.email)).id as string;
  expect((await clock(shop.s, 'trial_ended')).plan.code).toBe('free');
  const { invoice: inv, payment } = await subscribe(shop.s, 'starter', 'month', 'bkash');
  await waitBillingPayment(shop.s, payment.id as string, 'succeeded');
  paidTotal = (await invoice(shop.s, inv.id as string)).total_amount as number;
  const a = await placeOrder(shop, shop.simple.variantId, 1);
  const b = await placeOrder(shop, shop.variable.variants[0].id as string, 2);
  gmv = (await orderTotals(shop.s, [a.order.number as string, b.order.number as string])).reduce((x, y) => x + y, 0);
  expect((await aggregate(admin)).as_of).toBe(today);
});
test.afterAll(() => shop?.cleanup());

test('API: AdminTenantMetrics equals the shop data (P82-7, P82-11)', async () => {
  const { data, meta } = await tenantMetrics(admin, tenantId);
  expect(meta).toMatchObject({ as_of: today, range: '30d', to: today });
  expect(data).toMatchObject({
    mrr_amount: MRR,
    is_comp: false,
    plan_code: 'starter',
    billing_interval: 'month',
    orders_30d: 2,
    gmv_30d_amount: gmv,
    aov_30d_amount: Math.floor(gmv / 2),
    gmv_month_amount: gmv,
    avg_orders_per_day_30d: 0.1, // 2 / 30, 1 decimal
    paid_12m_amount: paidTotal,
  });
  const months = data.monthly as Json[];
  expect(months).toHaveLength(12);
  expect(months.at(-1)).toMatchObject({ month: today.slice(0, 7), gmv_amount: gmv, orders_count: 2 });

  expect((await adminApi(admin, 'GET', '/admin/tenants/01AAAAAAAAAAAAAAAAAAAAAAAA/metrics')).status, 'unknown tenant').toBe(404);
});

test('API: list metrics and metric sorts (nulls last, §6.1)', async () => {
  const t = await tenantSummary(admin, shop.t.slug, tenantId);
  expect(t.metrics).toEqual({ as_of: today, mrr_amount: MRR, is_comp: false, orders_30d: 2, gmv_30d_amount: gmv });

  const byMrr = await tenantsList(admin, `sort=-mrr&per_page=100`);
  expect(byMrr.meta.metrics_as_of).toBe(today);
  const sorted = (rows: Json[], key: (t: Json) => number | string | null, label: string) => {
    const vals = rows.map(key);
    const firstNull = vals.findIndex((v) => v === null);
    if (firstNull >= 0) expect(vals.slice(firstNull).every((v) => v === null), `${label}: nulls last`).toBe(true);
    const nn = vals.filter((v) => v !== null) as (number | string)[];
    for (let i = 1; i < nn.length; i++) expect(nn[i - 1] >= nn[i], `${label}: ${nn[i - 1]} ≥ ${nn[i]}`).toBe(true);
  };
  sorted(byMrr.data, (t) => t.metrics?.mrr_amount ?? null, '-mrr');
  sorted((await tenantsList(admin, 'sort=-gmv_30d&per_page=100')).data, (t) => t.metrics?.gmv_30d_amount ?? null, '-gmv_30d');
  sorted((await tenantsList(admin, 'sort=-orders_30d&per_page=100')).data, (t) => t.metrics?.orders_30d ?? null, '-orders_30d');
  sorted((await tenantsList(admin, 'sort=-last_active_at&per_page=100')).data, (t) => (t.last_active_at ? Date.parse(t.last_active_at) : null), '-last_active_at');
  const mine = await tenantsList(admin, `sort=-mrr&filter[q]=${encodeURIComponent(shop.t.slug)}`);
  expect(mine.data.map((x) => x.id)).toContain(tenantId);
});

test('UI: merchants list — Sort "MRR · high to low", metric columns, Last active "—" then set after sign-in (P82-16)', async ({ page, context }) => {
  test.setTimeout(120_000);
  resetLastActive(tenantId);
  expect((await tenantSummary(admin, shop.t.slug, tenantId)).last_active_at).toBeNull();

  await signInAdminApp(context, admin);
  await page.goto(`${adminUrl}/merchants?q=${encodeURIComponent(shop.t.slug)}`);
  await expect(page.getByRole('heading', { name: 'Merchants', level: 1 })).toBeVisible();
  await sortMerchants(page, 'MRR · high to low');
  await expect(page).toHaveURL(/[?&]sort=-mrr(&|$)/);
  await settled(page);
  await expect(merchantsTable(page).getByRole('row').filter({ hasText: 'QA p82m' })).toHaveCount(1);
  await expect(await merchantCell(page, 'QA p82m', /^MRR/i)).toContainText(moneyPattern(MRR, { symbol: 'optional' }), { useInnerText: true });
  await expect(await merchantCell(page, 'QA p82m', /^Orders 30d/i)).toHaveText(/^\s*2\s*$/, { useInnerText: true });
  await expect(await merchantCell(page, 'QA p82m', /^GMV 30d/i)).toContainText(moneyPattern(gmv, { symbol: 'optional' }), { useInnerText: true });
  await expect(await merchantCell(page, 'QA p82m', /^Last active/i)).toHaveText(/^\s*—\s*$/, { useInnerText: true });

  // The merchant signs in (merchant surface) → last_active_at set once (15-min throttle).
  const t0 = Date.now();
  const fresh = await cookieLogin(shop.t.email, PASSWORD, resolve(E2E_ROOT, `.auth/${shop.t.email.split('@')[0]}-p82.json`));
  expect((await api(fresh, 'GET', `/stores/${fresh.storeId}`)).status).toBe(200);
  await expect
    .poll(async () => (await tenantSummary(admin, shop.t.slug, tenantId)).last_active_at as string | null, { timeout: 15_000 })
    .not.toBeNull();
  const at = Date.parse((await tenantSummary(admin, shop.t.slug, tenantId)).last_active_at as string);
  expect(at).toBeGreaterThanOrEqual(t0 - 60_000);
  expect(at).toBeLessThanOrEqual(Date.now() + 60_000);

  await page.reload();
  await settled(page);
  await expect(await merchantCell(page, 'QA p82m', /^Last active/i)).toHaveText(/just now|now|second|minute|min|ago/i, { useInnerText: true });
});

test('UI: merchant detail tiles and the "GMV & platform revenue" card', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInAdminApp(context, admin);
  await page.goto(`${adminUrl}/merchants/${tenantId}`);
  await expect(page.getByRole('heading', { name: 'QA p82m', exact: true })).toBeVisible();
  await settled(page);

  const mrr = kpi(page, 'MRR');
  await expect(mrr).toContainText(moneyPattern(MRR));
  await expect(mrr).toContainText(/Starter\s*·\s*monthly/i);
  await expect(kpi(page, 'Orders · 30d')).toContainText('2');
  const g = kpi(page, 'GMV · 30d');
  await expect(g).toContainText(moneyPattern(gmv));
  await expect(g).toContainText(/AOV/);
  await expect(g).toContainText(moneyPattern(Math.floor(gmv / 2)));
  await expect(kpi(page, 'Lifetime paid')).toContainText(moneyPattern(paidTotal));
  await expect(page.getByText('Health score')).toHaveCount(0); // Q105

  const c = gmvCard(page);
  await expect(c).toBeVisible();
  await expect(kpi(c, 'GMV this month')).toContainText(moneyPattern(gmv));
  await expect(kpi(c, 'Paid to Storeplix (12 mo)')).toContainText(moneyPattern(paidTotal));
  await expect(kpi(c, 'Avg orders / day')).toContainText('0.1');
});
