import type { DocumentKind, DocumentTemplate, OrderItemsQuote, ReturnListMeta, ReturnRequest, ReturnSummary, StoreDocument } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 5b (5b-4 documents, 5b-5 order changes) fixtures shaped like openapi 1.6.0.

export function returnSummary(r: Partial<ReturnSummary> = {}): ReturnSummary {
  return {
    id: 'R1',
    number: 'RT-31',
    type: 'exchange',
    status: 'requested',
    reason: 'wrong_size',
    source: 'merchant',
    order: { id: 'O1', number: 'MU-1042' },
    customer: { name: 'Nasrin Akter', phone: '8801712345678' },
    items_preview: [{ product_name: 'Cotton Panjabi', variant_title: 'White / 40', quantity: 1 }],
    requested_amount: 170_000,
    refunded_amount: 0,
    courier: 'steadfast',
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    ...r,
  };
}

export function returnRequest(r: Partial<ReturnRequest> = {}): ReturnRequest {
  return {
    ...returnSummary(),
    customer_note: 'Chest is too tight, I need 42.',
    pickup_tracking_code: null,
    checks: {},
    items: [
      {
        id: 'RI1',
        order_item_id: 'OI1',
        product_name: 'Cotton Panjabi',
        variant_title: 'White / 40',
        image: null,
        quantity: 1,
        amount: 170_000,
        restocked_quantity: 0,
        exchange_variant: { id: 'V3', title: 'White / 42', price_amount: 175_000, available: 12 },
      },
    ],
    events: [{ id: 'RE1', type: 'created', from_status: null, to_status: 'requested', actor: { type: 'user', user: { id: 'U1', name: 'Rahim Ahmed' } }, body: null, meta: {}, created_at: new Date().toISOString() }],
    exchange_order: null,
    price_difference_amount: 11_000,
    allowed_transitions: ['approved', 'rejected'],
    revision: 1,
    ...r,
  };
}

export const returnMeta = (m: Partial<ReturnListMeta> = {}): ReturnListMeta => ({
  current_page: 1,
  per_page: 25,
  total: 1,
  last_page: 1,
  counts: { open: 18, requested: 6, approved: 4, received: 3, refunded: 12, exchanged: 2, rejected: 7, closed: 86 },
  kpis: { open: 18, return_rate_30d: 0.048, money_lost_amount: 684_000, restocked_units_month: 27 },
  ...m,
});

export const returnList = (rows: ReturnSummary[], meta: Partial<ReturnListMeta> = {}) => jsonResponse(200, { data: rows, meta: returnMeta({ total: rows.length, ...meta }) });

const paper: Record<DocumentKind, DocumentTemplate['paper']> = {
  invoice_a4: { width_mm: 210, height_mm: 297, label: 'A4 (210 × 297 mm)' },
  receipt_80mm: { width_mm: 80, height_mm: null, label: '80 mm roll' },
  invoice_a5_two_up: { width_mm: 210, height_mm: 297, label: 'A4 · 2 × A5' },
  packing_slip: { width_mm: 210, height_mm: 297, label: 'A4 (210 × 297 mm)' },
  label_4x6: { width_mm: 100, height_mm: 150, label: '4 × 6 in (100 × 150 mm)' },
};

export function documentTemplate(kind: DocumentKind, t: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    kind,
    config: { show_logo: true, show_bin: false, show_product_names: true, show_prices: kind !== 'label_4x6', show_sku: false, language: 'en', footer_text: null },
    paper: paper[kind],
    is_default: true,
    revision: 0,
    updated_at: null,
    ...t,
  };
}

export const templates = () => jsonResponse(200, { data: (['invoice_a4', 'receipt_80mm', 'label_4x6', 'invoice_a5_two_up', 'packing_slip'] as DocumentKind[]).map((k) => documentTemplate(k)) });

export function storeDocument(d: Partial<StoreDocument> = {}): StoreDocument {
  return { id: 'D1', kind: 'invoice_a4', status: 'queued', orders_count: 1, pages: null, download_url: null, expires_at: null, error_code: null, created_at: new Date().toISOString(), ...d };
}

export const READY_URL = 'http://localhost/api/v1/documents/D1/download?tenant=T1&expires=1&signature=abc';

export function itemsQuote(q: Partial<OrderItemsQuote> = {}): OrderItemsQuote {
  return {
    lines: [],
    subtotal_amount: 340_000,
    discount_amount: 0,
    shipping_amount: 7_000,
    total_amount: 347_000,
    previous_total_amount: 177_000,
    due_amount: 347_000,
    due_delta_amount: 170_000,
    notices: [],
    ...q,
  };
}
