import { expect, test } from '@playwright/test';
import { apiCall, signInDashboard } from '../support/api';
import { randomPhone } from '../support/commerce';
import { mUrl, WAREHOUSES } from '../support/locations';
import { retryLocked, spath } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { gotoPos, posShop, type PosShop } from '../support/pos';

/**
 * Re-gate regression for the `ApiError.details` widening (f0f2217 / dd041de: validation readers moved to
 * `.fieldErrors`). A 422 `validation_failed` on existing non-POS forms must still land as the field's message:
 *  - Customers "Add customer" with a phone that already belongs to a customer → message under Phone.
 *  - Inventory › Warehouses "Add location" with a taken name → message under Name.
 *  - POS "Add register" with a taken name (422 `register_name_taken`) → message under Name.
 * The expected text is the API's own message for the same request, read first through the API.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
const phone = randomPhone();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pfrm', 'growth');
  const c = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, '/customers'), { json: { name: 'QA Existing', phone } }));
  expect(c.status, c.text.slice(0, 200)).toBe(201);
});
test.afterAll(() => shop?.cleanup());

/** The first field message of a 422 for the same input, straight from the API. */
async function apiFieldMessage(path: string, body: Json, field: string): Promise<string> {
  const r = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, path), { json: body }));
  expect(r.status, r.text.slice(0, 300)).toBe(422);
  const m = r.json.error?.details?.[field]?.[0] as string | undefined;
  expect(m, `details.${field} in ${r.text.slice(0, 300)}`).toBeTruthy();
  return m!;
}

test('Add customer: duplicate phone → the API message under Phone', async ({ page, context }) => {
  const msg = await apiFieldMessage('/customers', { name: 'QA Dup', phone }, 'phone');
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/customers'));
  await page.getByRole('button', { name: 'Add customer' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add customer' });
  await dlg.getByLabel('Name').fill('QA Dup');
  await dlg.getByLabel('Phone').fill(phone);
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/customers$/.test(new URL(r.url()).pathname));
  await dlg.getByRole('button', { name: 'Add customer' }).click();
  expect((await res).status()).toBe(422);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(msg)).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('Add location: taken name → the API message under Name', async ({ page, context }) => {
  const msg = await apiFieldMessage('/locations', { name: 'mirpur SHOP', type: 'shop' }, 'name');
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(WAREHOUSES));
  await page.getByRole('button', { name: /Add location/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add location' });
  await dlg.getByLabel('Name').fill('mirpur SHOP');
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/locations$/.test(new URL(r.url()).pathname));
  await dlg.getByRole('button', { name: /^(Add location|Save)$/ }).click();
  expect((await res).status()).toBe(422);
  await expect(dlg.getByText(msg)).toBeVisible();
});

test('POS Add register: taken name → the API message under Name', async ({ page, context }) => {
  const r = await retryLocked(() => apiCall(shop.s, 'POST', spath(shop.s, '/pos/registers'), { json: { name: 'register 1', location_id: shop.shop.id } }));
  expect([r.status, r.json.error?.code]).toEqual([422, 'register_name_taken']);
  await signInDashboard(context, shop.s);
  await gotoPos(page);
  await page.getByRole('button', { name: 'Add register' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add register' });
  await dlg.getByLabel('Name').fill('register 1');
  await dlg.getByRole('button', { name: 'Add register' }).click();
  await expect(dlg.getByText(r.json.error.message as string)).toBeVisible();
  await expect(dlg).toBeVisible();
});
