import type { NextRequest } from 'next/server';
import { markChatSeen } from '@/lib/inbox';
import { chatToken, fail, forwardFailure, inboxCall, NO_STORE, routeCtx, sameSiteWrite } from '@/lib/inbox-route';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** `POST /api/chat/seen` → 204 (sets `customer_seen_at`; pending reply SMS become `seen` and are skipped). */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const session = chatToken(req);
  if (!session) return fail(404, 'inbox_session_invalid');
  const r = await markChatSeen(inboxCall(ctx, { session }));
  return r.ok ? new NextResponse(null, { status: 204, headers: NO_STORE }) : forwardFailure(r);
}
