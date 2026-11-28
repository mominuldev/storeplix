import { NextResponse, type NextRequest } from 'next/server';
import { redeemMagicLink } from '@/lib/inbox';
import { NO_STORE, routeCtx, setChatCookies } from '@/lib/inbox-route';
import { MAGIC_CODE_RE, ORDER_ACCESS_COOKIE, ORDER_ACCESS_MAX_AGE, orderAccessCookieValue } from '@/lib/inbox-shared';

// PHASE-8-8E §9.3 / P88E-12 magic link from the reply SMS (`/m/{code}`, 7 days). Outside `(store)` like `/r`: the code
// is POSTed to the API, which answers a chat session (→ `sp_chat`, redirect `/?chat=open`) or an order access token
// (→ `sp_order_access`, redirect `/track?view=messages`). Invalid / expired codes, a closed channel, a draft shop or
// any error → `/` with no cookie. HEAD (SMS link previews) never redeems.

export const dynamic = 'force-dynamic';

const HEADERS = { ...NO_STORE, 'Referrer-Policy': 'no-referrer' };

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const ctx = routeCtx(req);
  const { code } = await params;
  if (!ctx || !MAGIC_CODE_RE.test(code)) return to('/');
  try {
    const r = await redeemMagicLink({ host: ctx.host, clientIp: ctx.clientIp }, code);
    if (!r.ok || !('data' in r)) return to('/');
    if (r.data.kind === 'chat') {
      const res = to('/?chat=open');
      setChatCookies(res, r.data.session_token, ctx.secure);
      return res;
    }
    const value = orderAccessCookieValue(r.data.number, r.data.access_token);
    if (!value) return to('/');
    const res = to('/track?view=messages');
    res.cookies.set(ORDER_ACCESS_COOKIE, value, { httpOnly: true, secure: ctx.secure, sameSite: 'lax', path: '/', maxAge: ORDER_ACCESS_MAX_AGE.link });
    return res;
  } catch {
    return to('/');
  }
}

export function HEAD(): NextResponse {
  return new NextResponse(null, { status: 204, headers: HEADERS });
}

/** 303 to a path on this host (relative, so it never leaves the shop). */
function to(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: path } });
}
