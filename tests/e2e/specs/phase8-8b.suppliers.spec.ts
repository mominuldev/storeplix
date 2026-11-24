import { expect, test } from '@playwright/test';
import { api, apiCall, signInDashboard } from '../support/api';
import { kpi } from '../support/analytics';
import { csvObjects, isFormulaUnsafe, parseCsv, toCsv, waitImport } from '../support/catalog';
import { type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import {
  allSuppliersByName,
  createPo,
  createSupplier,
  EMPTY_SUPPLIERS,
  importButton,
  openSuppliers,
  pay,
  purchasingShop,
  receive,
  sendPo,
  suppliersSummary,
  uploadSupplierCsv,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA supplier CSV import + Suppliers page (P88B-15, §4, §6.1, §10.4; S177):
 *  - empty state "No suppliers yet";
 *  - CSV (`type = suppliers`, columns name, contact_name, phone, city, supplies, payment_terms_days, lead_time_days,
 *    pays_by_method, pays_by_account, notes): a new row (phone typed `+880…`, stored `8801…`), a row matching an existing
 *    supplier by phone (updated: city), a row matching by exact name in another case (updated), a bad phone (error), a
 *    formula-looking name with a bad lead time (error) → validate {create 1, update 2, errors 2} → run → completed;
 *    the error report is formula-safe; nothing is created for error rows;
 *  - Suppliers page: KPI tiles Suppliers / You owe / On the way / Bought this month (no "vs last month"), rows with
 *    supplies · city, "you owe" in the row, the detail panel (owed banner, payment terms, lead time, recent POs, Record
 *    payment, New PO), search, and "Import" → `/products/import?type=suppliers` ("Import suppliers from CSV").
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let byPhone: Json;
let byName: Json;
const RUN = Date.now().toString(36).slice(-5);
const NEW_NAME = `QA Import New ${RUN}`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('pos', 'growth', 10);
});
test.afterAll(() => shop?.cleanup());

test('UI empty state: "No suppliers yet" with "+ Add supplier" and "Import"', async ({ page, context }) => {
  test.setTimeout(60_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSuppliers(page);
  await expect(page.getByText(EMPTY_SUPPLIERS).first()).toBeVisible({ timeout: 15_000 });
  await expect(importButton(page)).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('CSV import: create, match by phone, match by name, errors; formula-safe error report (P88B-15, S177)', async () => {
  test.setTimeout(180_000);
  byPhone = await createSupplier(shop.s, { name: `QA Phone Match ${RUN}`, phone: '01911222333', city: 'Dhaka' });
  byName = await createSupplier(shop.s, { name: `QA Name Match ${RUN}`, phone: null, city: 'Dhaka' });
  const header = ['name', 'contact_name', 'phone', 'city', 'supplies', 'payment_terms_days', 'lead_time_days', 'pays_by_method', 'pays_by_account', 'notes'];
  const csv = toCsv([
    header,
    [NEW_NAME, 'Sumon Mia', '+8801712345670', 'Gazipur', 'Denim', '30', '7', 'bkash', '01712345670', 'QA new'],
    [`Renamed In File ${RUN}`, '', '01911-222333', 'Chattogram', '', '', '', '', '', ''],
    [`qa name match ${RUN}`.toUpperCase(), '', '', 'Rajshahi', '', '', '', '', '', ''],
    [`QA Bad Phone ${RUN}`, '', '12345', 'Khulna', '', '', '', '', '', ''],
    [`=HYPERLINK("http://x.test","QA ${RUN}")`, '', '', '', '', '', '999', '', '', ''],
  ]);
  const up = await uploadSupplierCsv(shop.s, csv);
  expect(up.status, up.text.slice(0, 300)).toBe(201);
  const imp = up.json.data;
  expect(imp.type).toBe('suppliers');
  for (const h of ['name', 'phone', 'city', 'lead_time_days']) expect(imp.suggested_map[h], `suggested map ${h}`).toBe(h);
  const v = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/imports/${imp.id}/validate`, { column_map: imp.suggested_map, options: { update_existing: true, import_as_draft: false, create_missing_categories: false } });
  expect(v.status, JSON.stringify(v.json)).toBe(202);
  const validated = await waitImport(shop.s, imp.id);
  expect(validated.status).toBe('validated');
  expect(validated.summary).toMatchObject({ create: 1, update: 2, errors: 2 });

  // error report: original columns + errors, every cell formula-safe
  const rep = await apiCall(shop.s, 'GET', `/stores/${shop.s.storeId}/imports/${imp.id}/error-report`, { headers: { Accept: 'text/csv, application/json' } });
  expect(rep.status, rep.text.slice(0, 200)).toBe(200);
  const rows = csvObjects(rep.text);
  expect(rows).toHaveLength(2);
  for (const cell of parseCsv(rep.text).flat()) expect(isFormulaUnsafe(cell), `unsafe cell ${JSON.stringify(cell)}`).toBe(false);

  const run = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/imports/${imp.id}/run`);
  expect(run.status, JSON.stringify(run.json)).toBe(202);
  expect((await waitImport(shop.s, imp.id, 120_000)).status).toBe('completed');

  const created = await allSuppliersByName(shop.s, NEW_NAME);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ phone: '8801712345670', city: 'Gazipur', supplies: 'Denim', payment_terms_days: 30, lead_time_days: 7, pays_by_method: 'bkash', contact_name: 'Sumon Mia' });
  const phoneMatched = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/suppliers/${byPhone.id}`)).json.data;
  expect(phoneMatched.city).toBe('Chattogram');
  const nameMatched = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/suppliers/${byName.id}`)).json.data;
  expect(nameMatched.city).toBe('Rajshahi');
  expect(await allSuppliersByName(shop.s, `QA Bad Phone ${RUN}`)).toEqual([]);
  expect((await suppliersSummary(shop.s)).suppliers_count).toBe(3);

  const auditLog = await api(shop.s, 'GET', '/audit-logs?per_page=100');
  expect((auditLog.json.data as Json[]).map((a) => a.action)).toContain('purchasing.suppliers_imported');
});

test('UI Suppliers: KPI tiles, rows, detail panel, search, Import → supplier import page', async ({ page, context }) => {
  test.setTimeout(120_000);
  // give the phone-matched supplier a received PO and a part payment so "You owe" and recent POs show
  const d = await createPo(shop.s, byPhone.id, [{ variant_id: shop.simple.variantId, unit_cost_amount: 30_000, quantity: 2 }]);
  const o = await sendPo(shop.s, d.id, 'manual');
  await receive(shop.s, o.id, [{ item_id: o.lines[0].id, received: 2 }]);
  await pay(shop.s, byPhone.id, 20_000, { purchase_order_id: o.id });

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSuppliers(page);
  for (const t of ['Suppliers', 'You owe', 'On the way', 'Bought this month']) await expect(kpi(page, t), t).toBeVisible();
  await expect(page.getByText(/vs last month/i)).toHaveCount(0);
  await expect(kpi(page, 'You owe')).toContainText(/৳\s?400/);

  const row = page.getByRole('row').filter({ hasText: byPhone.name }).or(page.getByRole('listitem').filter({ hasText: byPhone.name })).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Chattogram/);
  await expect(page.getByText(NEW_NAME).first()).toBeVisible();
  await row.click();
  await expect(page.getByText(/You owe ৳\s?400/).first()).toBeVisible();
  await expect(page.getByText(o.number).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Record payment$/ }).first()).toBeVisible();

  const search = page.getByRole('searchbox').or(page.getByPlaceholder(/Search/)).first();
  await search.fill(NEW_NAME);
  await expect(page.getByRole('row').filter({ hasText: byPhone.name })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(NEW_NAME).first()).toBeVisible();

  await search.fill('');
  await importButton(page).click();
  await expect(page).toHaveURL(/\/products\/import\?type=suppliers|\/import.*suppliers/);
  await expect(page.getByRole('heading', { name: 'Import suppliers from CSV', level: 1 })).toBeVisible({ timeout: 15_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
