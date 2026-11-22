import { Badge, type BadgeTone } from './Badge';

// Inventory 11:743 status column / Products mobile ProductCard 139:1065: Pill tones per stock status.
export type StockStatusValue = 'in_stock' | 'low_stock' | 'out_of_stock' | 'untracked';

export const stockStatusMeta: Record<StockStatusValue, { label: string; tone: BadgeTone }> = {
  in_stock: { label: 'In stock', tone: 'success' },
  low_stock: { label: 'Low', tone: 'warning' },
  out_of_stock: { label: 'Out of stock', tone: 'danger' },
  untracked: { label: 'Not tracked', tone: 'neutral' },
};

export function StockBadge({ status, label, dot = false, className }: { status: StockStatusValue; label?: string; dot?: boolean; className?: string }) {
  const meta = stockStatusMeta[status];
  return (
    <Badge tone={meta.tone} dot={dot} className={className}>
      {label ?? meta.label}
    </Badge>
  );
}
