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
  ShipmentListFilters,
  StockMovementFilters,
  LocationListFilters,
  StockCountLineFilters,
  StockCountListFilters,
  StockTransferListFilters,
  PurchaseOrderListFilters,
  SupplierListFilters,
  PosCatalogParams,
  PosRegisterListFilters,
  PosSaleListFilters,
  SmsCreditLedgerFilters,
  SmsLogFilters,
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
    // PHASE-8-8C §5.4 (omitted = All locations)
    'filter[location_id]': f.location_id || undefined,
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
    // PHASE-8-8B §8.1
    'filter[reference_type]': f.reference_type || undefined,
    // PHASE-8-8C §5.4
    'filter[location_id]': f.location_id || undefined,
    page: f.page,
    per_page: f.per_page,
  };
}

export function customerListQuery(f: CustomerListFilters = {}): Query {
  return {
    'filter[channel]': list(f.channel),
    'filter[tag]': f.tag || undefined,
    'filter[created_at][gte]': f.created_from || undefined,
    // PHASE-8-8 §10.3
    'filter[risk]': list(f.risk),
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
    // 5b-3: "Book parcels" loads orders without an active shipment.
    'filter[has_shipment]': f.has_shipment === undefined ? undefined : f.has_shipment ? '1' : '0',
    // PHASE-8-8 §6.5: risk tiers and held orders.
    'filter[risk]': list(f.risk),
    'filter[guard_hold]': f.guard_hold ? '1' : undefined,
    // PHASE-8-8D §8: "POS" chip (till sales).
    'filter[created_via]': list(f.created_via),
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

/** Phase 5b §4.7 `GET /shipments`: status takes ShipmentStatus values or the groups problems, active, final. */
export function shipmentListQuery(f: ShipmentListFilters = {}): Query {
  return {
    'filter[provider]': list(f.provider),
    'filter[status]': list(f.status),
    'filter[booked_at][gte]': f.booked_from || undefined,
    'filter[booked_at][lte]': f.booked_to || undefined,
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

// PHASE-8-8B §4 / §8.1
export function supplierListQuery(f: SupplierListFilters = {}): Query {
  return {
    'filter[archived]': f.archived === undefined ? undefined : f.archived ? '1' : '0',
    q: text(f.q),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

export function purchaseOrderListQuery(f: PurchaseOrderListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[supplier_id]': f.supplier_id || undefined,
    q: text(f.q),
    page: f.page,
    per_page: f.per_page,
  };
}

/** PHASE-8-8C §4: `archived` omitted = all locations. */
export function locationListQuery(f: LocationListFilters = {}): Query {
  return {
    'filter[archived]': f.archived === undefined ? undefined : f.archived ? '1' : '0',
  };
}

/** PHASE-8-8C §7: `filter[location_id]` matches either side of the transfer; `q` = transfer number. */
export function stockTransferListQuery(f: StockTransferListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[location_id]': f.location_id || undefined,
    q: text(f.q),
    page: f.page,
    per_page: f.per_page,
  };
}

/** PHASE-8-8C §8: counts list, latest first. */
export function stockCountListQuery(f: StockCountListFilters = {}): Query {
  return {
    'filter[status]': list(f.status),
    'filter[location_id]': f.location_id || undefined,
    page: f.page,
    per_page: f.per_page,
  };
}

/** PHASE-8-8C §8: count lines (100 per page); `state` omitted = All. */
export function stockCountLineListQuery(f: StockCountLineFilters = {}): Query {
  return {
    'filter[state]': f.state || undefined,
    q: text(f.q),
    page: f.page,
    per_page: f.per_page,
  };
}

/** PHASE-8-8D §5.3 `GET /pos/catalog` (40 per page by name; cursor pages). */
export function posCatalogQuery(p: PosCatalogParams): Query {
  return { register_id: p.register_id, q: text(p.q), 'filter[category_id]': p.category_id || undefined, cursor: p.cursor || undefined };
}

/** PHASE-8-8D §4 `GET /pos/registers` (`filter[archived]=true` → archived only). */
export function posRegisterListQuery(f: PosRegisterListFilters = {}): Query {
  return { 'filter[archived]': f.archived ? 'true' : undefined };
}

/** PHASE-8-8D §9 `GET /pos/sales` (history; newest first, cursor pages). `from`/`to` only with `date=custom`. */
export function posSaleListQuery(f: PosSaleListFilters = {}): Query {
  const custom = f.date === 'custom';
  return {
    'filter[date]': f.date || undefined,
    from: custom ? f.from || undefined : undefined,
    to: custom ? f.to || undefined : undefined,
    'filter[register_id]': f.register_id || undefined,
    'filter[method]': f.method || undefined,
    q: text(f.q),
    cursor: f.cursor || undefined,
  };
}

/** PHASE-8-9A §9 SMS log: comma lists for purpose/status; dates YYYY-MM-DD (store timezone, ≤ 90 days back). */
export function smsLogQuery(f: SmsLogFilters = {}): Query {
  return {
    'filter[purpose]': list(f.purpose),
    'filter[status]': list(f.status),
    'filter[from]': f.from || undefined,
    'filter[to]': f.to || undefined,
    'filter[phone]': text(f.phone),
    cursor: f.cursor || undefined,
  };
}

/** PHASE-8-9A §5.5 credit ledger. */
export function smsCreditLedgerQuery(f: SmsCreditLedgerFilters = {}): Query {
  return { 'filter[type]': list(f.type), cursor: f.cursor || undefined };
}
