import { expect, test } from '@playwright/test';
import { api, createTenant, signInDashboard, urls, type ThrowawayTenant } from '../support/api';
import { changePlan, invoices, subscription } from '../support/billing';
import { REASON, adminApi, adminLogin, adminUrl, findTenant, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §10 QA `phase8.merchants`: find a fresh shop by owner phone, open its detail, extend the trial,
 * change plan now (comp), mark an open invoice paid, void another, and see each action in the shop's audit tab and in
 * the merchant's activity log as "Store Plix support" (S81: never the staff member's name or email).
 */
test.describe.configure({ mode: 'serial' });

let shop: ThrowawayTenant;
let phone: string;
let admin: AdminSession;
let tenantId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-merchants');
  shop = await createTenant('p8m');
  phone = shop.phone;
});
test.afterAll(() => shop?.cleanup());

test('search finds the shop by owner phone, email and slug', async () => {
  const byPhone = await findTenant(admin, phone);
  expect(byPhone.name).toBe('QA p8m');
  tenantId = byPhone.id as string;
  expect((await findTenant(admin, shop.email)).id).toBe(tenantId);
  expect((await findTenant(admin, shop.slug)).id).toBe(tenantId);
});

test('UI: global search → merchant detail with owner, plan and tabs', async ({ page, context }) => {
  await signInAdminApp(context, admin);
  await page.goto(`${adminUrl}/merchants`);
  await expect(page.getByRole('heading', { name: 'Merchants' })).toBeVisible();
  await page.goto(`${adminUrl}/merchants/${tenantId}`);
  await expect(page.getByRole('heading', { name: 'QA p8m', exact: true })).toBeVisible();
  await expect(page.getByText(shop.email).first()).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Merchant sections' });
  for (const name of ['Overview', 'Billing', 'Domains', 'Audit log']) await expect(tabs.getByRole('tab', { name: new RegExp(name) })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /Staff/ })).toBeVisible();
});

test('extend the trial by 7 days (reason required)', async () => {
  const before = await subscription(shop.session);
  expect(before.status).toBe('trialing');
  const noReason = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/subscription/extend`, { days: 7 });
  expect(noReason.status).toBe(422);
  const r = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/subscription/extend`, { days: 7, reason: REASON });
  expect(r.status, r.text).toBe(200);
  const after = await subscription(shop.session);
  expect(Date.parse(after.trial_ends_at) - Date.parse(before.trial_ends_at)).toBe(7 * 86_400_000);
});

test('change plan now (comp) to Growth', async () => {
  const r = await adminApi(
    admin,
    'POST',
    `/admin/tenants/${tenantId}/billing/change-plan`,
    { plan_code: 'growth', interval: 'month', effective: 'now', reason: REASON, notify: false },
    { idempotent: true },
  );
  expect(r.status, r.text).toBe(200);
  expect((await subscription(shop.session)).plan.code).toBe('growth');
});

test('void an open invoice, then mark the next one paid', async () => {
  // The merchant asks for a yearly Growth plan: an open change invoice. Staff void it…
  const first = await changePlan(shop.session, 'growth', 'year');
  expect(first.status, first.text).toBe(201);
  const voidId = first.json.data.invoice.id as string;
  const v = await adminApi(admin, 'POST', `/admin/invoices/${voidId}/void`, { reason: REASON });
  expect(v.status, v.text).toBe(200);

  // …the merchant asks again and pays by bank transfer: staff mark it paid (once; the replay answers 409).
  const second = await changePlan(shop.session, 'growth', 'year');
  expect(second.status, second.text).toBe(201);
  const paidId = second.json.data.invoice.id as string;
  const paid = await adminApi(admin, 'POST', `/admin/invoices/${paidId}/mark-paid`, { reference: 'bank txn QA-1', reason: REASON }, { idempotent: true });
  expect(paid.status, paid.text).toBe(200);
  const again = await adminApi(admin, 'POST', `/admin/invoices/${paidId}/mark-paid`, { reference: 'bank txn QA-1', reason: REASON }, { idempotent: true });
  expect(again.status).toBe(409);
  expect(again.json.error.code).toBe('invoice_not_open');

  const statuses = Object.fromEntries((await invoices(shop.session)).data.map((i) => [i.id, i.status]));
  expect([statuses[voidId], statuses[paidId]]).toEqual(['void', 'paid']);
  const sub = await subscription(shop.session);
  expect([sub.plan.code, sub.billing_interval ?? sub.interval]).toEqual(['growth', 'year']);
});

test('each action is on the shop audit log with the platform actor', async () => {
  const r = await adminApi(admin, 'GET', `/admin/tenants/${tenantId}/audit-logs?per_page=50`);
  expect(r.status, r.text).toBe(200);
  const actions = (r.json.data as Record<string, any>[]).filter((e) => e.actor?.type === 'platform_user').map((e) => e.action as string); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const a of ['billing.period_extended', 'subscription.plan_changed', 'billing.invoice_voided', 'billing.manual_payment']) expect(actions, a).toContain(a);
});

/**
 * S81 on the merchant API, then the merchant UI. P8-QA-1 (docs/reviews/phase-8-1-qa.md): Staff → "Recent staff
 * activity" also lists `filter[actor_type]=platform_user` rows, shown as "Store Plix support".
 */
test('merchant audit API shows the platform actor and never the staff identity', async () => {
  const r = await api(shop.session, 'GET', '/audit-logs?per_page=50');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const platform = (r.json.data as Record<string, any>[]).filter((e) => e.actor?.type === 'platform_user'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(platform.map((e) => e.action)).toEqual(expect.arrayContaining(['billing.period_extended', 'subscription.plan_changed', 'billing.invoice_voided', 'billing.manual_payment']));
  const raw = JSON.stringify(platform);
  expect(raw).not.toContain(admin.user.email);
  expect(raw).not.toContain(admin.user.id);
  expect(raw).not.toContain(admin.user.name);
});

test('UI: the merchant sees the support actions as "Store Plix support" on the Staff page', async ({ page, context }) => {
  await signInDashboard(context, shop.session);
  await page.goto(`${urls.merchant}/staff`);
  const activity = page.locator('li', { hasText: 'Store Plix support' });
  await expect(activity.filter({ hasText: 'voided an invoice' }).or(activity.filter({ hasText: 'recorded a payment on an invoice' })).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(admin.user.name, { exact: false })).toHaveCount(0);
  await expect(page.getByText(admin.user.email, { exact: false })).toHaveCount(0);
});
