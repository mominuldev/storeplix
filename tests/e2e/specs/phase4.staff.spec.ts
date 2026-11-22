import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, demoSession, signInDashboard, urls, type Session, type ThrowawayMember } from '../support/api';
import { Tracker, purgeRun, simpleProduct, tagged, toCsv, uploadImport } from '../support/catalog';

/**
 * Phase 4 P4-5 / P4-14 / P4-15 / §15.2 / §15.5: what staff can't do or see. A throwaway staff member is
 * invited to the demo shop (one throttle:auth call) and removed afterwards.
 *  - cost_amount null everywhere (product, list, inventory) and ignored on write; stock value at cost null
 *    (inventory summary, dashboard);
 *  - delete product/category/customer → 403; bulk delete → 403; imports, exports, template → 403;
 *  - another member's note → 403, own note → 204;
 *  - UI: no Export/Import on Customers, no Cost field in the editor, no Delete in the row menu.
 */
test.describe.configure({ mode: 'serial' });

let owner: Session;
let staff: ThrowawayMember;
let t: Tracker;
const base = () => `/stores/${owner.storeId}`;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  owner = await demoSession();
  t = new Tracker(owner);
  staff = await createMember(owner, 'staff');
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(owner.storeId, [...t.products]);
  await staff?.cleanup();
  expect(problems, 'cleanup').toEqual([]);
});

test('API: staff never see cost and cannot write it', async () => {
  const s = staff.session;
  const p = await t.createProduct(simpleProduct('Costly', 100000, { cost_amount: 60000, initial_on_hand: 2 }));
  const asStaff = await api(s, 'GET', `${base()}/products/${p.id}`);
  expect(asStaff.status).toBe(200);
  expect(asStaff.json.data.cost_amount).toBeNull();
  expect(asStaff.json.data.variants[0].cost_amount).toBeNull();
  const list = await api(s, 'GET', `${base()}/products?q=${encodeURIComponent(p.name)}`);
  expect(list.json.data[0].cost_amount).toBeNull();
  const inv = await api(s, 'GET', `${base()}/inventory?filter[product_id]=${p.id}`);
  expect(inv.json.data[0].cost_amount).toBeNull();
  expect(inv.json.meta.summary.stock_value_cost_amount).toBeNull();
  const dash = await api(s, 'GET', `${base()}/dashboard`);
  expect(dash.status).toBe(200);
  expect(dash.json.data.inventory.stock_value_cost_amount).toBeNull();
  // Owner still sees it.
  expect((await api(owner, 'GET', `${base()}/dashboard`)).json.data.inventory.stock_value_cost_amount).not.toBeNull();

  // A cost staff send is ignored (on update and on create).
  const v = asStaff.json.data.variants[0];
  const upd = await api(s, 'PATCH', `${base()}/products/${p.id}`, { revision: asStaff.json.data.revision, variants: [{ id: v.id, sku: v.sku, price_amount: v.price_amount, cost_amount: 1 }] });
  expect(upd.status, JSON.stringify(upd.json)).toBe(200);
  expect((await api(owner, 'GET', `${base()}/products/${p.id}`)).json.data.variants[0].cost_amount).toBe(60000);
  const mine = await t.createProduct(simpleProduct('Staff made', 5000, { cost_amount: 4000 }), s);
  expect((await api(owner, 'GET', `${base()}/products/${mine.id}`)).json.data.variants[0].cost_amount).toBeNull();
});

test('API: staff can operate but not delete, bulk-delete, import or export', async () => {
  const s = staff.session;
  const p = await t.createProduct(simpleProduct('Undeletable', 1000));
  const c = await t.createCategory({ name: tagged('Staff cat') });
  const cu = await t.createCustomer({ name: tagged('Staff cust'), email: `staff-${Date.now()}@e2e.example` });

  const forbidden: Array<[string, string, unknown?]> = [
    ['DELETE', `${base()}/products/${p.id}`],
    ['POST', `${base()}/products/bulk`, { action: 'delete', ids: [p.id] }],
    ['DELETE', `${base()}/categories/${c.id}`],
    ['DELETE', `${base()}/customers/${cu.id}`],
    ['POST', `${base()}/exports`, { type: 'customers' }],
    ['POST', `${base()}/exports`, { type: 'products' }],
    ['GET', `${base()}/imports/template?type=customers`],
  ];
  for (const [m, path, body] of forbidden) {
    const r = await api(s, m, path, body);
    expect(r.status, `${m} ${path}: ${JSON.stringify(r.json)}`).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
  }
  const up = await uploadImport(owner, 'customers', toCsv([['name', 'phone'], ['x', '01711000000']]), undefined, s);
  expect(up.status, up.text).toBe(403);

  // Allowed: archive via bulk, adjust stock, create/edit customers, add notes.
  expect((await api(s, 'POST', `${base()}/products/bulk`, { action: 'archive', ids: [p.id] })).status).toBe(200);
  const own = await api(s, 'POST', `${base()}/customers/${cu.id}/notes`, { body: 'staff note' });
  expect(own.status).toBe(201);
  const ownerNote = await api(owner, 'POST', `${base()}/customers/${cu.id}/notes`, { body: 'owner note' });
  expect((await api(s, 'DELETE', `${base()}/customers/${cu.id}/notes/${ownerNote.json.data.id}`)).status).toBe(403);
  expect((await api(s, 'DELETE', `${base()}/customers/${cu.id}/notes/${own.json.data.id}`)).status).toBe(204);
  // Staff see customer PII (they call customers to confirm orders).
  expect((await api(s, 'GET', `${base()}/customers/${cu.id}`)).json.data.email).toBe(cu.email);
  // Audit log and error report are O/A only as well.
  expect((await apiCall(s, 'GET', `${base()}/imports/01J00000000000000000000000/error-report`)).status).toBeGreaterThanOrEqual(403);
});

test('UI: staff see no Export/Import, no Cost field, no Delete', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, staff.session);
  await page.goto(`${urls.merchant}/customers`);
  await expect(page.getByRole('button', { name: /Add customer/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Export/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Export/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Import/ }).or(page.getByRole('link', { name: /^Import/ }))).toHaveCount(0);

  await page.goto(`${urls.merchant}/products/new`);
  await expect(page.getByLabel(/^Product name/i)).toBeVisible();
  await expect(page.getByLabel(/^Cost/i)).toHaveCount(0);
  await expect(page.getByText(/Cost is private/i)).toHaveCount(0);

  const p = await t.createProduct(simpleProduct('Staff menu', 1000));
  await page.goto(`${urls.merchant}/products?q=${encodeURIComponent(p.name)}`);
  const row = page.getByRole('row').filter({ hasText: p.name });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(/profit|margin/i);
  await row.getByRole('button', { name: /more|actions|•••/i }).click();
  await expect(page.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('UI: the sidebar hides Products → Import for staff (bulk_data)', async ({ page, context }) => {
  await signInDashboard(context, staff.session);
  await page.goto(`${urls.merchant}/products`);
  const nav = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: /^Categories$/ }) }).first();
  await expect(nav.getByRole('link', { name: /^Categories$/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Import$/ })).toHaveCount(0, { timeout: 3_000 });
});
