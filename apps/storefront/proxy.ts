import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_HOST_HEADER, isTrustedProxy, resolveRequestHost } from './lib/host';

/**
 * Tenant resolution edge: normalize the request host, reject malformed hosts with 400, and hand
 * the normalized host to server components via a request header. Any client-supplied value of
 * that header is overwritten here, and X-Forwarded-Host is ignored unless TRUSTED_PROXY is set.
 */
export function proxy(request: NextRequest) {
  const host = resolveRequestHost(request.headers, { trustedProxy: isTrustedProxy() });
  if (!host) {
    return new NextResponse('Bad Request: invalid host', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(STOREFRONT_HOST_HEADER, host);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Everything except build assets and our own static theme files. robots.txt, sitemap.xml and
  // /api/* must stay covered so they are always tenant-scoped.
  matcher: ['/((?!_next/static|_next/image|themes/).*)'],
};
