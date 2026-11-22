import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, urls, type Session } from '../support/api';
import { RUN, Tracker, png, purgeRun, simpleProduct, sku, tagged, variableProduct } from '../support/catalog';

/**
 * Phase 4 §12 "catalog" (+ §15.2): products on the demo store.
 *  - API: simple + variable (2 options, 6 variants) create, type derived, SKU unique per store
 *    case-insensitively, money rules, option rules, revision lock, variant replacement, stock only via
 *    the ledger, duplicate, bulk actions.
 *  - UI: create a product with 2 photos in the editor → the list shows it with its cover → archive,
 *    activate and duplicate from the row menu.
 * Everything created carries the run tag and is deleted (then hard-purged) in afterAll.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const P = () => `/stores/${s.storeId}/products`;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  expect(problems, 'cleanup').toEqual([]);
});

test('API: simple and variable products; type is derived; prices and stock land where the contract says', async () => {
  const simple = await t.createProduct(simpleProduct('Simple tee', 95000, { initial_on_hand: 7, cost_amount: 50000, compare_at_amount: 120000 }));
  expect(simple).toMatchObject({ type: 'simple', status: 'draft', revision: 1, price_min_amount: 95000, price_max_amount: 95000, currency: 'BDT' });
  expect(simple.variants).toHaveLength(1);
  expect(simple.variants[0]).toMatchObject({ is_default: true, option_values: [], title: 'Default', cost_amount: 50000 });
  expect(simple.variants[0].inventory).toMatchObject({ on_hand: 7, committed: 0, available: 7, status: 'in_stock' });

  const variable = await t.createProduct(variableProduct('Jamdani', ['M', 'L', 'XL'], ['Red', 'Blue'], 345000));
  expect(variable.type).toBe('variable');
  expect(variable.variants).toHaveLength(6);
  expect(variable.variants.map((v: { title: string }) => v.title)).toContain('M / Red');
  expect(variable.options).toEqual([
    { name: 'Size', values: ['M', 'L', 'XL'] },
    { name: 'Colour', values: ['Red', 'Blue'] },
  ]);

  // Every initial stock wrote one `initial` ledger row.
  const mv = await api(s, 'GET', `/stores/${s.storeId}/inventory/movements?filter[product_id]=${variable.id}&per_page=100`);
  expect(mv.status).toBe(200);
  expect(mv.json.data).toHaveLength(6);
  expect(new Set(mv.json.data.map((m: { reason: string }) => m.reason))).toEqual(new Set(['initial']));
});

test('API: validation — SKU case-insensitive uniqueness, compare-at, floats, option limits', async () => {
  const base = simpleProduct('Sku owner', 1000);
  const owner = await t.createProduct(base);
  const skuValue = owner.variants[0].sku as string;

  const cases: Array<[string, unknown, string]> = [
    ['same SKU, other case', { ...simpleProduct('Sku clash', 1000), variants: [{ sku: skuValue.toLowerCase(), price_amount: 1000 }] }, 'variants.0.sku'],
    ['duplicate SKU inside the payload', { ...variableProduct('Dup', ['S', 'M'], ['Red'], 1000), variants: [{ option_values: ['S', 'Red'], sku: sku('DUPX'), price_amount: 1 }, { option_values: ['M', 'Red'], sku: sku('dupx'), price_amount: 1 }] }, 'variants.1.sku'],
    ['compare-at equal to price', { ...simpleProduct('Cmp', 1000), variants: [{ price_amount: 1000, compare_at_amount: 1000 }] }, 'variants.0.compare_at_amount'],
    ['float price', { ...simpleProduct('Float', 1000), variants: [{ price_amount: 3450.5 }] }, 'variants.0.price_amount'],
    ['price above ৳1 crore', { ...simpleProduct('Big', 1000), variants: [{ price_amount: 1_000_000_001 }] }, 'variants.0.price_amount'],
    ['negative price', { ...simpleProduct('Neg', 1000), variants: [{ price_amount: -1 }] }, 'variants.0.price_amount'],
    ['price as a string', { ...simpleProduct('Str', 1000), variants: [{ price_amount: '1000' }] }, 'variants.0.price_amount'],
    ['4 options', { name: tagged('Four'), options: ['A', 'B', 'C', 'D'].map((n) => ({ name: n, values: ['x'] })), variants: [{ option_values: ['x', 'x', 'x', 'x'], price_amount: 1 }] }, 'options'],
    ['21 option values', { name: tagged('Many'), options: [{ name: 'Size', values: Array.from({ length: 21 }, (_, i) => `v${i}`) }], variants: [{ option_values: ['v0'], price_amount: 1 }] }, 'options.0.values'],
    ['duplicate combination', { name: tagged('Combo'), options: [{ name: 'Size', values: ['S', 'M'] }], variants: [{ option_values: ['S'], price_amount: 1 }, { option_values: ['S'], price_amount: 1 }] }, 'variants.1.option_values'],
    ['value not in the option', { name: tagged('Wrong'), options: [{ name: 'Size', values: ['S'] }], variants: [{ option_values: ['XL'], price_amount: 1 }] }, 'variants.0.option_values'],
    ['simple product with 2 variants', { name: tagged('Two'), variants: [{ price_amount: 1 }, { price_amount: 2 }] }, 'variants'],
  ];
  for (const [label, body, field] of cases) {
    const r = await api(s, 'POST', P(), body);
    if (r.status === 201) t.products.add(r.json.data.id);
    expect(r.status, `${label}: ${JSON.stringify(r.json)}`).toBe(422);
    expect(r.json.error.code, label).toBe('validation_failed');
    const keys = Object.keys(r.json.error.details ?? {});
    expect(keys.some((k) => k === field || k.startsWith(`${field}.`)), `${label}: details keys ${keys.join(', ')}`).toBe(true);
  }
});

test('API: PATCH — revision lock, variant replacement keeps ids, SKU freed, stock only through Inventory', async () => {
  const p = await t.createProduct(variableProduct('Patch', ['S', 'M'], ['Red'], 50000));
  const [vs, vm] = p.variants as Array<{ id: string; sku: string; option_values: string[]; price_amount: number }>;

  // revision is required, and a stale one → 409 revision_conflict.
  expect((await api(s, 'PATCH', `${P()}/${p.id}`, { name: tagged('No rev') })).status).toBe(422);
  const ok = await api(s, 'PATCH', `${P()}/${p.id}`, { revision: p.revision, name: tagged('Patch renamed') });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(ok.json.data.revision).toBe(p.revision + 1);
  const stale = await api(s, 'PATCH', `${P()}/${p.id}`, { revision: p.revision, name: tagged('Stale') });
  expect(stale.status).toBe(409);
  expect(stale.json.error.code).toBe('revision_conflict');

  // initial_on_hand on an existing variant → 422; on_hand is ignored.
  const init = await api(s, 'PATCH', `${P()}/${p.id}`, {
    revision: ok.json.data.revision,
    options: p.options,
    variants: [{ ...vs!, initial_on_hand: 50 }, vm],
  });
  expect(init.status).toBe(422);
  expect(Object.keys(init.json.error.details)).toContain('variants.0.initial_on_hand');

  const ignored = await api(s, 'PATCH', `${P()}/${p.id}`, {
    revision: ok.json.data.revision,
    options: p.options,
    variants: [{ id: vs!.id, option_values: vs!.option_values, sku: vs!.sku, price_amount: 60000, on_hand: 999 }, { id: vm!.id, option_values: vm!.option_values, sku: vm!.sku, price_amount: 50000 }],
    on_hand: 999,
    price_min_amount: 1,
    published_at: '2020-01-01T00:00:00Z',
  });
  expect(ignored.status, JSON.stringify(ignored.json)).toBe(200);
  const after = ignored.json.data;
  expect(after.variants.find((v: { id: string }) => v.id === vs!.id).inventory.on_hand).toBe(3);
  expect(after.price_min_amount).toBe(50000);
  expect(after.price_max_amount).toBe(60000);
  expect(after.published_at).toBeNull();

  // Dropping M soft-deletes it (ids kept for the rest) and frees its SKU for another product.
  const dropped = await api(s, 'PATCH', `${P()}/${p.id}`, {
    revision: after.revision,
    options: [{ name: 'Size', values: ['S'] }, { name: 'Colour', values: ['Red'] }],
    variants: [{ id: vs!.id, option_values: ['S', 'Red'], sku: vs!.sku, price_amount: 60000 }],
  });
  expect(dropped.status, JSON.stringify(dropped.json)).toBe(200);
  expect(dropped.json.data.variants.map((v: { id: string }) => v.id)).toEqual([vs!.id]);
  const reuse = await t.createProduct({ ...simpleProduct('Reuse sku', 1000), variants: [{ sku: vm!.sku, price_amount: 1000 }] });
  expect(reuse.variants[0].sku).toBe(vm!.sku);

  // First activation sets published_at once.
  const act = await api(s, 'PATCH', `${P()}/${p.id}`, { revision: dropped.json.data.revision, status: 'active' });
  expect(act.json.data.published_at).toBeTruthy();
  const back = await api(s, 'PATCH', `${P()}/${p.id}`, { revision: act.json.data.revision, status: 'draft' });
  const again = await api(s, 'PATCH', `${P()}/${p.id}`, { revision: back.json.data.revision, status: 'active' });
  expect(again.json.data.published_at).toBe(act.json.data.published_at);
});

test('API: duplicate and bulk actions (a foreign id fails the whole request)', async () => {
  const p = await t.createProduct(simpleProduct('Dupe me', 25000, { initial_on_hand: 4 }));
  const dup = await api(s, 'POST', `${P()}/${p.id}/duplicate`);
  expect(dup.status, JSON.stringify(dup.json)).toBe(201);
  t.products.add(dup.json.data.id);
  expect(dup.json.data).toMatchObject({ status: 'draft', name: `Copy of ${p.name}`, slug: `${p.slug}-copy` });
  expect(dup.json.data.variants[0].sku).toBeNull();
  expect(dup.json.data.variants[0].inventory.on_hand).toBe(0);

  const ids = [p.id, dup.json.data.id];
  const bulk = await api(s, 'POST', `${P()}/bulk`, { action: 'archive', ids });
  expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
  expect(bulk.json.data).toEqual({ action: 'archive', updated: 2 });

  const foreign = await api(s, 'POST', `${P()}/bulk`, { action: 'activate', ids: [...ids, '01J00000000000000000000000'] });
  expect(foreign.status).toBe(422);
  expect(Object.keys(foreign.json.error.details)).toContain('ids.2');
  const still = await api(s, 'GET', `${P()}/${p.id}`);
  expect(still.json.data.status, 'nothing applied').toBe('archived');
});

test('UI: create a product with 2 photos in the editor; the list shows it with its cover', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInDashboard(context, s);
  const name = tagged('Editor kurti');
  await page.goto(`${urls.merchant}/products/new`);
  await page.getByLabel(/^Product name/i).fill(name);

  const uploads: string[] = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/v1/media') && r.request().method() === 'POST' && r.status() === 201) uploads.push((await r.json()).data.id);
  });
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: `e2e-${RUN}-a.png`, mimeType: 'image/png', buffer: png(400, [180, 40, 60]) },
    { name: `e2e-${RUN}-b.png`, mimeType: 'image/png', buffer: png(400, [40, 90, 180]) },
  ]);
  await expect.poll(() => uploads.length, { timeout: 60_000 }).toBe(2); // sequential, each waits for the media job
  uploads.forEach((id) => t.media.add(id));
  await expect(page.getByText(/2 of 10/)).toBeVisible();

  await page.getByLabel(/^Price/i).first().fill('1450');
  await page.getByLabel(/^SKU/i).first().fill(sku('KURTI'));
  const saved = page.waitForResponse((r) => /\/api\/v1\/stores\/[^/]+\/products$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Save product$/ }).click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()).data;
  t.products.add(created.id);
  expect(created.variants[0].price_amount).toBe(145000);
  expect(created.images.map((i: { media_id: string }) => i.media_id)).toEqual(uploads);
  await page.waitForURL(new RegExp(`/products/${created.id}$`));

  await page.goto(`${urls.merchant}/products?q=${encodeURIComponent(RUN)}`);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator(`img[src*="${uploads[0]}"]`)).toBeVisible(); // first image is the cover
  await expect(row).toContainText('৳');
  await expect(row).toContainText('1,450');
});

test('UI: row menu — archive, activate and duplicate', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const p = await t.createProduct(simpleProduct('Row menu', 9900, { status: 'active' }));
  await page.goto(`${urls.merchant}/products?q=${encodeURIComponent(p.name)}`);
  const row = page.getByRole('row').filter({ hasText: p.name });
  await expect(row).toBeVisible();

  const menu = async (item: RegExp) => {
    await row.getByRole('button', { name: /more|actions|•••/i }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await menu(/^Archive/);
  await expect.poll(async () => (await api(s, 'GET', `${P()}/${p.id}`)).json.data.status).toBe('archived');
  await page.getByRole('tab', { name: /^Archived/ }).click();
  await expect(row).toBeVisible();
  await menu(/^(Activate|Publish)/);
  await expect.poll(async () => (await api(s, 'GET', `${P()}/${p.id}`)).json.data.status).toBe('active');

  const dup = page.waitForResponse((r) => r.url().endsWith(`/products/${p.id}/duplicate`) && r.request().method() === 'POST');
  await page.getByRole('tab', { name: /^All/ }).click();
  await menu(/^Duplicate/);
  const d = await dup;
  expect(d.status()).toBe(201);
  t.products.add((await d.json()).data.id);
  await page.goto(`${urls.merchant}/products?q=${encodeURIComponent(p.name)}`);
  await expect(page.getByRole('row').filter({ hasText: `Copy of ${p.name}` })).toBeVisible();
});
