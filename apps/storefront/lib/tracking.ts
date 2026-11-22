import type { OrderStatus, StorefrontOrderTracking } from '@storeplix/types';

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

export function trackingSteps(t: Pick<StorefrontOrderTracking, 'status' | 'placed_at' | 'timeline'>): TrackStep[] {
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
  return FLOW.map((f, i) => ({
    key: f.status,
    title: f.title,
    at: i <= idx ? (at.get(f.status) ?? null) : null,
    state: i < idx || (i === idx && t.status !== 'shipped') ? 'done' : i === idx ? 'current' : 'todo',
  }));
}

export function formatDhakaTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
