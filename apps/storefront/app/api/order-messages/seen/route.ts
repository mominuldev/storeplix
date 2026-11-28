import { NextResponse, type NextRequest } from 'next/server';
import { markOrderSeen } from '@/lib/inbox';
import { orderTarget, withOrderAccess } from '@/lib/inbox-order-route';
import { fail, forwardFailure, NO_STORE, routeCtx, sameSiteWrite } from '@/lib/inbox-route';

export const dynamic = 'force-dynamic';

/** `POST /api/order-messages/seen?number=&via=` → 204. */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const target = orderTarget(req);
  if (!target) return fail(404, 'order_access_invalid');
  return withOrderAccess(req, ctx, target, markOrderSeen, (r) => (r.ok ? new NextResponse(null, { status: 204, headers: NO_STORE }) : forwardFailure(r)));
}
