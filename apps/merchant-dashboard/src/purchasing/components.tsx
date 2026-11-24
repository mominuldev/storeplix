import type { InventoryItem, PurchaseOrderStatus, PurchasePaymentStatus, Supplier } from '@storeplix/types';
import { Badge, buttonVariants, cn, Modal, Skeleton } from '@storeplix/ui';
import { Building2, Check, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatCount } from '../catalog/format';
import { useInventory } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, SearchBox, Thumb, useDebounced } from '../catalog/ui';
import { formatBdPhone } from '../lib/phone';
import { paymentStatusMeta, poStatusMeta, receivingBar } from './purchasing';
import { useSuppliers } from './queries';

// Shared pieces of the purchasing screens (PHASE-8-8B §10).

export function PoStatusBadge({ status, size = 'sm' }: { status: PurchaseOrderStatus; size?: 'sm' | 'md' }) {
  const m = poStatusMeta[status];
  return (
    <Badge size={size} tone={m.tone}>
      {m.label}
    </Badge>
  );
}

export function PaymentBadge({ status }: { status: PurchasePaymentStatus }) {
  const m = paymentStatusMeta[status];
  return (
    <Badge size="sm" tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

/** Receiving cell (35:5619): "60 / 100 units" over a 4px bar (success when complete, brand otherwise). */
export function ReceivingBar({ po }: { po: Parameters<typeof receivingBar>[0] }) {
  const bar = receivingBar(po);
  if (!bar) return <span className="text-body text-text-muted">—</span>;
  return (
    <div className="flex w-full min-w-[96px] flex-col gap-1.5">
      <span className="text-caption font-medium text-text-primary">{bar.text}</span>
      <div className="h-1 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-label="Received" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.share * 100)}>
        <div className={cn('h-1 rounded-full', bar.complete ? 'bg-success' : 'bg-brand-600')} style={{ width: `${Math.max(bar.share * 100, bar.share > 0 ? 4 : 0)}%` }} />
      </div>
    </div>
  );
}

/** §10.5 plan note for Free (same shape as the 8.8a guard note). */
export function PurchasingPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Suppliers and purchase orders are on Starter and Growth. You can still see what’s already recorded.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

export function KpiLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <Skeleton className="h-4 w-2/3 rounded-full" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-3 w-3/4 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Supplier tile icon (153:35999 / 35:6210): 40px card tile with a building glyph. */
export function SupplierIcon({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-card text-brand-600 shadow-elevation-1 [&_svg]:size-5', className)}>
      <Building2 />
    </span>
  );
}

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => (
  <section className={cn('flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)} {...props} />
);

/** "+ Add product" picker (composed): tracked variants of this store from the inventory list, with IN STOCK. */
export function VariantPickerDialog({ onClose, onPick, exclude }: { onClose: () => void; onPick: (item: InventoryItem) => void; exclude: string[] }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useInventory({ q: debounced || undefined, per_page: 20 });
  const rows = (list.data?.data ?? []).filter((i) => i.track_inventory);
  return (
    <Modal open onClose={onClose} size="md" title="Add product" description="Pick a product variant to order. Only products that track stock can be bought on a purchase order.">
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Product, SKU or barcode" label="Search products" />
        {list.isPending ? (
          <LoadingRows rows={3} label="Loading products" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <NoResults title={debounced ? `Nothing matches “${debounced}”` : 'No products that track stock yet'} />
        ) : (
          <ul className="flex max-h-80 flex-col divide-y divide-border-default overflow-y-auto rounded-lg border border-border-default">
            {rows.map((i) => {
              const added = exclude.includes(i.variant_id);
              const variant = i.title !== 'Default' ? i.title : null;
              return (
                <li key={i.variant_id}>
                  <button
                    type="button"
                    disabled={added}
                    aria-label={`Add ${i.product.name}${variant ? ` ${variant}` : ''}`}
                    onClick={() => onPick(i)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle disabled:cursor-default disabled:opacity-60"
                  >
                    <Thumb src={i.product.image?.url} size={36} />
                    <Cell2 top={i.product.name} bottom={[variant, i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ') || undefined} />
                    <span className="ml-auto shrink-0 text-caption text-text-muted">{added ? <Check aria-label="Added" className="size-4 text-success" /> : `${formatCount(i.on_hand)} in stock`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** "Change" supplier picker (composed, 35:6210): searchable list of active suppliers. */
export function SupplierPickerDialog({ onClose, onPick, onAdd, selectedId }: { onClose: () => void; onPick: (s: Supplier) => void; onAdd?: () => void; selectedId?: string | null }) {
  const scope = useStoreScope();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useSuppliers({ q: debounced || undefined, per_page: 50 }, !!scope.storeId);
  const rows = list.data?.data ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Choose supplier"
      footerStart={
        onAdd && (
          <button type="button" onClick={onAdd} className="text-body font-medium text-brand-600 hover:text-brand-700">
            + Add supplier
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Name, phone or city" label="Search suppliers" />
        {list.isPending ? (
          <LoadingRows rows={3} label="Loading suppliers" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <NoResults title={debounced ? `No supplier matches “${debounced}”` : 'No suppliers yet'} description={debounced ? undefined : 'Add the people you buy from first.'} />
        ) : (
          <ul className="flex max-h-80 flex-col divide-y divide-border-default overflow-y-auto rounded-lg border border-border-default">
            {rows.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s)}
                  aria-current={selectedId === s.id || undefined}
                  className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle', selectedId === s.id && 'bg-brand-50')}
                >
                  <Cell2 top={s.name} bottom={[s.contact_name, s.phone ? formatBdPhone(s.phone) : null, s.city].filter(Boolean).join(' · ') || undefined} />
                  {selectedId === s.id && <Check aria-hidden className="ml-auto size-4 shrink-0 text-brand-600" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
