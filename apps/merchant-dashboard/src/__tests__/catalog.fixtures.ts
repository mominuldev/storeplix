import type { Category, CustomerDetail, DashboardSummary, DataImport, InventoryItem, Product, ProductSummary } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

export const pageMeta = (total: number) => ({ current_page: 1, per_page: 25, total, last_page: 1 });

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'C1',
    parent_id: null,
    name: 'Sarees',
    slug: 'sarees',
    description: null,
    image: null,
    depth: 1,
    position: 0,
    is_visible: true,
    url_path: '/c/sarees',
    product_count: 3,
    children_count: 0,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function summary(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'P1',
    name: 'Jamdani Three-Piece',
    slug: 'jamdani-three-piece',
    type: 'variable',
    status: 'active',
    currency: 'BDT',
    image: null,
    price_min_amount: 345000,
    price_max_amount: 365000,
    price_amount: 345000,
    compare_at_amount: 395000,
    cost_amount: 210000,
    variants_count: 6,
    first_sku: 'JT-001',
    stock: { on_hand: 46, available: 46, low_variants: 2, out_variants: 0, tracked: true },
    categories: [{ id: 'C1', name: 'Sarees', slug: 'sarees' }],
    published_at: '2026-11-01T00:00:00Z',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function productList(rows: ProductSummary[], overrides: Record<string, unknown> = {}) {
  return jsonResponse(200, {
    data: rows,
    meta: {
      ...pageMeta(rows.length),
      counts: { all: rows.length, active: rows.length, draft: 0, archived: 0 },
      summary: { active_products: rows.length, active_variants: 6, low_stock_variants: 2, out_of_stock_variants: 0 },
      plan: { limit: 100, used: rows.length },
      ...overrides,
    },
  });
}

export function variant(overrides: Partial<Product['variants'][number]> = {}): Product['variants'][number] {
  return {
    id: 'V1',
    title: 'M / Red',
    option_values: ['M', 'Red'],
    sku: 'JT-RD-M',
    barcode: null,
    price_amount: 345000,
    compare_at_amount: null,
    cost_amount: 210000,
    weight_grams: null,
    position: 0,
    is_default: false,
    is_enabled: true,
    track_inventory: true,
    allow_backorder: false,
    image_media_id: null,
    inventory: { on_hand: 14, committed: 0, available: 14, low_stock_threshold: null, effective_threshold: 5, status: 'in_stock' },
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function product(overrides: Partial<Product> = {}): Product {
  return {
    ...summary(),
    description: null,
    tags: ['eid'],
    options: [
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Colour', values: ['Red'] },
    ],
    variants: [variant(), variant({ id: 'V2', title: 'L / Red', option_values: ['L', 'Red'], sku: 'JT-RD-L', position: 1, inventory: { on_hand: 9, committed: 0, available: 9, low_stock_threshold: null, effective_threshold: 5, status: 'in_stock' } })],
    images: [],
    seo: { title: null, description: null },
    url_path: '/products/jamdani-three-piece',
    revision: 3,
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

export function inventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    variant_id: 'V1',
    product: { id: 'P1', name: 'Jamdani Three-Piece', status: 'active', image: null },
    title: 'M / Red',
    option_values: ['M', 'Red'],
    sku: 'JT-RD-M',
    barcode: null,
    on_hand: 14,
    committed: 0,
    available: 14,
    low_stock_threshold: null,
    effective_threshold: 5,
    status: 'in_stock',
    track_inventory: true,
    price_amount: 345000,
    cost_amount: 210000,
    updated_at: '2026-11-01T00:00:00Z',
    incoming: 0,
    ...overrides,
  };
}

export const inventoryList = (rows: InventoryItem[]) =>
  jsonResponse(200, {
    data: rows,
    meta: {
      ...pageMeta(rows.length),
      summary: {
        currency: 'BDT',
        stock_value_cost_amount: 3920000,
        stock_value_price_amount: 6105000,
        units_on_hand: 1284,
        committed_units: 0,
        low_stock_variants: 4,
        out_of_stock_variants: 2,
        variants_count: 212,
        products_count: 86,
      },
    },
  });

export function customer(overrides: Partial<CustomerDetail> = {}): CustomerDetail {
  return {
    id: 'CU1',
    name: 'Farhana Rahman',
    phone: '8801556120987',
    email: null,
    district: 'Narayanganj',
    area: 'Chashara',
    channel: 'instagram',
    source: 'manual',
    tags: ['repeat buyer'],
    accepts_marketing: false,
    delivered_orders_count: 0,
    returned_orders_count: 0,
    orders_count: 0,
    total_spent_amount: 0,
    currency: 'BDT',
    last_order_at: null,
    notes_count: 0,
    revision: 1,
    created_at: '2025-06-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
    created_by: null,
    marketing: { sms: 'not_eligible', email: 'no_address', unsubscribed_sms_at: null, unsubscribed_email_at: null, unsubscribed_source: { sms: null, email: null } },
    // PHASE-8-8 §6.5: own-shop tier (no parcels → new).
    risk: { tier: 'new', rate: null, delivered: 0, total: 0 },
    notes: [],
    ...overrides,
  };
}

export function dashboard(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    generated_at: '2026-11-22T00:00:00Z',
    products: { total: 0, active: 0, draft: 0, archived: 0, limit: 100 },
    inventory: { low_stock_variants: 0, out_of_stock_variants: 0, units_on_hand: 0, stock_value_cost_amount: null },
    customers: { total: 0, new_this_month: 0 },
    orders: null,
    setup: { has_products: false },
    ...overrides,
  };
}

export function dataImport(overrides: Partial<DataImport> = {}): DataImport {
  return {
    id: 'I1',
    type: 'products',
    status: 'uploaded',
    filename: 'mugdho-products.csv',
    size_bytes: 48_000,
    row_count: 3,
    headers: ['Title', 'Price (BDT)', 'Image URL', 'FB Post Link'],
    samples: { Title: 'Jamdani Three-Piece', 'Price (BDT)': '3450', 'Image URL': 'https://cdn/x.jpg', 'FB Post Link': null },
    suggested_map: { Title: 'name', 'Price (BDT)': 'price', 'Image URL': 'image_urls', 'FB Post Link': null },
    column_map: null,
    options: { update_existing: true, import_as_draft: false, create_missing_categories: true },
    summary: null,
    progress: { processed: 0, total: 3 },
    failure_reason: null,
    created_by: null,
    created_at: '2026-11-22T00:00:00Z',
    validated_at: null,
    completed_at: null,
    ...overrides,
  };
}
