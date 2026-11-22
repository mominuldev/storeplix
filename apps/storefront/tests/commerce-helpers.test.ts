import { describe, expect, it } from 'vitest';
import type { BdGeo, StorefrontProduct } from '@storeplix/types';
import { buildCommerceRequest, clientIpFromHeaders } from '@/lib/commerce-request';
import { catalogApiQuery, catalogHref, pageList, parseCatalogState } from '@/lib/catalog-query';
import { districtsOf, formatBdPhone, mapDetailsToFields, normalizeBdPhone, thanasOf, toCheckoutInput, validateCheckoutForm } from '@/lib/checkout-form';
import { findVariant, optionState, paisaToDecimal, productJsonLd, richTextPlain, toPdpVariants } from '@/lib/pdp';
import { serializeJsonLd } from '@/lib/json-ld';
import { courierStatus, formatDhakaClock, trackingSteps } from '@/lib/tracking';
import { policyLinks } from '@/lib/policy-pages';
import { errorMessage } from '@/lib/commerce-messages';

const env = { apiUrl: 'http://api.test', apiKey: 'secret-key' };
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('commerce requests (server-to-server)', () => {
  it('public catalog reads are tagged and cached; nothing personal is sent', () => {
    const { url, init } = buildCommerceRequest('/storefront/products/a', 'demo.localhost', { cache: { kind: 'public', revalidate: 300 } }, env);
    expect(url).toBe('http://api.test/api/v1/storefront/products/a');
    expect(init.next).toEqual({ tags: ['store:demo.localhost'], revalidate: 300 });
    expect(headersOf(init)).toMatchObject({ 'X-Storefront-Key': 'secret-key', 'X-Storefront-Host': 'demo.localhost' });
    expect(headersOf(init)['X-Cart-Token']).toBeUndefined();
  });

  it('cart, checkout and preview calls are never cached and carry their headers', () => {
    const { init } = buildCommerceRequest(
      '/storefront/checkout',
      'demo.localhost',
      { cache: { kind: 'public', revalidate: 300 }, method: 'POST', body: { a: 1 }, cartToken: 'tok', idempotencyKey: 'k'.repeat(36), clientIp: '203.0.113.9', previewToken: 'pv' },
      env,
    );
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
    expect(headersOf(init)).toMatchObject({ 'X-Cart-Token': 'tok', 'Idempotency-Key': 'k'.repeat(36), 'X-Storefront-Client-Ip': '203.0.113.9', 'X-Storefront-Preview': 'pv', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
  });

  it('forwards the shopper IP only from a trusted proxy', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-real-ip': '198.51.100.2' });
    expect(clientIpFromHeaders(h, false)).toBeNull();
    expect(clientIpFromHeaders(h, true)).toBe('203.0.113.9');
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'evil<script>' , 'x-real-ip': '198.51.100.2' }), true)).toBe('198.51.100.2');
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'nope' }), true)).toBeNull();
  });
});

describe('PLP / search URL state', () => {
  it('parses, clamps and swaps price bounds; taka → paisa for the API', () => {
    const s = parseCatalogState({ page: '3', sort: 'price_desc', min: '2000', max: '500', stock: '1' });
    expect(s).toMatchObject({ page: 3, sort: 'price_desc', min: 500, max: 2000, inStock: true });
    const q = catalogApiQuery(s, { category: 'winter' });
    expect(Object.fromEntries(q)).toEqual({ page: '3', per_page: '24', sort: 'price_desc', category: 'winter', price_min: '50000', price_max: '200000', in_stock: '1' });
  });

  it('drops garbage and defaults to Most popular', () => {
    expect(parseCatalogState({ page: '-1', sort: 'evil', min: 'abc', q: 'a\u0000b' })).toEqual({ page: 1, sort: 'bestsellers', min: null, max: null, inStock: false, q: 'a b' });
  });

  it('builds hrefs with only non-default values and numbered pages with gaps', () => {
    const s = parseCatalogState({ min: '100' });
    expect(catalogHref('/c/winter', s, { page: 2 })).toBe('/c/winter?min=100&page=2');
    expect(catalogHref('/c/winter', s, { min: null })).toBe('/c/winter');
    expect(pageList(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageList(10, 20)).toEqual([1, '…', 9, 10, 11, '…', 20]);
  });
});

describe('checkout form', () => {
  it('normalises BD mobile numbers', () => {
    expect(normalizeBdPhone('01712-345678')).toBe('8801712345678');
    expect(normalizeBdPhone('+880 1712 345678')).toBe('8801712345678');
    expect(normalizeBdPhone('01212345678')).toBeNull();
    expect(normalizeBdPhone('0171234567')).toBeNull();
    expect(formatBdPhone('8801712345678')).toBe('01712-345678');
  });

  it('validates and builds CheckoutInput (COD, expected total, no prices)', () => {
    const v = validateCheckoutForm({ name: ' Ayesha ', phone: '01712345678', email: 'A@B.COM', district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: '', address_line: 'House 12, Road 7', landmark: '', label: 'home', customer_note: '', unit_price_amount: 1 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const input = toCheckoutInput(v.data, 380000);
    expect(input).toEqual({
      contact: { name: 'Ayesha', phone: '8801712345678', email: 'a@b.com' },
      shipping_address: { district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: null, address_line: 'House 12, Road 7', landmark: null, label: 'home' },
      payment_method: 'cod',
      customer_note: null,
      expected_total_amount: 380000,
    });
  });

  it('returns field errors', () => {
    const v = validateCheckoutForm({ name: 'A', phone: '123', email: 'x', district_code: '', thana_code: '', address_line: 'h' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors).sort()).toEqual(['address_line', 'district_code', 'email', 'name', 'phone', 'thana_code']);
    expect(v.errors.phone).toBe('Enter a Bangladeshi mobile number (01XXXXXXXXX).');
  });

  it('maps API details to fields', () => {
    expect(mapDetailsToFields({ 'contact.phone': ['Bad phone'], 'shipping_address.thana_code': ['Unknown'], 'items.0.quantity': ['Only 1 left.'] })).toEqual({
      fields: { phone: 'Bad phone', thana_code: 'Unknown' },
      other: ['Only 1 left.'],
    });
  });

  it('cascades districts and thanas (city thanas first)', () => {
    const geo: BdGeo = {
      version: '1',
      divisions: [{ code: 'dhaka', name: 'Dhaka', name_bn: '' }, { code: 'khulna', name: 'Khulna', name_bn: '' }],
      districts: [{ code: 'gazipur', division_code: 'dhaka', name: 'Gazipur', name_bn: '' }, { code: 'dhaka', division_code: 'dhaka', name: 'Dhaka', name_bn: '' }, { code: 'khulna', division_code: 'khulna', name: 'Khulna', name_bn: '' }],
      thanas: [
        { code: 'dhaka-savar', district_code: 'dhaka', name: 'Savar', name_bn: '', is_city: false },
        { code: 'dhaka-mirpur', district_code: 'dhaka', name: 'Mirpur', name_bn: '', is_city: true },
        { code: 'dhaka-dhanmondi', district_code: 'dhaka', name: 'Dhanmondi', name_bn: '', is_city: true },
        { code: 'gazipur-tongi', district_code: 'gazipur', name: 'Tongi', name_bn: '', is_city: false },
      ],
    };
    expect(districtsOf(geo, 'dhaka').map((d) => d.code)).toEqual(['dhaka', 'gazipur']);
    expect(thanasOf(geo, 'dhaka').map((t) => t.name)).toEqual(['Dhanmondi', 'Mirpur', 'Savar']);
    expect(thanasOf(geo, 'khulna')).toEqual([]);
  });
});

describe('PDP variant selection', () => {
  const product = {
    images: [{ media_id: 'img-a' }, { media_id: 'img-b' }],
    variants: [
      { id: 'v1', option_values: ['Honey', 'S'], price_amount: 100, compare_at_amount: 150, image_media_id: 'img-b', title: '' },
      { id: 'v2', option_values: ['Honey', 'M'], price_amount: 120, compare_at_amount: null, image_media_id: null, title: '' },
      { id: 'v3', option_values: ['Sky', 'S'], price_amount: 100, compare_at_amount: null, image_media_id: 'missing', title: '' },
    ],
  } as unknown as StorefrontProduct;
  const variants = toPdpVariants(product);

  it('maps variant images to gallery indexes', () => {
    expect(variants.map((v) => v.image_index)).toEqual([1, null, null]);
  });

  it('finds the variant for a selection; price follows the variant', () => {
    expect(findVariant(variants, ['Honey', 'M'])!.price_amount).toBe(120);
    expect(findVariant(variants, ['Sky', 'M'])).toBeUndefined();
  });

  it('marks chips sold out from availability and keeps reachable values choosable', () => {
    const avail = { v1: { available: true }, v2: { available: false }, v3: { available: true } };
    expect(optionState(variants, ['Honey', 'S'], 1, 'M', avail)).toBe('sold_out');
    expect(optionState(variants, ['Sky', 'S'], 1, 'M', avail)).toBe('available'); // Honey/M exists
    expect(optionState(variants, ['Honey', 'S'], 1, 'XL', avail)).toBe('missing');
  });
});

describe('JSON-LD Product', () => {
  const product = {
    id: 'p', slug: 'cardigan', name: 'Cardigan </script><script>alert(1)</script>', description: null, options: [],
    variants: [{ id: 'v', title: '', option_values: [], price_amount: 185050, compare_at_amount: null, image_media_id: null }],
    images: [{ media_id: 'm', alt: null, media: { id: 'm', url: 'https://cdn.storeplix.com/a.webp', width: 1, height: 1, alt: null, srcset: [] } }],
    price_min_amount: 185050, price_max_amount: 200000, currency: 'BDT', categories: [{ slug: 'winter', name: 'Winter' }],
    seo: { title: null, description: null }, url_path: '/products/cardigan', is_preview_only: false, updated_at: '',
  } as StorefrontProduct;

  it('uses AggregateOffer for a price range, decimal prices and availability', () => {
    const [item, crumbs] = productJsonLd(product, 'https://shop.test', false, null) as [{ offers: unknown }, { itemListElement: Array<{ item: string }> }];
    expect(item.offers).toMatchObject({ '@type': 'AggregateOffer', lowPrice: '1850.50', highPrice: '2000.00', priceCurrency: 'BDT', availability: 'https://schema.org/OutOfStock' });
    expect(crumbs.itemListElement.map((c: { item: string }) => c.item)).toEqual(['https://shop.test/', 'https://shop.test/c/winter', 'https://shop.test/products/cardigan']);
    expect(paisaToDecimal(5)).toBe('0.05');
  });

  it('is safe to embed in a script tag', () => {
    const out = serializeJsonLd(productJsonLd(product, 'https://shop.test', true, null));
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
  });

  it('extracts plain text from rich text for descriptions', () => {
    expect(richTextPlain({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Warm ' }, { type: 'text', text: 'wool', marks: [{ type: 'bold' }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Next.' }] }] })).toBe('Warm wool Next.');
    expect(richTextPlain({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(300) }] }] }, 10)).toHaveLength(10);
  });
});

describe('tracking timeline', () => {
  it('marks steps done up to the status; shipped is in progress', () => {
    const steps = trackingSteps({ status: 'shipped', placed_at: '2026-11-22T10:00:00Z', timeline: [{ status: 'confirmed', at: '2026-11-22T11:00:00Z' }, { status: 'shipped', at: '2026-11-23T09:00:00Z' }] });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'todo']);
    expect(steps[0]!.at).toBe('2026-11-22T10:00:00Z');
  });

  it('shows the courier status and its time on the courier step (5b-3)', () => {
    const timeline = [{ status: 'confirmed' as const, at: '2026-11-22T11:00:00Z' }, { status: 'shipped' as const, at: '2026-11-23T03:00:00Z' }];
    const shipment = { carrier_name: 'Steadfast', tracking_code: 'SF-1', tracking_url: null, status: 'out_for_delivery' as const, status_at: '2026-11-23T05:20:00Z', checked_at: '2026-11-23T05:42:00Z', events: [] };
    const steps = trackingSteps({ status: 'shipped', placed_at: '2026-11-22T10:00:00Z', timeline, shipment });
    expect(steps[3]).toEqual({ key: 'shipped', title: 'Out for delivery', at: '2026-11-23T05:20:00Z', state: 'current' });
    // booked/booking/unknown keep the generic title and the order's shipped time
    const booked = trackingSteps({ status: 'shipped', placed_at: '2026-11-22T10:00:00Z', timeline, shipment: { ...shipment, status: 'booked' } });
    expect([booked[3]!.title, booked[3]!.at]).toEqual(['With the courier', '2026-11-23T03:00:00Z']);
    // manual shipment (no courier fields) behaves as before
    expect(trackingSteps({ status: 'shipped', placed_at: '2026-11-22T10:00:00Z', timeline, shipment: { carrier_name: 'Sundarban', tracking_code: null, tracking_url: null } })[3]!.title).toBe('With the courier');
    // delivered orders ignore the courier label
    expect(trackingSteps({ status: 'delivered', placed_at: '2026-11-22T10:00:00Z', timeline, shipment })[3]!.title).toBe('With the courier');
  });

  it('falls back to the newest courier event when the status field is absent', () => {
    const s = { carrier_name: null, tracking_code: null, tracking_url: null, events: [{ status: 'in_transit' as const, at: '2026-11-23T04:00:00Z' }, { status: 'picked_up' as const, at: '2026-11-23T01:00:00Z' }] };
    expect(courierStatus(s)).toEqual({ status: 'in_transit', at: '2026-11-23T04:00:00Z' });
    expect(courierStatus(null)).toBeNull();
    expect(formatDhakaClock('2026-11-23T05:42:00Z')).toBe('11:42 am');
    expect(formatDhakaClock('nope')).toBeUndefined();
  });

  it('ends with a stopped step for cancelled orders', () => {
    const steps = trackingSteps({ status: 'cancelled', placed_at: '2026-11-22T10:00:00Z', timeline: [{ status: 'cancelled', at: '2026-11-22T12:00:00Z' }] });
    expect(steps.map((s) => [s.key, s.state])).toEqual([['pending', 'done'], ['cancelled', 'stopped']]);
  });
});

describe('policy links and messages', () => {
  it('links only to published delivery/return pages', () => {
    expect(policyLinks([{ slug: 'delivery-return' }, { slug: 'privacy' }])).toEqual([{ label: 'Delivery & return policy', href: '/pages/delivery-return' }]);
    expect(policyLinks([{ slug: 'about' }])).toEqual([]);
  });

  it('turns API errors into shopper text', () => {
    expect(errorMessage({ code: 'out_of_stock', message: 'x', details: { quantity: ['Only 3 left.'] } })).toBe('Only 3 left.');
    expect(errorMessage({ code: 'store_not_live', message: '', details: {} })).toBe("Your shop isn't live yet. Orders open after you go live.");
    expect(errorMessage({ code: 'rate_limited', message: '', details: {} })).toMatch(/Too many tries/);
  });
});

describe('SEO files and private paths (Phase 5)', async () => {
  const { sitemapResponse, robotsResponse } = await import('@/lib/seo-files');
  const { isPrivateCommercePath } = await import('@/proxy');
  const target = (mode: 'live' | 'preview' | 'coming_soon') => ({ host: 'shop.example.com', mode, config: { store: { primary_host: 'shop.example.com' }, seo: { noindex: false } } });
  const entries = { products: [{ slug: 'cardigan', updated_at: '2026-11-20T10:00:00Z' }], categories: [{ slug: 'winter' }] };

  it('sitemap lists products and categories only for live stores', async () => {
    const live = await sitemapResponse(target('live'), entries).text();
    expect(live).toContain('<loc>https://shop.example.com/products/cardigan</loc><lastmod>2026-11-20T10:00:00.000Z</lastmod>');
    expect(live).toContain('<loc>https://shop.example.com/c/winter</loc>');
    for (const mode of ['preview', 'coming_soon'] as const) expect(await sitemapResponse(target(mode), entries).text()).not.toContain('/products/');
  });

  it('sitemap is capped at 5 000 URLs', async () => {
    const many = { products: Array.from({ length: 6000 }, (_, i) => ({ slug: `p${i}`, updated_at: null })) };
    expect((await sitemapResponse(target('live'), many).text()).match(/<url>/g)).toHaveLength(5000);
  });

  it('robots disallows the private commerce routes', async () => {
    const txt = await robotsResponse(target('live')).text();
    for (const p of ['/cart', '/checkout', '/track', '/search', '/discount']) expect(txt).toContain(`Disallow: ${p}\n`);
  });

  it('marks per-shopper paths private', () => {
    expect(['/cart', '/checkout', '/checkout/thank-you', '/track', '/discount/WINTER15'].every(isPrivateCommercePath)).toBe(true);
    expect(['/', '/c/winter', '/products/a', '/tracking-info'].some(isPrivateCommercePath)).toBe(false);
  });
});
