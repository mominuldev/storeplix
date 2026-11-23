import { expect, test } from '@playwright/test';
import { PRICE, addDays, clock, invoice, subscribe, subscription, waitBillingPayment } from '../support/billing';
import { setupShop, type CommerceShop } from '../support/commerce';
import { adminLogin, findTenant, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import {
  aggregate,
  avoidDhakaMidnight,
  card,
  compareToggle,
  count,
  dataAsOf,
  dayMonth,
  dhakaToday,
  expectMovementIdentity,
  historyStarts,
  isOn,
  kpi,
  moneyPattern,
  monthYear,
  openAdmin,
  overview,
  revenue,
  setCustomRange,
  settled,
  topMerchantRow,
} from '../support/analytics';

/**
 * PHASE-8-2-CONTRACT §10 QA `phase8-2.revenue` (§3 P82-7/8/9/13/15, §6.2 AdminRevenueReport, §7.1 Revenue reports
 * `39:12705`): a fresh shop ends its trial and pays a monthly plan on the fake billing gateway → aggregate → platform MRR
 * grows by exactly the list price, the shop is in Top paying merchants with plan, provider, interval, customer since and
 * lifetime paid; trial → paid and the trial funnel count it; custom range + compare toggle; a range before
 * `data_starts_on` shows the empty/history state.
 *
 * The shop buys **Growth monthly** (৳ 1,499 MRR, the highest possible per-shop MRR) rather than Starter, so it reaches the
 * top 10 even on a dev DB with many ৳ 499 shops left over; the contract's "MRR ≥ ৳ 499" still holds.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MRR = PRICE.growth.month;
let admin: AdminSession;
let shop: CommerceShop;
let tenantId: string;
let today: string;
let paidTotal = 0;
let before: { rev: Json; ov: Json };
let after: { rev: Json; revMeta: Json; ov: Json };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-p82-revenue');
});
test.afterAll(() => shop?.cleanup());

test('trial ends → pays Growth monthly → aggregate → MRR +৳1,499, paying +1, funnel and trial → paid +1', async () => {
  test.setTimeout(240_000);
  await avoidDhakaMidnight(8);
  today = dhakaToday();

  // Baseline before the shop exists (today's rows for everyone else).
  expect((await aggregate(admin)).as_of).toBe(today);
  before = { rev: (await revenue(admin, { range: '30d' })).data, ov: (await overview(admin, { range: '30d' })).data };

  shop = await setupShop('p82r'); // published store (funnel: store_published)
  tenantId = (await findTenant(admin, shop.t.email)).id as string;
  const ended = await clock(shop.s, 'trial_ended'); // trial_ends_at = now − 1 min → Free
  expect([ended.status, ended.plan.code]).toEqual(['active', 'free']);
  const { invoice: inv, payment } = await subscribe(shop.s, 'growth', 'month', 'bkash');
  await waitBillingPayment(shop.s, payment.id as string, 'succeeded');
  const sub = await subscription(shop.s);
  expect([sub.status, sub.plan.code, sub.billing_interval]).toEqual(['active', 'growth', 'month']);
  const paid = await invoice(shop.s, inv.id as string);
  expect(paid.status).toBe('paid');
  paidTotal = paid.total_amount as number;

  expect((await aggregate(admin)).as_of).toBe(today);
  const r = await revenue(admin, { range: '30d' });
  after = { rev: r.data, revMeta: r.meta, ov: (await overview(admin, { range: '30d' })).data };

  const k0 = before.rev.kpis;
  const k1 = after.rev.kpis;
  // P82-7: active + active subscription + paid plan + a paid invoice on the row (not comp) → list price.
  expect(k1.mrr.amount - (k0.mrr.amount ?? 0), 'platform MRR delta = Growth monthly list price').toBe(MRR);
  expect(k1.mrr.amount).toBeGreaterThanOrEqual(PRICE.starter.month);
  expect(k1.arr.amount).toBe(k1.mrr.amount * 12);
  expect(k1.arpa.paying - (k0.arpa.paying ?? 0), 'paying +1').toBe(1);
  expect(k1.arpa.amount).toBe(Math.floor(k1.mrr.amount / k1.arpa.paying));

  // §6.2 by_plan: Growth row +1 shop, +MRR; totals add up.
  const growth = (p: Json) => (p.by_plan.rows as Json[]).find((x) => x.plan_code === 'growth')!;
  expect(growth(after.rev).shops - growth(before.rev).shops).toBe(1);
  expect(growth(after.rev).mrr_amount - growth(before.rev).mrr_amount).toBe(MRR);
  expect((after.rev.by_plan.rows as Json[]).map((x) => x.plan_code), 'plans order desc, no Pro').toEqual(['growth', 'starter', 'free']);
  expect((after.rev.by_plan.rows as Json[]).reduce((n, x) => n + x.mrr_amount, 0)).toBe(after.rev.by_plan.total.mrr_amount);
  expect(after.rev.by_plan.total.mrr_amount).toBe(k1.mrr.amount);

  // P82-15 funnel over tenants created in the range (live): signed up, published, trial ended, converted.
  const f0 = before.rev.trial_funnel;
  const f1 = after.rev.trial_funnel;
  expect([f1.signed_up - f0.signed_up, f1.store_published - f0.store_published, f1.trial_ended - f0.trial_ended, f1.converted - f0.converted]).toEqual([1, 1, 1, 1]);
  if (f1.signed_up > 0) expect(f1.signup_to_paid_rate).toBeCloseTo(f1.converted / f1.signed_up, 3);

  // P82-13 trial → paid on the dashboard: trial ended today, paid the same day → ended +1, converted +1.
  const t0 = before.ov.trial_conversion;
  const t1 = after.ov.trial_conversion;
  expect([t1.ended - t0.ended, t1.converted - t0.converted]).toEqual([1, 1]);
  if (t1.ended > 0) expect(t1.rate).toBeCloseTo(t1.converted / t1.ended, 3);

  // P82-9 identities on every bucket and the range KPI.
  for (const m of after.rev.movement as Json[]) expectMovementIdentity(m, `bucket ${m.bucket_start}`);
  const nn = k1.net_new_mrr;
  if (nn.amount !== null) expect(nn.new_amount + nn.expansion_amount - nn.contraction_amount - nn.churned_amount).toBe(nn.amount);
});

test('API: the shop is in Top paying merchants with plan, provider, interval, since and lifetime paid (§6.2)', async () => {
  const top = after.rev.top_merchants as Json[];
  expect(top.length).toBeLessThanOrEqual(10);
  for (let i = 1; i < top.length; i++) expect(top[i - 1].mrr_amount).toBeGreaterThanOrEqual(top[i].mrr_amount);
  const row = top.find((t) => t.tenant.id === tenantId);
  expect(row, `shop in top_merchants: ${JSON.stringify(top.map((t) => [t.tenant.name, t.mrr_amount]))}`).toBeTruthy();
  expect(row).toMatchObject({
    plan_code: 'growth',
    billing_interval: 'month',
    last_payment_provider: 'bkash',
    mrr_amount: MRR,
    customer_since: today,
    lifetime_paid_amount: paidTotal,
  });
  // Cohort of the first paid month (P82-14): this month's cohort exists and M0 is 100 % paying for it at as_of.
  const cohort = (after.rev.cohorts.rows as Json[]).find((c) => c.cohort === today.slice(0, 7));
  expect(cohort, 'current month cohort').toBeTruthy();
  expect(cohort!.size).toBeGreaterThanOrEqual(1);
  expect(cohort!.retention).toHaveLength(1);
});

test('UI: KPIs and Top paying merchants (default 12 months)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInAdminApp(context, admin);
  await openAdmin(page, '/revenue');
  await settled(page);
  await expect(dataAsOf(page)).toContainText(dayMonth(today));
  const r12 = (await revenue(admin)).data; // default range 12m
  await expect(kpi(page, 'MRR')).toContainText(moneyPattern(r12.kpis.mrr.amount));
  await expect(kpi(page, 'ARR')).toContainText(moneyPattern(r12.kpis.arr.amount));
  await expect(kpi(page, 'ARR')).toContainText(`${count(r12.kpis.arpa.paying)} paying`);
  await expect(kpi(page, 'ARPA')).toContainText(moneyPattern(r12.kpis.arpa.amount));
  for (const title of ['MRR movement', 'Cohort retention', 'Revenue by plan', 'Trial funnel']) await expect(card(page, title)).toBeVisible();
  await expect(card(page, 'Cohort retention')).toContainText(/by first paid month/);

  const row = topMerchantRow(page, 'QA p82r');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Growth');
  await expect(row).toContainText(/bKash\s*·\s*monthly/i);
  await expect(row).toContainText(moneyPattern(MRR));
  await expect(row).toContainText(monthYear(today));
  await expect(row).toContainText(moneyPattern(paidTotal));
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/merchants/${tenantId}$`));
});

test('UI: custom range and the compare toggle (P82-17)', async ({ page, context }) => {
  test.setTimeout(120_000);
  // A snapshot for the previous period's last day (within the 7-day catch-up window), so "previous" has a value.
  const from = addDays(today, -3);
  await aggregate(admin, { from: addDays(today, -4), to: addDays(today, -4) });
  const api = await revenue(admin, { range: 'custom', from, to: today });
  expect(api.meta).toMatchObject({ range: 'custom', from, to: today, previous_to: addDays(today, -4), previous_from: addDays(today, -7), granularity: 'day' });
  expect(api.data.kpis.mrr.previous_amount).not.toBeNull();

  await signInAdminApp(context, admin);
  await openAdmin(page, '/revenue');
  await settled(page);
  await setCustomRange(page, from, today);
  await expect(page).toHaveURL(/[?&]range=custom/);
  await expect(page).toHaveURL(new RegExp(`[?&]from=${from}`));
  await settled(page);
  await expect(kpi(page, 'MRR')).toContainText(moneyPattern(api.data.kpis.mrr.amount));

  // Compare on → the previous value caption ("vs … in …") is shown; off → hidden (client-side only).
  const toggle = compareToggle(page);
  if (!(await isOn(toggle))) await toggle.click();
  await expect.poll(() => isOn(toggle)).toBe(true);
  await expect(kpi(page, 'MRR')).toContainText(/vs /);
  await expect(kpi(page, 'MRR')).toContainText(moneyPattern(api.data.kpis.mrr.previous_amount));
  await toggle.click();
  await expect.poll(() => isOn(toggle)).toBe(false);
  await expect(kpi(page, 'MRR')).not.toContainText(/vs /);
});

test('a range before data_starts_on: null metrics in the API, history note and "—" in the UI', async ({ page, context }) => {
  test.setTimeout(90_000);
  // Re-read: the compare test aggregates an earlier day, which moves data_starts_on back after `after` was captured.
  const starts = (await revenue(admin, { range: '30d' })).meta.data_starts_on as string;
  test.skip(!starts || starts <= '2024-01-01', `data_starts_on ${starts}: no valid custom range before it (from ≥ 2024-01-01)`);
  const to = addDays(starts, -1);
  const from = addDays(to, -13) < '2024-01-01' ? '2024-01-01' : addDays(to, -13);
  const r = await revenue(admin, { range: 'custom', from, to });
  expect(r.meta.data_starts_on).toBe(starts);
  expect([r.data.kpis.mrr.amount, r.data.kpis.arr.amount, r.data.kpis.net_new_mrr.amount]).toEqual([null, null, null]);
  for (const m of r.data.movement as Json[]) expect([m.opening_mrr_amount, m.closing_mrr_amount, m.net_new_amount]).toEqual([null, null, null]);

  await signInAdminApp(context, admin);
  await openAdmin(page, `/revenue?range=custom&from=${from}&to=${to}`);
  await settled(page);
  await expect(historyStarts(page)).toBeVisible();
  await expect(kpi(page, 'MRR')).toContainText('—');
});
