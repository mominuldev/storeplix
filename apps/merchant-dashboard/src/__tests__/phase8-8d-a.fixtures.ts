import type { PosCatalogItem, PosCatalogVariant, PosQuote, PosReceipt, PosRegister, PosSale, PosSession, PosSessionTotals } from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { order } from './phase5.fixtures';
import { features } from './phase7.fixtures';

// PHASE-8-8D part A shapes (openapi 1.21.0) with the Figma 22:1736 sample data (Mirpur shop, Register 1).

export const growthPos = () => features({ plan_code: 'growth', features: { ...features().features, pos: true, multi_warehouse: true, purchasing: true } });
export const starterNoPos = () => features({ plan_code: 'starter', features: { ...features().features, pos: false } });

export function register(o: Partial<PosRegister> = {}): PosRegister {
  return {
    id: 'R1',
    name: 'Register 1',
    location: { id: 'LOC2', name: 'Mirpur shop', type: 'shop' },
    position: 0,
    archived_at: null,
    open_session: null,
    last_session: {
      id: 'PS0',
      closed_at: '2026-11-18T14:00:00Z',
      sales_amount: 2438000,
      receipts_count: 17,
      counted_cash_amount: 1642000,
      variance_amount: 0,
      banked_amount: 1442000,
      left_in_drawer_amount: 200000,
    },
    ...o,
  };
}

export function totals(o: Partial<PosSessionTotals> = {}): PosSessionTotals {
  return {
    cash_in_drawer_amount: 1482000,
    cash_sales_amount: 1326000,
    cash_refunds_amount: 44000,
    sales_amount: 2281000,
    receipts_count: 14,
    by_method: [
      { method: 'cash', amount: 1326000, count: 9 },
      { method: 'bkash_personal', amount: 640000, count: 3 },
      { method: 'card', amount: 315000, count: 2 },
    ],
    returns_count: 1,
    returns_amount: 45000,
    discounts_amount: 118000,
    held_sales_count: 0,
    ...o,
  };
}

export function session(o: Partial<PosSession> = {}): PosSession {
  return {
    id: 'PS1',
    register: { id: 'R1', name: 'Register 1', location: { id: 'LOC2', name: 'Mirpur shop' } },
    status: 'open',
    currency: 'BDT',
    opened_at: '2026-11-25T04:02:00Z',
    opened_by: { id: 'U1', name: 'Rahim' },
    opening_cash_amount: 200000,
    opening_counts: { '100000': 1, '50000': 1, '10000': 3, '5000': 2, '2000': 5 },
    closed_at: null,
    closed_by: null,
    counted_cash_amount: null,
    closing_counts: null,
    expected_cash_amount: null,
    variance_amount: null,
    left_in_drawer_amount: null,
    banked_amount: null,
    close_note: null,
    tolerance_amount: 5000,
    last_closing_left_amount: 200000,
    totals: totals(),
    revision: 3,
    ...o,
  };
}

export function variant(o: Partial<PosCatalogVariant> = {}): PosCatalogVariant {
  return {
    id: 'V1',
    title: 'Red · M',
    options: [
      { name: 'Colour', value: 'Red' },
      { name: 'Size', value: 'M' },
    ],
    sku: 'JT-RD-M',
    barcode: '8801000000011',
    price_amount: 165000,
    compare_at_amount: 185000,
    available: 8,
    ...o,
  };
}

/** Jamdani Three-Piece: Red M (8), Red L (0), Blue M (2). */
export const jamdani = (): PosCatalogItem => ({
  product_id: 'P1',
  name: 'Jamdani Three-Piece',
  image_url: null,
  currency: 'BDT',
  variants: [
    variant(),
    variant({ id: 'V2', title: 'Red · L', options: [{ name: 'Colour', value: 'Red' }, { name: 'Size', value: 'L' }], sku: 'JT-RD-L', available: 0 }),
    variant({ id: 'V3', title: 'Blue · M', options: [{ name: 'Colour', value: 'Blue' }, { name: 'Size', value: 'M' }], sku: 'JT-BL-M', available: 2 }),
  ],
});

/** Cotton Panjabi: one variant, 43 in stock, ৳ 1,500. */
export const panjabi = (): PosCatalogItem => ({
  product_id: 'P2',
  name: 'Cotton Panjabi',
  image_url: null,
  currency: 'BDT',
  variants: [variant({ id: 'V9', title: 'Default', options: [], sku: 'CP-1', barcode: '8801000000099', price_amount: 150000, compare_at_amount: null, available: 43 })],
});

export const hijab = (): PosCatalogItem => ({
  product_id: 'P3',
  name: 'Georgette Hijab',
  image_url: null,
  currency: 'BDT',
  variants: [variant({ id: 'V7', title: 'Default', options: [], sku: 'GH-1', price_amount: 45000, compare_at_amount: null, available: 0 })],
});

export const catalogResponse = (items: PosCatalogItem[], next: string | null = null) => jsonResponse(200, { data: items, meta: { next_cursor: next, prev_cursor: null, per_page: 40 } });

export function quote(o: Partial<PosQuote> = {}): PosQuote {
  return {
    currency: 'BDT',
    lines: [{ variant_id: 'V9', name: 'Cotton Panjabi', variant_title: '', quantity: 1, unit_price_amount: 150000, compare_at_amount: null, line_total_amount: 150000, available: 43, problem: null }],
    items_count: 1,
    subtotal_amount: 150000,
    discount_amount: 0,
    coupon_code: null,
    vat: null,
    total_amount: 150000,
    ...o,
  };
}

export function receipt(o: Partial<PosReceipt> = {}): PosReceipt {
  return {
    language: 'en',
    shop: { name: 'Mugdho Fashion', address: 'House 12, Road 7, Mirpur 10, Dhaka', phone: '01700-000000', bin: '0012-3456', logo_url: null },
    number: 'MF-2232',
    placed_at: '2026-11-25T08:42:00Z',
    cashier_name: 'Rahim',
    register_name: 'Register 1',
    customer: null,
    lines: [{ name: 'Cotton Panjabi', variant_title: null, sku: 'CP-1', quantity: 1, line_total_amount: 150000 }],
    subtotal_amount: 150000,
    discount_amount: 0,
    coupon_code: null,
    vat: null,
    total_amount: 150000,
    payments: [{ method: 'cash', amount: 150000 }],
    tendered_cash_amount: 200000,
    change_amount: 50000,
    footer_text: 'Thank you! Exchange within 7 days with this receipt.',
    currency: 'BDT',
    ...o,
  };
}

export function sale(o: Partial<PosSale> = {}): PosSale {
  return {
    id: 'SALE1',
    order_id: 'O1',
    number: 'MF-2232',
    placed_at: '2026-11-25T08:42:00Z',
    register_name: 'Register 1',
    cashier_name: 'Rahim',
    customer_name: null,
    items_count: 1,
    paid_by: 'cash',
    total_amount: 150000,
    refunded_amount: 0,
    currency: 'BDT',
    order: order({ id: 'O1', number: 'MF-2232' }),
    session_id: 'PS1',
    tendered_cash_amount: 200000,
    change_amount: 50000,
    sms_receipt_status: 'not_requested',
    receipt: receipt(),
    ...o,
  };
}
