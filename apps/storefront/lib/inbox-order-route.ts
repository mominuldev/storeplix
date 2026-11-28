import 'server-only';
import type { NextRequest, NextResponse } from 'next/server';
import { ORDER_COOKIE } from './commerce-request';
import { getConfirmationWithMessages, type InboxCall, type InboxResult } from './inbox';
import { fail, inboxCall, type RouteCtx } from './inbox-route';
import { ORDER_ACCESS_COOKIE, ORDER_ACCESS_MAX_AGE, ORDER_NUMBER_RE, orderAccessCookieValue, parseOrderAccessCookie } from './inbox-shared';

/**
 * Order Messages access for `/api/order-messages/**` (PHASE-8-8E §10). The browser names the order (`number`) and the
 * page it is on (`via`); the token comes only from the httpOnly `sp_order_access` cookie (`{number}~{token}`, set by the
 * track action or the magic link) or — on the thank-you page — is minted from the `sp_order` confirmation token and
 * stored in that cookie. A cookie for another order is never used.
 */

export type OrderVia = 'track' | 'confirmation';

export interface OrderTarget {
  number: string;
  via: OrderVia;
}

export function orderTarget(req: NextRequest): OrderTarget | null {
  const number = (req.nextUrl.searchParams.get('number') ?? '').toUpperCase();
  const via = req.nextUrl.searchParams.get('via') === 'confirmation' ? 'confirmation' : 'track';
  return ORDER_NUMBER_RE.test(number) ? { number, via } : null;
}

interface Resolved {
  token: string;
  /** a freshly minted cookie value to set on the response */
  mint: string | null;
}

async function mintFromConfirmation(req: NextRequest, ctx: RouteCtx, number: string): Promise<Resolved | null> {
  const orderToken = req.cookies.get(ORDER_COOKIE)?.value;
  if (!orderToken || !/^[A-Za-z0-9_-]{16,128}$/.test(orderToken)) return null;
  const r = await getConfirmationWithMessages(inboxCall(ctx, {}), orderToken);
  if (!r.ok || !('data' in r) || r.data.order.number.toUpperCase() !== number || !r.data.messages) return null;
  const v = orderAccessCookieValue(number, r.data.messages.access_token);
  return v ? { token: r.data.messages.access_token, mint: v } : null;
}

function setAccess(res: NextResponse, value: string, secure: boolean) {
  res.cookies.set(ORDER_ACCESS_COOKIE, value, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ORDER_ACCESS_MAX_AGE.confirmation });
}

/**
 * Run `fn` with the order access token. On the thank-you page an expired/absent token is re-minted once from the
 * confirmation. No usable access → 404 `order_access_invalid`.
 */
export async function withOrderAccess<T>(
  req: NextRequest,
  ctx: RouteCtx,
  target: OrderTarget,
  fn: (c: InboxCall) => Promise<InboxResult<T>>,
  respond: (r: InboxResult<T>) => NextResponse,
): Promise<NextResponse> {
  const held = parseOrderAccessCookie(req.cookies.get(ORDER_ACCESS_COOKIE)?.value);
  let resolved: Resolved | null = held && held.number === target.number ? { token: held.token, mint: null } : null;
  if (!resolved && target.via === 'confirmation') resolved = await mintFromConfirmation(req, ctx, target.number);
  if (!resolved) return fail(404, 'order_access_invalid');

  let r = await fn(inboxCall(ctx, { orderAccess: resolved.token }));
  if (!r.ok && r.code === 'order_access_invalid' && resolved.mint === null && target.via === 'confirmation') {
    const again = await mintFromConfirmation(req, ctx, target.number);
    if (again) {
      resolved = again;
      r = await fn(inboxCall(ctx, { orderAccess: again.token }));
    }
  }
  const res = respond(r);
  if (resolved.mint) setAccess(res, resolved.mint, ctx.secure);
  return res;
}
