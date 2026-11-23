import type { AdminTenantSummary } from '@storeplix/types';
import { Avatar, Modal } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/useDebounced';
import { TenantStatusBadge } from './badges';
import { ErrorState, LoadingRows } from './States';

// Top bar "Impersonate shop" (15:123, §7.1): a shop picker that hands the chosen shop to the reason dialog.
export function ShopPickerDialog({ title, onPick, onClose }: { title: string; onPick: (t: AdminTenantSummary) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const shops = useQuery({
    queryKey: ['admin', 'tenants', 'picker', term],
    queryFn: () => api.admin.tenants.list({ q: term, per_page: 8 }),
  });
  return (
    <Modal open title={title} description="Find the shop by name, slug, owner email or phone, or domain." onClose={onClose} size="md">
      <div className="flex flex-col gap-3">
        <label className="flex h-11 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus">
          <Search aria-hidden className="size-4 text-text-muted" />
          <input
            autoFocus
            type="search"
            aria-label="Search shops"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Shop, owner phone or domain"
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
          />
        </label>
        <div className="-mx-2 max-h-[360px] overflow-y-auto">
          {shops.isPending ? (
            <LoadingRows rows={4} label="Loading shops" />
          ) : shops.isError ? (
            <ErrorState error={shops.error} onRetry={() => void shops.refetch()} />
          ) : shops.data.data.length === 0 ? (
            <p className="px-2 py-6 text-center text-body text-text-secondary">No shop matches “{term}”.</p>
          ) : (
            <ul aria-label="Shops" className="flex flex-col">
              {shops.data.data.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onPick(t)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle"
                  >
                    <Avatar name={t.name} size="sm" className="rounded-md" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body font-semibold text-text-primary">{t.name}</span>
                      <span className="truncate text-caption text-text-muted">{t.store?.primary_host}</span>
                    </span>
                    <TenantStatusBadge tenant={t} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
