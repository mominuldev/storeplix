import { describe, expect, it } from 'vitest';
import { customerLine, newIdempotencyKey, nextStep, ordinal } from '../commerce/format';
import { buildGeoIndex } from '../commerce/queries';
import { areaSummary, defaultZones, takenAreas, zoneToInput } from '../commerce/zones';
import { fromDhakaLocal, toDhakaLocal, toInput, validateCoupon } from '../coupons/form';
import { allocateDiscount, couponDiscount, generateCode, previewCheckout, CODE_PATTERN } from '../coupons/math';
import { refundAmountError } from '../orders/transitions';
import { smsPreview } from '../settings/commerceSettings';
import { geo, shipping } from './phase5.fixtures';

describe('orders: next step (§4)', () => {
  it('derives the next step from the status', () => {
    expect(nextStep('pending')).toEqual({ label: 'Confirm', to: 'confirmed' });
    expect(nextStep('confirmed')).toEqual({ label: 'Mark packed', to: 'ready_to_ship' });
    expect(nextStep('ready_to_ship')).toEqual({ label: 'Mark shipped', to: 'shipped' });
    expect(nextStep('shipped')).toEqual({ label: 'Mark delivered', to: 'delivered' });
    for (const s of ['delivered', 'returned', 'cancelled', 'pending_payment'] as const) expect(nextStep(s)).toBeNull();
  });

  it('builds the customer line from this shop’s counters', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
    expect(customerLine({ id: 'C', name: 'N', phone: '8801712345678', email: null, orders_count: 3, delivered_orders_count: 3, returned_orders_count: 0, total_spent_amount: 0 })).toBe(
      '01712-345678 · 3rd order · 3/3 delivered',
    );
    expect(customerLine({ id: null, name: 'N', phone: '8801556778899', email: null, orders_count: 1, delivered_orders_count: 0, returned_orders_count: 0, total_spent_amount: 0 })).toBe('01556-778899 · first order');
  });
});

describe('idempotency keys', () => {
  it('match the API format (8–64 of [A-Za-z0-9_-])', () => {
    for (let i = 0; i < 20; i += 1) expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('refund dialog bounds (P5-18)', () => {
  it('accepts 1 paisa … refundable', () => {
    expect(refundAmountError(null, 1000)).toBe('Enter an amount.');
    expect(refundAmountError(0, 1000)).toBe('Enter an amount like 500.');
    expect(refundAmountError(Number.NaN, 1000)).toBe('Enter an amount like 500.');
    expect(refundAmountError(1001, 1000)).toBe('You can refund up to ৳ 10.');
    expect(refundAmountError(1000, 1000)).toBeNull();
    expect(refundAmountError(1, 1000)).toBeNull();
  });
});

describe('coupon math mirrors P5-12', () => {
  // API allocation fixture (P5-12 worked example): 15 % capped at ৳ 300 over ৳ 1,850 + ৳ 1,170.
  const fixture = { lines: [185_000, 117_000], bps: 1500, cap: 30_000, discount: 30_000, allocation: [18_377, 11_623] };

  it('percentage floors, caps and allocates by largest remainder', () => {
    const rule = { type: 'percentage' as const, percent_bps: fixture.bps, amount: null, max_discount_amount: fixture.cap, min_subtotal_amount: null };
    expect(couponDiscount(rule, 302_000)).toBe(fixture.discount);
    expect(allocateDiscount(fixture.discount, fixture.lines)).toEqual(fixture.allocation);
    expect(couponDiscount({ ...rule, max_discount_amount: null }, 333)).toBe(49); // floor(333 × 0.15)
  });

  it('fixed is capped at the eligible subtotal; allocation always sums exactly', () => {
    expect(couponDiscount({ type: 'fixed', percent_bps: null, amount: 50_000, max_discount_amount: null, min_subtotal_amount: null }, 30_000)).toBe(30_000);
    for (let i = 0; i < 200; i += 1) {
      const lines = Array.from({ length: 1 + (i % 5) }, (_, j) => 1 + ((i * 7919 + j * 104729) % 500_000));
      const d = (i * 31) % (lines.reduce((s, x) => s + x, 0) + 1);
      expect(allocateDiscount(d, lines).reduce((s, x) => s + x, 0)).toBe(d);
    }
    expect(allocateDiscount(1, [100, 100])).toEqual([1, 0]); // tie → lower index
  });

  it('preview applies free delivery and the minimum order', () => {
    const lines = [{ name: 'A', detail: '', amount: 100_000 }];
    const free = previewCheckout({ type: 'free_shipping', percent_bps: null, amount: null, max_discount_amount: null, min_subtotal_amount: null }, lines, 7_000);
    expect(free).toMatchObject({ discount: 0, shipping: 0, shippingDiscount: 7_000, total: 100_000, applied: true });
    const below = previewCheckout({ type: 'fixed', percent_bps: null, amount: 10_000, max_discount_amount: null, min_subtotal_amount: 200_000 }, lines, 7_000);
    expect(below).toMatchObject({ applied: false, discount: 0, total: 107_000 });
  });

  it('generates valid 8-character codes', () => {
    for (let i = 0; i < 20; i += 1) {
      const c = generateCode();
      expect(c).toMatch(/^[A-Z2-9]{8}$/);
      expect(CODE_PATTERN.test(c)).toBe(true);
    }
  });
});

describe('coupon form type rules', () => {
  const base = {
    code: 'EID20', type: 'percentage' as const, percent_bps: 2000, amount: null, max_discount_amount: null, applies_to: 'all' as const, category_ids: [], products: [],
    min_subtotal_amount: null, usage_limit: '', usage_per_customer: '1', first_order_only: false, starts_at: '2026-11-22T10:00', ends_at: '', no_end: true,
  };

  it('requires the field of the chosen type and valid dates', () => {
    expect(validateCoupon(base)).toEqual({});
    expect(validateCoupon({ ...base, percent_bps: null })).toHaveProperty('percent_bps');
    expect(validateCoupon({ ...base, type: 'fixed', amount: null })).toHaveProperty('amount');
    expect(validateCoupon({ ...base, code: 'a' })).toHaveProperty('code');
    expect(validateCoupon({ ...base, applies_to: 'categories' })).toHaveProperty('category_ids');
    expect(validateCoupon({ ...base, no_end: false, ends_at: '2026-11-21T10:00' })).toHaveProperty('ends_at');
  });

  it('maps to the API shape: free delivery forces all products and nulls values', () => {
    const fixed = toInput({ ...base, type: 'fixed', amount: 15_000, percent_bps: 2000, max_discount_amount: 5 }, 'active');
    expect(fixed).toMatchObject({ type: 'fixed', amount: 15_000, percent_bps: null, max_discount_amount: null, status: 'active', starts_at: '2026-11-22T10:00:00+06:00', ends_at: null });
    const free = toInput({ ...base, type: 'free_shipping', applies_to: 'products', products: [{ id: 'P1', name: 'x', image: null, price_min_amount: 1 }] }, 'draft');
    expect(free).toMatchObject({ applies_to: 'all', product_ids: [], percent_bps: null, amount: null });
  });

  it('converts store time (Asia/Dhaka) both ways', () => {
    expect(toDhakaLocal('2026-11-20T04:00:00Z')).toBe('2026-11-20T10:00');
    expect(fromDhakaLocal('2026-11-20T10:00')).toBe('2026-11-20T10:00:00+06:00');
    expect(fromDhakaLocal('')).toBeNull();
  });
});

describe('shipping zones', () => {
  const index = buildGeoIndex(geo);

  it('defaults Inside Dhaka to the city thanas plus an Outside Dhaka fallback (P5-8)', () => {
    const zones = defaultZones(index);
    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ name: 'Inside Dhaka', charge_amount: 7_000, kind: 'custom' });
    expect(zones[0]!.areas!.map((a) => a.thana_code).sort()).toEqual(['dhaka-gulshan', 'dhaka-mirpur']);
    expect(zones[1]).toMatchObject({ name: 'Outside Dhaka', kind: 'fallback', charge_amount: 13_000, areas: [] });
  });

  it('marks areas of other zones as taken (zone editor conflicts)', () => {
    const zones = shipping().zones.map(zoneToInput);
    expect(takenAreas(zones, null)).toEqual({ 'dhaka:dhaka-mirpur': 'Inside Dhaka' });
    expect(takenAreas(zones, 0)).toEqual({});
    expect(areaSummary(zones[0]!, index)).toBe('Dhaka · 1 thana');
    expect(areaSummary({ ...zones[0]!, areas: [{ district_code: 'gazipur' }] }, index)).toBe('Gazipur');
  });
});

describe('notification preview', () => {
  it('renders the fixed Bangla and English templates', () => {
    expect(smsPreview('order_cancelled', 'bn', 'Mugdho')).toBe('Mugdho: অর্ডার GS-1042 বাতিল করা হয়েছে।');
    expect(smsPreview('order_confirmed', 'en', 'Mugdho')).toBe('Mugdho: Order GS-1042 is confirmed.');
  });
});
