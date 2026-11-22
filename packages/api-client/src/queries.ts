// Phase 4 list filters → query params (`filter[...]` comma lists, contract §3.2–§3.5, §6 notes).
import type {
  CouponListFilters,
  CustomerListFilters,
  OrderListFilters,
  InventoryListFilters,
  ProductListFilters,
  ReturnReason,
  ReturnStatus,
  ReturnType,
  CourierProvider,
  StockMovementFilters,
} from '@storeplix/types';

type Query = Record<string, string | number | undefined>;

const list = (v?: readonly string[]) => (v?.length ? v.join(',') : undefined);
const text = (v?: string) => (v && v.trim() ? v.trim() : undefined);

export function productListQuery(f: ProductListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[category_id]': f.category_id || undefined,
    'filter[stock]': f.stock,
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

export function inventoryListQuery(f: InventoryListFilters = {}): Query {
  return {
    'filter[stock]': list(f.stock),
    'filter[category_id]': f.category_id || undefined,
    'filter[product_id]': f.product_id || undefined,
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

export function movementListQuery(f: StockMovementFilters = {}): Query {
  return {
    'filter[variant_id]': f.variant_id || undefined,
    'filter[product_id]': f.product_id || undefined,
    'filter[reason]': list(f.reason),
    'filter[created_at][gte]': f.created_from || undefined,
    'filter[created_at][lte]': f.created_to || undefined,
    page: f.page,
    per_page: f.per_page,
  };
}

export function customerListQuery(f: CustomerListFilters = {}): Query {
  return {
    'filter[channel]': list(f.channel),
    'filter[tag]': f.tag || undefined,
    'filter[created_at][gte]': f.created_from || undefined,
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

/** Phase 5a §3.7: `filter[placed_at][gte|lte]`, comma lists. */
export function orderListQuery(f: OrderListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[payment_status]': list(f.payment_status),
    'filter[channel]': list(f.channel),
    'filter[district_code]': f.district_code || undefined,
    'filter[customer_id]': f.customer_id || undefined,
    'filter[coupon_id]': f.coupon_id || undefined,
    'filter[placed_at][gte]': f.placed_from || undefined,
    'filter[placed_at][lte]': f.placed_to || undefined,
    // 5b §4.8: "Not printed · Printed today" on the print page.
    'filter[printed]': f.printed || undefined,
    'filter[not_printed]': f.not_printed || undefined,
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

/** Phase 5b §4.9 `GET /returns` filters (`open` = requested, approved, received). Not in @storeplix/types; client-local. */
export interface ReturnListFilters {
  status?: (ReturnStatus | 'open')[];
  type?: ReturnType[];
  reason?: ReturnReason[];
  provider?: (CourierProvider | 'manual')[];
  q?: string;
  sort?: '-created_at';
  page?: number;
  per_page?: number;
}

export function returnListQuery(f: ReturnListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[type]': list(f.type),
    'filter[reason]': list(f.reason),
    'filter[provider]': list(f.provider),
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

/** Phase 5a §3.6. */
export function couponListQuery(f: CouponListFilters = {}): Query {
  return {
    'filter[type]': list(f.type),
    'filter[status]': list(f.status),
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

/** `attachment; filename="x.csv"` → `x.csv`. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}
