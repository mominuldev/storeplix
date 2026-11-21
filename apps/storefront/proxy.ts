import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_HOST_HEADER, isTrustedProxy, resolveRequestHost } from './lib/host';
import { PREVIEW_COOKIE, PREVIEW_MAX_AGE, PREVIEW_PARAM, sanitizePreviewToken } from './lib/preview-token';
import { isLocalDevHost } from './lib/seo';

/**
 * Tenant resolution edge: normalize the request host, reject malformed hosts with 400, and hand
 * the normalized host to server components via a request header. Any client-supplied value of
 * that header is overwritten here, and X-Forwarded-Host is ignored unless TRUSTED_PROXY is set.
 *
 * Merchant preview (contract D2): `?preview=<token>` becomes an httpOnly `sp_preview` cookie and
 * the visitor is redirected to the same URL without the param, so the token doesn't linger in the
 * address bar, history or Referer headers.
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
  return NextResponse.next({ request: { headers: requestHeaders } });
}

function previewRedirect(request: NextRequest, host: string) {
  const token = sanitizePreviewToken(request.nextUrl.searchParams.get(PREVIEW_PARAM));
  // Same URL (Next builds nextUrl from the request's Host) minus the token param.
  const target = request.nextUrl.clone();
  target.searchParams.delete(PREVIEW_PARAM);

  const res = NextResponse.redirect(target, 307);
  res.headers.set('Cache-Control', 'private, no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');

  if (token) {
    res.cookies.set(PREVIEW_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && !isLocalDevHost(host),
      sameSite: 'lax',
      path: '/',
      maxAge: PREVIEW_MAX_AGE,
    });
  } else if (request.cookies.has(PREVIEW_COOKIE)) {
    // `?preview=` with an empty/garbage value ends the preview session.
    res.cookies.delete(PREVIEW_COOKIE);
  }
  return res;
}

export const config = {
  // Everything except build assets and our own static theme files. robots.txt, sitemap.xml and
  // /api/* must stay covered so they are always tenant-scoped.
  matcher: ['/((?!_next/static|_next/image|themes/).*)'],
};
