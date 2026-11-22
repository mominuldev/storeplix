import type { BdGeo, Coupon, LaunchChecklist, Order, OrderSummary, ShippingSettings, StoreCommerceSettings } from '@storeplix/types';
import { jsonResponse, settingsFixture } from '../test/utils';

export const geo: BdGeo = {
  version: '2026.1',
  divisions: [{ code: 'dhaka', name: 'Dhaka', name_bn: 'ঢাকা' }],
  districts: [
    { code: 'dhaka', division_code: 'dhaka', name: 'Dhaka', name_bn: 'ঢাকা' },
    { code: 'gazipur', division_code: 'dhaka', name: 'Gazipur', name_bn: 'গাজীপুর' },
  ],
  thanas: [
    { code: 'dhaka-mirpur', district_code: 'dhaka', name: 'Mirpur', name_bn: 'মিরপুর', is_city: true },
    { code: 'dhaka-gulshan', district_code: 'dhaka', name: 'Gulshan', name_bn: 'গুলশান', is_city: true },
    { code: 'dhaka-savar', district_code: 'dhaka', name: 'Savar', name_bn: 'সাভার', is_city: false },
    { code: 'gazipur-sadar', district_code: 'gazipur', name: 'Gazipur Sadar', name_bn: 'গাজীপুর সদর', is_city: false },
  ],
};

export const commerce: StoreCommerceSettings = {
  checkout: { cod_enabled: true, cod_advance: 'none' },
  order_prefix: 'MU',
  next_order_number: 'MU-1049',
  notifications: { new_order_email: true, sms_language: 'bn', customer_sms: { order_placed: true, order_confirmed: false, order_shipped: true, order_cancelled: true, payment_link: true, order_updated: true } },
  tax: { display: 'none', rate_bps: 0, bin: null },
  invoice: { footer: null },
};

export const settingsWithCommerce = (c: Partial<StoreCommerceSettings> = {}) => jsonResponse(200, { data: settingsFixture({ commerce: { ...commerce, ...c } }) });

const customerSummary = { id: 'CU1', name: 'Nasrin Akter', phone: '8801712345678', email: null, orders_count: 3, delivered_orders_count: 2, returned_orders_count: 0, total_spent_amount: 354_000 };

export function orderSummary(o: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 'O1',
    number: 'MU-1042',
    status: 'pending',
    payment_status: 'unpaid',
    payment_method: 'cod',
    channel: 'facebook',
    created_via: 'storefront',
    customer: customerSummary,
    district: 'Dhaka',
    thana: 'Mirpur',
    items_count: 1,
    total_amount: 177_000,
    paid_amount: 0,
    due_amount: 177_000,
    currency: 'BDT',
    coupon_code: null,
    tags: [],
    placed_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date().toISOString(),
    shipment: null,
    return_status: 'none',
    ...o,
  };
}

export function order(o: Partial<Order> = {}): Order {
  return {
    ...orderSummary(),
    contact: { name: 'Nasrin Akter', phone: '8801712345678', email: null },
    shipping_address: {
      division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-mirpur', thana: 'Mirpur',
      area: null, address_line: 'House 12, Road 7, Mirpur 10', landmark: null, label: null,
    },
    customer_note: null,
    items: [
      {
        id: 'OI1', product_id: 'P1', variant_id: 'V1', product_name: 'Cotton Panjabi', variant_title: 'White / 40', option_values: ['White', '40'], sku: 'CP-WH-40',
        image: null, unit_price_amount: 170_000, compare_at_amount: null, unit_cost_amount: 90_000, quantity: 1, subtotal_amount: 170_000, discount_amount: 0,
        total_amount: 170_000, restocked_quantity: 0, current_stock: { available: 43, tracked: true },
      },
    ],
    events: [
      { id: 'E1', type: 'placed', from_status: null, to_status: 'pending', actor: { type: 'customer', user: null }, body: null, meta: {}, created_at: new Date().toISOString() },
    ],
    payments: [{ id: 'PAY1', provider: 'cod', type: 'charge', status: 'pending', amount: 177_000, currency: 'BDT', method: null, reference: null, note: null, actor: null, created_at: new Date().toISOString(),
      purpose: 'order', provider_trx_id: null, refunded_amount: 0, expires_at: null, failure_code: null, payment_link_id: null, return_request_id: null, can_refund: false }],
    shipment: null,
    subtotal_amount: 170_000,
    discount_amount: 0,
    shipping_amount: 7_000,
    shipping_discount_amount: 0,
    tax_amount: 0,
    refunded_amount: 0,
    shipping_zone_name: 'Inside Dhaka',
    delivery_min_days: 1,
    delivery_max_days: 2,
    shipping_overridden: false,
    cancel_reason: null,
    timestamps: {},
    allowed_transitions: ['confirmed', 'cancelled'],
    can: { edit: true, cancel: true, refund: true },
    revision: 1,
    created_by: null,
    shipments: [],
    payment_expires_at: null,
    payment_links: [],
    invoice_printed_at: null,
    label_printed_at: null,
    source_order_id: null,
    ...o,
  };
}

export const orderCounts = { all: 12, pending_payment: 0, pending: 4, confirmed: 3, ready_to_ship: 2, shipped: 1, delivered: 1, returned: 1, cancelled: 0 };

export const orderList = (rows: OrderSummary[], counts = orderCounts) =>
  jsonResponse(200, { data: rows, meta: { current_page: 1, per_page: 25, total: rows.length, last_page: 1, counts } });

export function coupon(c: Partial<Coupon> = {}): Coupon {
  return {
    id: 'C1', code: 'WINTER15', type: 'percentage', percent_bps: 1500, amount: null, max_discount_amount: 30_000, applies_to: 'all', categories: [], products: [],
    min_subtotal_amount: 120_000, usage_limit: 300, usage_per_customer: 1, first_order_only: false, starts_at: '2026-11-20T04:00:00Z', ends_at: null,
    status: 'active', display_status: 'active', stats: { used_count: 12, orders_count: 12, revenue_amount: 3_480_000, discount_amount: 290_000 },
    share_path: '/discount/WINTER15', revision: 2, created_by: null, created_at: '2026-11-20T04:00:00Z', updated_at: '2026-11-20T04:00:00Z',
    ...c,
  };
}

export function shipping(s: Partial<ShippingSettings> = {}): ShippingSettings {
  return {
    zones: [
      { id: 'Z1', name: 'Inside Dhaka', kind: 'custom', charge_amount: 7_000, min_days: 1, max_days: 2, is_active: true, position: 0, areas: [{ district_code: 'dhaka', thana_code: 'dhaka-mirpur', label: 'Mirpur' }], area_summary: 'Dhaka city · 1 thana' },
      { id: 'Z9', name: 'Outside Dhaka', kind: 'fallback', charge_amount: 13_000, min_days: 2, max_days: 4, is_active: true, position: 1, areas: [], area_summary: 'Everywhere else' },
    ],
    pickup_locations: [],
    free_delivery_over_amount: null,
    configured: true,
    ...s,
  };
}

export function checklist(c: Partial<LaunchChecklist> = {}): LaunchChecklist {
  return {
    status: 'draft',
    can_publish: true,
    published_at: null,
    shop_url: 'https://mugdho.storeplix.com',
    items: [
      { key: 'products', required: true, done: true, href: '/products' },
      { key: 'shipping', required: true, done: true, href: '/settings/shipping' },
      { key: 'payments', required: true, done: true, href: '/settings/payments' },
      { key: 'contact_phone', required: true, done: false, href: '/settings/store' },
      { key: 'policy_pages', required: false, done: false, href: '/online-store/pages' },
      { key: 'first_order', required: false, done: false, href: '/orders' },
    ],
    ...c,
  };
}
