import 'server-only';
import type {
  InboxMagicLinkResult,
  InboxWidgetSession,
  InboxWidgetStart,
  InboxWidgetVerifyResult,
  StorefrontOrder,
  StorefrontOrderMessagesAccess,
} from '@storeplix/types';
import { serverEnv } from './env';
import { parseApiError, parseStorefrontOrder, parseTracking } from './commerce-schemas';
import {
  parseMagicLinkResult,
  parseOrderMessagesAccess,
  parseShopperMessage,
  parseShopperMessages,
  parseVerifyResult,
  parseWidgetSession,
  parseWidgetStart,
} from './inbox-schemas';
import type { ThreadMessage } from './inbox-shared';
import type { StorefrontTracking } from './tracking';

/**
 * PHASE-8-8E §9.2 / §10 server-to-server calls for the shopper Inbox. Every call carries X-Storefront-Key +
 * X-Storefront-Host (+ X-Storefront-Client-Ip from our trusted proxy). The chat session (`X-Inbox-Session`) and the
 * order access token (`X-Order-Access`) come from httpOnly cookies read by the route handlers and are never returned
 * to the browser. Nothing here logs headers or bodies.
 */

export interface ShopperAuth {
  /** `sp_chat` session token */
  session?: string | null;
  /** order access token from `sp_order_access` */
  orderAccess?: string | null;
}

export interface InboxCall {
  host: string;
  clientIp: string | null;
  auth?: ShopperAuth;
}

export type InboxResult<T> =
  | { ok: true; status: number; data: T; etag: string | null }
  | { ok: true; status: 304; notModified: true; etag: string | null }
  | { ok: false; status: number; code: string; message: string; details: Record<string, string[]>; retryAfter: number | null };

export type InboxFailure = Extract<InboxResult<never>, { ok: false }>;

const failure = (status: number, code: string): InboxFailure => ({ ok: false, status, code, message: '', details: {}, retryAfter: null });

interface RawOpts {
  method?: 'GET' | 'POST';
  body?: FormData | Record<string, unknown>;
  etag?: string | null;
  orderToken?: string | null;
}

/** Headers for one call (exported for tests). */
export function inboxHeaders(call: InboxCall, apiKey: string, opts: RawOpts = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Host': call.host,
    'X-Storefront-Key': apiKey,
  };
  if (call.clientIp) h['X-Storefront-Client-Ip'] = call.clientIp;
  if (call.auth?.session) h['X-Inbox-Session'] = call.auth.session;
  if (call.auth?.orderAccess) h['X-Order-Access'] = call.auth.orderAccess;
  if (opts.orderToken) h['X-Order-Token'] = opts.orderToken;
  if (opts.etag) h['If-None-Match'] = opts.etag;
  if (opts.body && !(opts.body instanceof FormData)) h['Content-Type'] = 'application/json';
  return h;
}

async function rawFetch(call: InboxCall, path: string, opts: RawOpts = {}): Promise<Response | null> {
  const apiKey = serverEnv.apiKey;
  if (!apiKey) {
    console.error('[storefront] STOREFRONT_API_KEY is not configured');
    return null;
  }
  const init: RequestInit = { method: opts.method ?? 'GET', headers: inboxHeaders(call, apiKey, opts), cache: 'no-store', redirect: 'manual' };
  if (opts.body) init.body = opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body);
  try {
    return await fetch(`${serverEnv.apiUrl}/api/v1${path}`, init);
  } catch (err) {
    console.error(`[storefront] inbox ${opts.method ?? 'GET'} ${path.split('?')[0]} failed: ${(err as Error).message}`);
    return null;
  }
}

function retryAfterOf(res: Response, body: unknown): number | null {
  const header = Number(res.headers.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) return Math.min(3600, Math.ceil(header));
  const err = (body as { error?: { details?: { retry_after?: unknown }; retry_after?: unknown } } | null)?.error;
  const v = Number(err?.details?.retry_after ?? err?.retry_after);
  return Number.isFinite(v) && v > 0 ? Math.min(3600, Math.ceil(v)) : null;
}

async function call<T>(c: InboxCall, path: string, parse: (data: unknown) => T | null, opts: RawOpts = {}): Promise<InboxResult<T>> {
  const res = await rawFetch(c, path, opts);
  if (!res) return failure(0, 'network_error');
  const etag = res.headers.get('ETag');
  if (res.status === 304) return { ok: true, status: 304, notModified: true, etag: etag ?? opts.etag ?? null };
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) {
    const data = parse(res.status === 204 ? null : (body as { data?: unknown } | null)?.data);
    if (data === null) {
      console.error(`[storefront] invalid inbox payload from ${path.split('?')[0]}`);
      return failure(502, 'invalid_payload');
    }
    return { ok: true, status: res.status, data, etag };
  }
  return { ok: false, status: res.status, ...parseApiError(body, res.status), retryAfter: retryAfterOf(res, body) };
}

const ok204 = () => true as const;
const q = (after: string | null | undefined) => (after ? `?after=${encodeURIComponent(after)}` : '');

// ---------- website chat (§9.2) ----------
export function getChatSession(c: InboxCall): Promise<InboxResult<InboxWidgetSession>> {
  return call(c, '/storefront/inbox/session', parseWidgetSession);
}

export function startChat(c: InboxCall, form: FormData): Promise<InboxResult<InboxWidgetStart>> {
  return call(c, '/storefront/inbox/sessions', parseWidgetStart, { method: 'POST', body: form });
}

export function verifyChat(c: InboxCall, code: string): Promise<InboxResult<InboxWidgetVerifyResult>> {
  return call(c, '/storefront/inbox/sessions/verify', parseVerifyResult, { method: 'POST', body: { code } });
}

export function resendChatCode(c: InboxCall): Promise<InboxResult<InboxWidgetSession | true>> {
  return call(c, '/storefront/inbox/sessions/resend', (d) => (d == null ? true : parseWidgetSession(d)), { method: 'POST' });
}

export function listChatMessages(c: InboxCall, after: string | null, etag: string | null): Promise<InboxResult<ThreadMessage[]>> {
  return call(c, `/storefront/inbox/messages${q(after)}`, parseShopperMessages, { etag });
}

export function sendChatMessage(c: InboxCall, form: FormData): Promise<InboxResult<ThreadMessage>> {
  return call(c, '/storefront/inbox/messages', parseShopperMessage, { method: 'POST', body: form });
}

export function markChatSeen(c: InboxCall): Promise<InboxResult<true>> {
  return call(c, '/storefront/inbox/messages/seen', ok204, { method: 'POST' });
}

/** Raw stream for the attachment proxy (own conversation only; the API answers 404 otherwise). */
export function fetchShopperAttachment(c: InboxCall, id: string): Promise<Response | null> {
  return rawFetch(c, `/storefront/inbox/attachments/${encodeURIComponent(id)}`);
}

export function redeemMagicLink(c: InboxCall, code: string): Promise<InboxResult<InboxMagicLinkResult>> {
  return call(c, `/storefront/inbox/links/${encodeURIComponent(code)}`, parseMagicLinkResult, { method: 'POST' });
}

// ---------- order messages (§10) ----------
/** `GET /storefront/orders/access` → the limited tracking view (magic link / held token). */
export function getOrderByAccess(c: InboxCall): Promise<InboxResult<StorefrontTracking>> {
  return call(c, '/storefront/orders/access', parseTracking);
}

export function listOrderMessages(c: InboxCall, after: string | null, etag: string | null): Promise<InboxResult<ThreadMessage[]>> {
  return call(c, `/storefront/orders/messages${q(after)}`, parseShopperMessages, { etag });
}

export function sendOrderMessage(c: InboxCall, form: FormData): Promise<InboxResult<ThreadMessage>> {
  return call(c, '/storefront/orders/messages', parseShopperMessage, { method: 'POST', body: form });
}

export function markOrderSeen(c: InboxCall): Promise<InboxResult<true>> {
  return call(c, '/storefront/orders/messages/seen', ok204, { method: 'POST' });
}

/**
 * The order and its `messages` access from the confirmation (`sp_order` token). Used by the thank-you page (render)
 * and by the order-messages route handler when it must mint `sp_order_access` for that order.
 */
export function getConfirmationWithMessages(
  c: InboxCall,
  orderToken: string,
): Promise<InboxResult<{ order: StorefrontOrder; messages: StorefrontOrderMessagesAccess | null }>> {
  return call(
    c,
    '/storefront/orders/confirmation',
    (d) => {
      const order = parseStorefrontOrder(d);
      return order ? { order, messages: parseOrderMessagesAccess((d as { messages?: unknown } | null)?.messages) } : null;
    },
    { orderToken },
  );
}
