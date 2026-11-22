import type { ReturnEvent } from '@storeplix/types';
import { returnStatusMeta, type TimelineEntry } from '@storeplix/ui';
import { Ban, CheckCircle2, CreditCard, MessageSquare, PackageCheck, RotateCcw } from 'lucide-react';
import { formatBdt, formatCount } from '../catalog/format';
import { timeAgo } from '../commerce/format';

// Return detail 146:32329 timeline.

const who = (e: ReturnEvent) => (e.actor.type === 'customer' ? 'Customer' : e.actor.type === 'system' ? 'Store Plix' : (e.actor.user?.name ?? 'A teammate'));

export function returnEventToEntry(e: ReturnEvent): TimelineEntry {
  const base = { id: e.id, time: timeAgo(e.created_at) };
  const meta = e.meta as Record<string, unknown>;
  switch (e.type) {
    case 'created':
      return { ...base, icon: <RotateCcw />, tone: 'brand', title: `Return created · ${who(e)}`, detail: e.body };
    case 'status_changed': {
      const to = e.to_status;
      const tone = to === 'rejected' ? 'danger' : to === 'refunded' || to === 'exchanged' ? 'success' : 'brand';
      const icon = to === 'rejected' ? <Ban /> : to === 'received' ? <PackageCheck /> : <CheckCircle2 />;
      return { ...base, icon, tone, title: `${to ? returnStatusMeta[to].label : 'Updated'} · ${who(e)}`, detail: e.body };
    }
    case 'refund':
      return { ...base, icon: <CreditCard />, tone: 'warning', title: `Refund recorded · ${who(e)}`, detail: e.body ?? (typeof meta.amount === 'number' ? formatBdt(meta.amount) : null) };
    case 'restock':
      return { ...base, icon: <PackageCheck />, tone: 'success', title: 'Put back in stock', detail: e.body ?? (typeof meta.units === 'number' ? `${formatCount(meta.units)} units` : null) };
    case 'note':
      return { ...base, icon: <MessageSquare />, tone: 'neutral', title: `${who(e)} added a note`, detail: e.body };
    default:
      return { ...base, title: e.body ?? e.type };
  }
}
