import type { AdminDomainState } from '@storeplix/types';
import { Card, Chip, Pagination } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Globe, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { useDebounced } from '../lib/useDebounced';
import { DomainsTable } from './DomainsTable';

const CHIPS: { value: AdminDomainState; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dns_pending', label: 'DNS pending' },
  { value: 'ssl_failing', label: 'SSL failing' },
  { value: 'suspended', label: 'Suspended' },
];

// Settings – Domains & SSL 45:8156, "Custom domains" table only, as its own sidebar page (§7.1): search + chips All /
// DNS pending / SSL failing / Suspended ("Expiring ≤ 14 d" hidden: no expiry is stored), Export CSV / Add domain hidden.
export function DomainsPage() {
  const [params, setParams] = useSearchParams();
  const state = (CHIPS.find((c) => c.value === params.get('state'))?.value ?? 'all') as AdminDomainState;
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 300);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if ((params.get('q') ?? '') !== debouncedQ) update({ q: debouncedQ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filters = {
    state,
    q: params.get('q') ?? undefined,
    page,
    per_page: 25,
  };
  const list = useQuery({
    queryKey: ['admin', 'domains', 'list', filters],
    queryFn: () => api.admin.domains.list(filters),
    placeholderData: keepPreviousData,
  });
  const filtered = state !== 'all' || !!filters.q;

  return (
    <>
      <PageHeader title="Domains" subtitle="Merchant-owned domains pointed at Storeplix" />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-1 px-5 pt-5">
          <h2 className="text-body-lg font-semibold text-text-primary">Custom domains</h2>
          {list.data && <p className="text-caption text-text-muted">{list.data.meta.total} domains</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <label className="flex h-10 w-full items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus sm:w-64">
            <Search aria-hidden className="size-4 text-text-muted" />
            <input
              type="search"
              aria-label="Search domain or shop"
              placeholder="Search domain or shop"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
          </label>
          <div role="group" aria-label="Domain state" className="flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <Chip
                key={c.value}
                check={false}
                selected={state === c.value}
                onClick={() => update({ state: c.value === 'all' ? null : c.value })}
                className="px-3 py-1.5 text-caption"
              >
                {c.label}
              </Chip>
            ))}
          </div>
        </div>
        <DomainsTable
          className="rounded-none border-x-0 border-b-0 shadow-none"
          rows={list.data?.data ?? []}
          state={
            list.isPending ? (
              <LoadingRows label="Loading domains" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.data.data.length === 0 ? (
              <Empty
                icon={<Globe />}
                title={filtered ? 'No domains match these filters' : 'No custom domains yet'}
                description={filtered ? 'Try another chip or search.' : 'Domains appear when merchants connect one in their dashboard.'}
              />
            ) : undefined
          }
          footer={
            list.data && list.data.meta.total > 0 ? (
              <Pagination
                page={list.data.meta.current_page}
                perPage={list.data.meta.per_page}
                total={list.data.meta.total}
                lastPage={list.data.meta.last_page}
                noun="domains"
                onPage={(p) => update({ page: p > 1 ? String(p) : null })}
              />
            ) : undefined
          }
        />
      </Card>
    </>
  );
}
