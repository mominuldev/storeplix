import 'server-only';
import { cookies } from 'next/headers';
import type { CurrentStore } from './store';
import { getPreviewToken } from './preview';
import { getClientIp, type CartCall } from './commerce-api';
import { CART_COOKIE, CART_MAX_AGE, ORDER_COOKIE, ORDER_MAX_AGE, commerceCookieOptions } from './commerce-request';
import { CART_TOKEN_RE } from './commerce-schemas';
import { isLocalDevHost } from './seo';

/**
 * Per-request commerce context: the current store, the shopper's cart token (httpOnly `sp_cart`,
 * read server-side only) and the headers the API needs. Draft stores without a preview get null:
 * commerce routes render Coming soon there.
 */
export interface CommerceContext {
  store: CurrentStore;
  call: CartCall;
}

export async function getCommerceContext(): Promise<CommerceContext | null> {
  // Lazy: lib/store → theme registry → product cards → cart actions → here would be an import cycle.
  const { findCurrentStore } = await import('./store');
  const store = await findCurrentStore();
  if (!store || store.mode === 'coming_soon') return null;
  const jar = await cookies();
  const raw = jar.get(CART_COOKIE)?.value;
  return {
    store,
    call: {
      host: store.host,
      cartToken: raw && CART_TOKEN_RE.test(raw) ? raw : null,
      previewToken: store.mode === 'preview' ? await getPreviewToken() : null,
      clientIp: await getClientIp(),
    },
  };
}

const secureCookie = (host: string) => process.env.NODE_ENV === 'production' && !isLocalDevHost(host);

/** Only callable from Server Actions / route handlers (Next forbids cookie writes during render). */
export async function setCartCookie(host: string, token: string) {
  (await cookies()).set(CART_COOKIE, token, commerceCookieOptions(CART_MAX_AGE, secureCookie(host)));
}

export async function clearCartCookie() {
  const jar = await cookies();
  if (jar.has(CART_COOKIE)) jar.delete(CART_COOKIE);
}

export async function setOrderCookie(host: string, token: string) {
  (await cookies()).set(ORDER_COOKIE, token, commerceCookieOptions(ORDER_MAX_AGE, secureCookie(host)));
}

export async function getOrderToken(): Promise<string | null> {
  const v = (await cookies()).get(ORDER_COOKIE)?.value;
  return v && /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : null;
}
