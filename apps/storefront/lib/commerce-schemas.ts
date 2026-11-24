import { z } from 'zod';
import type {
  Address,
  BdGeo,
  Cart,
  CartLine,
  CartMeta,
  OrderStatus,
  PaymentInitiation,
  PaymentLinkView,
  PaymentMethod,
  ShippingQuote,
  StorefrontAvailability,
  StorefrontCategory,
  StorefrontCategoryDetail,
  StorefrontCommerce,
  StorefrontMedia,
  StorefrontOrder,
  StorefrontOrderLine,
  StorefrontPaymentResult,
  StorefrontPaymentState,
  StorefrontProduct,
  StorefrontProductCard,
  StorefrontVariant,
} from '@storeplix/types';
import type { CourierTrackStatus, StorefrontTracking } from './tracking';
import { normalizeRichText } from './rich-text';
import { cleanText } from './text';
import { parseProductCard, parseStorefrontMedia } from './storefront-schemas';

/**
 * Boundary parsers for the Phase 5a storefront payloads (PHASE-5-CONTRACT §3.2–3.4, §6). Pure (no
 * server-only) so they are unit-testable. Unknown keys are always stripped, so anything the API
 * might add (cost, sku, on_hand, committed, tenant ids) never reaches a render path or the browser.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_AMOUNT = 100_000_000_000;
export const amount = z.number().int().min(0).max(MAX_AMOUNT);
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const slug = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const currency = z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()).catch('BDT');
const text = (max: number) =>
  z
    .unknown()
    .optional()
    .transform((v) => cleanText(v, max, 1))
    .pipe(z.string());
const optText = (max: number) => z.unknown().optional().transform((v) => cleanText(v, max, 1) ?? null);
const media = z.unknown().optional().transform((v): StorefrontMedia | null => parseStorefrontMedia(v));
const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)));
const geoCode = z.string().min(1).max(48).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

/** Array whose invalid items are dropped instead of failing the whole payload. */
function lenientArray<T>(item: z.ZodType<T, unknown>, max: number) {
  return z.unknown().optional().transform((v): T[] => {
    if (!Array.isArray(v)) return [];
    return v.slice(0, max).flatMap((x) => {
      const r = item.safeParse(x);
      return r.success ? [r.data] : [];
    });
  });
}

const ORDER_STATUSES = ['pending_payment', 'pending', 'confirmed', 'ready_to_ship', 'shipped', 'delivered', 'returned', 'cancelled'] as const;
const orderStatus = z.enum(ORDER_STATUSES);
const paymentMethod = z.enum(['cod', 'bkash', 'sslcommerz']);
const gatewayProvider = z.enum(['bkash', 'sslcommerz']);
const paymentStatus = z.enum(['pending', 'succeeded', 'failed', 'cancelled']);
const paymentPurpose = z.enum(['order', 'advance', 'link', 'exchange', 'test']);
/** Payment ids are ULIDs (26 chars, any case on the wire). */
export const PAYMENT_ID_RE = /^[0-9A-Za-z]{26}$/;
const paymentId = z.string().regex(PAYMENT_ID_RE);

// ---------- API error envelope ----------
export interface ParsedApiError {
  code: string;
  message: string;
  details: Record<string, string[]>;
}

const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(500).catch(''),
    details: z
      // Scalars (e.g. 8.8a `otp_invalid` `details.attempts_left: 3`) are read as a one-item list.
      .record(z.string().max(120), z.union([z.array(z.string().max(500)).max(10), z.string().max(500), z.number().finite()]))
      .optional()
      .catch(undefined),
  }),
});

/** `{error:{code,message,details}}` or a generic error for anything else. */
export function parseApiError(body: unknown, status: number): ParsedApiError {
  const parsed = ApiErrorSchema.safeParse(body);
  if (!parsed.success) return { code: status === 0 ? 'network_error' : `http_${status}`, message: '', details: {} };
  const details: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed.data.error.details ?? {})) {
    const msgs = (Array.isArray(v) ? v : [String(v)]).flatMap((m) => {
      const t = cleanText(m, 500, 1);
      return t ? [t] : [];
    });
    if (msgs.length) details[k] = msgs;
  }
  return { code: parsed.data.error.code, message: cleanText(parsed.data.error.message, 500) ?? '', details };
}

// ---------- catalog ----------
const VariantSchema = z
  .object({
    id,
    title: z.unknown().optional().transform((v) => cleanText(v, 130) ?? ''),
    option_values: z.array(z.string().max(60)).max(3).catch([]),
    price_amount: amount,
    compare_at_amount: amount.nullable().catch(null),
    image_media_id: z.string().max(64).nullable().catch(null),
  })
  .transform(
    (v): StorefrontVariant => ({
      ...v,
      compare_at_amount: v.compare_at_amount !== null && v.compare_at_amount > v.price_amount ? v.compare_at_amount : null,
      image_media_id: v.image_media_id ? v.image_media_id.toLowerCase() : null,
    }),
  );

const OptionSchema = z.object({
  name: text(40),
  values: z.array(z.string().min(1).max(60)).min(1).max(50),
});

const ProductImageSchema = z
  .object({ media_id: z.string().max(64), alt: optText(500), media })
  .transform((v, ctx) => {
    if (!v.media) {
      ctx.addIssue({ code: 'custom', message: 'bad media' });
      return z.NEVER;
    }
    return { media_id: v.media_id.toLowerCase(), alt: v.alt, media: v.media };
  });

const ProductSchema = z.object({
  id,
  slug,
  name: text(200),
  description: z.unknown().optional().transform((v) => (isObject(v) ? normalizeRichText(v).doc : null)),
  options: lenientArray(OptionSchema, 3),
  variants: lenientArray(VariantSchema, 250),
  images: lenientArray(ProductImageSchema, 30),
  price_min_amount: amount,
  price_max_amount: amount,
  currency,
  categories: lenientArray(z.object({ slug, name: text(120) }), 10),
  seo: z
    .object({ title: optText(120), description: optText(320) })
    .catch({ title: null, description: null }),
  url_path: z.string().max(260).catch(''),
  is_preview_only: z.boolean().catch(false),
  updated_at: isoDate.catch(''),
});

/** `GET /storefront/products/{slug}` data; null when unusable or without a variant. */
export function parseStorefrontProduct(v: unknown): StorefrontProduct | null {
  const r = ProductSchema.safeParse(v);
  if (!r.success || r.data.variants.length === 0) return null;
  return { ...r.data, url_path: `/products/${r.data.slug}` };
}

const AvailabilitySchema = z.object({
  variants: lenientArray(
    z.object({
      id,
      available: z.boolean().catch(false),
      // Only a positive count is ever shown ("Only N left").
      low_stock: z.number().int().min(1).max(100000).nullable().catch(null),
    }),
    250,
  ),
});

export function parseAvailability(v: unknown): StorefrontAvailability | null {
  const r = AvailabilitySchema.safeParse(v);
  return r.success ? r.data : null;
}

const CategorySchema: z.ZodType<StorefrontCategory, unknown> = z.lazy(() =>
  z.object({
    slug,
    name: text(120),
    image: media,
    url_path: z.unknown().optional().transform(() => ''),
    children: lenientArray(CategorySchema, 100),
  }),
).transform((c) => ({ ...c, url_path: `/c/${c.slug}` }));

export function parseCategoryTree(v: unknown): StorefrontCategory[] {
  return lenientArray(CategorySchema, 200).parse(v);
}

const CategoryDetailSchema = z.object({
  slug,
  name: text(120),
  image: media,
  description: optText(2000),
  ancestors: lenientArray(z.object({ slug, name: text(120) }), 5),
  children: lenientArray(
    z.object({ slug, name: text(120) }).transform((c) => ({ ...c, url_path: `/c/${c.slug}` })),
    100,
  ),
});

export function parseCategoryDetail(v: unknown): StorefrontCategoryDetail | null {
  const r = CategoryDetailSchema.safeParse(v);
  return r.success ? { ...r.data, url_path: `/c/${r.data.slug}` } : null;
}

export interface ProductPage {
  products: StorefrontProductCard[];
  has_products: boolean;
  page: number;
  per_page: number;
  total: number;
  last_page: number;
}

const ListMetaSchema = z.object({
  has_products: z.boolean().catch(false),
  current_page: z.number().int().min(1).optional().catch(undefined),
  per_page: z.number().int().min(1).max(100).optional().catch(undefined),
  total: z.number().int().min(0).optional().catch(undefined),
  last_page: z.number().int().min(1).optional().catch(undefined),
});

/** `GET /storefront/products` (paginated or `limit`); null for an unusable envelope. */
export function parseProductPage(body: unknown): ProductPage | null {
  if (!isObject(body) || !Array.isArray(body.data)) return null;
  const meta = ListMetaSchema.safeParse(body.meta);
  if (!meta.success) return null;
  const products = body.data.slice(0, 100).flatMap((c) => {
    const card = parseProductCard(c);
    return card ? [card] : [];
  });
  const m = meta.data;
  return {
    products,
    has_products: m.has_products,
    page: m.current_page ?? 1,
    per_page: m.per_page ?? products.length,
    total: m.total ?? products.length,
    last_page: m.last_page ?? 1,
  };
}

// ---------- config.commerce ----------
const CommerceSchema = z.object({
  checkout_enabled: z.boolean().catch(false),
  payment_methods: lenientArray(paymentMethod, 5),
  free_delivery_over_amount: amount.nullable().catch(null),
  delivery: lenientArray(
    z.object({
      name: text(60),
      charge_amount: amount,
      min_days: z.number().int().min(0).max(30),
      max_days: z.number().int().min(0).max(30),
    }),
    30,
  ),
  // 5b: sent once advance payments ship (5b-2); until then the API omits it.
  cod_advance: z.enum(['none', 'delivery_charge']).catch('none'),
});

/** Optional on the wire (rolling deploys): missing/invalid → null and the UI hides commerce extras. */
export function parseCommerce(v: unknown): StorefrontCommerce | null {
  const r = CommerceSchema.safeParse(v);
  return r.success ? r.data : null;
}

// ---------- cart ----------
const CartLineSchema = z.object({
  id,
  variant_id: id,
  product_slug: slug.catch(''),
  product_name: text(200),
  variant_title: z.unknown().optional().transform((v) => cleanText(v, 130) ?? ''),
  option_values: z.array(z.string().max(60)).max(3).catch([]),
  image: media,
  quantity: z.number().int().min(1).max(99),
  unit_price_amount: amount,
  compare_at_amount: amount.nullable().catch(null),
  line_amount: amount,
  issue: z.enum(['unavailable', 'insufficient_stock']).nullable().catch(null),
  max_quantity: z.number().int().min(0).max(99).nullable().catch(null),
  low_stock: z.number().int().min(1).max(100000).nullable().catch(null),
}) satisfies z.ZodType<CartLine, unknown>;

const CartSchema = z.object({
  lines: lenientArray(CartLineSchema, 50),
  lines_count: z.number().int().min(0).max(50),
  items_count: z.number().int().min(0).max(5000),
  currency,
  coupon: z
    .object({
      code: z.string().min(1).max(32),
      type: z.enum(['percentage', 'fixed', 'free_shipping']),
      discount_amount: amount,
      free_shipping: z.boolean().catch(false),
    })
    .nullable()
    .catch(null),
  subtotal_amount: amount,
  discount_amount: amount,
  savings_amount: amount.catch(0),
  estimated_total_amount: amount,
  free_delivery: z
    .object({ threshold_amount: amount, remaining_amount: amount })
    .nullable()
    .catch(null),
  can_checkout: z.boolean().catch(false),
}) satisfies z.ZodType<Cart, unknown>;

/** base64url, 32 random bytes = 43 chars (P5-3); accept a small range for forward compatibility. */
export const CART_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

const CartMetaSchema = z
  .object({
    cart_token: z.string().regex(CART_TOKEN_RE).optional().catch(undefined),
    notices: lenientArray(text(300), 10).optional(),
  })
  .catch({});

export interface CartEnvelope {
  cart: Cart;
  meta: CartMeta;
}

export function parseCartEnvelope(body: unknown): CartEnvelope | null {
  if (!isObject(body)) return null;
  const cart = CartSchema.safeParse(body.data);
  if (!cart.success) return null;
  return { cart: cart.data, meta: CartMetaSchema.parse(body.meta ?? {}) };
}

const ShippingQuoteSchema = z.object({
  zone_id: z.string().max(64).catch(''),
  zone_name: text(60),
  min_days: z.number().int().min(0).max(30),
  max_days: z.number().int().min(0).max(30),
  charge_amount: amount,
  amount,
  is_free: z.boolean().catch(false),
}) satisfies z.ZodType<ShippingQuote, unknown>;

export function parseShippingQuote(v: unknown): ShippingQuote | null {
  const r = ShippingQuoteSchema.safeParse(v);
  return r.success ? r.data : null;
}

// ---------- orders ----------
const OrderLineSchema = z.object({
  product_name: text(200),
  variant_title: z.unknown().optional().transform((v) => cleanText(v, 130) ?? ''),
  quantity: z.number().int().min(1).max(99),
  image: media,
  unit_price_amount: amount,
  total_amount: amount,
}) satisfies z.ZodType<StorefrontOrderLine, unknown>;

const AddressSchema = z.object({
  division_code: z.string().max(48).catch(''),
  division: z.unknown().optional().transform((v) => cleanText(v, 80) ?? ''),
  district_code: z.string().max(48).catch(''),
  district: z.unknown().optional().transform((v) => cleanText(v, 80) ?? ''),
  thana_code: z.string().max(48).catch(''),
  thana: z.unknown().optional().transform((v) => cleanText(v, 80) ?? ''),
  area: optText(120),
  address_line: z.unknown().optional().transform((v) => cleanText(v, 255) ?? ''),
  landmark: optText(160),
  label: z.enum(['home', 'office']).nullable().catch(null),
}) satisfies z.ZodType<Address, unknown>;

const OrderNumber = z.string().min(1).max(24).regex(/^[A-Za-z0-9-]+$/);

const OrderSchema = z.object({
  number: OrderNumber,
  status: orderStatus,
  payment_method: paymentMethod.catch('cod'),
  placed_at: isoDate,
  customer_name: text(120),
  customer_phone: z.string().max(20).catch(''),
  shipping_address: AddressSchema,
  lines: lenientArray(OrderLineSchema, 50),
  coupon_code: z.string().max(32).nullable().catch(null),
  subtotal_amount: amount,
  discount_amount: amount,
  shipping_amount: amount,
  total_amount: amount,
  due_amount: amount,
  currency,
  delivery: z
    .object({
      zone_name: z.unknown().optional().transform((v) => cleanText(v, 60) ?? ''),
      min_days: z.number().int().min(0).max(30).nullable().catch(null),
      max_days: z.number().int().min(0).max(30).nullable().catch(null),
    })
    .catch({ zone_name: '', min_days: null, max_days: null }),
  // 5b-2: state of the order's latest online payment (null for plain COD).
  payment: z.unknown().optional().transform((v) => parsePaymentState(v)),
  paid_amount: amount.catch(0),
}) satisfies z.ZodType<StorefrontOrder, unknown>;

export function parseStorefrontOrder(v: unknown): StorefrontOrder | null {
  const r = OrderSchema.safeParse(v);
  return r.success ? r.data : null;
}

export interface ParsedCheckoutResult {
  order: StorefrontOrder;
  confirmation_token: string;
  payment: PaymentInitiation | null;
}

export function parseCheckoutResult(v: unknown): ParsedCheckoutResult | null {
  if (!isObject(v)) return null;
  const order = parseStorefrontOrder(v.order);
  const token = typeof v.confirmation_token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v.confirmation_token) ? v.confirmation_token : null;
  if (!order || !token) return null;
  // `payment` is null for plain COD; a present-but-unusable initiation fails the payload (the
  // shopper would otherwise land on a COD thank-you for an order that waits for payment).
  if (v.payment === undefined || v.payment === null) return { order, confirmation_token: token, payment: null };
  const payment = parsePaymentInitiation(v.payment);
  return payment ? { order, confirmation_token: token, payment } : null;
}

// ---------- payments (5b-2, PHASE-5B-CONTRACT §4.2) ----------

/**
 * Gateway URL we send the browser to. Absolute https only (http only outside production, for the
 * local fake gateway), no credentials, ≤ 2 000 chars. Anything else → null (treated as a failed
 * initiation, never followed).
 */
export function safeGatewayUrl(v: unknown, allowHttp = process.env.NODE_ENV !== 'production'): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    const okProtocol = u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
    return okProtocol && !u.username && !u.password && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

const PaymentInitiationSchema = z
  .object({
    payment_id: paymentId,
    provider: gatewayProvider,
    status: z.enum(['redirect', 'initiation_failed']),
    redirect_url: z.unknown().optional().transform((u) => safeGatewayUrl(u)),
    amount,
    expires_at: isoDate,
  })
  .transform((p): PaymentInitiation => (p.status === 'redirect' && !p.redirect_url ? { ...p, status: 'initiation_failed', redirect_url: null } : p));

/** `PaymentInitiation` (checkout, `orders/pay`, `payment-links/{token}/pay`). */
export function parsePaymentInitiation(v: unknown): PaymentInitiation | null {
  const r = PaymentInitiationSchema.safeParse(v);
  return r.success ? r.data : null;
}

const PaymentStateSchema = z.object({
  status: paymentStatus,
  provider: gatewayProvider,
  purpose: paymentPurpose.catch('order'),
  amount,
  expires_at: isoDate.nullable().catch(null),
  can_retry: z.boolean().catch(false),
  can_switch_to_cod: z.boolean().catch(false),
}) satisfies z.ZodType<StorefrontPaymentState, unknown>;

/** `StorefrontOrder.payment`; null when absent or unusable (rendered as a COD order). */
export function parsePaymentState(v: unknown): StorefrontPaymentState | null {
  const r = PaymentStateSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** `POST /storefront/orders/pay` → `{ order, payment }` (`payment: null` after a switch to COD). */
export function parseOrderPayResult(v: unknown): { order: StorefrontOrder; payment: PaymentInitiation | null } | null {
  if (!isObject(v)) return null;
  const order = parseStorefrontOrder(v.order);
  if (!order) return null;
  if (v.payment === undefined || v.payment === null) return { order, payment: null };
  const payment = parsePaymentInitiation(v.payment);
  return payment ? { order, payment } : null;
}

const PaymentResultSchema = z.object({
  status: paymentStatus,
  order_number: OrderNumber,
  amount,
  currency,
  purpose: paymentPurpose.catch('order'),
  shop_name: text(120),
}) satisfies z.ZodType<StorefrontPaymentResult, unknown>;

/** `GET /storefront/payments/{payment}/result` (no PII). */
export function parsePaymentResult(v: unknown): StorefrontPaymentResult | null {
  const r = PaymentResultSchema.safeParse(v);
  return r.success ? r.data : null;
}

const PaymentLinkViewSchema = z.object({
  order_number: OrderNumber,
  shop_name: z.unknown().optional().transform((v) => cleanText(v, 120) ?? ''),
  amount: amount.refine((a) => a > 0),
  currency,
  provider: gatewayProvider,
  expires_at: isoDate,
  status: z.literal('active'),
}) satisfies z.ZodType<PaymentLinkView, unknown>;

/** `GET /storefront/payment-links/{token}`; anything but an active link → null (invalid page). */
export function parsePaymentLinkView(v: unknown): PaymentLinkView | null {
  const r = PaymentLinkViewSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** Payment-link tokens: 12 base62 chars (P5B-22); a small range for forward compatibility. */
export const PAY_LINK_TOKEN_RE = /^[A-Za-z0-9]{10,64}$/;

const COURIER_TRACK_STATUSES = [
  'booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'delivery_failed', 'delivered',
  'partially_delivered', 'returning', 'returned', 'cancelled', 'booking_failed', 'shipped',
] as const satisfies readonly CourierTrackStatus[];
const courierTrackStatus = z.enum(COURIER_TRACK_STATUSES);

const TrackingSchema = z.object({
  number: OrderNumber,
  status: orderStatus,
  placed_at: isoDate,
  shipping: z
    .object({ district: z.unknown().optional().transform((v) => cleanText(v, 80) ?? ''), thana: z.unknown().optional().transform((v) => cleanText(v, 80) ?? '') })
    .catch({ district: '', thana: '' }),
  lines: lenientArray(OrderLineSchema, 50),
  total_amount: amount,
  due_amount: amount,
  currency,
  timeline: lenientArray(z.object({ status: orderStatus, at: isoDate }), 20),
  shipment: z
    .object({
      carrier_name: optText(60),
      tracking_code: optText(64),
      tracking_url: z
        .unknown()
        .optional()
        .transform((v) => {
          // https only (S14); rendered with rel="noopener noreferrer nofollow".
          if (typeof v !== 'string' || v.length > 500) return null;
          try {
            const u = new URL(v);
            return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
          } catch {
            return null;
          }
        }),
      // 5b-3 (§11 `/track`): courier status + time only. Unknown keys (rider name/phone, location, raw
      // provider payloads) are stripped by the object schema and never reach the page.
      status: courierTrackStatus.nullable().optional().catch(null).transform((x) => x ?? null),
      status_at: isoDate.nullable().optional().catch(null).transform((x) => x ?? null),
      checked_at: isoDate.nullable().optional().catch(null).transform((x) => x ?? null),
      events: lenientArray(z.object({ status: courierTrackStatus, at: isoDate }), 30),
    })
    .nullable()
    .catch(null),
}) satisfies z.ZodType<StorefrontTracking, unknown>;

export function parseTracking(v: unknown): StorefrontTracking | null {
  const r = TrackingSchema.safeParse(v);
  return r.success ? r.data : null;
}

// ---------- geo ----------
const GeoSchema = z.object({
  version: z.string().max(40).catch(''),
  divisions: lenientArray(z.object({ code: geoCode, name: text(80), name_bn: z.unknown().optional().transform((v) => cleanText(v, 80) ?? '') }), 20),
  districts: lenientArray(
    z.object({ code: geoCode, division_code: geoCode, name: text(80), name_bn: z.unknown().optional().transform((v) => cleanText(v, 80) ?? '') }),
    100,
  ),
  thanas: lenientArray(
    z.object({
      code: geoCode,
      district_code: geoCode,
      name: text(80),
      name_bn: z.unknown().optional().transform((v) => cleanText(v, 80) ?? ''),
      is_city: z.boolean().catch(false),
    }),
    1000,
  ),
}) satisfies z.ZodType<BdGeo, unknown>;

export function parseGeo(v: unknown): BdGeo | null {
  const r = GeoSchema.safeParse(v);
  return r.success && r.data.divisions.length > 0 ? r.data : null;
}

export type { OrderStatus, PaymentMethod };
