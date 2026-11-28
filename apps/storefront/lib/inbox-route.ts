import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { clientIpFromHeaders } from './commerce-request';
import { isTrustedProxy, normalizeHost, STOREFRONT_HOST_HEADER } from './host';
import { isLocalDevHost } from './seo';
import type { InboxCall, InboxFailure, InboxResult } from './inbox';
import { ATTACHMENT_MAX_BYTES, CHAT_COOKIE, CHAT_HINT_COOKIE, CHAT_MAX_AGE, sniffMime } from './inbox-shared';

/**
 * Plumbing shared by the `/api/chat/**` and `/api/order-messages/**` route handlers (PHASE-8-8E §9.3, §10).
 * Responses are `private, no-store`, JSON envelopes like the API, and never contain a session or access token.
 */

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
/** Multipart overhead allowance on top of the 5 MB file + 2000-char body. */
const MAX_FORM_BYTES = ATTACHMENT_MAX_BYTES + 64 * 1024;
const TOKEN_RE = /^[A-Za-z0-9._-]{16,512}$/;

export interface RouteCtx {
  host: string;
  clientIp: string | null;
  secure: boolean;
}

/** Tenant from the proxy-normalized host header only (never the raw Host). */
export function routeCtx(req: NextRequest): RouteCtx | null {
  const host = normalizeHost(req.headers.get(STOREFRONT_HOST_HEADER));
  if (!host) return null;
  return { host, clientIp: clientIpFromHeaders(req.headers, isTrustedProxy()), secure: process.env.NODE_ENV === 'production' && !isLocalDevHost(host) };
}

/**
 * Writes come from our own page: a cross-site `Sec-Fetch-Site` or a foreign `Origin` is refused (SameSite=Lax already
 * keeps the cookies off cross-site POSTs; this also stops blind posts that would start sessions or send SMS codes).
 */
export function sameSiteWrite(req: NextRequest, host: string): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return normalizeHost(new URL(origin).host) === host;
  } catch {
    return false;
  }
}

export function ok<T>(data: T, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ data }, { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(status: number, code: string, details?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: { code, message: '', ...(details ? { details } : {}) } }, { status, headers: NO_STORE });
}

/** Forward an API failure: status family + stable code + the only details a shopper needs. */
export function forwardFailure(r: InboxFailure): NextResponse {
  const status = r.status === 0 || r.status >= 500 ? 502 : r.status;
  const details: Record<string, unknown> = {};
  const left = r.details.attempts_left?.[0];
  if (left !== undefined && /^\d{1,2}$/.test(left)) details.attempts_left = Number(left);
  if (r.retryAfter !== null) details.retry_after = r.retryAfter;
  if (r.code === 'validation_failed') {
    for (const k of ['name', 'phone', 'message', 'body', 'file', 'code']) {
      const m = r.details[k]?.[0];
      if (m) details[k] = [m];
    }
  }
  const code = status === 502 ? (r.code === 'network_error' ? 'network_error' : 'unavailable') : r.code;
  return fail(status, code, Object.keys(details).length ? details : undefined);
}

export function notModified(etag: string | null): NextResponse {
  return new NextResponse(null, { status: 304, headers: { ...NO_STORE, ...(etag ? { ETag: etag } : {}) } });
}

/** 200 rows (+ ETag) / 304 / failure. */
export function listResponse<T>(r: InboxResult<T>): NextResponse {
  if (!r.ok) return forwardFailure(r);
  if ('notModified' in r) return notModified(r.etag);
  return ok(r.data, 200, r.etag ? { ETag: r.etag } : {});
}

// ---------- chat cookies ----------
export function chatToken(req: NextRequest): string | null {
  const v = req.cookies.get(CHAT_COOKIE)?.value;
  return v && TOKEN_RE.test(v) ? v : null;
}

export function setChatCookies(res: NextResponse, token: string, secure: boolean): void {
  res.cookies.set(CHAT_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: CHAT_MAX_AGE });
  res.cookies.set(CHAT_HINT_COOKIE, '1', { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: CHAT_MAX_AGE });
}

export function clearChatCookies(res: NextResponse): void {
  res.cookies.set(CHAT_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(CHAT_HINT_COOKIE, '', { path: '/', maxAge: 0 });
}

export function inboxCall(ctx: RouteCtx, auth: InboxCall['auth']): InboxCall {
  return { host: ctx.host, clientIp: ctx.clientIp, auth };
}

// ---------- multipart ----------
export type FormRead = { ok: true; form: FormData } | { ok: false; res: NextResponse };

/** Read a multipart body with a size cap (413) and a parse guard (422). */
export async function readForm(req: NextRequest): Promise<FormRead> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_FORM_BYTES) return { ok: false, res: fail(413, 'validation_failed', { file: ['That file is over 5 MB.'] }) };
  try {
    return { ok: true, form: await req.formData() };
  } catch {
    return { ok: false, res: fail(422, 'validation_failed') };
  }
}

/**
 * The optional `file` field re-checked server-side before it is forwarded (the API sniffs again): JPG/PNG/PDF by
 * content, ≤ 5 MB. Returns the File to forward, null when absent, or a 422.
 */
export async function checkedFile(form: FormData): Promise<{ ok: true; file: File | null } | { ok: false; res: NextResponse }> {
  const f = form.get('file');
  if (f === null || f === '') return { ok: true, file: null };
  if (!(f instanceof File) || f.size === 0) return { ok: false, res: fail(422, 'validation_failed', { file: ['Choose a JPG, PNG or PDF file.'] }) };
  if (f.size > ATTACHMENT_MAX_BYTES) return { ok: false, res: fail(422, 'validation_failed', { file: ['That file is over 5 MB.'] }) };
  const mime = sniffMime(new Uint8Array(await f.slice(0, 16).arrayBuffer()));
  if (!mime) return { ok: false, res: fail(422, 'validation_failed', { file: ['Only JPG, PNG or PDF files.'] }) };
  const name = (f.name || 'attachment').replace(/[^\w.() -]/g, '_').slice(0, 120) || 'attachment';
  return { ok: true, file: new File([f], name, { type: mime }) };
}

/** Stream an attachment from the API with our own security headers (P88E-7): nosniff, sandbox CSP, PDF as download. */
export function attachmentResponse(res: Response | null): NextResponse {
  if (!res) return new NextResponse(null, { status: 502, headers: NO_STORE });
  if (!res.ok || !res.body) return new NextResponse(null, { status: res.status === 404 || res.status === 409 ? res.status : 502, headers: NO_STORE });
  const type = (res.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(type)) return new NextResponse(null, { status: 502, headers: NO_STORE });
  const headers: Record<string, string> = {
    ...NO_STORE,
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Referrer-Policy': 'no-referrer',
  };
  const len = res.headers.get('Content-Length');
  if (len && /^\d{1,8}$/.test(len)) headers['Content-Length'] = len;
  const disposition = res.headers.get('Content-Disposition');
  const name = /filename="?([^";]{1,160})"?/i.exec(disposition ?? '')?.[1]?.replace(/[^\w.() -]/g, '_') ?? 'attachment';
  headers['Content-Disposition'] = `${type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${name}"`;
  return new NextResponse(res.body, { status: 200, headers });
}
