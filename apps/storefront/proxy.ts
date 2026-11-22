import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_HOST_HEADER, isTrustedProxy, resolveRequestHost } from './lib/host';
import {
  EMBED_COOKIE,
  EMBED_PARAM,
  PREVIEW_COOKIE,
  PREVIEW_MAX_AGE,
  PREVIEW_PARAM,
  sanitizePreviewToken,
} from './lib/preview-token';
import { parseEditorOrigins } from './lib/editor-origins';
import { isLocalDevHost } from './lib/seo';
import { STOREFRONT_PATH_HEADER, redirectablePath } from './lib/primary-host';

/**
 * Tenant resolution edge: normalize the request host, reject malformed hosts with 400, and hand
 * the normalized host to server components via a request header. Any client-supplied value of
 * that header is overwritten here, and X-Forwarded-Host is ignored unless TRUSTED_PROXY is set.
 *
 * Merchant preview (contract D2 + Phase 3 §5.3): `?preview=<token>` becomes an httpOnly
 * `sp_preview` cookie and the visitor is redirected to the same URL without the param, so the token
 * doesn't linger in the address bar, history or Referer headers. `&embed=1` (dashboard editor
 * iframe) sets the cookie `SameSite=None; Secure; Partitioned` plus `sp_embed=1`.
 *
 * Primary-domain redirects (PHASE-6-CONTRACT §7): the path + query of a GET/HEAD page request goes
 * to server components in STOREFRONT_PATH_HEADER so they can rebuild the URL on the primary host.
 * The header is always overwritten or deleted here; POSTs (Server Actions) and `/api/*` never get it.
 *
 * Framing: only responses to a request carrying `sp_preview` may be framed, and only by the exact
 * STOREFRONT_EDITOR_ORIGINS; everything else sends `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 */
export function proxy(request: NextRequest) {
  const host = resolveRequestHost(request.headers, { trustedProxy: isTrustedProxy() });
  if (!host) {
    return new NextResponse('Bad Request: invalid host', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (request.nextUrl.searchParams.has(PREVIEW_PARAM) && (request.method === 'GET' || request.method === 'HEAD')) {
    return previewRedirect(request, host);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(STOREFRONT_HOST_HEADER, host);
  const path = redirectablePath(request.method, request.nextUrl.pathname, request.nextUrl.search);
  if (path !== null) requestHeaders.set(STOREFRONT_PATH_HEADER, path);
  else requestHeaders.delete(STOREFRONT_PATH_HEADER);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  setFramingHeaders(res, sanitizePreviewToken(request.cookies.get(PREVIEW_COOKIE)?.value) !== null);
  if (isPrivateCommercePath(request.nextUrl.pathname)) res.headers.set('Cache-Control', 'private, no-store');
  // Payment-link pages carry the link token in the path: never send it as a Referer (gateway, CDN).
  if (/^\/pay(?:\/|$)/.test(request.nextUrl.pathname)) res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

/**
 * Cart, checkout (incl. payment-result), thank-you, tracking, discount links (PHASE-5-CONTRACT §5)
 * and payment-link pages (PHASE-5B-CONTRACT §11) are per shopper.
 */
export function isPrivateCommercePath(pathname: string): boolean {
  return /^\/(?:cart|checkout|track|discount|pay)(?:\/|$)/.test(pathname);
}

/** `frame-ancestors` for this response (exported for tests). */
export function framingPolicy(previewCookie: boolean, origins: string[] = parseEditorOrigins()): string {
  if (!previewCookie || origins.length === 0) return "frame-ancestors 'none'";
  return `frame-ancestors 'self' ${origins.join(' ')}`;
}

function setFramingHeaders(res: NextResponse, previewCookie: boolean) {
  const policy = framingPolicy(previewCookie);
  res.headers.set('Content-Security-Policy', policy);
  if (policy === "frame-ancestors 'none'") res.headers.set('X-Frame-Options', 'DENY');
  else res.headers.delete('X-Frame-Options');
}

function previewRedirect(request: NextRequest, host: string) {
  const token = sanitizePreviewToken(request.nextUrl.searchParams.get(PREVIEW_PARAM));
  const embed = request.nextUrl.searchParams.get(EMBED_PARAM) === '1';
  // Same URL (Next builds nextUrl from the request's Host) minus the token and embed params.
  const target = request.nextUrl.clone();
  target.searchParams.delete(PREVIEW_PARAM);
  target.searchParams.delete(EMBED_PARAM);

  const res = NextResponse.redirect(target, 307);
  res.headers.set('Cache-Control', 'private, no-store');
  // Embedded: keep the editor's *origin* as the document referrer so the PreviewBridge can address
  // it (the token URL itself is never a referrer). Otherwise send no referrer at all.
  res.headers.set('Referrer-Policy', token && embed ? 'strict-origin' : 'no-referrer');

  if (token && embed) {
    // Cross-site iframe: SameSite=None requires Secure; browsers accept Secure on http://*.localhost.
    const opts = { httpOnly: true, secure: true, sameSite: 'none' as const, partitioned: true, path: '/', maxAge: PREVIEW_MAX_AGE };
    res.cookies.set(PREVIEW_COOKIE, token, opts);
    res.cookies.set(EMBED_COOKIE, '1', opts);
    setFramingHeaders(res, true);
  } else if (token) {
    res.cookies.set(PREVIEW_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && !isLocalDevHost(host),
      sameSite: 'lax',
      path: '/',
      maxAge: PREVIEW_MAX_AGE,
    });
    if (request.cookies.has(EMBED_COOKIE)) res.cookies.delete(EMBED_COOKIE);
    setFramingHeaders(res, false);
  } else {
    // `?preview=` with an empty/garbage value ends the preview session.
    if (request.cookies.has(PREVIEW_COOKIE)) res.cookies.delete(PREVIEW_COOKIE);
    if (request.cookies.has(EMBED_COOKIE)) res.cookies.delete(EMBED_COOKIE);
    setFramingHeaders(res, false);
  }
  return res;
}

export const config = {
  // Everything except build assets and our own static theme files. robots.txt, sitemap.xml and
  // /api/* must stay covered so they are always tenant-scoped.
  matcher: ['/((?!_next/static|_next/image|themes/).*)'],
};
