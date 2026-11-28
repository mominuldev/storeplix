import { NextResponse, type NextRequest } from 'next/server';
import { fetchShopperAttachment } from '@/lib/inbox';
import { attachmentResponse, inboxCall, NO_STORE, routeCtx } from '@/lib/inbox-route';
import { ORDER_ACCESS_COOKIE, INBOX_ID_RE, parseOrderAccessCookie } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

/** `GET /api/order-messages/attachments/{id}?number=`: streams an attachment of this order's conversation (held access only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = routeCtx(req);
  const { id } = await params;
  const number = (req.nextUrl.searchParams.get('number') ?? '').toUpperCase();
  const held = parseOrderAccessCookie(req.cookies.get(ORDER_ACCESS_COOKIE)?.value);
  if (!ctx || !held || held.number !== number || !INBOX_ID_RE.test(id)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  return attachmentResponse(await fetchShopperAttachment(inboxCall(ctx, { orderAccess: held.token }), id));
}
