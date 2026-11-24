import type {
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderSummary,
  ReorderSuggestionGroup,
  Supplier,
  SupplierDetail,
  SupplierSummary,
} from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';

// PHASE-8-8B §8.2 shapes for suppliers + purchase orders (Figma 35:5619 / 35:6210 / 36:6607 / 153:35999 sample data).

export const purchasingPlan = () => features({ plan_code: 'starter', features: { ...features().features, purchasing: true } });

export function supplier(o: Partial<Supplier> = {}): Supplier {
  return {
    id: 'SUP1',
    name: 'Tangail Weavers',
    contact_name: 'Karim Mia',
    phone: '8801711889900',
    city: 'Tangail',
    supplies: 'Jamdani, saree',
    payment_terms_days: 15,
    advance_percent: 50,
    lead_time_days: 5,
    pays_by_method: 'bkash',
    pays_by_account: '01712-889900',
    notes: null,
    archived_at: null,
    products_count: 24,
    open_pos_count: 2,
    past_orders_count: 12,
    currency: 'BDT',
    owed_amount: 8600000,
    overdue_amount: 4000000,
    overdue_since: '2026-11-15',
    last_order_on: '2026-11-12',
    active_this_month: true,
    created_by: { id: 'U1', name: 'Rahim Ahmed' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z',
    ...o,
  };
}

export const suppliers: Supplier[] = [
  supplier(),
  supplier({ id: 'SUP2', name: 'Narsingdi Textiles', supplies: 'Panjabi fabric', city: 'Narsingdi', owed_amount: 3850000, overdue_amount: 0, overdue_since: null, open_pos_count: 1, products_count: 18, last_order_on: '2026-11-15' }),
  supplier({ id: 'SUP3', name: 'PackRight BD', supplies: 'Poly mailers, boxes', city: 'Tejgaon', phone: null, owed_amount: 0, overdue_amount: 0, overdue_since: null, open_pos_count: 0, products_count: 4, advance_percent: null }),
];

export function po(o: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'PO12',
    number: 'PO-0012',
    location: { id: 'LOC1', name: 'Main warehouse' },
    status: 'partially_received',
    payment_status: 'partially_paid',
    supplier: { id: 'SUP1', name: 'Tangail Weavers', phone: '8801711889900', city: 'Tangail' },
    lines_count: 5,
    preview_items: [
      { product_name: 'Jamdani', image: null },
      { product_name: 'Katan Saree', image: null },
    ],
    units_ordered: 100,
    units_received: 60,
    units_damaged: 0,
    units_left: 40,
    expected_on: '2026-11-15',
    is_late: false,
    days_late: null,
    ordered_at: '2026-11-10T05:00:00Z',
    sent_at: '2026-11-10T05:06:00Z',
    sent_via: 'whatsapp',
    closed_at: null,
    cancelled_at: null,
    due_on: '2026-11-30',
    is_overdue: false,
    currency: 'BDT',
    subtotal_amount: 11800000,
    shipping_amount: 0,
    discount_amount: 0,
    total_amount: 11800000,
    received_value_amount: 7100000,
    paid_amount: 5000000,
    balance_amount: 2100000,
    revision: 3,
    created_by: { id: 'U1', name: 'Rahim Ahmed' },
    created_at: '2026-11-10T05:00:00Z',
    updated_at: '2026-11-15T10:20:00Z',
    ...o,
  };
}

export const poRows: PurchaseOrder[] = [
  po({ id: 'PO14', number: 'PO-0014', status: 'draft', payment_status: 'unpaid', units_received: 0, units_left: 54, units_ordered: 54, ordered_at: null, expected_on: null, total_amount: 8400000, paid_amount: 0, sent_at: null, sent_via: null }),
  po({ id: 'PO13', number: 'PO-0013', status: 'ordered', supplier: { id: 'SUP2', name: 'Dhaka Panjabi House', phone: null, city: 'Dhaka' }, units_ordered: 80, units_received: 0, units_left: 80, expected_on: '2026-11-17', is_late: true, days_late: 2, total_amount: 9600000, paid_amount: 3000000 }),
  po(),
  po({ id: 'PO11', number: 'PO-0011', status: 'received', payment_status: 'paid', units_ordered: 40, units_received: 40, units_left: 0, total_amount: 2440000, paid_amount: 2440000 }),
];

export const poCounts = { all: 14, draft: 1, ordered: 2, partially_received: 1, received: 9, closed: 0, cancelled: 1 };

export function poSummary(o: Partial<PurchaseOrderSummary> = {}): PurchaseOrderSummary {
  return {
    currency: 'BDT',
    open_count: 4,
    open_total_amount: 24860000,
    units_coming: 186,
    suppliers_coming: 3,
    owed_amount: 11240000,
    payments_due_this_week: 2,
    late_count: 1,
    first_late: { id: 'PO13', number: 'PO-0013', days_late: 2 },
    ...o,
  };
}

export function line(o: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'L1',
    variant_id: 'V1',
    product: { id: 'P1', name: 'Jamdani Three-Piece', image: null },
    variant_title: 'Red · M',
    option_values: ['Red', 'M'],
    sku: null,
    unit_cost_amount: 105000,
    quantity_ordered: 40,
    quantity_received: 40,
    quantity_damaged: 0,
    quantity_left: 0,
    line_total_amount: 4200000,
    landed_unit_cost_amount: 105000,
    in_stock: 8,
    last_bought_unit_cost_amount: 100000,
    position: 1,
    ...o,
  };
}

export function poDetail(o: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail {
  const base = po();
  return {
    ...base,
    supplier: {
      ...base.supplier,
      contact_name: 'Karim Mia',
      lead_time_days: 5,
      payment_terms_days: 15,
      advance_percent: 50,
      pays_by_method: 'bkash',
      pays_by_account: null,
      past_orders_count: 12,
      archived_at: null,
      owed_amount: 6800000,
    },
    notes: null,
    lines: [
      line(),
      line({ id: 'L3', variant_id: 'V3', variant_title: 'Green · S', unit_cost_amount: 100000, landed_unit_cost_amount: 100000, quantity_ordered: 30, quantity_received: 0, quantity_left: 30, position: 2 }),
      line({ id: 'L4', variant_id: 'V4', product: { id: 'P4', name: 'Katan Saree', image: null }, variant_title: 'Emerald', unit_cost_amount: 250000, landed_unit_cost_amount: 250000, quantity_ordered: 10, quantity_received: 0, quantity_left: 10, position: 3 }),
    ],
    receipts: [],
    payments: [
      { id: 'PAY1', supplier: { id: 'SUP1', name: 'Tangail Weavers' }, purchase_order: { id: 'PO12', number: 'PO-0012' }, amount: 5000000, currency: 'BDT', method: 'bkash', paid_on: '2026-11-10', reference: null, note: null, created_by: null, created_at: '2026-11-10T08:30:00Z' },
    ],
    events: [
      { type: 'created', actor: { id: 'U1', name: 'Rahim Ahmed' }, created_at: '2026-11-10T05:02:00Z', sent_via: null, units: null, damaged: null, amount: null },
      { type: 'sent', actor: { id: 'U1', name: 'Rahim Ahmed' }, created_at: '2026-11-10T05:06:00Z', sent_via: 'whatsapp', units: null, damaged: null, amount: null },
      { type: 'received', actor: { id: 'U2', name: 'Sumi Akter' }, created_at: '2026-11-15T10:20:00Z', sent_via: null, units: 60, damaged: 0, amount: null },
    ],
    ...o,
  };
}

/** What an `inventory.adjust`-only receiver gets: every money and cost field null, no payments. */
export function adjustOnly(d: PurchaseOrderDetail): PurchaseOrderDetail {
  return {
    ...d,
    payment_status: null,
    subtotal_amount: null,
    shipping_amount: null,
    discount_amount: null,
    total_amount: null,
    received_value_amount: null,
    paid_amount: null,
    balance_amount: null,
    supplier: { ...d.supplier, owed_amount: null },
    lines: d.lines.map((l) => ({ ...l, unit_cost_amount: null, line_total_amount: null, landed_unit_cost_amount: null, last_bought_unit_cost_amount: null })),
    payments: [],
  };
}

export function supplierSummary(o: Partial<SupplierSummary> = {}): SupplierSummary {
  return {
    currency: 'BDT',
    suppliers_count: 8,
    active_this_month: 5,
    owed_amount: 14250000,
    owed_suppliers_count: 3,
    overdue_count: 1,
    pos_on_the_way: 3,
    arriving_this_week: 2,
    bought_this_month_amount: 38600000,
    ...o,
  };
}

export function supplierDetail(o: Partial<SupplierDetail> = {}): SupplierDetail {
  return {
    ...supplier(),
    recent_purchase_orders: [po({ id: 'PO42', number: 'PO-0042', status: 'ordered', expected_on: '2026-11-22', total_amount: 4600000 }), po({ id: 'PO39', number: 'PO-0039', status: 'received', payment_status: 'unpaid', total_amount: 4000000 })],
    ...o,
  };
}

export const suggestions: ReorderSuggestionGroup[] = [
  {
    supplier: { id: 'SUP1', name: 'Tangail Weavers', lead_time_days: 5 },
    items: [
      { variant_id: 'V9', product: { id: 'P9', name: 'Jamdani', image: null }, variant_title: 'Red · M', sku: null, available: 8, incoming: 0, sold_30d: 48, days_left: 5, suggested_quantity: 30, last_unit_cost_amount: 105000 },
    ],
  },
  {
    supplier: null,
    items: [{ variant_id: 'V8', product: { id: 'P8', name: 'Silk Saree', image: null }, variant_title: 'Maroon', sku: null, available: 0, incoming: 0, sold_30d: 15, days_left: 0, suggested_quantity: 15, last_unit_cost_amount: null }],
  },
];

const page = (n: number, per = 25) => ({ current_page: 1, per_page: per, total: n, last_page: 1 });

export function purchasingRoutes(o: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: purchasingPlan() }),
    'GET /stores/S1/purchase-orders': jsonResponse(200, { data: poRows, meta: { ...page(poRows.length), counts: poCounts } }),
    'GET /stores/S1/purchase-orders/summary': jsonResponse(200, { data: poSummary() }),
    'GET /stores/S1/purchase-orders/PO12': jsonResponse(200, { data: poDetail() }),
    'GET /stores/S1/purchasing/reorder-suggestions': jsonResponse(200, { data: suggestions }),
    'GET /stores/S1/suppliers': jsonResponse(200, { data: suppliers, meta: { ...page(suppliers.length, 50), counts: { active: 3, archived: 1 } } }),
    'GET /stores/S1/suppliers/summary': jsonResponse(200, { data: supplierSummary() }),
    'GET /stores/S1/suppliers/SUP1': jsonResponse(200, { data: supplierDetail() }),
    ...o,
  };
}
