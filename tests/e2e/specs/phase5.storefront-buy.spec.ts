import { expect, test } from '@playwright/test';
import { api, urls } from '../support/api';
import { browserHost, forbiddenKeys, setupShop, sf, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5-CONTRACT §12 QA "storefront-buy" (+ §15.1): PLP → price filter → PDP (variant) → cart (coupon)
 * → checkout COD → thank-you → track by number + phone. The order is placed on a throwaway shop
 * (`{slug}.localhost`), so the demo store gets no test orders; the demo is browsed read-only.
 */
let shop: CommerceShop;
const CODE = `QABUY${Date.now() % 100000}`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('buy', { stock: 6 });
  browserHost(shop);
  // percentage 10 % capped at ৳ 100
  const c = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/coupons`, { code: CODE, type: 'percentage', percent_bps: 1000, max_discount_amount: 10000, status: 'active' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
});
test.afterAll(() => shop?.cleanup());

test('shopper: PLP filter → PDP variant → cart coupon → COD checkout → thank-you → track', async ({ page, context }) => {
  test.setTimeout(150_000);
  const sfu = shop.storefront;
  const plp = await page.goto(`${sfu}/c/${shop.category.slug}`);
  expect(plp?.status()).toBe(200);
  await expect(page.getByText('QA Cotton Kurta').first()).toBeVisible();
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible();
  // price filter: max ৳ 1,000 leaves only the ৳ 500 wrap
  await page.getByLabel('Maximum price').first().fill('1000');
  await page.getByRole('button', { name: 'Apply filters' }).first().click();
  await expect(page).toHaveURL(/max=1000|price_max=/);
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible();
  await expect(page.getByText('QA Cotton Kurta')).toHaveCount(0);
  await page.getByRole('link', { name: 'Clear all' }).first().click();
  await expect(page.getByText('QA Cotton Kurta').first()).toBeVisible();

  await page.getByRole('link', { name: /QA Cotton Kurta/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/products/${shop.variable.slug}$`));
  await expect(page.getByRole('heading', { name: 'QA Cotton Kurta' })).toBeVisible();
  // the PDP HTML never carries stock, SKU or cost (availability is a client fetch)
  const html = await (await fetch(`${sfu}/products/${shop.variable.slug}`)).text();
  for (const v of shop.variable.variants) expect(html).not.toContain(v.sku);
  expect(html).not.toMatch(/on_hand|cost_amount|"committed"/);
  await page.getByRole('button', { name: 'L', exact: true }).click();
  await expect(page.getByRole('button', { name: 'L', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('৳ 1,400').first()).toBeVisible();
  const avail = await (await fetch(`${sfu}/api/availability/${shop.variable.slug}`)).json();
  expect(avail.data.variants.every((v: { available: boolean }) => v.available)).toBe(true);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect.poll(async () => (await context.cookies(sfu)).find((c) => c.name === 'sp_cart')?.value ?? '').toMatch(/^[A-Za-z0-9_-]{43}$/);
  const cartCookie = (await context.cookies(sfu)).find((c) => c.name === 'sp_cart')!;
  expect([cartCookie.httpOnly, cartCookie.sameSite, cartCookie.path]).toEqual([true, 'Lax', '/']);
  expect(await page.evaluate(() => document.cookie)).not.toContain('sp_cart');

  const cartRes = await page.goto(`${sfu}/cart`);
  // `next dev` rewrites it to `no-store`; a production build (`next start`) keeps `private, no-store`.
  expect(cartRes?.headers()['cache-control']).toMatch(/(^|, )no-store/);
  expect(cartRes?.headers()['cache-control']).not.toMatch(/public|s-maxage/);
  await expect(page.getByText('QA Cotton Kurta').first()).toBeVisible();
  await page.getByPlaceholder('Coupon code').fill('NOPE123');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText("This code doesn't exist.")).toBeVisible();
  await page.getByPlaceholder('Coupon code').fill(CODE.toLowerCase());
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(CODE).first()).toBeVisible();
  await expect(page.getByText('৳ 100').first()).toBeVisible(); // 10 % of 1,400 = 140, capped at 100
  await page.getByRole('link', { name: 'Checkout' }).first().click();

  await expect(page).toHaveURL(/\/checkout$/);
  await page.getByLabel('Full name').fill('Rahim Uddin');
  const phone = `017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Division').selectOption('dhaka');
  await page.getByLabel('District').selectOption('dhaka');
  await page.getByLabel('Upazila / Thana').selectOption('dhaka-dhanmondi');
  await page.getByLabel('House, road, flat').fill('House 12, Road 7A, Flat 4B');
  await expect(page.getByText('Inside Dhaka').first()).toBeVisible();
  // 1,400 − 100 + 60 (Inside Dhaka: Dhanmondi thana)
  const place = page.getByRole('button', { name: /Place order — ৳ 1,360/ });
  await expect(place).toBeVisible();
  await place.click();

  await expect(page).toHaveURL(/\/checkout\/thank-you$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Thank you, Rahim!' })).toBeVisible();
  const orders = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`);
  const order = orders.json.data[0];
  expect([order.total_amount, order.coupon_code, order.channel]).toEqual([136000, CODE, 'website']);
  await expect(page.getByText(order.number).first()).toBeVisible();
  const orderCookie = (await context.cookies(sfu)).find((c) => c.name === 'sp_order')!;
  expect(orderCookie.httpOnly).toBe(true);
  expect((await context.cookies(sfu)).find((c) => c.name === 'sp_cart')).toBeUndefined();

  const prodPort = process.env.E2E_PROD_STOREFRONT_PORT; // optional: the same host on a `next start` build
  if (prodPort) {
    for (const path of ['/checkout/thank-you', '/cart', '/checkout', '/track']) {
      const r = await context.request.get(`http://${shop.localHost}:${prodPort}${path}`, { maxRedirects: 0 });
      expect(`${path} ${r.status()} ${r.headers()['cache-control']}`).toMatch(new RegExp(`^${path} (200|307) private, no-store$`));
    }
  }
  await page.getByRole('link', { name: 'Track this order' }).click();
  await expect(page).toHaveURL(/\/track/);
  await expect(page.locator('#track-number')).toHaveValue(order.number);
  await page.locator('#track-phone').fill(phone);
  await page.getByRole('button', { name: 'Track order' }).click();
  await expect(page.getByText(/Dhanmondi/).first()).toBeVisible();
  await expect(page.getByText('House 12')).toHaveCount(0);

  // wrong phone → the generic not-found message
  await page.locator('#track-phone').fill('01799999999');
  await page.getByRole('button', { name: 'Track order' }).click();
  await expect(page.getByText("We couldn't find an order with that number and phone. Check both and try again.")).toBeVisible();

  // stock: L committed 1 of 3
  const p = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/products/${shop.variable.id}`);
  expect(p.json.data.variants.find((v: { option_values: string[] }) => v.option_values[0] === 'L').inventory.committed).toBe(1);
});

test('demo store (read-only): category, search and PDP render; storefront API never leaks cost/SKU/stock', async ({ page }) => {
  const cats = await sf('demo.localhost', 'GET', '/categories');
  expect(cats.status).toBe(200);
  const slug = cats.json.data[0].slug as string;
  await page.goto(`${urls.storefront}/c/${slug}`);
  await expect(page.locator('main')).toBeVisible();
  const list = await sf('demo.localhost', 'GET', `/products?page=1&per_page=48&category=${slug}`);
  expect(forbiddenKeys(list.json)).toEqual([]);
  const first = list.json.data[0];
  if (first) {
    await page.goto(`${urls.storefront}/products/${first.slug}`);
    await expect(page.getByRole('heading', { name: first.name })).toBeVisible();
    const pdp = await sf('demo.localhost', 'GET', `/products/${first.slug}`);
    expect(forbiddenKeys(pdp.json)).toEqual([]);
    expect(pdp.headers['cache-control']).toContain('s-maxage=60');
  }
  await page.goto(`${urls.storefront}/search?q=set`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const robots = await (await fetch(`${urls.storefront}/robots.txt`)).text();
  for (const p of ['/cart', '/checkout', '/track', '/search', '/discount']) expect(robots).toContain(`Disallow: ${p}`);
});
