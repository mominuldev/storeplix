import type { NextRequest } from 'next/server';
import { getChatSession } from '@/lib/inbox';
import { chatToken, clearChatCookies, fail, forwardFailure, inboxCall, ok, routeCtx, sameSiteWrite } from '@/lib/inbox-route';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/chat/session` (PHASE-8-8E §9.2): the widget's session state `{status, name, phone_masked, unread_count,
 * resend_after}` from the httpOnly `sp_chat` cookie. No cookie → 404 `inbox_session_invalid`; an unknown/expired
 * session clears both cookies. The token never appears in the response.
 */
export async function GET(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  const session = chatToken(req);
  if (!session) {
    const res = fail(404, 'inbox_session_invalid');
    if (req.cookies.has('sp_chat_on')) clearChatCookies(res);
    return res;
  }
  const r = await getChatSession(inboxCall(ctx, { session }));
  if (r.ok && 'data' in r) return ok(r.data);
  if (!r.ok) {
    const res = forwardFailure(r);
    if (r.code === 'inbox_session_invalid' || r.code === 'inbox_unavailable') clearChatCookies(res);
    return res;
  }
  return fail(502, 'unavailable');
}

/** `DELETE /api/chat/session`: "Change number" / start over on this device (forgets the cookie only). */
export async function DELETE(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const res = ok({ cleared: true });
  clearChatCookies(res);
  return res;
}
