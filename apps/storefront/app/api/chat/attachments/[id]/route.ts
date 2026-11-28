import { NextResponse, type NextRequest } from 'next/server';
import { fetchShopperAttachment } from '@/lib/inbox';
import { attachmentResponse, chatToken, inboxCall, NO_STORE, routeCtx } from '@/lib/inbox-route';
import { INBOX_ID_RE } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

/** `GET /api/chat/attachments/{id}`: streams an attachment of the shopper's own conversation (§9.2, P88E-7). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = routeCtx(req);
  const { id } = await params;
  const session = chatToken(req);
  if (!ctx || !session || !INBOX_ID_RE.test(id)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  return attachmentResponse(await fetchShopperAttachment(inboxCall(ctx, { session }), id));
}
