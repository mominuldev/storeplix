import type { NextRequest } from 'next/server';
import { listOrderMessages, sendOrderMessage } from '@/lib/inbox';
import { orderTarget, withOrderAccess } from '@/lib/inbox-order-route';
import { checkedFile, fail, forwardFailure, listResponse, ok, readForm, routeCtx, sameSiteWrite } from '@/lib/inbox-route';
import { CLIENT_ID_RE, INBOX_ID_RE, SHOPPER_BODY_MAX, cleanBody } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;

/** `GET /api/order-messages?number=&via=&after=` → the order's shopper-visible rows; ETag/304 (§10, §12). */
export async function GET(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  const target = orderTarget(req);
  if (!target) return fail(404, 'order_access_invalid');
  const after = req.nextUrl.searchParams.get('after');
  if (after !== null && !INBOX_ID_RE.test(after)) return fail(422, 'validation_failed');
  const etag = req.headers.get('if-none-match');
  return withOrderAccess(req, ctx, target, (c) => listOrderMessages(c, after, etag && ETAG_RE.test(etag) ? etag : null), listResponse);
}

/** `POST /api/order-messages?number=&via=` multipart `body`, `file?`, `client_id` → 201 row. The first one creates the order conversation. */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const target = orderTarget(req);
  if (!target) return fail(404, 'order_access_invalid');
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
  return withOrderAccess(req, ctx, target, (c) => sendOrderMessage(c, out), (r) => {
    if (!r.ok) return forwardFailure(r);
    return 'data' in r ? ok(r.data, r.status === 200 ? 200 : 201) : fail(502, 'unavailable');
  });
}
