import type { InboxReplyTime, OrderStatus, ShipmentStatus, StorefrontOrderTracking } from '@storeplix/types';

/**
 * 5b-3 (PHASE-5B-CONTRACT §11 `/track`): the shipment block gains the courier status and its time, from courier
 * events (status + time only; rider name/phone and locations are never part of the shopper view).
 * Local extension until `packages/types` StorefrontOrderTracking carries these fields.
 */
export type CourierTrackStatus = ShipmentStatus;
export interface CourierTrack {
  /** Normalised courier status (P5B-36) of the active shipment; null for manual shipments. */
  status: CourierTrackStatus | null;
  /** When the courier reported that status. */
  status_at: string | null;
  /** When we last checked with the courier (webhook or poll). */
  checked_at: string | null;
  events: { status: CourierTrackStatus; at: string }[];
}
export type StorefrontTracking = Omit<StorefrontOrderTracking, 'shipment'> & {
  // Courier fields optional: manual shipments and older API responses don't carry them (the Zod schema nulls bad values).
  shipment: (Pick<NonNullable<StorefrontOrderTracking['shipment']>, 'carrier_name' | 'tracking_code' | 'tracking_url'> & Partial<CourierTrack>) | null;
};

/**
 * 8.8e (PHASE-8-8E §10): what the browser gets for order Messages — never the access token, which goes into the httpOnly
 * `sp_order_access` cookie server-side.
 */
export interface ShopperOrderMessagesView {
  unread_count: number;
  reply_time: InboxReplyTime;
}
export type ShopperTracking = Omit<StorefrontTracking, 'messages'> & { messages: ShopperOrderMessagesView | null };

export function toShopperTracking(t: StorefrontTracking): ShopperTracking {
  const { messages, ...rest } = t;
  return { ...rest, messages: messages ? { unread_count: messages.unread_count, reply_time: messages.reply_time } : null };
}

/** Title of the "with the courier" step for a courier status while the order is `shipped`. */
const COURIER_STEP_TITLES: Partial<Record<CourierTrackStatus, string>> = {
  picked_up: 'Picked up by the courier',
  in_transit: 'On the way',
  out_for_delivery: 'Out for delivery',
  on_hold: 'On hold at the courier',
  delivery_failed: 'Delivery attempt failed',
  returning: 'Returning to the shop',
};

/** Latest courier status + time: the explicit fields win, else the newest event. */
export function courierStatus(shipment: StorefrontTracking['shipment']): { status: CourierTrackStatus; at: string | null } | null {
  if (!shipment) return null;
  if (shipment.status) return { status: shipment.status, at: shipment.status_at ?? null };
  const events = [...(shipment.events ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = events.at(-1);
  return last ? { status: last.status, at: last.at } : null;
}

/** Shopper-facing tracking timeline (PHASE-5-CONTRACT §5 `/track`). Pure. */
export interface TrackStep {
  key: string;
  title: string;
  at: string | null;
  state: 'done' | 'current' | 'todo' | 'stopped';
}

const FLOW: Array<{ status: OrderStatus; title: string }> = [
  { status: 'pending', title: 'Order placed' },
  { status: 'confirmed', title: 'Confirmed' },
  { status: 'ready_to_ship', title: 'Packed' },
  { status: 'shipped', title: 'With the courier' },
  { status: 'delivered', title: 'Delivered' },
];

export const TRACK_HEADLINES: Record<OrderStatus, string> = {
  pending_payment: 'Waiting for payment',
  pending: 'Order received',
  confirmed: 'Order confirmed',
  ready_to_ship: 'Packed and ready',
  shipped: 'On the way to you',
  delivered: 'Delivered',
  returned: 'Returned to the shop',
  cancelled: 'Order cancelled',
};

export function trackingSteps(t: Pick<StorefrontTracking, 'status' | 'placed_at' | 'timeline'> & { shipment?: StorefrontTracking['shipment'] }): TrackStep[] {
  const at = new Map<OrderStatus, string>();
  at.set('pending', t.placed_at);
  for (const e of t.timeline) if (e.status !== 'pending') at.set(e.status, e.at);

  if (t.status === 'cancelled' || t.status === 'returned') {
    const reached = FLOW.filter((f) => at.has(f.status) && f.status !== 'delivered');
    return [
      ...reached.map((f) => ({ key: f.status, title: f.title, at: at.get(f.status) ?? null, state: 'done' as const })),
      { key: t.status, title: t.status === 'cancelled' ? 'Cancelled' : 'Returned to the shop', at: at.get(t.status) ?? null, state: 'stopped' as const },
    ];
  }

  const idx = Math.max(0, FLOW.findIndex((f) => f.status === t.status));
  // While the parcel is with the courier, its latest status replaces the generic "With the courier" step.
  const courier = t.status === 'shipped' ? courierStatus(t.shipment ?? null) : null;
  const courierTitle = courier ? COURIER_STEP_TITLES[courier.status] : undefined;
  return FLOW.map((f, i) => {
    const isCourierStep = f.status === 'shipped' && courierTitle !== undefined;
    return {
      key: f.status,
      title: isCourierStep ? courierTitle : f.title,
      at: i <= idx ? ((isCourierStep ? courier?.at : null) ?? at.get(f.status) ?? null) : null,
      state: i < idx || (i === idx && t.status !== 'shipped') ? 'done' : i === idx ? 'current' : 'todo',
    };
  });
}

/** "Courier status is checked with the courier directly…" footnote time (Dhaka clock, e.g. "11:42 am"). */
export function formatDhakaClock(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}

export function formatDhakaTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
