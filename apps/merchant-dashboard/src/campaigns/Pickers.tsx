import { Modal } from '@storeplix/ui';
import { useState } from 'react';
import { formatBdt } from '../catalog/format';
import { useProducts } from '../catalog/queries';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { SearchBox, Thumb, mediaThumbUrl, useDebounced } from '../catalog/ui';
import { useCoupons } from '../commerce/queries';
import { couponValue } from '../coupons/labels';

// §8.3 merge-tag pickers: "+ Coupon code" picks an active coupon (P85-20: must be active), "+ Product" a product.

const rowClass = 'flex w-full items-center gap-3 border-t border-border-default px-1 py-3 text-left outline-none first:border-t-0 hover:bg-surface-subtle focus-visible:shadow-focus';

export function CouponPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (c: { id: string; code: string }) => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useCoupons({ status: ['active'], q: debounced || undefined, sort: '-revenue', per_page: 25 });
  const rows = list.data?.data ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Pick a coupon" description="Only active coupons can go in a campaign.">
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Search code" label="Search coupons" className="h-[38px] w-full border border-border-default bg-surface-card" />
        <div className="flex max-h-[360px] flex-col overflow-y-auto">
          {list.isPending ? (
            <LoadingRows rows={3} label="Loading coupons" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <NoResults title={debounced ? `No active coupon matches “${debounced}”` : 'No active coupons'} description="Create or turn on a coupon first." />
          ) : (
            rows.map((c) => (
              <button key={c.id} type="button" className={rowClass} onClick={() => onPick({ id: c.id, code: c.code })}>
                <span className="shrink-0 rounded-sm border border-dashed border-brand-500 bg-brand-50 px-2 py-1 text-caption font-medium text-brand-700">{c.code}</span>
                <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{couponValue(c)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ProductPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: { id: string; name: string; slug: string }) => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useProducts({ status: ['active'], q: debounced || undefined, per_page: 25 }, open);
  const rows = list.data?.data ?? [];
  return (
    <Modal open={open} onClose={onClose} title="Pick a product" description="Its name and link go into the message.">
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Search products" label="Search products" className="h-[38px] w-full border border-border-default bg-surface-card" />
        <div className="flex max-h-[360px] flex-col overflow-y-auto">
          {list.isPending ? (
            <LoadingRows rows={3} label="Loading products" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <NoResults title={debounced ? `No product matches “${debounced}”` : 'No active products'} />
          ) : (
            rows.map((p) => (
              <button key={p.id} type="button" className={rowClass} onClick={() => onPick({ id: p.id, name: p.name, slug: p.slug })}>
                <Thumb src={mediaThumbUrl(p.image)} size={36} />
                <span className="min-w-0 flex-1 truncate text-body font-medium text-text-primary">{p.name}</span>
                <span className="shrink-0 text-body text-text-secondary">{formatBdt(p.price_min_amount)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
