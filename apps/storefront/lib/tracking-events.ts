import { TRACKING_BEACON_MAX_EVENTS, TRACKING_EVENT_NAMES, type TrackingBeaconEvent } from '@storeplix/types';

/**
 * Browser events (PHASE-8-9D §6.2, P89D-10, P89D-12). Pure and client-safe: no tracking code runs from here unless
 * the tracking runtime (components/tracking) is mounted, which happens only for a live shop with tracking on.
 */

export type BrowserEventName = TrackingBeaconEvent['name'];

/** What a page reports. Amounts are minor units (rule 9) and only feed the browser tag; the API prices mirrors itself. */
export interface TrackInput {
  name: BrowserEventName;
  product_id?: string | null;
  variant_id?: string | null;
  quantity?: number | null;
  value_amount?: number | null;
  currency?: string | null;
  num_items?: number | null;
}

// ---------- event ids: ULID (Crockford base32, 48-bit time + 80-bit random) ----------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  let t = Math.max(0, Math.floor(now));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(new Uint8Array(16));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

// ---------- the shared id: one ULID for the tag call and its beacon copy ----------
export interface TrackedEvent {
  event_id: string;
  input: TrackInput;
  beacon: TrackingBeaconEvent;
}

const ID_RE = /^[0-9A-Za-z]{26}$/;

/** Builds the event once; the pixel calls and the beacon both use `event_id` so providers deduplicate (P89D-12). */
export function makeEvent(input: TrackInput, pagePath: string, now: number = Date.now(), id: string = ulid(now)): TrackedEvent {
  const beacon: TrackingBeaconEvent = { event_id: id, name: input.name, occurred_at: new Date(now).toISOString(), page_path: pagePath };
  if (input.product_id && ID_RE.test(input.product_id)) beacon.product_id = input.product_id;
  if (input.variant_id && ID_RE.test(input.variant_id)) beacon.variant_id = input.variant_id;
  if (Number.isInteger(input.quantity) && input.quantity! >= 1 && input.quantity! <= 99) beacon.quantity = input.quantity!;
  return { event_id: id, input, beacon };
}

const decimal = (minor: number | null | undefined) => (typeof minor === 'number' && Number.isFinite(minor) ? Math.round(minor) / 100 : undefined);

type Params = Record<string, unknown>;
export interface TagCalls {
  meta: { name: string; params: Params; options: { eventID: string } } | null;
  ga4: { name: string; params: Params } | null;
  tiktok: { name: string; params: Params; options: { event_id: string } } | null;
}

/** Provider tag calls for one event (names from `TRACKING_EVENT_NAMES`). */
export function tagCalls(e: TrackedEvent, pageLocation: string): TagCalls {
  const { input, event_id } = e;
  const value = decimal(input.value_amount);
  const currency = input.currency ?? undefined;
  const contentId = input.variant_id ?? input.product_id ?? undefined;
  const qty = input.quantity ?? 1;
  const money = value !== undefined && currency ? { value, currency } : {};

  let meta: Params = {};
  let ga4: Params = { event_id };
  let tiktok: Params = {};
  if (input.name === 'page_view') {
    ga4 = { ...ga4, page_location: pageLocation };
  } else if (input.name === 'begin_checkout') {
    meta = { ...money, ...(input.num_items ? { num_items: input.num_items } : {}) };
    ga4 = { ...ga4, ...money };
    tiktok = { ...money };
  } else {
    meta = { content_type: 'product', ...(contentId ? { content_ids: [contentId] } : {}), ...money };
    ga4 = { ...ga4, ...money, ...(contentId ? { items: [{ item_id: contentId, quantity: qty }] } : {}) };
    tiktok = { content_type: 'product', ...(contentId ? { contents: [{ content_id: contentId, quantity: qty }] } : {}), ...money };
  }
  const metaName = TRACKING_EVENT_NAMES.meta_pixel[input.name];
  const gaName = TRACKING_EVENT_NAMES.ga4[input.name];
  const ttName = TRACKING_EVENT_NAMES.tiktok_pixel[input.name];
  return {
    meta: metaName ? { name: metaName, params: meta, options: { eventID: event_id } } : null,
    ga4: gaName ? { name: gaName, params: ga4 } : null,
    tiktok: ttName ? { name: ttName, params: tiktok, options: { event_id } } : null,
  };
}

/** Path only (no query/hash: never ship tokens or PII from a URL), capped. */
export function cleanPagePath(pathname: string): string {
  const p = pathname.split(/[?#]/)[0] ?? '/';
  return p.startsWith('/') && !p.startsWith('//') ? p.slice(0, 500) : '/';
}

// ---------- beacon queue: batched ≤ 20, at most one send per 2 s, never blocks ----------
export const BEACON_URL = '/api/t';
export const BEACON_INTERVAL_MS = 2000;
const QUEUE_CAP = 100;

export interface BeaconQueueDeps {
  send: (events: TrackingBeaconEvent[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  intervalMs?: number;
}

export class BeaconQueue {
  private queue: TrackingBeaconEvent[] = [];
  private last = -Infinity;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly interval: number;

  constructor(private readonly deps: BeaconQueueDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.interval = deps.intervalMs ?? BEACON_INTERVAL_MS;
  }

  get size(): number {
    return this.queue.length;
  }

  push(event: TrackingBeaconEvent): void {
    if (this.queue.length >= QUEUE_CAP) this.queue.shift();
    this.queue.push(event);
    this.schedule();
  }

  /** Page is going away: send what is queued now (one batch per call to sendBeacon; errors swallowed). */
  flushAll(): void {
    while (this.queue.length) this.sendBatch();
  }

  private schedule(): void {
    if (this.timer !== null || !this.queue.length) return;
    const wait = Math.max(0, this.last + this.interval - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.sendBatch();
      this.schedule();
    }, wait);
  }

  private sendBatch(): void {
    const batch = this.queue.splice(0, TRACKING_BEACON_MAX_EVENTS);
    if (!batch.length) return;
    this.last = this.now();
    try {
      this.deps.send(batch);
    } catch {
      // The beacon never breaks the page.
    }
  }
}

/** `navigator.sendBeacon` (text/plain: no preflight), else a keepalive fetch. Same origin; errors swallowed. */
export function sendBeacon(events: TrackingBeaconEvent[]): void {
  const body = JSON.stringify({ events });
  const type = 'text/plain;charset=UTF-8';
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(BEACON_URL, new Blob([body], { type }))) return;
  } catch {
    // fall through to fetch
  }
  void fetch(BEACON_URL, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': type } }).catch(() => undefined);
}

// ---------- page → runtime hand-off ----------
/** `window.__spTrack`: an array buffer until the runtime mounts, then the runtime's handler (dataLayer pattern). */
export interface TrackSink {
  push: (input: TrackInput) => unknown;
}
declare global {
  interface Window {
    __spTrack?: TrackSink | TrackInput[];
  }
}

/**
 * Report an event. `buffer: true` (page components rendered only when tracking is on) queues it for the runtime;
 * otherwise it is a no-op unless the runtime is mounted — so a shop without tracking runs nothing.
 */
export function emitTrack(input: TrackInput, opts: { buffer?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const sink = window.__spTrack;
  if (sink && !Array.isArray(sink)) {
    sink.push(input);
    return;
  }
  if (!opts.buffer) return;
  const q = Array.isArray(sink) ? sink : (window.__spTrack = []);
  if (q.length < 20) q.push(input);
}
