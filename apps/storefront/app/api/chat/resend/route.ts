import type { NextRequest } from 'next/server';
import { resendChatCode } from '@/lib/inbox';
import { chatToken, clearChatCookies, fail, forwardFailure, inboxCall, ok, routeCtx, sameSiteWrite } from '@/lib/inbox-route';

export const dynamic = 'force-dynamic';

/** `POST /api/chat/resend` → the session view (or `{resent: true}`); inside the 60 s cooldown 429 with `retry_after`. */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const session = chatToken(req);
  if (!session) return fail(404, 'inbox_session_invalid');
  const r = await resendChatCode(inboxCall(ctx, { session }));
  if (!r.ok) {
    const res = forwardFailure(r);
    if (r.code === 'inbox_session_invalid') clearChatCookies(res);
    return res;
  }
  if (!('data' in r)) return fail(502, 'unavailable');
  return ok(r.data === true ? { resent: true } : r.data);
}
