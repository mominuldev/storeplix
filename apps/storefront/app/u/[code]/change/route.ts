import { NextResponse, type NextRequest } from 'next/server';
import { clientIpFromHeaders } from '@/lib/commerce-request';
import { isTrustedProxy, STOREFRONT_HOST_HEADER } from '@/lib/host';
import { postUnsubscribe } from '@/lib/storefront-api';
import { sameOrigin } from '../origin';

// PHASE-8-5 §8.6 "Unsubscribe" / "Subscribe again" buttons: a plain HTML form POST (works without JS), answered with a
// 303 back to `/u/{code}` so the browser does a fresh GET and the page re-reads the status. (A Server Action redirect
// re-rendered the page inside the action response and showed the store 404 — P85-QA-2.) The tenant is the
// proxy-normalized host header; a cross-site form post is refused (Origin must be this host when the browser sends it).

export const dynamic = 'force-dynamic';

const CODE = /^[A-Za-z0-9]{10}$/;
const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const host = request.headers.get(STOREFRONT_HOST_HEADER);
  const { code } = await params;
  if (!host || !CODE.test(code)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!sameOrigin(request.headers.get('origin'), host, request.headers.get('sec-fetch-site')))
    return new NextResponse(null, { status: 403, headers: NO_STORE });

  const form = await request.formData().catch(() => null);
  const action = form?.get('action');
  if (action !== 'unsubscribe' && action !== 'resubscribe') return back(code, true);
  try {
    const result = await postUnsubscribe(host, code, action, clientIpFromHeaders(request.headers, isTrustedProxy()));
    return back(code, result.status === 'error');
  } catch {
    return back(code, true);
  }
}

/** 303 See Other → GET `/u/{code}` (relative, so it stays on this host); `?e=1` shows "That didn't go through". */
function back(code: string, failed: boolean): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { ...NO_STORE, Location: `/u/${code}${failed ? '?e=1' : ''}` },
  });
}
