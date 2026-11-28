import type { NextRequest } from 'next/server';
import { verifyChat } from '@/lib/inbox';
import { chatToken, clearChatCookies, fail, forwardFailure, inboxCall, ok, routeCtx, sameSiteWrite } from '@/lib/inbox-route';
import { CODE_RE } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

/** `POST /api/chat/verify` `{code}` → `{status: 'verified', unread_count}`; 422 `inbox_code_invalid` (attempts_left) / `inbox_code_expired`. */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const session = chatToken(req);
  if (!session) return fail(404, 'inbox_session_invalid');
  const body: unknown = await req.json().catch(() => null);
  const code = typeof (body as { code?: unknown } | null)?.code === 'string' ? (body as { code: string }).code.trim() : '';
  if (!CODE_RE.test(code)) return fail(422, 'validation_failed', { code: ['Enter the 6-digit code.'] });
  const r = await verifyChat(inboxCall(ctx, { session }), code);
  if (!r.ok) {
    const res = forwardFailure(r);
    if (r.code === 'inbox_session_invalid') clearChatCookies(res);
    return res;
  }
  return 'data' in r ? ok(r.data) : fail(502, 'unavailable');
}
