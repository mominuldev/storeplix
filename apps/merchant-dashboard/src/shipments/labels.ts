import type { CourierAccount, CourierProvider, Order, Shipment, ShipmentListFilters, ShipmentStatus } from '@storeplix/types';

// Shipments 39:10347, shipment detail 146:33100, bulk booking 39:18808 copy (PHASE-5B §10).

export const COURIERS: CourierProvider[] = ['steadfast', 'pathao', 'redx'];
export const courierName: Record<CourierProvider | 'manual', string> = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', manual: 'Own delivery' };
export const isCourier = (p: string): p is CourierProvider => p === 'steadfast' || p === 'pathao' || p === 'redx';
/** P5B-39: Pathao and RedX need their own area ids; Steadfast takes free text. */
export const needsArea = (p: CourierProvider) => p === 'pathao' || p === 'redx';

export const FINAL: ShipmentStatus[] = ['delivered', 'partially_delivered', 'returned', 'cancelled', 'booking_failed'];

export type StatusFilter = '' | 'problems' | 'active' | 'final' | ShipmentStatus;
export const statusFilters: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'problems', label: 'Problems' },
  { value: 'active', label: 'On the way' },
  { value: 'booked', label: 'Waiting for pickup' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'returning', label: 'Returning' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'final', label: 'Finished' },
];

export const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

export const problemLabels: Record<NonNullable<Shipment['problem']>, string> = {
  delivery_failed: 'Delivery attempt failed',
  on_hold: 'On hold with the courier',
  returning: 'Coming back to you',
  unknown: 'Courier problem · needs you',
};

/** COD cell (39:10347): to collect / collected / won't collect / paid online. */
export function codCell(s: Pick<Shipment, 'status' | 'cod_amount' | 'cod_collected_amount'>): { amount: number; label: string; tone: 'muted' | 'danger' } {
  if (s.status === 'delivered' || s.status === 'partially_delivered') {
    if (s.cod_amount === 0) return { amount: 0, label: 'Paid online', tone: 'muted' };
    return { amount: s.cod_collected_amount ?? s.cod_amount, label: 'Collected', tone: 'muted' };
  }
  if (s.status === 'returning' || s.status === 'returned' || s.status === 'cancelled' || s.status === 'booking_failed') {
    return { amount: s.cod_amount, label: 'Won’t collect', tone: 'danger' };
  }
  if (s.cod_amount === 0) return { amount: 0, label: 'Paid online', tone: 'muted' };
  return { amount: s.cod_amount, label: 'To collect', tone: 'muted' };
}

/** 146:33100 stepper: Booked → Picked up → At hub → Out for delivery → Delivered (or the final off-path state). */
export function trackingSteps(status: ShipmentStatus): { title: string; state: 'done' | 'current' | 'upcoming' }[] {
  const path = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'] as const;
  const titles = ['Booked', 'Picked up', 'At hub', 'Out for delivery', 'Delivered'];
  const offPath: Partial<Record<ShipmentStatus, { at: number; title: string }>> = {
    booking: { at: 0, title: 'Booking…' },
    shipped: { at: 2, title: 'At hub' },
    on_hold: { at: 3, title: 'On hold' },
    delivery_failed: { at: 3, title: 'Failed attempt' },
    partially_delivered: { at: 4, title: 'Partly delivered' },
    returning: { at: 4, title: 'Returning' },
    returned: { at: 4, title: 'Returned' },
    cancelled: { at: 1, title: 'Cancelled' },
    booking_failed: { at: 0, title: 'Booking failed' },
  };
  const idx = (path as readonly ShipmentStatus[]).indexOf(status);
  const off = offPath[status];
  const at = idx >= 0 ? idx : (off?.at ?? 0);
  const finished = status === 'delivered';
  return titles.map((t, i) => ({
    title: i === at && off ? off.title : t,
    state: i < at || (finished && i === at) ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}

export function rangeFilter(range: string): Pick<ShipmentListFilters, 'booked_from'> {
  if (range === 'all') return {};
  const d = new Date();
  d.setDate(d.getDate() - Number(range));
  return { booked_from: d.toISOString().slice(0, 10) };
}

/** Bulk/batch result reasons (P5B-40) in shop language. */
export function batchReasonLabel(reason: string | null, provider: CourierProvider): string {
  switch (reason) {
    case null:
      return '';
    case 'area_unmapped':
      return `Area needs mapping · book it from the order to choose the ${courierName[provider]} area`;
    case 'shipment_booked':
      return 'Already booked';
    case 'invalid_state_transition':
      return 'Not confirmed or already shipped';
    case 'provider_unavailable':
      return `${courierName[provider]} didn’t answer · try again`;
    case 'courier_rejected':
      return `${courierName[provider]} refused this parcel`;
    default:
      return reason;
  }
}

/** `{items}` / `{order_no}` template preview (P5B-32; the API renders the real one, ≤ 120 chars). */
export function renderDescription(template: string, order: Pick<Order, 'number' | 'items'>): string {
  const items = order.items.map((i) => `${i.product_name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', ');
  return template.replace(/\{items\}/g, items).replace(/\{order_no\}/g, order.number).slice(0, 120);
}

export const connectedCouriers = (list: CourierAccount[] | undefined) =>
  (list ?? []).filter((a) => a.status === 'connected').sort((a, b) => Number(b.is_default) - Number(a.is_default));

/** Client-side manifest (§10 "Download manifest = CSV of selected"). Cells are quoted; formula prefixes neutralised. */
export function manifestCsv(rows: { consignment_id: string | null; tracking_code: string | null; provider: string; status: string; cod_amount: number; order: { number: string; customer_name: string; customer_phone: string; thana: string; district: string } }[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = ['Consignment', 'Order', 'Customer', 'Phone', 'Area', 'Courier', 'Status', 'COD (BDT)'];
  const lines = rows.map((r) =>
    [r.consignment_id ?? r.tracking_code ?? '', r.order.number, r.order.customer_name, r.order.customer_phone, `${r.order.thana}, ${r.order.district}`, isCourier(r.provider) ? courierName[r.provider] : courierName.manual, r.status, `${Math.trunc(r.cod_amount / 100)}.${String(r.cod_amount % 100).padStart(2, '0')}`].map(cell).join(','),
  );
  return [head.map(cell).join(','), ...lines].join('\r\n');
}
