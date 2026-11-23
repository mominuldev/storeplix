import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { rawFetch, setupShop, sf, type CommerceShop } from '../support/commerce';
import {
  PRICE,
  billingPayment,
  binaryGet,
  changePlan,
  chooseInterval,
  clickFakeBilling,
  clock,
  confirmChange,
  dialog,
  fakeBillingOutcome,
  fakeBillingReturnUrl,
  features,
  invoice,
  invoiceRow,
  invoices,
  openPlan,
  payInDialog,
  payInvoice,
  payNow,
  planCta,
  quote,
  subscribe,
  subscription,
  waitBillingPayment,
} from '../support/billing';
import { devDns, devProvider, getDomain, listDomains, waitDomainStatus } from '../support/domains';

/**
 * PHASE-7-CONTRACT §11 QA (billing-upgrade, billing-failures, billing-renewal, billing-downgrade) on the fake platform
 * gateway (`BILLING_FAKE=true`) and the testing-only billing clock (`POST /dev/billing/clock`, §4.6). One FRESH
 * merchant per describe (never the demo tenant, which stays on its trial).
 */
const ms = (iso: string) => new Date(iso).getTime();
const DAY = 86_400_000;
const ceil100 = (n: number) => Math.ceil(n / 100) * 100;

/** A fresh shop dropped to Free through the real trial-end path (`dev clock trial_ended`). */
async function freeShop(label: string): Promise<CommerceShop> {
  const shop = await setupShop(label);
  const before = await subscription(shop.s);
  expect([before.status, before.plan.code]).toEqual(['trialing', 'starter']);
  const after = await clock(shop.s, 'trial_ended');
  expect([after.status, after.plan.code]).toEqual(['active', 'free']);
  return shop;
}

/** Success state of the return page (§8.2 Return). */
async function expectPaidReturn(page: Page, planName: string) {
  await expect(page).toHaveURL(/\/settings\/plan/, { timeout: 30_000 });
  await expect(page.getByText(new RegExp(`You[’']re on ${planName}`)).first()).toBeVisible({ timeout: 30_000 });
}

test.describe('billing-upgrade: Free → Starter (UI, fake bKash) → Growth (proration)', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;
  let paidInvoiceId: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await freeShop('bup');
  });
  test.afterAll(() => shop?.cleanup());

  test('API: plans have yearly prices, quotes per kind, §6.0 codes', async () => {
    const plans = await api(null, 'GET', '/plans');
    expect(plans.status).toBe(200);
    const by = Object.fromEntries((plans.json.data as Record<string, unknown>[]).map((p) => [p.code, p]));
    expect([by.starter.price_amount, by.starter.price_yearly_amount, by.growth.price_amount, by.growth.price_yearly_amount, by.free.price_yearly_amount])
      .toEqual([PRICE.starter.month, PRICE.starter.year, PRICE.growth.month, PRICE.growth.year, null]);

    const q = await quote(shop.s, 'starter', 'month');
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    expect(q.json.data).toMatchObject({ kind: 'new', amount: PRICE.starter.month, currency: 'BDT', requires_payment: true, interval: 'month' });
    expect(q.json.data.plan.code).toBe('starter');
    const qy = await quote(shop.s, 'growth', 'year');
    expect([qy.json.data.kind, qy.json.data.amount]).toEqual(['new', PRICE.growth.year]);

    expect([(await quote(shop.s, 'free', 'year')).status, (await quote(shop.s, 'free', 'year')).json.error?.code]).toEqual([422, 'plan_unavailable']);
    const same = await quote(shop.s, 'free', 'month');
    expect([same.status, same.json.error?.code]).toEqual([409, 'plan_unchanged']);
    const unknown = await quote(shop.s, 'platinum', 'month');
    expect([unknown.status, unknown.json.error?.code]).toEqual([422, 'plan_unavailable']);
    // Idempotency-Key is required on change-plan (400)
    expect((await changePlan(shop.s, 'starter', 'month', null)).status).toBe(400);
    // nothing was issued by quotes
    expect((await invoices(shop.s)).data).toHaveLength(0);
  });

  test('UI: Upgrade to Starter monthly → quote → pay with fake bKash → "You\'re on Starter", invoice Paid, PDF', async ({ page, context }) => {
    test.setTimeout(150_000);
    await signInDashboard(context, shop.s);
    await openPlan(page);
    await chooseInterval(page, 'month');
    await planCta(page, 'Starter').click();
    await expect(dialog(page)).toContainText(/৳\s?499/);
    await confirmChange(page);
    // §8.2: for `new`/`upgrade` the dialog continues to Pay
    await payInDialog(page, 'bkash');
    await clickFakeBilling(page, 'pay');
    await expectPaidReturn(page, 'Starter');
    // query params removed after reading (§8.2 Return)
    await expect(page).not.toHaveURL(/payment=/, { timeout: 10_000 });

    const sub = await subscription(shop.s);
    expect([sub.status, sub.plan.code, sub.billing_interval, sub.open_invoice]).toEqual(['active', 'starter', 'month', null]);
    // new from a period-less Free row: period starts at payment, ends ~1 month later (P7-6)
    const len = ms(sub.current_period_end) - ms(sub.current_period_start);
    expect(len).toBeGreaterThanOrEqual(28 * DAY);
    expect(len).toBeLessThanOrEqual(31 * DAY + 60_000);
    expect((await features(shop.s)).plan_code).toBe('starter');

    const list = await invoices(shop.s);
    expect(list.data).toHaveLength(1);
    const inv = list.data[0];
    expect(inv).toMatchObject({ kind: 'new', status: 'paid', total_amount: PRICE.starter.month, currency: 'BDT', is_overdue: false, can_pay: false });
    expect(inv.number).toMatch(/^SP-\d{4}-\d{6}$/);
    paidInvoiceId = inv.id;
    const full = await invoice(shop.s, inv.id);
    // VAT-inclusive 15 % (P7-15): tax = floor(total × 1500 / 11500)
    expect([full.tax_rate_bps, full.tax_amount, full.subtotal_amount]).toEqual([1500, Math.floor((PRICE.starter.month * 1500) / 11500), PRICE.starter.month - Math.floor((PRICE.starter.month * 1500) / 11500)]);
    expect(full.payments).toHaveLength(1);
    expect(full.payments[0]).toMatchObject({ provider: 'bkash', status: 'succeeded', amount: PRICE.starter.month, is_duplicate: false, redirect_url: null });
    expect(JSON.stringify(full)).not.toMatch(/"raw"|app_secret|store_passwd/);

    // UI invoices table: the row says Paid
    await openPlan(page);
    await expect(invoiceRow(page, inv.number)).toContainText(/Paid/);

    // PDF (P7-15): attachment named after the number, private no-store
    const pdf = await binaryGet(shop.s, `/billing/invoices/${inv.id}/pdf`);
    expect(pdf.status, pdf.body.toString('utf8', 0, 300)).toBe(200);
    // `.pdf` with Gotenberg; the e2e stack's DOCUMENTS_DRIVER=html serves the stored HTML as `{number}.html`
    expect(pdf.headers['content-disposition'] ?? '').toMatch(new RegExp(`attachment; filename="${inv.number}\\.(pdf|html)"`));
    expect(pdf.headers['cache-control'] ?? '').toMatch(/no-store/);
    // DOCUMENTS_DRIVER=gotenberg → a real PDF; the e2e stack's `html` driver may store HTML instead (5b-4 P5B-57)
    const head = pdf.body.toString('latin1', 0, 5);
    if (head !== '%PDF-') expect(pdf.body.toString('utf8')).toContain(inv.number);
    test.info().annotations.push({ type: 'pdf', description: head === '%PDF-' ? 'real PDF' : `not a PDF (${pdf.headers['content-type']})` });
  });

  test('S61/S62: change-plan and pay are idempotent; posted amount/status/period are ignored', async () => {
    const key = randomUUID();
    const a = await changePlan(shop.s, 'growth', 'month', key, { amount: 100, total_amount: 100, status: 'paid', plan_id: 'x', current_period_end: '2099-01-01T00:00:00Z' });
    expect(a.status, a.text).toBe(201);
    const b = await changePlan(shop.s, 'growth', 'month', key, { amount: 100, total_amount: 100, status: 'paid', plan_id: 'x', current_period_end: '2099-01-01T00:00:00Z' });
    expect([b.status, b.json.data?.invoice?.id]).toEqual([201, a.json.data.invoice.id]);
    const inv = a.json.data.invoice;
    expect([inv.kind, inv.status]).toEqual(['upgrade', 'open']);
    expect(inv.total_amount).toBeGreaterThanOrEqual(100);
    expect((await subscription(shop.s)).current_period_end).not.toContain('2099');

    const payKey = randomUUID();
    const p1 = await payInvoice(shop.s, inv.id, 'sslcommerz', payKey, { amount: 1, status: 'succeeded' });
    expect(p1.status, p1.text).toBe(201);
    const p2 = await payInvoice(shop.s, inv.id, 'sslcommerz', payKey);
    expect([p2.status, p2.json.data?.id]).toEqual([201, p1.json.data.id]);
    expect([p1.json.data.status, p1.json.data.amount]).toEqual(['pending', inv.total_amount]);
    // a paid invoice can't be paid again
    const again = await payInvoice(shop.s, paidInvoiceId, 'bkash');
    expect([again.status, again.json.error?.code]).toEqual([409, 'invoice_not_open']);
  });

  test('upgrade Starter → Growth mid-period: prorated difference (ceil to taka), period unchanged, fake SSLCommerz', async () => {
    const before = await subscription(shop.s);
    const q = await quote(shop.s, 'growth', 'month');
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    expect(q.json.data.kind).toBe('upgrade');
    const remaining = ms(before.current_period_end) - Date.now();
    const period = ms(before.current_period_end) - ms(before.current_period_start);
    const expected = Math.max(100, ceil100(((PRICE.growth.month - PRICE.starter.month) * remaining) / period));
    // a few seconds pass between our clock and the API's: allow one taka
    expect(Math.abs(q.json.data.amount - expected)).toBeLessThanOrEqual(100);
    expect(q.json.data.amount % 100).toBe(0);

    const change = await changePlan(shop.s, 'growth', 'month');
    expect(change.status, change.text).toBe(201);
    const inv = change.json.data.invoice;
    // one open invoice per tenant: the previous upgrade invoice was superseded (P7-7)
    const all = await invoices(shop.s);
    expect(all.data.filter((i) => i.status === 'open')).toHaveLength(1);
    expect(Math.abs(inv.total_amount - q.json.data.amount)).toBeLessThanOrEqual(100);

    const pay = await payInvoice(shop.s, inv.id, 'sslcommerz');
    expect(pay.status, pay.text).toBe(201);
    const r = await fakeBillingOutcome(pay.json.data.redirect_url, 'pay');
    expect(r.finalUrl).toMatch(new RegExp(`^${urls.merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/settings/plan\\?payment=${pay.json.data.id}$`));
    expect(r.hops.some((h) => h.status === 303)).toBe(true);
    await waitBillingPayment(shop.s, pay.json.data.id, 'succeeded');
    const after = await subscription(shop.s);
    expect([after.plan.code, after.status, after.current_period_end, after.current_period_start]).toEqual(['growth', 'active', before.current_period_end, before.current_period_start]);
    expect((await features(shop.s)).features.profit_reports).toBe(true);
  });
});

test.describe('billing-failures: Fail, Pay wrong amount, Cancel, Pay then time out; forged returns', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;
  let invoiceId: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await freeShop('bfail');
    const c = await changePlan(shop.s, 'starter', 'month');
    expect(c.status, c.text).toBe(201);
    invoiceId = c.json.data.invoice.id;
  });
  test.afterAll(() => shop?.cleanup());

  test('UI: Fail → "Payment didn\'t go through", plan unchanged, Pay again offered', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signInDashboard(context, shop.s);
    await openPlan(page);
    // the open invoice row offers Pay
    const inv = await invoice(shop.s, invoiceId);
    await invoiceRow(page, inv.number).getByRole('button', { name: /^Pay/ }).click();
    await payInDialog(page, 'bkash');
    await clickFakeBilling(page, 'fail');
    await expect(page).toHaveURL(/\/settings\/plan/, { timeout: 30_000 });
    await expect(page.getByText(/Payment didn.t go through/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/haven.t been charged/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Pay again/ }).first()).toBeVisible();
    const sub = await subscription(shop.s);
    expect(sub.plan.code).toBe('free');
    const fresh = await invoice(shop.s, invoiceId);
    expect(fresh.status).toBe('open');
    expect(fresh.payments.map((p: { status: string }) => p.status)).toEqual(['failed']);
  });

  test('S54: Pay wrong amount → failed amount_mismatch, invoice open, plan unchanged', async () => {
    const pay = await payInvoice(shop.s, invoiceId, 'bkash');
    expect(pay.status, pay.text).toBe(201);
    await fakeBillingOutcome(pay.json.data.redirect_url, 'wrong_amount');
    const p = await waitBillingPayment(shop.s, pay.json.data.id, 'failed');
    expect(p.failure_code).toBe('amount_mismatch');
    expect((await invoice(shop.s, invoiceId)).status).toBe('open');
    expect((await subscription(shop.s)).plan.code).toBe('free');
  });

  test('Cancel → cancelled; plan unchanged', async () => {
    const pay = await payInvoice(shop.s, invoiceId, 'sslcommerz');
    expect(pay.status, pay.text).toBe(201);
    const r = await fakeBillingOutcome(pay.json.data.redirect_url, 'cancel');
    expect(r.finalUrl).toContain(`/settings/plan?payment=${pay.json.data.id}`);
    await waitBillingPayment(shop.s, pay.json.data.id, 'cancelled');
    expect((await subscription(shop.s)).plan.code).toBe('free');
  });

  test('S53/S59: forged and tampered returns never pay and only ever redirect to the merchant app', async () => {
    const pay = await payInvoice(shop.s, invoiceId, 'bkash');
    expect(pay.status, pay.text).toBe(201);
    const paymentId = pay.json.data.id as string;
    // signed return for a "fail" click, then forged: status=success, plus an open-redirect attempt
    const signed = await fakeBillingReturnUrl(pay.json.data.redirect_url, 'fail');
    const forged = new URL(signed);
    forged.searchParams.set('status', 'success');
    forged.searchParams.set('next', 'https://evil.example/');
    const f = await rawFetch(forged.toString());
    // an extra query param breaks the signature → generic error page on the merchant app (no detail)
    expect([303, 302]).toContain(f.status);
    expect(f.headers.location ?? '').toMatch(new RegExp(`^${urls.merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/settings/plan\\?`));
    expect(f.headers.location).not.toContain('evil');
    // tampered signature
    const bad = new URL(signed);
    bad.searchParams.set('signature', 'f'.repeat(64));
    const t = await rawFetch(bad.toString());
    expect(t.headers.location ?? '').toContain('/settings/plan?payment_error=1');
    // unknown payment id
    const unknown = new URL(signed);
    unknown.pathname = unknown.pathname.replace(paymentId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect((await rawFetch(unknown.toString())).headers.location ?? '').toContain('payment_error=1');
    // the genuine signed return: the provider said failed → payment failed, invoice still open
    const g = await rawFetch(signed);
    expect(g.headers.location ?? '').toContain(`/settings/plan?payment=${paymentId}`);
    expect((await waitBillingPayment(shop.s, paymentId, 'failed')).status).toBe('failed');
    expect((await invoice(shop.s, invoiceId)).status).toBe('open');
    expect((await subscription(shop.s)).plan.code).toBe('free');
  });

  test('"Pay, then time out" → pending, then paid by the status query (reconcile path)', async () => {
    test.setTimeout(120_000);
    const pay = await payInvoice(shop.s, invoiceId, 'bkash');
    expect(pay.status, pay.text).toBe(201);
    await fakeBillingOutcome(pay.json.data.redirect_url, 'timeout');
    // complete() threw provider_unavailable: still pending right after the return
    expect(['pending', 'succeeded']).toContain((await billingPayment(shop.s, pay.json.data.id)).status);
    const p = await waitBillingPayment(shop.s, pay.json.data.id, 'succeeded', 60_000);
    expect(p.is_duplicate).toBe(false);
    expect((await invoice(shop.s, invoiceId)).status).toBe('paid');
    expect((await subscription(shop.s)).plan.code).toBe('starter');
  });
});

test.describe('billing-renewal: renewal_due → pay (fake SSLCommerz) → period extended; past_due → grace_ended → Free, domain detached', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;
  let domainId: string;
  let customHost: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await freeShop('bren');
    await subscribe(shop.s, 'starter', 'month', 'bkash');
    await expect.poll(async () => (await subscription(shop.s)).plan.code, { timeout: 30_000 }).toBe('starter');
    // a connected custom domain, made primary (Phase 6 fake drivers)
    customHost = `shop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.localhost`;
    const add = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: customHost });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    domainId = add.json.data.id;
    await devDns(domainId, { ownership: 'correct', routing: 'correct' }, true);
    await devProvider(domainId, { hostname_status: 'active', ssl_status: 'active' }, true);
    await waitDomainStatus(shop.s, domainId, 'active');
    const prim = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains/${domainId}/primary`, {});
    expect(prim.status, JSON.stringify(prim.json)).toBe(200);
  });
  test.afterAll(() => shop?.cleanup());

  test('renewal_due → renewal invoice + banner → Pay now with fake SSLCommerz → period extended from the old end', async ({ page, context }) => {
    test.setTimeout(150_000);
    const before = await clock(shop.s, 'renewal_due');
    expect(before.open_invoice, JSON.stringify(before)).toBeTruthy();
    expect([before.open_invoice.kind, before.open_invoice.status, before.open_invoice.total_amount]).toEqual(['renewal', 'open', PRICE.starter.month]);
    expect(Math.abs(ms(before.open_invoice.due_at) - ms(before.current_period_end))).toBeLessThan(1_000);

    await signInDashboard(context, shop.s);
    await openPlan(page);
    await expect(page.getByText(/Your Starter plan renews on/).first()).toBeVisible({ timeout: 20_000 });
    await payNow(page).click();
    await payInDialog(page, 'sslcommerz');
    await clickFakeBilling(page, 'pay');
    await expect(page).toHaveURL(/\/settings\/plan/, { timeout: 30_000 });
    await expect(page.getByText(/Receipt SP-|You[’']re on Starter/).first()).toBeVisible({ timeout: 30_000 });

    const after = await subscription(shop.s);
    expect(after.status).toBe('active');
    expect(after.current_period_start).toBe(before.current_period_end);
    const added = ms(after.current_period_end) - ms(before.current_period_end);
    expect(added).toBeGreaterThanOrEqual(28 * DAY);
    expect(added).toBeLessThanOrEqual(31 * DAY + 60_000);
    expect(after.open_invoice).toBeNull();
    await expect(page.getByText(/renews on/)).toHaveCount(0);
  });

  test('unpaid renewal: period_ended → past_due (features kept, 148:35383 banner) → grace_ended → Free, invoice Void, custom domain detached', async ({ page, context }) => {
    test.setTimeout(150_000);
    const due = await clock(shop.s, 'renewal_due');
    const renewalId = due.open_invoice.id as string;
    const pd = await clock(shop.s, 'period_ended');
    expect(pd.status).toBe('past_due');
    expect(pd.grace_ends_at).toBeTruthy();
    expect(ms(pd.grace_ends_at) - ms(pd.past_due_at ?? pd.current_period_end)).toBeLessThanOrEqual(7 * DAY + 60_000);
    // P7-1: past_due keeps the paid plan's features
    const f = await features(shop.s);
    expect([f.plan_code, f.subscription_status, f.features.custom_domain]).toEqual(['starter', 'past_due', true]);
    expect(f.grace_ends_at).toBe(pd.grace_ends_at);
    expect((await getDomain(shop.s, domainId)).status).toBe('active');
    // in past_due only cancel is accepted (§3.3)
    const up = await quote(shop.s, 'growth', 'month');
    expect([up.status, up.json.error?.code]).toEqual([409, 'invoice_overdue']);

    await signInDashboard(context, shop.s);
    await openPlan(page);
    await expect(page.getByText(/Payment failed for your Starter plan/).first()).toBeVisible({ timeout: 20_000 });
    await expect(payNow(page)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('past-due-banner.png'), fullPage: true });

    const exp = await clock(shop.s, 'grace_ended');
    expect([exp.status, exp.plan.code]).toEqual(['active', 'free']);
    const old = await invoice(shop.s, renewalId);
    expect([old.status, old.void_reason]).toEqual(['void', 'unpaid']);
    // P7-16: non-payment expiry detaches at once (domain grace = now), possibly through the domain-grace step
    if ((await getDomain(shop.s, domainId)).status !== 'expired') await clock(shop.s, 'domain_grace_ended');
    const d = await getDomain(shop.s, domainId);
    expect([d.status, d.failure_code, d.is_primary]).toEqual(['expired', 'plan_limit', false]);
    const primary = (await listDomains(shop.s)).data.find((x) => x.is_primary);
    expect(primary?.type).toBe('platform');
    // the platform subdomain serves the shop again (no redirect to the detached host)
    const cfg = await sf(shop.apiHost, 'GET', '/config');
    expect(cfg.status, cfg.text.slice(0, 200)).toBe(200);
    expect(cfg.json.data.store.redirect_host ?? null).toBeNull();
    expect(cfg.json.data.store.primary_host).toBe(shop.apiHost);
    // the detached host no longer resolves
    expect((await sf(customHost, 'GET', '/config')).status).toBe(404);
    // S66: re-check of a plan_limit row on Free → 402
    const re = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains/${domainId}/verify`, {});
    expect([re.status, re.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect(re.json.error.details.upgrade_plan).toEqual(['starter']);

    await page.reload();
    await expect(page.getByText(/Payment failed for your Starter plan/)).toHaveCount(0);
    await expect(invoiceRow(page, old.number)).toContainText(/Void/);
  });
});

test.describe('billing-downgrade: Growth → Switch to Starter (scheduled) → Keep Growth → switch again → applied at period end', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await freeShop('bdown');
    await subscribe(shop.s, 'growth', 'month', 'sslcommerz');
    await expect.poll(async () => (await subscription(shop.s)).plan.code, { timeout: 30_000 }).toBe('growth');
  });
  test.afterAll(() => shop?.cleanup());

  test('UI: Switch to Starter → "no charge" → scheduled line → Keep Growth cancels it', async ({ page, context }) => {
    test.setTimeout(120_000);
    const q = await quote(shop.s, 'starter', 'month');
    expect(q.json.data).toMatchObject({ kind: 'downgrade', amount: 0, requires_payment: false });
    const sub = await subscription(shop.s);
    expect(q.json.data.effective_at).toBe(sub.current_period_end);

    await signInDashboard(context, shop.s);
    await openPlan(page);
    await planCta(page, 'Starter').click();
    await expect(dialog(page)).toContainText(/no charge/i);
    await confirmChange(page);
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/Switches to Starter\b.* on /).first()).toBeVisible({ timeout: 20_000 });
    const scheduled = await subscription(shop.s);
    expect(scheduled.scheduled_change).toMatchObject({ interval: 'month', effective_at: sub.current_period_end });
    expect(scheduled.scheduled_change.plan.code).toBe('starter');
    expect(scheduled.plan.code).toBe('growth');
    expect((await invoices(shop.s)).data.filter((i) => i.status === 'open')).toHaveLength(0);

    await page.getByRole('button', { name: /^Keep Growth/ }).click();
    await expect(page.getByText(/Switches to Starter\b.* on /)).toHaveCount(0, { timeout: 20_000 });
    expect((await subscription(shop.s)).scheduled_change).toBeNull();
    const none = await api(shop.s, 'DELETE', '/billing/scheduled-change');
    expect(none.status).toBe(404);
  });

  test('switch again (API) → period_ended → Starter; cancel to Free is scheduled, not immediate', async () => {
    const c = await changePlan(shop.s, 'starter', 'month');
    expect(c.status, c.text).toBe(200);
    expect(c.json.data.invoice).toBeNull();
    const applied = await clock(shop.s, 'period_ended');
    expect(applied.plan.code).toBe('starter');
    expect(applied.scheduled_change).toBeNull();
    // the period rolled into the lower plan; renewal rules continue (active, or past_due if the renewal is unpaid)
    expect(['active', 'past_due']).toContain(applied.status);
    expect((await features(shop.s)).features.profit_reports).toBe(false);

    if (applied.status === 'active') {
      const cancel = await changePlan(shop.s, 'free', 'month');
      expect(cancel.status, cancel.text).toBe(200);
      const s2 = await subscription(shop.s);
      expect([s2.plan.code, s2.cancel_at_period_end, s2.scheduled_change?.plan?.code]).toEqual(['starter', true, 'free']);
    }
  });
});
