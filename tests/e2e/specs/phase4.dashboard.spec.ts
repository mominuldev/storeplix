import { expect, test } from '@playwright/test';
import { api, apiCall, demoSession, signInDashboard, urls, type Session } from '../support/api';
import { Tracker, purgeRun, simpleProduct, tagged } from '../support/catalog';

/**
 * Phase 4 §3.6 / §9.1 / §15.6: dashboard home on the demo store.
 *  - API: real catalog/stock/customer numbers that move when data changes; orders null; no-store.
 *  - UI: greeting "{store} · N products, M low on stock[, K out of stock]"; order/money tiles show "—" with "Starts with your
 *    first order"; the hero money card shows "No sales yet"; Restock task links to /inventory; checklist
 *    has "Add products".
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const D = () => `/stores/${s.storeId}/dashboard`;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  expect(problems, 'cleanup').toEqual([]);
});

test('API: shape, no-store, numbers follow the data', async () => {
  const r = await apiCall(s, 'GET', D());
  expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toContain('no-store');
  const d0 = r.json.data;
  expect(Object.keys(d0).sort()).toEqual(['currency', 'customers', 'generated_at', 'inventory', 'orders', 'products', 'setup', 'timezone'].sort());
  expect(d0).toMatchObject({ currency: 'BDT', timezone: 'Asia/Dhaka', orders: null });
  expect(d0.setup.has_products).toBe(d0.products.total > 0);
  expect(d0.products.total).toBe(d0.products.active + d0.products.draft + d0.products.archived);

  // Cross-check against the list endpoint's counts.
  const list = await api(s, 'GET', `/stores/${s.storeId}/products?per_page=1`);
  expect(list.json.meta.counts.all).toBe(d0.products.total);
  expect(list.json.meta.plan.used).toBe(d0.products.total);
  expect(list.json.meta.plan.limit).toBe(d0.products.limit);

  await t.createProduct(simpleProduct('Dash active out', 1000, { status: 'active', initial_on_hand: 0 }));
  await t.createProduct(simpleProduct('Dash active low', 1000, { status: 'active', initial_on_hand: 2 }));
  await t.createProduct(simpleProduct('Dash draft', 1000, { initial_on_hand: 0 }));
  await t.createCustomer({ name: tagged('Dash customer'), email: `dash-${Date.now()}@e2e.example` });

  const d1 = (await api(s, 'GET', D())).json.data;
  expect(d1.products.total).toBe(d0.products.total + 3);
  expect(d1.products.active).toBe(d0.products.active + 2);
  expect(d1.products.draft).toBe(d0.products.draft + 1);
  // Inventory counts only tracked, enabled variants of ACTIVE products: the draft's 0 stock doesn't count.
  expect(d1.inventory.out_of_stock_variants).toBe(d0.inventory.out_of_stock_variants + 1);
  expect(d1.inventory.low_stock_variants).toBe(d0.inventory.low_stock_variants + 1);
  expect(d1.inventory.units_on_hand).toBe(d0.inventory.units_on_hand + 2);
  expect(d1.customers.total).toBe(d0.customers.total + 1);
  expect(d1.customers.new_this_month).toBe(d0.customers.new_this_month + 1);
});

test('UI: KPI empty states, catalog card, Restock task, checklist', async ({ page, context }) => {
  await signInDashboard(context, s);
  const d = (await api(s, 'GET', D())).json.data;
  await page.goto(`${urls.merchant}/`);
  await expect(page.getByText(new RegExp(`${d.products.total} products?`)).first()).toBeVisible();
  // Order/money tiles: "—" + hint (no fake numbers).
  await expect(page.getByText('Starts with your first order').first()).toBeVisible();
  await expect(page.getByText('No sales yet').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Share your shop link|Copy link/i }).first()).toBeVisible();
  // Deferred cards are not rendered.
  for (const gone of [/Courier performance/i, /Orders by source/i, /Money flow/i, /Best sellers/i]) await expect(page.getByText(gone)).toHaveCount(0);

  const restock = page.getByRole('link', { name: /Restock products/i });
  if (d.inventory.low_stock_variants + d.inventory.out_of_stock_variants > 0) {
    await expect(restock).toBeVisible();
    await expect(restock).toHaveAttribute('href', /\/inventory\?stock=low(,|%2C)out/);
  }
  await expect(page.getByText('Add products').first()).toBeVisible();
});
