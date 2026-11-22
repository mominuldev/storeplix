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
