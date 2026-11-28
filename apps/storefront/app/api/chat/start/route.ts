import type { NextRequest } from 'next/server';
import { normalizeBdPhone } from '@/lib/checkout-form';
import { startChat } from '@/lib/inbox';
import { checkedFile, fail, forwardFailure, inboxCall, ok, readForm, routeCtx, sameSiteWrite, setChatCookies } from '@/lib/inbox-route';
import { CLIENT_ID_RE, NAME_MAX, PRODUCT_SLUG_RE, SHOPPER_BODY_MAX, cleanBody, cleanPagePath } from '@/lib/inbox-shared';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/chat/start` (multipart: name, phone, message, file?, product_slug?, page_path?, client_id, website) →
 * `{status: 'code_sent'|'unverified', phone_masked, resend_after}` and the httpOnly `sp_chat` cookie (§9.3). Inputs are
 * checked here first (the API validates again); the honeypot `website` is forwarded untouched for the API to judge.
 */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return fail(400, 'invalid_host');
  if (!sameSiteWrite(req, ctx.host)) return fail(403, 'forbidden');
  const read = await readForm(req);
  if (!read.ok) return read.res;
  const f = read.form;

  const name = cleanBody(String(f.get('name') ?? '')).replace(/\s+/g, ' ');
  const phone = normalizeBdPhone(String(f.get('phone') ?? '').slice(0, 20));
  const message = cleanBody(String(f.get('message') ?? ''));
  const clientId = String(f.get('client_id') ?? '');
  const errors: Record<string, string[]> = {};
  if (!name || [...name].length > NAME_MAX) errors.name = ['Enter your name.'];
  if (!phone) errors.phone = ['Enter a Bangladeshi mobile number.'];
  if (!message || [...message].length > SHOPPER_BODY_MAX) errors.message = ['Write a message.'];
  if (!CLIENT_ID_RE.test(clientId)) errors.client_id = ['Invalid.'];
  if (Object.keys(errors).length) return fail(422, 'validation_failed', errors);
  const file = await checkedFile(f);
  if (!file.ok) return file.res;

  const out = new FormData();
  out.append('name', name);
  out.append('phone', phone!);
  out.append('message', message);
  out.append('client_id', clientId);
  const slug = String(f.get('product_slug') ?? '');
  if (slug && slug.length <= 200 && PRODUCT_SLUG_RE.test(slug)) out.append('product_slug', slug);
  const path = cleanPagePath(f.get('page_path') as string | null);
  if (path) out.append('page_path', path);
  out.append('website', String(f.get('website') ?? '').slice(0, 200));
  if (file.file) out.append('file', file.file, file.file.name);

  const r = await startChat(inboxCall(ctx, {}), out);
  if (!r.ok) return forwardFailure(r);
  if (!('data' in r)) return fail(502, 'unavailable');
  const { session_token, ...view } = r.data;
  const res = ok(view, 201);
  setChatCookies(res, session_token, ctx.secure);
  return res;
}
