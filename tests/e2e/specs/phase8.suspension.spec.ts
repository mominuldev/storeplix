import { expect, test } from '@playwright/test';
import { api, signInDashboard, urls } from '../support/api';
import { browserHost, placeOrder, setupShop, sf, type CommerceShop } from '../support/commerce';
import { REASON, adminApi, adminLogin, findTenant, reseedSuperAdmin, type AdminSession } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §10 QA `phase8.suspension` (S80, §4.1, §7.2, §7.3): suspend → the merchant dashboard shows the
 * suspended screen, every page of the storefront's platform host answers the bare 503 "temporarily unavailable" page,
 * checkout is refused; reactivate → the storefront is back.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let admin: AdminSession;
let tenantId: string;

/** The storefront re-checks a host's suspension every 15 s (SUSPENSION_TTL_MS): poll until `status` is answered. */
async function waitForStatus(path: string, status: number, timeoutMs = 40_000): Promise<Response> {
  const started = Date.now();
  let last: Response | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await fetch(`${shop.storefront}${path}`, { redirect: 'manual' });
    if (last.status === status) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${shop.storefront}${path} still answers ${last?.status}, expected ${status}`);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-suspension');
  shop = await setupShop('p8s');
  browserHost(shop);
  tenantId = (await findTenant(admin, shop.t.email)).id as string;
  await waitForStatus('/', 200, 60_000);
});
test.afterAll(() => shop?.cleanup());

test('suspend needs a reason code and a reason; then the merchant API answers tenant_suspended', async () => {
  const bad = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/suspend`, { reason: REASON });
  expect(bad.status).toBe(422);
  const r = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/suspend`, { reason_code: 'terms_violation', reason: REASON, notify: false });
  expect(r.status, r.text).toBe(200);
  const twice = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/suspend`, { reason_code: 'terms_violation', reason: REASON });
  expect(twice.status).toBe(409);
  expect(twice.json.error.code).toBe('invalid_state_transition');

  const m = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`);
  expect(m.status).toBe(403);
  expect(m.json.error.code).toBe('tenant_suspended');
});

test('merchant dashboard shows the suspended screen', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/`);
  await expect(page.getByRole('heading', { name: 'Your shop is suspended' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Contact Store Plix support' })).toBeVisible();
});

test('every storefront page answers the bare 503 page; config is "suspended"; checkout is refused', async ({ page }) => {
  const home = await waitForStatus('/', 503);
  expect(home.headers.get('retry-after')).toBe('86400');
  expect(home.headers.get('cache-control')).toContain('no-store');
  const html = await home.text();
  expect(html).toContain('This store is temporarily unavailable');
  expect(html).toMatch(/<meta[^>]+name="robots"[^>]+noindex/);
  expect(html).not.toContain('QA p8s');
  expect((await fetch(`${shop.storefront}/products/${shop.simple.slug}`, { redirect: 'manual' })).status).toBe(503);

  await page.goto(`${shop.storefront}/`);
  await expect(page.getByRole('heading', { name: 'This store is temporarily unavailable' })).toBeVisible();

  const config = await sf(shop.apiHost, 'GET', '/config');
  expect(config.status).toBe(200);
  expect(config.json.data).toEqual({ availability: 'suspended' });
  const cart = await sf(shop.apiHost, 'POST', '/cart/items', { json: { variant_id: shop.simple.variantId, quantity: 1 } });
  expect(cart.status).toBe(404);
  expect(cart.json.error.code).toBe('store_not_found');
});

test('reactivate restores the storefront; a checkout works again', async ({ page }) => {
  const r = await adminApi(admin, 'POST', `/admin/tenants/${tenantId}/reactivate`, { reason: REASON, notify: false });
  expect(r.status, r.text).toBe(200);
  await waitForStatus('/', 200);
  await page.goto(`${shop.storefront}/`);
  await expect(page.getByRole('heading', { name: 'This store is temporarily unavailable' })).toHaveCount(0);

  const { order } = await placeOrder(shop, shop.simple.variantId, 1);
  expect(order.number).toBeTruthy();
});

test('after reactivation the merchant dashboard works again', async ({ page, context }) => {
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`)).status).toBe(200);
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders`);
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible({ timeout: 15_000 });
});

test('suspend and reactivate are on the shop audit log', async () => {
  const r = await adminApi(admin, 'GET', `/admin/tenants/${tenantId}/audit-logs?per_page=50`);
  const actions = (r.json.data as { action: string }[]).map((e) => e.action);
  expect(actions).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']));
});
