import { useEffect, useId, useRef, useState } from 'react';
import { formatCount } from '../catalog/format';
import { useInventory } from '../catalog/queries';
import { ErrorBlock, LoadingRows } from '../catalog/states';

// PHASE-8-8C §10.3 (composed): the product editor stock field edits the **default** location; below it "+ n at other
// locations" opens a popover listing the other active locations' on-hand. Shown only when stock exists elsewhere
// (`other_locations_on_hand > 0`, which needs > 1 location), so a one-location store makes no extra request.

export function OtherLocationsStock({ productId, variantId, defaultLocationId, count, label }: { productId: string; variantId: string; defaultLocationId: string; count: number; label: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const list = useInventory({ product_id: productId, per_page: 100 }, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (count <= 0) return null;
  const item = list.data?.data.find((i) => i.variant_id === variantId);
  const others = (item?.locations ?? []).filter((l) => l.id !== defaultLocationId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${formatCount(count)} at other locations`}
        onClick={() => setOpen((o) => !o)}
        className="text-left text-caption font-medium text-brand-600 outline-none hover:text-brand-700 focus-visible:shadow-focus"
      >
        + {formatCount(count)} at other locations
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Stock at other locations for ${label}`}
          className="absolute top-full left-0 z-20 mt-1.5 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-border-default bg-surface-card p-3 shadow-elevation-1"
        >
          <span className="text-caption text-text-muted">This field edits your default location. Other locations:</span>
          {list.isPending ? (
            <LoadingRows rows={2} label="Loading stock per location" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {others.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 text-body">
                  <span className="min-w-0 truncate text-text-secondary">{l.name}</span>
                  <span className="font-medium text-text-primary">{formatCount(l.on_hand)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
