import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, createTenant, signInDashboard, urls, type ThrowawayTenant } from '../support/api';
import type { CommerceShop } from '../support/commerce';
import {
  PLAIN_KEY,
  PLAIN_KEY_IN_TEXT,
  SCOPE_LABEL,
  createKeyButton,
  devCard,
  devShop,
  external,
  fakePlainKey,
  listKeys,
  openDeveloper,
  rowMenu,
  rowOf,
  storefrontOrder,
} from '../support/developer';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-4 §10 QA `phase8-4.api-keys` (§3, §6.1, §7, S100–S104, AC 3/4):
 * owner creates a key in the Developer page (plain key shown once) → `/external/me` and the orders list with
 * `Authorization: Bearer` → scope deny, merchant routes refuse the key, external routes refuse the session, another
 * tenant's store → 404 → owner revokes it in the UI → 401 `invalid_api_key`, same body as a never-issued key.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let other: ThrowawayTenant;
let order: { id: string; number: string };
let plain = '';
let keyId = '';
const KEY_NAME = 'E2E accounting sync';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await devShop('dk-keys');
  other = await createTenant('dk-other');
  order = await storefrontOrder(shop);
});
test.afterAll(() => {
  shop?.cleanup();
  other?.cleanup();
});

test('UI: create key → plain key shown once, then only the masked key', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  await expect(devCard(page, 'API keys')).toBeVisible();

  await createKeyButton(page).click();
  const d = page.getByRole('dialog').last();
  await expect(d).toBeVisible();
  await d.getByLabel(/^Name/).fill(KEY_NAME);
  await d.getByRole('checkbox', { name: SCOPE_LABEL['orders:read'], exact: true }).check();
  // Not granted: products / customers stay unchecked; implied reads are added by the API only for writes.
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/api-keys') && r.request().method() === 'POST');
  await d.getByRole('button', { name: /^Create( key| API key)?$/ }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as Json;
  plain = body.data.plain_key as string;
  keyId = body.data.id as string;
  expect(plain).toMatch(PLAIN_KEY);
  expect(body.data.scopes).toEqual(['orders:read']);

  // Success step: the plain key, Copy, "I've stored it".
  await expect(d.getByLabel('API key', { exact: true })).toHaveValue(plain); // CopyField is a read-only <input>
  await expect(d.getByRole('button', { name: /Copy/ })).toBeVisible();
  await d.getByRole('button', { name: /I.ve stored it/ }).click();
  await expect(d).toBeHidden();

  // Never again: not on the page, not in the list API (S100).
  const card = devCard(page, 'API keys');
  const row = rowOf(card, KEY_NAME);
  await expect(row).toBeVisible();
  await expect(row).toContainText(`sp_live_••••${plain.slice(-4)}`);
  await expect(row).toContainText(SCOPE_LABEL['orders:read']);
  expect(await page.locator('body').innerText()).not.toMatch(PLAIN_KEY_IN_TEXT);
  const listed = await listKeys(shop.s);
  expect(JSON.stringify(listed)).not.toContain(plain);
  const mine = listed.find((k) => k.id === keyId)!;
  expect(mine).toMatchObject({ name: KEY_NAME, status: 'active', prefix: plain.slice(0, 12), last_four: plain.slice(-4), scopes: ['orders:read'] });
  expect(mine).not.toHaveProperty('plain_key');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('external API with the key: /me, orders list + detail, scope deny, isolation (S102–S104)', async () => {
  test.skip(!plain, 'needs the key from the UI test');
  const me = await external(plain, 'GET', '/me');
  expect(me.status, me.text).toBe(200);
  expect(me.json.data).toMatchObject({ id: keyId, name: KEY_NAME, scopes: ['orders:read'], tenant_id: shop.s.tenantId });
  expect(me.json.data.store).toMatchObject({ id: shop.s.storeId, currency: 'BDT' });
  // §3 "X-Request-Id as elsewhere": no API route sends it today (QA P84-QA finding, Info), so not asserted.

  // Orders list: same item shape as the merchant API (§3 "same response shapes").
  const list = await external(plain, 'GET', `/stores/${shop.s.storeId}/orders`);
  expect(list.status, list.text).toBe(200);
  const ext = (list.json.data as Json[]).find((o) => o.id === order.id);
  expect(ext, `order ${order.number} in the external list`).toBeTruthy();
  const merchant = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`);
  const mine = (merchant.json.data as Json[]).find((o) => o.id === order.id)!;
  expect(Object.keys(ext!).sort()).toEqual(Object.keys(mine).sort());
  expect(ext!.number).toBe(order.number);
  const detail = await external(plain, 'GET', `/stores/${shop.s.storeId}/orders/${order.id}`);
  expect(detail.status, detail.text).toBe(200);
  expect(detail.json.data.id).toBe(order.id);

  // S103: a route outside the key's scopes.
  const products = await external(plain, 'GET', `/stores/${shop.s.storeId}/products`);
  expect([products.status, products.json.error?.code]).toEqual([403, 'api_key_scope_missing']);
  // details values are arrays (API-CONVENTIONS details shape).
  expect([products.json.error.details?.required_scope].flat()).toEqual(['products:read']);
  const status = await external(plain, 'POST', `/stores/${shop.s.storeId}/orders/${order.id}/status`, { json: { status: 'confirmed' }, headers: { 'Idempotency-Key': randomUUID() } });
  expect([status.status, status.json.error?.code]).toEqual([403, 'api_key_scope_missing']);

  // S102: another tenant's store id, a made-up order id → 404; X-Tenant-Id is ignored.
  expect((await external(plain, 'GET', `/stores/${other.session.storeId}/orders`)).status).toBe(404);
  expect((await external(plain, 'GET', `/stores/${shop.s.storeId}/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV`)).status).toBe(404);
  const spoof = await external(plain, 'GET', `/stores/${other.session.storeId}/orders`, { headers: { 'X-Tenant-Id': other.session.tenantId } });
  expect(spoof.status).toBe(404);

  // S104: merchant routes never accept a key; external routes never accept the session cookie.
  const merchantWithKey = await fetch(`${urls.api}/api/v1/stores`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${plain}`, 'X-Tenant-Id': shop.s.tenantId },
  });
  expect(merchantWithKey.status).toBe(401);
  const sessionOnExternal = await api(shop.s, 'GET', '/external/me');
  expect(sessionOnExternal.status).toBe(401);
  // Malformed header → same 401.
  expect((await external('sp_live_short', 'GET', '/me')).status).toBe(401);
});

test('UI: revoke → the key gets 401 invalid_api_key, identical to a never-issued key (S101)', async ({ page, context }) => {
  test.skip(!plain, 'needs the key from the UI test');
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openDeveloper(page);
  const row = rowOf(devCard(page, 'API keys'), KEY_NAME);
  await rowMenu(row).click();
  await page.getByRole('menuitem', { name: /^Revoke/ }).click();
  const confirm = page.getByRole('dialog').last();
  await expect(confirm).toBeVisible();
  const revoked = page.waitForResponse((r) => r.url().endsWith(`/api/v1/api-keys/${keyId}`) && r.request().method() === 'DELETE');
  await confirm.getByRole('button', { name: /^Revoke/ }).click();
  expect((await revoked).status()).toBe(200);
  await expect(row).toContainText('Revoked');

  const after = await external(plain, 'GET', '/me');
  expect([after.status, after.json.error?.code]).toEqual([401, 'invalid_api_key']);
  const unknown = await external(fakePlainKey(), 'GET', '/me');
  expect(unknown.status).toBe(401);
  expect(after.json.error).toEqual(unknown.json.error);
  expect((await external(plain, 'GET', `/stores/${shop.s.storeId}/orders`)).status).toBe(401);

  // Row kept, status revoked; DELETE again is idempotent.
  expect((await listKeys(shop.s)).find((k) => k.id === keyId)).toMatchObject({ status: 'revoked' });
  expect((await api(shop.s, 'DELETE', `/api-keys/${keyId}`)).status).toBe(200);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
