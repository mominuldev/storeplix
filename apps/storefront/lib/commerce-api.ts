import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import type {
  BdGeo,
  PaymentInitiation,
  PaymentLinkView,
  PaymentMethod,
  ShippingQuote,
  StorefrontAvailability,
  StorefrontCategory,
  StorefrontCategoryDetail,
  StorefrontOrder,
  StorefrontPaymentResult,
  StorefrontProduct,
} from '@storeplix/types';
import { serverEnv } from './env';
import { isTrustedProxy } from './host';
import {
  CATALOG_REVALIDATE_SECONDS,
  buildCommerceRequest,
  clientIpFromHeaders,
  type CommerceCall,
} from './commerce-request';
import {
  parseApiError,
  parseAvailability,
  parseCartEnvelope,
  parseCategoryDetail,
  parseCategoryTree,
  parseCheckoutResult,
  parseGeo,
  parseOrderPayResult,
  parsePaymentInitiation,
  parsePaymentLinkView,
  parsePaymentResult,
  parseProductPage,
  parseShippingQuote,
  parseStorefrontOrder,
  parseStorefrontProduct,
  parseTracking,
  type CartEnvelope,
  type ParsedApiError,
  type ProductPage,
} from './commerce-schemas';
import { commerceMockFetch, commerceMockEnabled } from './commerce-mock';
import type { StorefrontTracking } from './tracking';

/**
 * Server-to-server client for the Phase 5a storefront API (PHASE-5-CONTRACT §3.2–3.4). Every call
 * carries X-Storefront-Key + X-Storefront-Host; cart/checkout/track also forward the shopper IP
 * from the trusted proxy header. Responses are validated at the boundary (commerce-schemas).
 */

export type ApiResult<T> =
  | { ok: true; status: number; data: T; replayed?: boolean }
  | ({ ok: false; status: number } & ParsedApiError);

const NETWORK_ERROR = { ok: false as const, status: 0, code: 'network_error', message: '', details: {} };

async function rawCall(host: string, path: string, call: CommerceCall): Promise<{ status: number; body: unknown; headers: Headers } | null> {
  const apiKey = serverEnv.apiKey;
  if (!apiKey) {
    console.error('[storefront] STOREFRONT_API_KEY is not configured');
    return null;
  }
  const { url, init } = buildCommerceRequest(path, host, call, { apiUrl: serverEnv.apiUrl, apiKey });
  try {
    const res = commerceMockEnabled() ? await commerceMockFetch(url, init) : await fetch(url, init);
    const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    // Never log headers or bodies (tokens, phone numbers): the path and message only.
    console.error(`[storefront] ${call.method ?? 'GET'} ${path.split('?')[0]} failed: ${(err as Error).message}`);
    return null;
  }
}

async function request<T>(host: string, path: string, call: CommerceCall, parse: (data: unknown, body: unknown) => T | null): Promise<ApiResult<T>> {
  const res = await rawCall(host, path, call);
  if (!res) return NETWORK_ERROR;
  if (res.status >= 200 && res.status < 300) {
    const body = res.body as { data?: unknown } | null;
    const data = parse(body?.data, body);
    if (data === null) {
      console.error(`[storefront] invalid payload from ${path.split('?')[0]}`);
      return { ok: false, status: 502, code: 'invalid_payload', message: '', details: {} };
    }
    return { ok: true, status: res.status, data, replayed: res.headers.get('Idempotent-Replayed') === 'true' };
  }
  return { ok: false, status: res.status, ...parseApiError(res.body, res.status) };
}

/** Shopper IP for throttling (only from our trusted proxy). */
export async function getClientIp(): Promise<string | null> {
  return clientIpFromHeaders(await headers(), isTrustedProxy());
}

/** Preview calls are per visitor (no-store) and carry the shopper IP; public calls are shared and never do (5b §2.10). */
const catalogCache = async (previewToken: string | null): Promise<CommerceCall> =>
  previewToken
    ? { cache: { kind: 'no-store' }, previewToken, clientIp: await getClientIp() }
    : { cache: { kind: 'public', revalidate: CATALOG_REVALIDATE_SECONDS } };

// ---------- catalog (public, tagged; preview no-store) ----------
export const getProduct = cache(async (host: string, slug: string, previewToken: string | null): Promise<StorefrontProduct | null> => {
  const r = await request(host, `/storefront/products/${encodeURIComponent(slug)}`, await catalogCache(previewToken), parseStorefrontProduct);
  if (!r.ok && r.status !== 404) console.error(`[storefront] product ${slug}: ${r.status} ${r.code}`);
  return r.ok ? r.data : null;
});

/** Never throws: an API error yields an empty page (the PLP shows its empty state). */
export async function listProducts(host: string, query: URLSearchParams, previewToken: string | null): Promise<ProductPage> {
  const r = await request(host, `/storefront/products?${query.toString()}`, await catalogCache(previewToken), (_d, body) => parseProductPage(body));
  if (r.ok) return r.data;
  console.error(`[storefront] product list: ${r.status} ${r.code}`);
  return { products: [], has_products: false, page: 1, per_page: 0, total: 0, last_page: 1 };
}

export const getCategory = cache(async (host: string, slug: string, previewToken: string | null): Promise<StorefrontCategoryDetail | null> => {
  const r = await request(host, `/storefront/categories/${encodeURIComponent(slug)}`, await catalogCache(previewToken), parseCategoryDetail);
  return r.ok ? r.data : null;
});

export const getCategoryTree = cache(async (host: string): Promise<StorefrontCategory[]> => {
  const r = await request(host, '/storefront/categories', await catalogCache(null), (d) => parseCategoryTree(d));
  return r.ok ? r.data : [];
});

/** Availability is per visitor and never cached (P5-6). */
export async function getAvailability(host: string, slug: string, previewToken: string | null): Promise<StorefrontAvailability | null> {
  const r = await request(host, `/storefront/products/${encodeURIComponent(slug)}/availability`, { cache: { kind: 'no-store' }, previewToken, clientIp: await getClientIp() }, parseAvailability);
  return r.ok ? r.data : null;
}

/** BD geography dataset (public, cached 24 h). */
export const getGeo = cache(async (host: string): Promise<BdGeo | null> => {
  const r = await request(host, '/geo/bd', { cache: { kind: 'public', revalidate: 86400 } }, parseGeo);
  return r.ok ? r.data : null;
});

// ---------- cart (no-store, X-Cart-Token) ----------
export interface CartCall {
  host: string;
  cartToken: string | null;
  previewToken: string | null;
  clientIp: string | null;
}

const cartCall = (c: CartCall, extra: Partial<CommerceCall> = {}): CommerceCall => ({
  cache: { kind: 'no-store' },
  cartToken: c.cartToken,
  previewToken: c.previewToken,
  clientIp: c.clientIp,
  ...extra,
});

const cartParse = (_d: unknown, body: unknown) => parseCartEnvelope(body);

export function fetchCart(c: CartCall): Promise<ApiResult<CartEnvelope>> {
  if (!c.cartToken) return Promise.resolve({ ok: false, status: 404, code: 'cart_not_found', message: '', details: {} });
  return request(c.host, '/storefront/cart', cartCall(c), cartParse);
}

export function addCartItem(c: CartCall, variantId: string, quantity: number) {
  return request(c.host, '/storefront/cart/items', cartCall(c, { method: 'POST', body: { variant_id: variantId, quantity } }), cartParse);
}

export function updateCartItem(c: CartCall, itemId: string, quantity: number) {
  return request(c.host, `/storefront/cart/items/${encodeURIComponent(itemId)}`, cartCall(c, { method: 'PATCH', body: { quantity } }), cartParse);
}

export function removeCartItem(c: CartCall, itemId: string) {
  return request(c.host, `/storefront/cart/items/${encodeURIComponent(itemId)}`, cartCall(c, { method: 'DELETE' }), cartParse);
}

export function putCoupon(c: CartCall, code: string) {
  return request(c.host, '/storefront/cart/coupon', cartCall(c, { method: 'PUT', body: { code } }), cartParse);
}

export function deleteCoupon(c: CartCall) {
  return request(c.host, '/storefront/cart/coupon', cartCall(c, { method: 'DELETE' }), cartParse);
}

export function fetchShippingQuote(c: CartCall, districtCode: string, thanaCode: string): Promise<ApiResult<ShippingQuote>> {
  const q = new URLSearchParams({ district_code: districtCode, thana_code: thanaCode });
  return request(c.host, `/storefront/cart/shipping-options?${q.toString()}`, cartCall(c), parseShippingQuote);
}

export function postCheckout(c: CartCall, idempotencyKey: string, body: unknown) {
  return request(c.host, '/storefront/checkout', cartCall(c, { method: 'POST', body, idempotencyKey }), parseCheckoutResult);
}

// ---------- orders ----------
export function fetchConfirmation(host: string, orderToken: string, previewToken: string | null, clientIp: string | null): Promise<ApiResult<StorefrontOrder>> {
  return request(host, '/storefront/orders/confirmation', { cache: { kind: 'no-store' }, orderToken, previewToken, clientIp }, parseStorefrontOrder);
}

export function postTrack(host: string, number: string, phone: string, previewToken: string | null, clientIp: string | null): Promise<ApiResult<StorefrontTracking>> {
  return request(host, '/storefront/orders/track', { cache: { kind: 'no-store' }, method: 'POST', body: { number, phone }, previewToken, clientIp }, parseTracking);
}

// ---------- online payments (5b-2, PHASE-5B-CONTRACT §4.2; all no-store + shopper IP) ----------
export interface ShopperCall {
  host: string;
  previewToken: string | null;
  clientIp: string | null;
}

const shopperCall = (c: ShopperCall, extra: Partial<CommerceCall> = {}): CommerceCall => ({
  cache: { kind: 'no-store' },
  previewToken: c.previewToken,
  clientIp: c.clientIp,
  ...extra,
});

/** Retry an online payment or switch to COD from the thank-you / payment-result page (P5B-17). */
export function postOrderPay(
  c: ShopperCall,
  orderToken: string,
  idempotencyKey: string,
  paymentMethod: PaymentMethod,
): Promise<ApiResult<{ order: StorefrontOrder; payment: PaymentInitiation | null }>> {
  return request(c.host, '/storefront/orders/pay', shopperCall(c, { method: 'POST', body: { payment_method: paymentMethod }, orderToken, idempotencyKey }), parseOrderPayResult);
}

/** Status of one payment (no PII), for the result pages and `/api/payment-status`. */
export function fetchPaymentResult(c: ShopperCall, paymentId: string): Promise<ApiResult<StorefrontPaymentResult>> {
  return request(c.host, `/storefront/payments/${encodeURIComponent(paymentId)}/result`, shopperCall(c), parsePaymentResult);
}

/** Active payment link view; unknown/expired/paid/cancelled are one identical 404 (P5B-23). */
export function fetchPaymentLink(c: ShopperCall, token: string): Promise<ApiResult<PaymentLinkView>> {
  return request(c.host, `/storefront/payment-links/${encodeURIComponent(token)}`, shopperCall(c), parsePaymentLinkView);
}

export function postPaymentLinkPay(c: ShopperCall, token: string, idempotencyKey: string): Promise<ApiResult<PaymentInitiation>> {
  return request(c.host, `/storefront/payment-links/${encodeURIComponent(token)}/pay`, shopperCall(c, { method: 'POST', idempotencyKey }), parsePaymentInitiation);
}
