import { storeTag } from './cache-tags';
import { PREVIEW_HEADER } from './preview-token';
import type { HeaderSource } from './host';

/**
 * Pure request plumbing for the Phase 5a storefront endpoints (PHASE-5-CONTRACT §3.2–3.4, §5).
 * Server-to-server only: the key, cart token and order token are headers on a fetch made by the
 * Next server and never reach the browser.
 */

export const CART_COOKIE = 'sp_cart';
export const ORDER_COOKIE = 'sp_order';
export const FLASH_COOKIE = 'sp_flash';
/** A `/discount/{CODE}` code waiting for the first add-to-cart (there is no empty-cart endpoint). */
export const PENDING_COUPON_COOKIE = 'sp_coupon';
export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const CART_MAX_AGE = 30 * 24 * 3600;
export const ORDER_MAX_AGE = 86400;

/** Catalog pages revalidate every 300 s; product/category saves revalidate the store tag (P5-28). */
export const CATALOG_REVALIDATE_SECONDS = 300;

export interface CommerceEnv {
  apiUrl: string;
  apiKey: string;
}

export type CacheMode =
  /** Shared Next data cache, tag `store:{host}`. Only for requests without per-visitor input. */
  | { kind: 'public'; revalidate: number }
  /** Never cached (cart, checkout, orders, availability, preview). */
  | { kind: 'no-store' };

export interface CommerceCall {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  cache: CacheMode;
  previewToken?: string | null;
  clientIp?: string | null;
  cartToken?: string | null;
  orderToken?: string | null;
  idempotencyKey?: string | null;
}

export type CommerceInit = RequestInit & { next?: { tags?: string[]; revalidate?: number } };

/** Build the fetch for `/api/v1{path}` (path starts with `/storefront/…` or `/geo/…`). */
export function buildCommerceRequest(path: string, host: string, call: CommerceCall, env: CommerceEnv): { url: string; init: CommerceInit } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Host': host,
    'X-Storefront-Key': env.apiKey,
  };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';
  if (call.previewToken) headers[PREVIEW_HEADER] = call.previewToken;
  if (call.clientIp) headers['X-Storefront-Client-Ip'] = call.clientIp;
  if (call.cartToken) headers['X-Cart-Token'] = call.cartToken;
  if (call.orderToken) headers['X-Order-Token'] = call.orderToken;
  if (call.idempotencyKey) headers['Idempotency-Key'] = call.idempotencyKey;

  const init: CommerceInit = { method: call.method ?? 'GET', headers };
  if (call.body !== undefined) init.body = JSON.stringify(call.body);

  // A preview token, a cart/order token or a write always bypasses the shared cache.
  const personal = Boolean(call.previewToken || call.cartToken || call.orderToken || call.idempotencyKey || call.body !== undefined);
  if (call.cache.kind === 'public' && !personal && (call.method ?? 'GET') === 'GET') {
    init.next = { tags: [storeTag(host)], revalidate: call.cache.revalidate };
  } else {
    init.cache = 'no-store';
  }
  return { url: `${env.apiUrl}/api/v1${path}`, init };
}

// ---------- client IP (X-Storefront-Client-Ip) ----------
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

export function isIp(v: string): boolean {
  return IPV4.test(v) || (IPV6.test(v) && v.includes(':'));
}

/**
 * The shopper IP, taken only from our trusted proxy's header (TRUSTED_PROXY=true): left-most
 * X-Forwarded-For, else X-Real-IP. Without a trusted proxy nothing is forwarded (a client could
 * spoof it), and the API throttles on the storefront server's IP instead.
 */
export function clientIpFromHeaders(headers: HeaderSource, trustedProxy: boolean): string | null {
  if (!trustedProxy) return null;
  const xff = headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  if (first && isIp(first)) return first;
  const real = headers.get('x-real-ip')?.trim();
  return real && isIp(real) ? real : null;
}

/** Cookie options for sp_cart / sp_order (host-only, httpOnly, Lax; Secure outside local dev). */
export function commerceCookieOptions(maxAge: number, secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge };
}
