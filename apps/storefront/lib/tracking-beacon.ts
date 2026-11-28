import { BROWSER_TRACKING_EVENTS, TRACKING_BEACON_MAX_EVENTS, type TrackingBeaconEvent } from '@storeplix/types';
import { ULID_RE, cleanPagePath } from './tracking-events';

/**
 * `POST /api/t` body check (PHASE-8-9D §6.2, S335). Pure. Each event is validated on its own: a bad one is dropped,
 * the rest go on; duplicates (same `event_id`) are sent once; at most 20. Browser amounts are never forwarded — the
 * API prices from the catalogue. The API validates again.
 */
export const BEACON_MAX_BYTES = 16 * 1024;

const ID_RE = /^[0-9A-Za-z]{26}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function parseEvent(v: unknown): TrackingBeaconEvent | null {
  if (!isObject(v)) return null;
  const { event_id, name, occurred_at, page_path } = v;
  if (typeof event_id !== 'string' || !ULID_RE.test(event_id)) return null;
  if (typeof name !== 'string' || !(BROWSER_TRACKING_EVENTS as readonly string[]).includes(name)) return null;
  if (typeof occurred_at !== 'string' || occurred_at.length > 40 || Number.isNaN(Date.parse(occurred_at))) return null;
  if (typeof page_path !== 'string' || page_path.length > 2000 || CONTROL.test(page_path)) return null;
  const out: TrackingBeaconEvent = {
    event_id,
    name: name as TrackingBeaconEvent['name'],
    occurred_at: new Date(Date.parse(occurred_at)).toISOString(),
    page_path: cleanPagePath(page_path),
  };
  if (typeof v.product_id === 'string' && ID_RE.test(v.product_id)) out.product_id = v.product_id;
  if (typeof v.variant_id === 'string' && ID_RE.test(v.variant_id)) out.variant_id = v.variant_id;
  if (typeof v.quantity === 'number' && Number.isInteger(v.quantity) && v.quantity >= 1 && v.quantity <= 99) out.quantity = v.quantity;
  return out;
}

/** Valid, de-duplicated events from a raw body (string), at most `TRACKING_BEACON_MAX_EVENTS`. */
export function parseBeaconBody(raw: string): TrackingBeaconEvent[] {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(body) || !Array.isArray(body.events)) return [];
  const seen = new Set<string>();
  const events: TrackingBeaconEvent[] = [];
  for (const raw of body.events.slice(0, TRACKING_BEACON_MAX_EVENTS * 2)) {
    const e = parseEvent(raw);
    if (!e || seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    events.push(e);
    if (events.length === TRACKING_BEACON_MAX_EVENTS) break;
  }
  return events;
}

/**
 * Same-origin only: an `Origin` must be this store host; without one, `Sec-Fetch-Site: same-origin` is required.
 * (sendBeacon and fetch from our page always send one of them.)
 */
export function beaconOriginAllowed(headers: { get(name: string): string | null }, host: string, normalize: (h: string) => string | null): boolean {
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = headers.get('origin');
  if (origin !== null) {
    try {
      return normalize(new URL(origin).host) === host;
    } catch {
      return false;
    }
  }
  return site === 'same-origin';
}
