import { Badge, Button, cn } from '@storeplix/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { plural } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { Thumb } from '../catalog/ui';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { orderableCount, purchasingError, sellsOutText } from './purchasing';
import { usePurchaseOrderMutations, useReorderSuggestions } from './queries';

// PHASE-8-8B §7 / §10.1 / §10.2 Reorder suggestions card (35:5619 bottom card; Inventory 11:589 "reorder suggestion").
// Built only when suggestions exist (P88B-16, real data only). "Create PO for n items" creates one draft per supplier
// group (items without a supplier yet are listed but can't be ordered automatically).

export function ReorderCard({ variant = 'purchase-orders' }: { variant?: 'purchase-orders' | 'inventory' }) {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const suggestions = useReorderSuggestions(scope.canManagePurchasing);
  const { create } = usePurchaseOrderMutations();
  const [busy, setBusy] = useState(false);
  const groups = suggestions.data ?? [];
  const items = groups.flatMap((g) => g.items.map((i) => ({ ...i, supplier: g.supplier })));
  if (!scope.canManagePurchasing || items.length === 0) return null;
  const n = orderableCount(groups);
  const shown = variant === 'inventory' ? items.slice(0, 3) : items.slice(0, 6);

  const createAll = async () => {
    setBusy(true);
    const made: { id: string; number: string }[] = [];
    try {
      for (const g of groups) {
        if (!g.supplier) continue;
        const po = await create.mutateAsync({
          supplier_id: g.supplier.id,
          lines: g.items.map((i) => ({ variant_id: i.variant_id, quantity: i.suggested_quantity, ...(i.last_unit_cost_amount !== null ? { unit_cost_amount: i.last_unit_cost_amount } : {}) })),
        });
        made.push(po);
      }
      if (made.length === 1) navigate(`/inventory/purchase-orders/${made[0]!.id}`);
      else toast(`${plural(made.length, 'draft purchase order')} created: ${made.map((m) => m.number).join(', ')}.`);
    } catch (e) {
      const msg = purchasingError(e, 'We couldn’t create the purchase orders.');
      if (msg) toast(made.length ? `${msg} ${made.length} created before the error.` : msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Reorder suggestions" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-body-lg font-medium text-text-primary">Reorder suggestions</h2>
          <p className="text-caption text-text-secondary">Based on the last 30 days of sales and each supplier’s delivery time.</p>
        </div>
        {n > 0 && (
          <ReadOnlyActions className="shrink-0">
            <Button size="sm" loading={busy} onClick={() => void createAll()}>
              Create PO for {plural(n, 'item')}
            </Button>
          </ReadOnlyActions>
        )}
      </div>
      <ul className={cn('grid gap-3', variant === 'inventory' ? 'md:grid-cols-3' : 'md:grid-cols-2 xl:grid-cols-3')}>
        {shown.map((i) => {
          const out = i.available <= 0 || i.days_left <= 0;
          return (
            <li key={i.variant_id} className="flex items-center gap-3 rounded-lg bg-surface-subtle px-3 py-3">
              <Thumb src={i.product.image?.url} size={44} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body font-medium text-text-primary">{[i.product.name, i.variant_title !== 'Default' ? i.variant_title : null].filter(Boolean).join(' · ')}</span>
                <span className={cn('truncate text-caption', out ? 'text-danger' : 'text-warning')}>{sellsOutText(i)}</span>
                <span className="truncate text-caption text-text-muted">{i.supplier?.name ?? 'No supplier yet'}</span>
              </div>
              <Badge size="sm" tone="brand" className="shrink-0">
                Order {i.suggested_quantity}
              </Badge>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && <p className="text-caption text-text-muted">+ {plural(items.length - shown.length, 'more item')} on the drafts</p>}
    </section>
  );
}
