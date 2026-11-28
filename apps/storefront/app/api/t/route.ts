import { NextResponse, type NextRequest } from 'next/server';
import { buildCommerceRequest } from '@/lib/commerce-request';
import { serverEnv } from '@/lib/env';
import { normalizeHost } from '@/lib/host';
import { NO_STORE, routeCtx } from '@/lib/inbox-route';
import { getStorefrontConfig } from '@/lib/storefront-api';
import { BEACON_MAX_BYTES, beaconOriginAllowed, parseBeaconBody } from '@/lib/tracking-beacon';
import { buildTrackingContext } from '@/lib/tracking-context';

export const dynamic = 'force-dynamic';

const done = (status = 204) => new NextResponse(null, { status, headers: NO_STORE });

/**
 * `POST /api/t` — the storefront tracking beacon (PHASE-8-9D §6.2, S335). Same-origin only. Valid events go to
 * `POST /api/v1/storefront/tracking/events` server-to-server with the storefront key, the shopper IP
 * (`X-Storefront-Client-Ip`) and the cookie context (§5.5); the key and the API's answer never reach the browser.
 * Nothing is forwarded for a draft store, a store without tracking, or a shop waiting for consent that has none.
 * Always answers 204 once the request is acceptable: the beacon never surfaces errors.
 */
export async function POST(req: NextRequest) {
  const ctx = routeCtx(req);
  if (!ctx) return done(400);
  if (!beaconOriginAllowed(req.headers, ctx.host, normalizeHost)) return done(403);
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > BEACON_MAX_BYTES) return done(413);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return done();
  }
  if (raw.length > BEACON_MAX_BYTES) return done(413);
  const events = parseBeaconBody(raw);
  if (!events.length) return done();

  const apiKey = serverEnv.apiKey;
  if (!apiKey) return done();
  try {
    const found = await getStorefrontConfig(ctx.host, null);
    if (found.status !== 'found') return done();
    const { config } = found;
    const tracking = config.store.status === 'active' && !config.preview ? config.tracking : null;
    if (!tracking || !tracking.collect) return done();
    const context = buildTrackingContext(tracking, (n) => req.cookies.get(n)?.value, req.headers.get('user-agent'));
    // Double-check of the browser gate (P89D-14): a waiting shop gets nothing without Accept.
    if (tracking.wait_for_consent && context.consent !== 'granted') return done();

    const { url, init } = buildCommerceRequest(
      '/storefront/tracking/events',
      ctx.host,
      { method: 'POST', body: { events, context }, cache: { kind: 'no-store' }, clientIp: ctx.clientIp },
      { apiUrl: serverEnv.apiUrl, apiKey },
    );
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 404 && res.status !== 429) console.warn(`[storefront] tracking beacon: API answered ${res.status}`);
  } catch (err) {
    console.warn(`[storefront] tracking beacon failed: ${(err as Error).name}`);
  }
  return done();
}
