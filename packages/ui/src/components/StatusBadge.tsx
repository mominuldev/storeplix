import { couponStatusMeta, orderStatusMeta, paymentStatusMeta, type CouponDisplayStatus, type OrderStatus, type PaymentStatus } from '../lib/status';
import { Badge } from './Badge';

// Figma StatusBadge 3:44 order/payment variants (Orders 7:276): Pending warning, Confirmed info, Ready to ship brand,
// In transit info, Delivered success, Returned/Cancelled danger/neutral.

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const m = orderStatusMeta[status];
  return (
    <Badge tone={m.tone} dot className={className}>
      {m.label}
    </Badge>
  );
}

export function PaymentStatusBadge({ status, className }: { status: PaymentStatus; className?: string }) {
  const m = paymentStatusMeta[status];
  return (
    <Badge tone={m.tone} dot className={className}>
      {m.label}
    </Badge>
  );
}

export function CouponStatusBadge({ status, className }: { status: CouponDisplayStatus; className?: string }) {
  const m = couponStatusMeta[status];
  return (
    <Badge tone={m.tone} dot className={className}>
      {m.label}
    </Badge>
  );
}
