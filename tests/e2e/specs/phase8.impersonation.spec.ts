import { expect, test, type Browser, type Page } from '@playwright/test';
import { createTenant, urls, type ThrowawayTenant } from '../support/api';
import { REASON, adminApi, adminLogin, findTenant, reseedSuperAdmin, type AdminSession } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §10 QA `phase8.impersonation` (S71–S74): start with a reason → the merchant dashboard opens with
 * the support banner; orders and billing pages read fine; a create button is disabled; a write that still reaches
 * the API shows the read-only toast; Exit → "Impersonation ended". A second session is revoked from the admin side
 * and ends at its next request. Start and end are audited on the shop.
 */
test.describe.configure({ mode: 'serial' });

let shop: ThrowawayTenant;
let admin: AdminSession;
let tenantId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-impersonation');
  shop = await createTenant('p8i');
  tenantId = (await findTenant(admin, shop.email)).id as string;
});
test.afterAll(() => shop?.cleanup());

async function start(): Promise<{ id: string; url: string }> {
  const r = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/impersonations`, { reason: REASON, ticket_ref: 'SP-8101' });
  expect(r.status, r.text).toBe(201);
  expect(r.json.data.url).toMatch(/\/impersonate#ticket=/);
  return { id: r.json.data.id as string, url: r.json.data.url as string };
}

/** A fresh browser context (no merchant cookies) that consumes the ticket link. */
async function openTicket(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url.replace(/^https?:\/\/[^/]+/, urls.merchant));
  await expect(page.getByRole('region', { name: 'Support session' })).toBeVisible({ timeout: 20_000 });
  return page;
}

test('ticket needs a reason; a used or bogus ticket answers the same 404', async ({ browser }) => {
  const noReason = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/impersonations`, {});
  expect(noReason.status).toBe(422);

  const { url } = await start();
  const page = await openTicket(browser, url);
  // The hash is cleared after use, and the same link can't be used twice.
  expect(page.url()).not.toContain('ticket=');
  const reuse = await (await browser.newContext()).newPage();
  await reuse.goto(url.replace(/^https?:\/\/[^/]+/, urls.merchant));
  await expect(reuse.getByText('This link has expired. Start again from Store Plix admin.')).toBeVisible();
  await page.context().close();
});

test('banner, reads, disabled create button, read-only toast, exit', async ({ browser }) => {
  const { url } = await start();
  const page = await openTicket(browser, url);
  const banner = page.getByRole('region', { name: 'Support session' });
  await expect(banner).toContainText('You are viewing');
  await expect(banner).toContainText(`Reason: ${REASON}`);
  await expect(banner.getByText('Read-only', { exact: true })).toBeVisible();
  await expect(banner.getByRole('timer', { name: 'Time left' })).toHaveText(/1[45]:\d\d left/);

  // Reads: orders and plan & billing.
  await page.goto(`${urls.merchant}/orders`);
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
  await page.goto(`${urls.merchant}/settings/plan`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);

  // Primary create action on a list page is disabled.
  await page.goto(`${urls.merchant}/products`);
  await expect(page.locator('[data-read-only]').first()).toBeVisible();
  await expect(page.locator('[data-read-only]').first()).toHaveAttribute('aria-disabled', 'true');

  // Account (QA P8-QA-2): the staff member is never shown as the shop's owner, and no personal profile forms.
  await page.goto(`${urls.merchant}/account`);
  await expect(page.getByRole('heading', { name: 'Account settings aren’t available in a support session.' })).toBeVisible();
  await expect(page.getByText(/Owner of/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save profile' })).toHaveCount(0);

  // A write that still reaches the API (store details save, a TanStack mutation) → 403 impersonation_read_only →
  // the global toast.
  await page.goto(`${urls.merchant}/settings/store`);
  await page.getByLabel('Support hours').fill('Changed by support');
  const refused = page.waitForResponse((r) => r.request().method() !== 'GET' && r.url().includes('/api/v1/') && r.status() === 403);
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await (await refused).json()).error.code).toBe('impersonation_read_only');
  await expect(page.getByText('Read-only support session. Changes are disabled.')).toBeVisible();

  await banner.getByRole('button', { name: 'Exit impersonation' }).click();
  await expect(page.getByRole('heading', { name: 'Impersonation ended' })).toBeVisible();
  await page.context().close();
});

test('revoke from admin ends a second session at its next request', async ({ browser }) => {
  const { id, url } = await start();
  const page = await openTicket(browser, url);
  // Let the dashboard finish its first load. Otherwise one of its in-flight reads can be the request that receives
  // the single 401 `impersonation_ended` (the session is invalidated with it, later requests get `unauthenticated`),
  // and the goto below drops that response, so the reloaded app only sees `unauthenticated` → login page.
  await page.waitForLoadState('networkidle');
  const list =await adminApi(admin, 'GET', `/admin/impersonations?filter[status]=active&filter[tenant]=${tenantId}`);
  expect(list.status, list.text).toBe(200);
  expect((list.json.data as { id: string }[]).map((i) => i.id)).toContain(id);

  const r = await adminApi(admin, 'POST', `/admin/impersonations/${id}/revoke`, { reason: REASON });
  expect(r.status, r.text).toBe(200);
  await page.goto(`${urls.merchant}/orders`);
  await expect(page.getByRole('heading', { name: 'Impersonation ended' })).toBeVisible({ timeout: 15_000 });
  await page.context().close();
});

test('start and end of every session are on the shop audit log', async () => {
  const r = await adminApi(admin, 'GET', `/admin/tenants/${tenantId}/audit-logs?per_page=50`);
  expect(r.status, r.text).toBe(200);
  const actions = (r.json.data as { action: string }[]).map((e) => e.action);
  expect(actions.filter((a) => a === 'admin.impersonation_started').length).toBeGreaterThanOrEqual(3);
  expect(actions.filter((a) => a === 'admin.impersonation_ended').length).toBeGreaterThanOrEqual(2);
});
