import type { CancelReason, OrderChannel, OrderCustomerSummary, OrderStatus, RefundMethod } from '@storeplix/types';
import { formatCount } from '@storeplix/ui';

export const orderChannelLabels: Record<OrderChannel, string> = {
  website: 'Website',
  facebook: 'Facebook',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  phone: 'Phone call',
  walk_in: 'Walk-in',
  landing_page: 'Landing page',
  other: 'Other',
};

/** Channels a merchant can pick for a manual order (P5-19; never `website`). */
export const manualChannels: Exclude<OrderChannel, 'website'>[] = ['facebook', 'instagram', 'whatsapp', 'phone', 'walk_in', 'landing_page', 'other'];

export const cancelReasonLabels: Record<CancelReason, string> = {
  customer_request: 'Customer asked to cancel',
  fake_order: 'Fake order',
  unreachable: 'Couldn’t reach the customer',
  out_of_stock: 'Out of stock',
  duplicate: 'Duplicate order',
  other: 'Other',
  payment_timeout: 'Not paid in time',
  payment_link_expired: 'Payment link expired',
};

export const refundMethodLabels: Record<RefundMethod, string> = {
  cash: 'Cash',
  bkash_personal: 'bKash (personal)',
  nagad_personal: 'Nagad (personal)',
  bank: 'Bank transfer',
  other: 'Other',
  gateway: 'Back through the gateway',
  card: 'Card',
};

/** Status tabs of Orders 7:276 (In transit = `shipped`). */
export const orderTabs: { value: 'all' | OrderStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  // 5b-2 (§10): online checkout holds the order in `pending_payment` for 30 min.
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'ready_to_ship', label: 'Ready to ship' },
  { value: 'shipped', label: 'In transit' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' },
];

export type NextStep = { label: string; to: OrderStatus };

/** §4 "Next step" column, derived client-side from the status. Final states → none. */
export function nextStep(status: OrderStatus): NextStep | null {
  switch (status) {
    case 'pending':
      return { label: 'Confirm', to: 'confirmed' };
    case 'confirmed':
      return { label: 'Mark packed', to: 'ready_to_ship' };
    case 'ready_to_ship':
      return { label: 'Mark shipped', to: 'shipped' };
    case 'shipped':
      return { label: 'Mark delivered', to: 'delivered' };
    default:
      return null;
  }
}

/** Labels for transition buttons on the detail page (from `allowed_transitions`). */
export const transitionLabels: Partial<Record<OrderStatus, string>> = {
  confirmed: 'Confirm',
  ready_to_ship: 'Mark packed',
  shipped: 'Mark shipped',
  delivered: 'Mark delivered',
  returned: 'Returned',
  cancelled: 'Cancel order',
};

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${formatCount(n)}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "01712-345678 · 3rd order · 3/3 delivered" (§4 customer line; this shop only). */
export function customerLine(c: OrderCustomerSummary): string {
  const phone = localPhone(c.phone);
  const nth = c.orders_count <= 1 ? 'first order' : `${ordinal(c.orders_count)} order`;
  const delivered = c.delivered_orders_count + c.returned_orders_count > 0 ? `${formatCount(c.delivered_orders_count)}/${formatCount(c.orders_count)} delivered` : null;
  return [phone, nth, delivered].filter(Boolean).join(' · ');
}

/** 8801712345678 → "01712-345678". */
export function localPhone(msisdn: string | null | undefined): string {
  if (!msisdn) return '';
  const m = /^880(1\d{3})(\d{6})$/.exec(msisdn);
  return m ? `0${m[1]}-${m[2]}` : msisdn;
}

/** "2 min ago", "3 h ago", "Yesterday", "12 Nov". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "13:18". */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Days → "1–2 days". */
export function daysRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min === null || min === undefined) return '';
  if (max === null || max === undefined || max === min) return `${min} ${min === 1 ? 'day' : 'days'}`;
  return `${min}–${max} days`;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** ISO for the start of the day `days` ago (date filters). */
export function daysAgoIso(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return d.toISOString();
}
