import {
  couponStatusMeta,
  orderStatusMeta,
  paymentStatusMeta,
  returnStatusMeta,
  returnTypeMeta,
  shipmentStatusMeta,
  type CouponDisplayStatus,
  type OrderStatus,
  type PaymentStatus,
  type ReturnStatus,
  type ReturnType,
  type ShipmentStatus,
} from '../lib/status';
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

/** Phase 5b Returns & exchanges 39:9900. */
export function ReturnStatusBadge({ status, className }: { status: ReturnStatus; className?: string }) {
  const m = returnStatusMeta[status];
  return (
    <Badge tone={m.tone} dot className={className}>
      {m.label}
    </Badge>
  );
}

export function ReturnTypeBadge({ type, className }: { type: ReturnType; className?: string }) {
  const m = returnTypeMeta[type];
  return (
    <Badge tone={m.tone} className={className}>
      {m.label}
    </Badge>
  );
}

/** Phase 5b-3 Shipments 39:10347. Unknown values (enums widen, API-CONVENTIONS §1) fall back to a neutral label. */
export function ShipmentStatusBadge({ status, className }: { status: ShipmentStatus; className?: string }) {
  const m = shipmentStatusMeta[status] ?? { label: String(status).replace(/_/g, ' '), tone: 'neutral' as const };
  return (
    <Badge tone={m.tone} dot className={className}>
      {m.label}
    </Badge>
  );
}
