import { NextResponse, type NextRequest } from 'next/server';
import { clientIpFromHeaders } from '@/lib/commerce-request';
import { isTrustedProxy, STOREFRONT_HOST_HEADER } from '@/lib/host';
import { postUnsubscribe } from '@/lib/storefront-api';

// PHASE-8-5 §8.6 / P85-6: RFC 8058 one-click unsubscribe (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`). Mail
// providers POST here; we forward `{action: "unsubscribe", one_click: true}` and answer 200 with an empty body. The
// tenant is the proxy-normalized host header (never the raw Host). Only POST exists (GET → 405, never a state change).

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const host = request.headers.get(STOREFRONT_HOST_HEADER);
  const { code } = await params;
  if (!host) return new NextResponse(null, { status: 400, headers: NO_STORE });
  try {
    const result = await postUnsubscribe(
      host,
      code,
      'unsubscribe',
      clientIpFromHeaders(request.headers, isTrustedProxy()),
      true,
    );
    if (result.status === 'invalid') return new NextResponse(null, { status: 404, headers: NO_STORE });
    if (result.status === 'error')
      return new NextResponse(null, {
        status: result.code === 429 ? 429 : 502,
        headers: NO_STORE,
      });
  } catch {
    return new NextResponse(null, { status: 502, headers: NO_STORE });
  }
  return new NextResponse(null, { status: 200, headers: NO_STORE });
}
