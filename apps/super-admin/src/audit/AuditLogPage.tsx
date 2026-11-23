import type { AdminAuditFilters } from '@storeplix/api-client';
import type { AuditActorType } from '@storeplix/types';
import { Button, Card, Input, Select, Toggle } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText, Search, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ShopPickerDialog } from '../components/ShopPickerDialog';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { AuditTable } from './AuditTable';
import { CursorFooter } from './CursorFooter';
import { useCursorPages } from './useCursorPages';

const ACTORS: { value: '' | AuditActorType; label: string }[] = [
  { value: '', label: 'All actors' },
  { value: 'platform_user', label: 'Platform staff' },
  { value: 'user', label: 'Merchant users' },
  { value: 'system', label: 'System' },
];

const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'admin.', label: 'Staff sign-in & impersonation' },
  { value: 'tenant.', label: 'Suspensions' },
  { value: 'subscription.', label: 'Plan changes & extensions' },
  { value: 'billing.', label: 'Invoices & payments' },
  { value: 'domain.', label: 'Domains' },
  { value: 'platform.', label: 'Team & roles' },
];

const PER_PAGE = 50;

// Audit log 39:16118 (§7.1): Actor / Action type / Merchant / Date filters + "Impersonations only", expandable rows.
// "Kept 2 years · hash-chained", Verify chain, Export CSV and the before/after diff are hidden (Q100).
export function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  const [picker, setPicker] = useState(false);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'tenant' && !v) next.delete('tenant_name');
    setParams(next, { replace: true });
  };

  const filters: AdminAuditFilters = {
    tenant: params.get('tenant') ?? undefined,
    actor_type: (params.get('actor_type') as AuditActorType | null) ?? undefined,
    action: params.get('action') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    impersonation: params.get('impersonation') === '1',
    per_page: PER_PAGE,
  };
  const pages = useCursorPages(JSON.stringify(filters));
  const query = { ...filters, cursor: pages.cursor };
  const list = useQuery({
    queryKey: ['admin', 'audit', query],
    queryFn: () => api.admin.auditLogs(query),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(filters.tenant || filters.actor_type || filters.action || filters.from || filters.to || filters.impersonation);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every admin and merchant action across Storeplix · times in Asia/Dhaka (GMT+6)" />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 px-5 pt-5 pb-4">
          <Select label="Actor" value={filters.actor_type ?? ''} onChange={(e) => set('actor_type', e.target.value)} containerClassName="w-44">
            {ACTORS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
          <Select label="Action type" value={filters.action ?? ''} onChange={(e) => set('action', e.target.value)} containerClassName="w-56">
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
          <div className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-text-primary">Merchant</span>
            {filters.tenant ? (
              <span className="flex h-11 items-center gap-2 rounded-md border border-border-default bg-surface-card pr-1.5 pl-3 text-body">
                <span className="max-w-40 truncate">{params.get('tenant_name') ?? 'Selected shop'}</span>
                <button
                  type="button"
                  aria-label="Clear merchant"
                  onClick={() => set('tenant', null)}
                  className="rounded-sm p-1 text-text-muted hover:bg-surface-subtle"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </span>
            ) : (
              <Button variant="secondary" className="h-11" onClick={() => setPicker(true)}>
                <Search aria-hidden className="size-4" />
                Any merchant
              </Button>
            )}
          </div>
          <Input label="From" type="date" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} containerClassName="w-40" />
          <Input label="To" type="date" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value)} containerClassName="w-40" />
          <label className="flex h-11 items-center gap-2.5 rounded-md border border-border-default px-3 text-body text-text-primary">
            <Toggle label="Impersonations only" checked={!!filters.impersonation} onChange={(on) => set('impersonation', on ? '1' : null)} />
            Impersonations only
          </label>
          {filtered && (
            <Button variant="ghost" size="sm" className="h-11" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </Button>
          )}
        </div>
        <AuditTable
          rows={list.data?.data ?? []}
          state={
            list.isPending ? (
              <LoadingRows label="Loading audit log" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.data.data.length === 0 ? (
              <Empty
                icon={<ScrollText />}
                title={filtered ? 'No events match these filters' : 'No events yet'}
                description={filtered ? 'Try a wider date range or fewer filters.' : 'Admin and merchant actions are recorded here.'}
              />
            ) : undefined
          }
          footer={
            list.data && (list.data.data.length > 0 || pages.page > 1) ? (
              <CursorFooter
                page={pages.page}
                count={list.data.data.length}
                hasNext={!!list.data.meta.next_cursor}
                onPrev={pages.prev}
                onNext={() => list.data.meta.next_cursor && pages.next(list.data.meta.next_cursor)}
              />
            ) : undefined
          }
        />
      </Card>
      {picker && (
        <ShopPickerDialog
          title="Filter by merchant"
          onClose={() => setPicker(false)}
          onPick={(t) => {
            setPicker(false);
            const next = new URLSearchParams(params);
            next.set('tenant', t.id);
            next.set('tenant_name', t.name);
            setParams(next, { replace: true });
          }}
        />
      )}
    </>
  );
}
