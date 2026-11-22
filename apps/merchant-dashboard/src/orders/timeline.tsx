import type { OrderEvent } from '@storeplix/types';
import { orderStatusMeta, type TimelineEntry } from '@storeplix/ui';
import { Ban, CheckCircle2, CreditCard, MessageSquare, Package, PencilLine, RotateCcw, ShoppingBag, Tag, Truck } from 'lucide-react';
import { formatBdt } from '../catalog/format';
import { clock } from '../commerce/format';

// Order detail 33:3676 Timeline: events newest first, with actor names.

const actorName = (e: OrderEvent) => (e.actor.type === 'customer' ? 'Customer' : e.actor.type === 'system' ? 'Store Plix' : (e.actor.user?.name ?? 'A teammate'));

function dayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  return d.toDateString() === today.toDateString() ? clock(iso) : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${clock(iso)}`;
}

export function eventToEntry(e: OrderEvent): TimelineEntry {
  const base = { id: e.id, time: dayTime(e.created_at) };
  const meta = e.meta as Record<string, unknown>;
  switch (e.type) {
    case 'placed':
      return { ...base, icon: <ShoppingBag />, tone: 'brand', title: e.actor.type === 'user' ? `Order created by ${actorName(e)}` : 'Order placed on your shop', detail: e.body };
    case 'status_changed': {
      const to = e.to_status;
      const label = to ? orderStatusMeta[to].label : 'Status changed';
      const icon = to === 'cancelled' ? <Ban /> : to === 'returned' ? <RotateCcw /> : to === 'shipped' ? <Truck /> : to === 'ready_to_ship' ? <Package /> : <CheckCircle2 />;
      const tone = to === 'cancelled' || to === 'returned' ? 'danger' : to === 'delivered' ? 'success' : 'brand';
      return { ...base, icon, tone, title: `${label} · ${actorName(e)}`, detail: e.body };
    }
    case 'note':
      return { ...base, icon: <MessageSquare />, tone: 'neutral', title: `${actorName(e)} added a note`, detail: e.body };
    case 'edited': {
      const fields = Array.isArray(meta.fields) ? (meta.fields as string[]).map((f) => f.replace(/_/g, ' ')).join(', ') : null;
      return { ...base, icon: <PencilLine />, tone: 'neutral', title: `${actorName(e)} edited the order`, detail: e.body ?? (fields ? `Changed ${fields}` : null) };
    }
    case 'payment':
      return { ...base, icon: <CreditCard />, tone: 'success', title: 'Payment collected', detail: e.body ?? (typeof meta.amount === 'number' ? formatBdt(meta.amount) : null) };
    case 'refund':
      return { ...base, icon: <CreditCard />, tone: 'warning', title: `Refund recorded · ${actorName(e)}`, detail: e.body ?? (typeof meta.amount === 'number' ? formatBdt(meta.amount) : null) };
    case 'shipment':
      return { ...base, icon: <Truck />, tone: 'brand', title: 'Shipment details added', detail: e.body };
    case 'notification':
      return { ...base, icon: <MessageSquare />, tone: 'neutral', title: e.body ?? 'Customer notified' };
    case 'coupon_released':
      return { ...base, icon: <Tag />, tone: 'neutral', title: 'Coupon use released', detail: e.body };
    default:
      return { ...base, title: e.body ?? e.type };
  }
}
