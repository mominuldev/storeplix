import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, createTenant, signInDashboard, urls, type ThrowawayMember, type ThrowawayTenant } from '../support/api';
import { setupShop, type CommerceShop } from '../support/commerce';
import { binaryGet, changePlan, clock, invoices, openPlan, payInvoice, quote, report } from '../support/billing';

/**
 * PHASE-7-CONTRACT §10 live checks: S56 cross-tenant billing + report access (404, never 403), S57 roles (ManageBilling =
 * owner, ViewBilling = owner/admin, Profit = owner/admin), S65 dev routes, admin read-only UI (§8.2 Roles).
 */
let shop: CommerceShop;
let admin: ThrowawayMember | undefined;
let staff: ThrowawayMember | undefined;
let eve: ThrowawayTenant | undefined;
let invoiceId: string;
let paymentId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await setupShop('bsec');
  await clock(shop.s, 'trial_ended');
  const c = await changePlan(shop.s, 'starter', 'month');
  expect(c.status, c.text).toBe(201);
  invoiceId = c.json.data.invoice.id;
  const p = await payInvoice(shop.s, invoiceId, 'bkash');
  expect(p.status, p.text).toBe(201);
  paymentId = p.json.data.id;
  admin = await createMember(shop.s, 'admin');
  staff = await createMember(shop.s, 'staff');
  eve = await createTenant('bseceve');
});

test.afterAll(async () => {
  await admin?.cleanup().catch(() => undefined);
  await staff?.cleanup().catch(() => undefined);
  eve?.cleanup();
  shop?.cleanup();
});

test('S57 roles: admin reads billing but cannot change plan or pay; staff sees no billing', async () => {
  const a = admin!.session;
  expect((await api(a, 'GET', '/subscription')).status).toBe(200);
  expect((await api(a, 'GET', '/billing/invoices')).status).toBe(200);
  expect((await api(a, 'GET', `/billing/invoices/${invoiceId}`)).status).toBe(200);
  expect((await api(a, 'GET', `/billing/payments/${paymentId}`)).status).toBe(200);
  expect((await quote(a, 'growth', 'month')).status).toBe(200);
  const ch = await changePlan(a, 'growth', 'month');
  expect([ch.status, ch.json.error?.code]).toEqual([403, 'forbidden']);
  const pay = await payInvoice(a, invoiceId, 'bkash');
  expect([pay.status, pay.json.error?.code]).toEqual([403, 'forbidden']);
  expect((await api(a, 'DELETE', '/billing/scheduled-change')).status).toBe(403);
  // admin: can_pay false on the open invoice
  const list = await invoices(a);
  expect(list.data.find((i) => i.id === invoiceId)?.can_pay).toBe(false);
  expect((await invoices(shop.s)).data.find((i) => i.id === invoiceId)?.can_pay).toBe(true);

  const st = staff!.session;
  for (const [m, p] of [
    ['GET', '/subscription'],
    ['GET', '/billing/invoices'],
    ['GET', `/billing/invoices/${invoiceId}`],
    ['GET', `/billing/payments/${paymentId}`],
  ] as const) {
    expect((await api(st, m, p)).status, `${m} ${p} as staff`).toBe(403);
  }
  expect((await quote(st, 'growth', 'month')).status).toBe(403);
  expect((await changePlan(st, 'growth', 'month')).status).toBe(403);
  // /features stays readable for staff (402 dialog wording)
  expect((await api(st, 'GET', '/features')).status).toBe(200);
  // reports: Sales + Delivery for every role; Profit owner/admin only (staff 403 before the plan check)
  expect((await report(shop.s, 'sales', undefined, undefined, st)).status).toBe(200);
  expect((await report(shop.s, 'delivery', undefined, undefined, st)).status).toBe(200);
  expect((await report(shop.s, 'profit', undefined, undefined, st)).status).toBe(403);
});

test('S56 cross-tenant: another tenant gets 404 on every billing id and on the store\'s reports', async () => {
  const e = eve!.session;
  for (const [m, p] of [
    ['GET', `/billing/invoices/${invoiceId}`],
    ['GET', `/billing/invoices/${invoiceId}/pdf`],
    ['GET', `/billing/payments/${paymentId}`],
  ] as const) {
    const r = await api(e, m, p);
    expect([r.status, r.json.error?.code], `${m} ${p}`).toEqual([404, 'not_found']);
  }
  const pay = await apiCall(e, 'POST', `/billing/invoices/${invoiceId}/pay`, { json: { provider: 'bkash' }, headers: { 'Idempotency-Key': randomUUID() } });
  expect(pay.status).toBe(404);
  expect((await binaryGet(e, `/billing/invoices/${invoiceId}/pdf`)).status).toBe(404);
  // Eve's own list does not contain A's invoice
  expect((await invoices(e)).data.some((i) => i.id === invoiceId)).toBe(false);
  // A's store under Eve's tenant header → 404 (store not in tenant)
  for (const type of ['sales', 'profit', 'delivery'] as const) {
    const r = await apiCall(e, 'GET', `/stores/${shop.s.storeId}/reports/${type}`);
    expect(r.status, `${type} ${r.text.slice(0, 200)}`).toBe(404);
  }
  // spoofed tenant header: Eve's session with A's tenant id → 403 (no membership)
  const spoof = await apiCall({ ...e, tenantId: shop.s.tenantId }, 'GET', `/billing/invoices/${invoiceId}`);
  expect(spoof.status).toBe(403);
});

test('S65/§4.6: dev clock is per session tenant, owner only; anonymous 401', async () => {
  expect((await api(staff!.session, 'POST', '/dev/billing/clock', { state: 'renewal_due' })).status).toBe(403);
  const anon = await api(null, 'POST', '/dev/billing/clock', { state: 'renewal_due' });
  expect([401, 404]).toContain(anon.status);
  const bad = await api(shop.s, 'POST', '/dev/billing/clock', { state: 'time_machine' });
  expect(bad.status).toBe(422);
});

test('admin UI is read-only: no Upgrade / Pay, "Only the shop owner can change the plan"; staff gets the empty state', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInDashboard(ctx, admin!.session);
  await openPlan(page);
  await expect(page.getByText(/Only the shop owner can change the plan/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^(Upgrade to|Subscribe to|Switch to) / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Pay\b/ })).toHaveCount(0);
  await ctx.close();

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await signInDashboard(sctx, staff!.session);
  await spage.goto(`${urls.merchant}/settings/plan`);
  await expect(spage.getByText(/Plan & billing is for owners and managers/).first()).toBeVisible({ timeout: 20_000 });
  await sctx.close();
});
