import { describe, expect, it } from 'vitest';
import {
  parseApiError,
  parseAvailability,
  parseCartEnvelope,
  parseCategoryDetail,
  parseCategoryTree,
  parseCheckoutResult,
  parseCommerce,
  parseGeo,
  parseProductPage,
  parseShippingQuote,
  parseStorefrontProduct,
  parseTracking,
} from '@/lib/commerce-schemas';
import { formatBdt } from '@/lib/format';

const MEDIA = '01jcz8m4q9w7t3x5y6z8a0b2c4';
const media = { id: MEDIA, url: 'https://cdn.storeplix.com/a.webp', width: 800, height: 1000, alt: null, srcset: [] };
const variant = (over: Record<string, unknown> = {}) => ({
  id: '01jvar00000000000000000001',
  title: 'Honey / 2–3 y',
  option_values: ['Honey', '2–3 y'],
  price_amount: 185000,
  compare_at_amount: 230000,
  image_media_id: MEDIA.toUpperCase(),
  ...over,
});
const product = (over: Record<string, unknown> = {}) => ({
  id: '01jprod0000000000000000001',
  slug: 'merino-cardigan',
  name: 'Merino cardigan',
  description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Soft.' }] }] },
  options: [{ name: 'Colour', values: ['Honey'] }, { name: 'Size', values: ['2–3 y'] }],
  variants: [variant()],
  images: [{ media_id: MEDIA, alt: 'Front', media }],
  price_min_amount: 185000,
  price_max_amount: 185000,
  currency: 'bdt',
  categories: [{ slug: 'winter-wear', name: 'Winter wear' }],
  seo: { title: null, description: null },
  url_path: '/products/merino-cardigan',
  is_preview_only: false,
  updated_at: '2026-11-20T10:00:00Z',
  ...over,
});

describe('StorefrontProduct (S7: never cost, SKU, barcode or stock)', () => {
  it('parses and strips every key outside the contract', () => {
    const p = parseStorefrontProduct(
      product({ cost_amount: 90000, sku: 'SKU-1', barcode: '123', on_hand: 4, committed: 1, tenant_id: 't', store_id: 's', revision: 3, variants: [variant({ sku: 'SKU-1', cost_amount: 1, on_hand: 9, barcode: 'x' })] }),
    )!;
    const json = JSON.stringify(p);
    for (const k of ['cost_amount', 'sku', 'barcode', 'on_hand', 'committed', 'tenant_id', 'store_id', 'revision']) expect(json).not.toContain(`"${k}"`);
    expect(p.currency).toBe('BDT');
    expect(p.variants[0]!.image_media_id).toBe(MEDIA);
    expect(p.url_path).toBe('/products/merino-cardigan');
  });

  it('drops a compare-at that is not above the price, and invalid variants/images', () => {
    const p = parseStorefrontProduct(
      product({ variants: [variant({ compare_at_amount: 185000 }), variant({ id: 'x y', price_amount: 1.5 })], images: [{ media_id: MEDIA, alt: null, media: { url: 'javascript:alert(1)' } }] }),
    )!;
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]!.compare_at_amount).toBeNull();
    expect(p.images).toEqual([]);
  });

  it('is null without a purchasable variant or with a bad slug', () => {
    expect(parseStorefrontProduct(product({ variants: [] }))).toBeNull();
    expect(parseStorefrontProduct(product({ slug: '../etc' }))).toBeNull();
    expect(parseStorefrontProduct(null)).toBeNull();
  });

  it('formats prices with discounts in paisa (৳)', () => {
    const p = parseStorefrontProduct(product())!;
    const v = p.variants[0]!;
    expect(formatBdt(v.price_amount)).toBe('৳ 1,850');
    expect(formatBdt(v.compare_at_amount! - v.price_amount)).toBe('৳ 450');
    expect(formatBdt(345050)).toBe('৳ 3,450.50');
  });
});

describe('availability (P5-6)', () => {
  it('keeps booleans and a positive low-stock count only', () => {
    const a = parseAvailability({ variants: [{ id: 'v1', available: true, low_stock: 4, on_hand: 4 }, { id: 'v2', available: false, low_stock: 0 }, { id: 'v3', available: 'yes', low_stock: -2 }] })!;
    expect(a.variants).toEqual([
      { id: 'v1', available: true, low_stock: 4 },
      { id: 'v2', available: false, low_stock: null },
      { id: 'v3', available: false, low_stock: null },
    ]);
    expect(JSON.stringify(a)).not.toContain('on_hand');
  });
});

describe('categories', () => {
  it('builds /c/{slug} paths and drops bad nodes', () => {
    const tree = parseCategoryTree([{ slug: 'winter', name: 'Winter', image: null, url_path: '/evil', children: [{ slug: 'caps', name: 'Caps', image: null, children: [] }, { slug: 'BAD SLUG', name: 'x', children: [] }] }]);
    expect(tree[0]!.url_path).toBe('/c/winter');
    expect(tree[0]!.children.map((c) => c.url_path)).toEqual(['/c/caps']);
    const d = parseCategoryDetail({ slug: 'caps', name: 'Caps', image: null, description: 'Warm', ancestors: [{ slug: 'winter', name: 'Winter' }], children: [] })!;
    expect(d).toMatchObject({ url_path: '/c/caps', ancestors: [{ slug: 'winter', name: 'Winter' }] });
  });
});

describe('product list page', () => {
  it('reads pagination meta and drops invalid cards', () => {
    const page = parseProductPage({
      data: [{ id: 'a', slug: 'a', name: 'A', subtitle: null, price_amount: 100, compare_at_amount: null, currency: 'BDT', on_sale: false, image: null, cost_amount: 5 }, { id: 'b' }],
      meta: { has_products: true, current_page: 2, per_page: 24, total: 25, last_page: 2 },
    })!;
    expect(page).toMatchObject({ page: 2, per_page: 24, total: 25, last_page: 2 });
    expect(page.products).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('cost_amount');
    expect(parseProductPage({ data: 'x', meta: {} })).toBeNull();
  });
});

describe('cart', () => {
  const cart = {
    lines: [
      {
        id: 'l1', variant_id: 'v1', product_slug: 'a', product_name: 'A', variant_title: 'Red', option_values: ['Red'], image: null, quantity: 2,
        unit_price_amount: 1000, compare_at_amount: null, line_amount: 2000, issue: 'insufficient_stock', max_quantity: 1, low_stock: 1, sku: 'S',
      },
    ],
    lines_count: 1, items_count: 2, currency: 'BDT', coupon: { code: 'WINTER15', type: 'percentage', discount_amount: 300, free_shipping: false },
    subtotal_amount: 2000, discount_amount: 300, savings_amount: 300, estimated_total_amount: 1700,
    free_delivery: { threshold_amount: 300000, remaining_amount: 298300 }, can_checkout: false,
  };

  it('parses the envelope with the one-time token and notices', () => {
    const e = parseCartEnvelope({ data: cart, meta: { cart_token: 'a'.repeat(43), notices: ['Code X was removed: This code has expired.'] } })!;
    expect(e.meta.cart_token).toHaveLength(43);
    expect(e.meta.notices).toHaveLength(1);
    expect(e.cart.lines[0]!.issue).toBe('insufficient_stock');
    expect(JSON.stringify(e.cart)).not.toContain('"sku"');
  });

  it('ignores a malformed token', () => {
    expect(parseCartEnvelope({ data: cart, meta: { cart_token: 'bad token' } })!.meta.cart_token).toBeUndefined();
  });

  it('parses a shipping quote', () => {
    expect(parseShippingQuote({ zone_id: 'z', zone_name: 'Inside Dhaka', min_days: 1, max_days: 2, charge_amount: 7000, amount: 0, is_free: true })).toMatchObject({ amount: 0, is_free: true });
    expect(parseShippingQuote({ zone_name: 'x', amount: -1 })).toBeNull();
  });
});

describe('orders', () => {
  const order = {
    number: 'DE-1042', status: 'pending', payment_method: 'cod', placed_at: '2026-11-22T10:00:00Z', customer_name: 'Ayesha Rahman', customer_phone: '8801712345678',
    shipping_address: { division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-dhanmondi', thana: 'Dhanmondi', area: null, address_line: 'House 12', landmark: null, label: 'home' },
    lines: [{ product_name: 'A', variant_title: '', quantity: 1, image: null, unit_price_amount: 1000, total_amount: 1000, unit_cost_amount: 1 }],
    coupon_code: null, subtotal_amount: 1000, discount_amount: 0, shipping_amount: 7000, total_amount: 8000, due_amount: 8000, currency: 'BDT',
    delivery: { zone_name: 'Inside Dhaka', min_days: 1, max_days: 2 },
  };

  it('checkout result requires an order and a plausible token', () => {
    expect(parseCheckoutResult({ order, confirmation_token: 'b'.repeat(43) })!.order.number).toBe('DE-1042');
    expect(parseCheckoutResult({ order, confirmation_token: '<x>' })).toBeNull();
    expect(JSON.stringify(parseCheckoutResult({ order, confirmation_token: 'b'.repeat(43) }))).not.toContain('unit_cost_amount');
  });

  it('tracking keeps district/thana only and https tracking links only (S14)', () => {
    const base = { number: 'DE-1042', status: 'shipped', placed_at: '2026-11-22T10:00:00Z', shipping: { district: 'Dhaka', thana: 'Dhanmondi', address_line: 'House 12' }, lines: [], total_amount: 8000, due_amount: 8000, currency: 'BDT', timeline: [{ status: 'shipped', at: '2026-11-23T10:00:00Z' }] };
    const t = parseTracking({ ...base, shipment: { carrier_name: 'Steadfast', tracking_code: 'SF-1', tracking_url: 'javascript:alert(1)' } })!;
    expect(t.shipment!.tracking_url).toBeNull();
    expect(JSON.stringify(t)).not.toContain('House 12');
    expect(parseTracking({ ...base, shipment: { carrier_name: null, tracking_code: null, tracking_url: 'http://x.com' } })!.shipment!.tracking_url).toBeNull();
    expect(parseTracking({ ...base, shipment: { carrier_name: null, tracking_code: null, tracking_url: 'https://steadfast.com.bd/t/1' } })!.shipment!.tracking_url).toBe('https://steadfast.com.bd/t/1');
  });
});

describe('geo, commerce, errors', () => {
  it('parses the BD geo dataset', () => {
    const g = parseGeo({ version: '1', divisions: [{ code: 'dhaka', name: 'Dhaka', name_bn: 'ঢাকা' }], districts: [{ code: 'dhaka', division_code: 'dhaka', name: 'Dhaka', name_bn: '' }], thanas: [{ code: 'dhaka-mirpur', district_code: 'dhaka', name: 'Mirpur', name_bn: '', is_city: true }, { code: 'Bad Code', district_code: 'dhaka', name: 'x' }] })!;
    expect(g.thanas).toHaveLength(1);
    expect(parseGeo({ divisions: [] })).toBeNull();
  });

  it('config.commerce is optional (rolling deploys)', () => {
    expect(parseCommerce(undefined)).toBeNull();
    expect(parseCommerce({ checkout_enabled: true, payment_methods: ['cod', 'paypal'], free_delivery_over_amount: 300000, delivery: [{ name: 'Inside Dhaka', charge_amount: 7000, min_days: 1, max_days: 2 }] })).toEqual({
      checkout_enabled: true, payment_methods: ['cod'], free_delivery_over_amount: 300000, delivery: [{ name: 'Inside Dhaka', charge_amount: 7000, min_days: 1, max_days: 2 }],
    });
  });

  it('parses the API error envelope', () => {
    expect(parseApiError({ error: { code: 'out_of_stock', message: 'No', details: { 'items.0.quantity': ['Only 2 left.'] } } }, 422)).toEqual({ code: 'out_of_stock', message: 'No', details: { 'items.0.quantity': ['Only 2 left.'] } });
    expect(parseApiError('<html>', 502).code).toBe('http_502');
    expect(parseApiError(null, 0).code).toBe('network_error');
  });
});
