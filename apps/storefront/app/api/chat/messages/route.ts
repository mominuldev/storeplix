import type { NextRequest } from 'next/server';
import { listChatMessages, sendChatMessage } from '@/lib/inbox';
import { chatToken, checkedFile, clearChatCookies, fail, forwardFailure, inboxCall, listResponse, ok, readForm, routeCtx, sameSiteWrite } from '@/lib/inbox-route';
import { CLIENT_ID_RE, INBOX_ID_RE, SHOPPER_BODY_MAX, cleanBody } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;

/** `GET /api/chat/messages?after=` → shopper-visible rows (customer + shop only), ETag/304 passed through (§12). */
export async function GET(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  const session = chatToken(req);
  if (!session) return fail(404, 'inbox_session_invalid');
  const after = req.nextUrl.searchParams.get('after');
  if (after !== null && !INBOX_ID_RE.test(after)) return fail(422, 'validation_failed');
  const etag = req.headers.get('if-none-match');
  const r = await listChatMessages(inboxCall(ctx, { session }), after, etag && ETAG_RE.test(etag) ? etag : null);
  const res = listResponse(r);
  if (!r.ok && r.code === 'inbox_session_invalid') clearChatCookies(res);
  return res;
}

/** `POST /api/chat/messages` multipart `body`, `file?`, `client_id` → 201 row; 409 `inbox_session_unverified` while the code is pending. */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const session = chatToken(req);
  if (!session) return fail(404, 'inbox_session_invalid');
  const read = await readForm(req);
  if (!read.ok) return read.res;
  const body = cleanBody(String(read.form.get('body') ?? ''));
  const clientId = String(read.form.get('client_id') ?? '');
  const file = await checkedFile(read.form);
  if (!file.ok) return file.res;
  if ((!body && !file.file) || [...body].length > SHOPPER_BODY_MAX) return fail(422, 'validation_failed', { body: ['Write a message.'] });
  if (!CLIENT_ID_RE.test(clientId)) return fail(422, 'validation_failed', { client_id: ['Invalid.'] });
  const out = new FormData();
  out.append('body', body);
  out.append('client_id', clientId);
  if (file.file) out.append('file', file.file, file.file.name);
  const r = await sendChatMessage(inboxCall(ctx, { session }), out);
  if (!r.ok) {
    const res = forwardFailure(r);
    if (r.code === 'inbox_session_invalid') clearChatCookies(res);
    return res;
  }
  return 'data' in r ? ok(r.data, r.status === 200 ? 200 : 201) : fail(502, 'unavailable');
}
