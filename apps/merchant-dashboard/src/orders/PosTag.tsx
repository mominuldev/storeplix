import type { OrderSummary } from '@storeplix/types';
import { Badge } from '@storeplix/ui';

/** PHASE-8-8D §8: "POS · {register}" tag on till sales (composed from Tag 39:4554). */
export function PosTag({ order, className }: { order: Pick<OrderSummary, 'created_via' | 'pos'>; className?: string }) {
  if (order.created_via !== 'pos') return null;
  return (
    <Badge size="sm" tone="brand" className={className} data-testid="order-pos-tag">
      {order.pos?.register_name ? `POS · ${order.pos.register_name}` : 'POS'}
    </Badge>
  );
}
