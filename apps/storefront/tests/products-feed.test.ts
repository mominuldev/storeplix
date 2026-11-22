import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => 'preview-tok' }));

import { buildProductFeedRequest } from '@/lib/config-request';
import { formatBdt, formatMoney } from '@/lib/format';
import { discountLabel, featuredFromFeed, flashDealsFromFeed, getFeaturedProducts, getFlashDeals, loadProductFeed, type ProductCardView } from '@/lib/products';
import { parseProductFeed } from '@/lib/storefront-schemas';
import { ProductCard } from '@/themes/modern-commerce/components/product-card';
import { FlashSaleSection } from '@/themes/modern-commerce/sections/flash-sale';
import { FeaturedProductsSection } from '@/themes/modern-commerce/sections/featured-products';
import { flashSaleSchema, featuredProductsSchema } from '@/themes/modern-commerce/schema';
import type { SectionContext } from '@/themes/types';

const MEDIA_ID = '01jcz8m4q9w7t3x5y6z8a0b2c4';
const card = (over: Record<string, unknown> = {}) => ({
  id: '01jd000000000000000000000a',
  slug: 'linen-kurta',
  name: 'Linen kurta',
  subtitle: 'Clothing',
  price_amount: 345000,
  compare_at_amount: null,
  currency: 'BDT',
  on_sale: false,
  image: { id: MEDIA_ID, url: 'https://cdn.storeplix.com/kurta.webp', width: 800, height: 1000, alt: 'Kurta', srcset: [] },
  ...over,
});
const body = (data: unknown[], has_products = true) => ({ data, meta: { has_products } });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const store = {
  id: '1', name: 'Demo Store', slug: 'demo', status: 'active' as const, currency: 'BDT', logo_url: null, favicon_url: null,
  icons: { apple_touch: null, icon_192: null, icon_512: null }, primary_host: 'demo.localhost',
};
const ctx = (preview = false): SectionContext => ({ store, host: 'demo.localhost', media: {}, preview });

async function render(Component: unknown, settings: unknown, c: SectionContext) {
  const el = (await (Component as (p: object) => Promise<ReactElement | null>)({ id: 's1', settings, blocks: [], ctx: c })) as ReactElement | null;
  return el ? renderToStaticMarkup(el) : '';
}

describe('formatBdt / formatMoney (paisa)', () => {
  it('formats whole taka without decimals and keeps paisa when present', () => {
    expect(formatBdt(345000)).toBe('৳ 3,450');
    expect(formatBdt(345050)).toBe('৳ 3,450.50');
    expect(formatBdt(5)).toBe('৳ 0.05');
    expect(formatBdt(0)).toBe('৳ 0');
    expect(formatBdt(123456789)).toBe('৳ 1,234,567.89');
  });
  it('rejects non-integer amounts instead of rounding floats', () => {
    expect(formatBdt(3450.5)).toBe('');
    expect(formatBdt(Number.NaN)).toBe('');
  });
  it('formatMoney uses ৳ for BDT and the ISO code otherwise', () => {
    expect(formatMoney(345000, 'bdt')).toBe('৳ 3,450');
    expect(formatMoney(1999, 'USD')).toBe('USD 19.99');
  });
});

describe('discountLabel', () => {
  it('is −round((1 − price/compare_at) × 100)%', () => {
    expect(discountLabel(241500, 345000)).toBe('−30%');
    expect(discountLabel(145000, 165000)).toBe('−12%'); // 12.12 → 12
    expect(discountLabel(100, 300)).toBe('−67%'); // 66.67 → 67
    expect(discountLabel(99500, 100000)).toBe('−1%'); // 0.5 → 1 (round half up)
  });
  it('is empty without a higher compare-at price', () => {
    expect(discountLabel(100, null)).toBe('');
    expect(discountLabel(100, 100)).toBe('');
  });
});

describe('parseProductFeed (Zod)', () => {
  it('parses cards and strips every key outside StorefrontProductCard (cost, stock, sku)', () => {
    const feed = parseProductFeed(body([card({ cost_amount: 100000, stock: 7, sku: 'K-1', tenant_id: 'x' })]));
    expect(feed?.has_products).toBe(true);
    expect(Object.keys(feed!.products[0]!).sort()).toEqual(
      ['compare_at_amount', 'currency', 'id', 'image', 'name', 'on_sale', 'price_amount', 'slug', 'subtitle'].sort(),
    );
    expect(JSON.stringify(feed)).not.toMatch(/cost|stock|sku|tenant/);
  });
  it('rejects an invalid envelope', () => {
    expect(parseProductFeed(null)).toBeNull();
    expect(parseProductFeed({ data: [] })).toBeNull();
    expect(parseProductFeed({ data: 'x', meta: { has_products: true } })).toBeNull();
  });
  it('drops invalid cards (float price, missing name) and unsafe images', () => {
    const feed = parseProductFeed(body([card({ price_amount: 3450.5 }), card({ name: '' }), card({ id: 'b', image: { id: MEDIA_ID, url: 'javascript:alert(1)', width: 1, height: 1 } })]));
    expect(feed!.products).toHaveLength(1);
    expect(feed!.products[0]!.image).toBeNull();
  });
  it('drops a compare-at that is not above the price', () => {
    expect(parseProductFeed(body([card({ compare_at_amount: 345000 })]))!.products[0]!.compare_at_amount).toBeNull();
  });
});

describe('buildProductFeedRequest', () => {
  const env = { apiUrl: 'http://api', apiKey: 'k' };
  it('public fetch is tagged store:{host} with a 300 s revalidate and no preview header', () => {
    const { url, init } = buildProductFeedRequest('demo.localhost', { sort: 'latest', limit: 4 }, null, env);
    expect(url).toBe('http://api/api/v1/storefront/products?sort=latest&limit=4');
    expect(init.next).toEqual({ tags: ['store:demo.localhost'], revalidate: 300 });
    expect(init.cache).toBeUndefined();
    expect(init.headers).not.toHaveProperty('X-Storefront-Preview');
  });
  it('preview fetch is no-store, untagged and forwards the token', () => {
    const { url, init } = buildProductFeedRequest('demo.localhost', { sort: 'latest', limit: 99, onSale: true }, 'tok', env);
    expect(url).toBe('http://api/api/v1/storefront/products?sort=latest&limit=24&on_sale=1');
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
    expect(init.headers).toMatchObject({ 'X-Storefront-Preview': 'tok', 'X-Storefront-Host': 'demo.localhost', 'X-Storefront-Key': 'k' });
  });
});

describe('feed client with fallbacks', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'test-key');
    vi.stubEnv('STOREFRONT_API_URL', 'http://api');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('has_products false → placeholders (paisa, still marked placeholder)', async () => {
    fetchMock.mockResolvedValue(json(body([], false)));
    const cards = await getFeaturedProducts('demo.localhost', 4);
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.placeholder)).toBe(true);
    expect(cards[1]!.price_amount).toBe(345000);
    expect(cards[0]!.compare_at_amount).toBe(230000);
  });

  it('has_products true with fewer than the limit → only the real cards, no padding', async () => {
    fetchMock.mockResolvedValue(json(body([card()])));
    const cards = await getFeaturedProducts('demo.localhost', 4);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ placeholder: false, href: '/products/linen-kurta', name: 'Linen kurta', price_amount: 345000 });
  });

  it.each([
    ['an invalid payload', () => json({ nope: true })],
    ['a 404 (endpoint missing)', () => json({ error: { code: 'not_found' } }, 404)],
    ['a 500', () => json({}, 500)],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s → logged, placeholders, never throws', async (_label, res) => {
    fetchMock.mockImplementation(res);
    const cards = await getFeaturedProducts('demo.localhost', 2);
    expect(cards.map((c) => c.placeholder)).toEqual([true, true]);
    expect(console.error).toHaveBeenCalled();
  });

  it('a missing API key never reaches fetch and falls back', async () => {
    vi.stubEnv('STOREFRONT_API_KEY', '');
    expect(await loadProductFeed('demo.localhost', { sort: 'latest', limit: 4 }, null)).toEqual({ products: [], has_products: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('public sections fetch tagged; preview sections fetch no-store with the token', async () => {
    fetchMock.mockImplementation(async () => json(body([card()])));
    await getFeaturedProducts('demo.localhost', 4, 'bestsellers');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api/api/v1/storefront/products?sort=bestsellers&limit=4');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ next: { tags: ['store:demo.localhost'], revalidate: 300 } });
    await getFlashDeals('demo.localhost', 4, { preview: true });
    expect(fetchMock.mock.calls[1]![0]).toContain('on_sale=1');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ cache: 'no-store', headers: { 'X-Storefront-Preview': 'preview-tok' } });
    expect(fetchMock.mock.calls[1]![1].next).toBeUndefined();
  });

  it('flash sale: empty on_sale result hides the section live and shows the note in preview', async () => {
    fetchMock.mockImplementation(async () => json(body([], true)));
    const settings = flashSaleSchema.parse({});
    expect(await render(FlashSaleSection, settings, ctx(false))).toBe('');
    const preview = await render(FlashSaleSection, settings, ctx(true));
    expect(preview).toContain('No sale items yet — add a compare-at price to show products here');
  });

  it('flash sale: real deals show the discount label, link to the PDP and have no stock meter (Phase 5)', async () => {
    fetchMock.mockImplementation(async () => json(body([card({ price_amount: 241500, compare_at_amount: 345000, on_sale: true })])));
    const html = await render(FlashSaleSection, flashSaleSchema.parse({}), ctx(false));
    expect(html).toContain('−30%');
    expect(html).toContain('৳ 2,415');
    expect(html).toContain('৳ 3,450');
    expect(html).not.toContain('data-sp-stock-meter');
    expect(html).not.toContain('claimed');
    expect(html).toContain('href="/products/linen-kurta"');
    expect(html).toContain('aria-label="Add Linen kurta to bag"');
  });

  it('flash sale: placeholders keep their stock meter when the store has no products', async () => {
    fetchMock.mockImplementation(async () => json(body([], false)));
    const html = await render(FlashSaleSection, flashSaleSchema.parse({}), ctx(false));
    expect(html).toContain('data-sp-stock-meter');
    expect(html).toContain('% claimed');
  });

  it('featured section renders real cards linking to their PDP', async () => {
    fetchMock.mockImplementation(async () => json(body([card(), card({ id: 'b', slug: 'b', name: 'Second', image: null })])));
    const html = await render(FeaturedProductsSection, featuredProductsSchema.parse({}), ctx(false));
    expect(html.match(/data-sp-product="real"/g)).toHaveLength(2);
    expect(html).toContain('href="/products/linen-kurta"');
    expect(html).toContain('href="/products/b"');
    expect(html).toContain('data-sp-image-placeholder');
  });
});

describe('ProductCard', () => {
  const view = (over: Partial<ProductCardView> = {}): ProductCardView => ({
    ...featuredFromFeed({ products: [parseProductFeed(body([card()]))!.products[0]!], has_products: true }, 1)[0]!,
    ...over,
  });

  it('links to the PDP and has an enabled Add to cart; no wishlist heart (deferred)', () => {
    const html = renderToStaticMarkup(createElement(ProductCard, { product: view() }));
    expect(html).toContain('href="/products/linen-kurta"');
    expect(html).not.toMatch(/<button type="button" disabled=""[^>]*>Add to cart/);
    expect(html).toContain('aria-label="Add Linen kurta to bag"');
    expect(html).not.toContain('wishlist');
    expect(html).toContain('৳ 3,450');
  });

  it('placeholder cards have no link either', () => {
    const [ph] = featuredFromFeed({ products: [], has_products: false }, 1);
    const html = renderToStaticMarkup(createElement(ProductCard, { product: ph! }));
    expect(html).not.toContain('<a ');
    expect(html).toContain('cardigan.png');
  });

  it('image null → neutral placeholder, not a demo photo', () => {
    const html = renderToStaticMarkup(createElement(ProductCard, { product: view({ image: null }) }));
    expect(html).toContain('data-sp-image-placeholder');
    expect(html).not.toMatch(/\/themes\/modern-commerce\/images\//);
  });

  it('flashDealsFromFeed only keeps cards with a higher compare-at', () => {
    const products = parseProductFeed(body([card(), card({ id: 'b', compare_at_amount: 400000, on_sale: true })]))!.products;
    const result = flashDealsFromFeed({ products, has_products: true }, 4);
    expect(result.source).toBe('feed');
    expect(result.deals.map((d) => d.id)).toEqual(['b']);
    expect(result.deals[0]).toMatchObject({ stock_left: null, claimed_percent: null, discount_label: '−14%' });
  });
});
