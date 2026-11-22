import type { BadgeTone } from '../components/Badge';

// Status labels and tones for StatusBadge 3:44 (kept out of the component file for fast refresh).
// Mirrors @storeplix/types (kept local so the UI package has no types dependency).
export type OrderStatus = 'pending_payment' | 'pending' | 'confirmed' | 'ready_to_ship' | 'shipped' | 'delivered' | 'returned' | 'cancelled';

export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded';

export type CouponDisplayStatus = 'draft' | 'active' | 'disabled' | 'scheduled' | 'expired' | 'used_up';

export const orderStatusMeta: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warning' },
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  ready_to_ship: { label: 'Ready to ship', tone: 'brand' },
  shipped: { label: 'In transit', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  returned: { label: 'Returned', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const paymentStatusMeta: Record<PaymentStatus, { label: string; tone: BadgeTone }> = {
  unpaid: { label: 'Unpaid', tone: 'warning' },
  partially_paid: { label: 'Partly paid', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  partially_refunded: { label: 'Partly refunded', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export const couponStatusMeta: Record<CouponDisplayStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  expired: { label: 'Expired', tone: 'neutral' },
  used_up: { label: 'Used up', tone: 'warning' },
};

// Phase 5b returns (Figma Returns & exchanges 39:9900): Requested warning, Approved info, Received neutral,
// Refunded/Exchanged success, Closed neutral, Rejected danger. `pickup_booked` (Figma) is deferred (P5B-64).
export type ReturnStatus = 'requested' | 'approved' | 'received' | 'refunded' | 'exchanged' | 'rejected' | 'closed';

export const returnStatusMeta: Record<ReturnStatus, { label: string; tone: BadgeTone }> = {
  requested: { label: 'Requested', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  received: { label: 'Received', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'success' },
  exchanged: { label: 'Exchanged', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export type ReturnType = 'return' | 'exchange';

/** Type chip under the reason (39:9900): Exchange brand, Return neutral. */
export const returnTypeMeta: Record<ReturnType, { label: string; tone: BadgeTone }> = {
  return: { label: 'Return', tone: 'neutral' },
  exchange: { label: 'Exchange', tone: 'brand' },
};
