import { NextResponse, type NextRequest } from 'next/server';
import { RECOVERY_CODE_PATTERN } from '@storeplix/types';
import { postRecoverCart } from '@/lib/commerce-api';
import { clientIpFromHeaders, CART_COOKIE, CART_MAX_AGE, commerceCookieOptions } from '@/lib/commerce-request';
import { isTrustedProxy, STOREFRONT_HOST_HEADER } from '@/lib/host';
import { isLocalDevHost } from '@/lib/seo';

// PHASE-8-6 P86-16 / §10.6 cart-restore link `{cart_link}` from a recovery message. Outside `(store)` like `/u`: the API
// clones the run's cart into a new cart with a fresh token (the original token is never revealed or reused), the token
// goes into `sp_cart` with the same attributes as cart creation, and the shopper lands on `/checkout` (or `/cart` when a
// line has an issue) with a 303. Unknown / expired / stopped codes, a draft shop and any API error → 303 `/`.
// A plain GET (opened from an SMS on any device); it carries no shopper input except the 10-char capability code, so
// there is no form post to origin-check. HEAD (link previews) never creates a cart.

export const dynamic = 'force-dynamic';

const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const host = request.headers.get(STOREFRONT_HOST_HEADER);
  const { code } = await params;
  if (!host || !RECOVERY_CODE_PATTERN.test(code)) return to('/');
  try {
    const r = await postRecoverCart(host, code, clientIpFromHeaders(request.headers, isTrustedProxy()));
    if (!r.ok) return to('/');
    const res = to(r.data.next === 'cart' ? '/cart' : '/checkout');
    const secure = process.env.NODE_ENV === 'production' && !isLocalDevHost(host);
    res.cookies.set(CART_COOKIE, r.data.cart_token, commerceCookieOptions(CART_MAX_AGE, secure));
    return res;
  } catch {
    return to('/');
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}

/** 303 See Other to a path on this host (relative, so it never leaves the shop). */
function to(path: '/' | '/cart' | '/checkout'): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: path } });
}
