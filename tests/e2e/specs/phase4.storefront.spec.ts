import { expect, test } from '@playwright/test';
import { api, createTenant, demoSession, urls, waitForStorefront, type Session, type ThrowawayTenant } from '../support/api';
import { Tracker, purgeRun, simpleProduct, storefrontFeed, tagged } from '../support/catalog';

/**
 * Phase 4 §3.8 / §8 / §15.8: the storefront shows real products.
 *  - Feed: only active products with an enabled variant; exact card key set (no cost, SKU, stock, ids);
 *    card variant = cheapest enabled; on_sale; cache headers.
 *  - Demo home: a new active product appears within 5 s of saving (revalidation), disappears when archived;
 *    placeholders are gone; cards have no link (no PDP yet).
 *  - A new store with no products shows the placeholders; its draft feed is 404.
 */
test.describe.configure({ mode: 'serial' });

const PLACEHOLDER = 'Merino cable-knit cardigan';
const DEMO_HOST = new URL(urls.storefront).hostname;
const CARD_KEYS = ['compare_at_amount', 'currency', 'id', 'image', 'name', 'on_sale', 'price_amount', 'slug', 'subtitle'].sort();

let s: Session;
let t: Tracker;
let eve: ThrowawayTenant | null = null;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  eve?.cleanup();
  expect(problems, 'cleanup').toEqual([]);
});

test('feed: active only, exact key set, cheapest enabled variant, on_sale, cache headers', async () => {
  const active = await t.createProduct({
    name: tagged('Feed saree'),
    status: 'active',
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: [
      { option_values: ['S'], price_amount: 300000, compare_at_amount: 400000, cost_amount: 100000, sku: null, is_enabled: true },
      { option_values: ['M'], price_amount: 100000, cost_amount: 50000, is_enabled: false }, // cheapest but disabled
      { option_values: ['L'], price_amount: 250000, compare_at_amount: 300000, is_enabled: true },
    ],
  });
  const draft = await t.createProduct(simpleProduct('Feed draft', 1000));
  const noVariant = await t.createProduct({ ...simpleProduct('Feed disabled', 1000, { status: 'active' }), variants: [{ price_amount: 1000, is_enabled: false }] });

  const feed = await storefrontFeed(DEMO_HOST, '?limit=24');
  expect(feed.status).toBe(200);
  expect(feed.json.meta.has_products).toBe(true);
  expect(feed.headers['cache-control']).toMatch(/public.*s-maxage=60|s-maxage=60.*public/);
  const ids = (feed.json.data as Array<{ id: string }>).map((c) => c.id);
  expect(ids).toContain(active.id);
  expect(ids).not.toContain(draft.id);
  expect(ids).not.toContain(noVariant.id);
  const card = feed.json.data.find((c: { id: string }) => c.id === active.id);
  expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
  expect(card).toMatchObject({ price_amount: 250000, compare_at_amount: 300000, on_sale: true, currency: 'BDT', name: active.name });
  expect(JSON.stringify(feed.json)).not.toMatch(/cost_amount|"sku"|on_hand|tenant_id|store_id/);

  const sale = await storefrontFeed(DEMO_HOST, '?on_sale=1&limit=24');
  expect((sale.json.data as Array<{ on_sale: boolean }>).every((c) => c.on_sale)).toBe(true);
  // Limits and bad input.
  expect((await storefrontFeed(DEMO_HOST, '?limit=25')).status).toBe(422);
  expect((await storefrontFeed(DEMO_HOST, '?category=no-such-category')).json.data).toEqual([]);
  expect((await storefrontFeed('nope.localhost')).status).toBe(404);
});

test('demo home: a new active product shows within 5 s and leaves when archived; no placeholders; no links', async ({ page }) => {
  test.setTimeout(90_000);
  const p = await t.createProduct({ ...simpleProduct('Live kurta', 189000, { status: 'active', compare_at_amount: 220000 }) });
  const ms = await waitForStorefront('/', (html) => html.includes(p.name), 5_000);
  test.info().annotations.push({ type: 'revalidation', description: `${ms} ms` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${urls.storefront}/`);
  const card = page.getByText(p.name, { exact: true }).first();
  await expect(card).toBeVisible();
  await expect(page.getByText(PLACEHOLDER)).toHaveCount(0);
  // Real cards render without a link until the PDP ships.
  expect(await card.evaluate((el) => !!el.closest('a'))).toBe(false);
  await expect(page.getByText('৳ 1,890').first()).toBeVisible();

  const cur = await api(s, 'GET', `/stores/${s.storeId}/products/${p.id}`);
  const r = await api(s, 'PATCH', `/stores/${s.storeId}/products/${p.id}`, { revision: cur.json.data.revision, status: 'archived' });
  expect(r.status).toBe(200);
  await waitForStorefront('/', (html) => !html.includes(p.name), 5_000);
});

test('new store: feed 404 while draft, has_products false when live → placeholders', async ({ page }) => {
  test.setTimeout(90_000);
  eve = await createTenant('sf');
  expect((await storefrontFeed(eve.host)).status).toBe(404); // no domain yet / draft
  eve.activateStorefront();
  const feed = await storefrontFeed(eve.host);
  expect(feed.status, JSON.stringify(feed.json)).toBe(200);
  expect(feed.json).toEqual({ data: [], meta: { has_products: false } });

  const url = `http://${eve.host}:${new URL(urls.storefront).port || 80}/`;
  await page.goto(url);
  await expect(page.getByText(PLACEHOLDER).first()).toBeVisible();
  // ...and the demo store's products never leak into it.
  const demo = await storefrontFeed(DEMO_HOST, '?limit=24');
  const html = await page.content();
  for (const c of demo.json.data as Array<{ name: string }>) expect(html).not.toContain(c.name);
});
