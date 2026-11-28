import type { ShopperError } from '@/lib/inbox-copy';

/**
 * Browser → our own route handlers (`/api/chat/**`, `/api/order-messages/**`). Same-origin, `no-store`; the
 * handlers hold the tokens. Never throws.
 */
export type ClientOutcome<T> =
  | { ok: true; status: number; data: T; etag: string | null }
  | { ok: true; status: 304; notModified: true }
  | { ok: false; error: ShopperError };

export async function clientFetch<T>(url: string, init: RequestInit & { etag?: string | null } = {}): Promise<ClientOutcome<T>> {
  const { etag, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Accept', 'application/json');
  if (etag) headers.set('If-None-Match', etag);
  let res: Response;
  try {
    res = await fetch(url, { ...rest, headers, cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { ok: false, error: { status: 0, code: 'network_error' } };
  }
  if (res.status === 304) return { ok: true, status: 304, notModified: true };
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: (body as { data?: T } | null)?.data as T, etag: res.headers.get('ETag') };
  const err = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  return {
    ok: false,
    error: {
      status: res.status,
      code: typeof err?.code === 'string' ? err.code : res.status === 429 ? 'rate_limited' : 'error',
      details: typeof err?.details === 'object' && err.details !== null ? (err.details as ShopperError['details']) : undefined,
    },
  };
}

export const jsonPost = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Non-secure contexts (plain http on a LAN host) lack randomUUID: build a v4 UUID from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
