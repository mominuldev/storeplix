import type { AdminInvoiceFilters } from '@storeplix/api-client';
import type { BillingInvoiceStatus } from '@storeplix/types';
import { Card, Pagination, Select, formatCount } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PillTabs } from '../components/PillTabs';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { useDebounced } from '../lib/useDebounced';
import { InvoiceDrawer } from './InvoiceDrawer';
import { InvoicesTable } from './InvoicesTable';

type Tab = 'all' | BillingInvoiceStatus;
const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];
const METHODS = [
  { value: '', label: 'All' },
  { value: 'bkash', label: 'bKash' },
  { value: 'sslcommerz', label: 'SSLCommerz' },
  { value: 'manual', label: 'Manual' },
];

// Billing & subscriptions 34:859 — invoice table only (§7.1): tabs All / Open / Paid / Void (Failed / Retrying /
// Refunded hidden), "Invoice no. or shop" search, Method filter. KPI row, retry queue and dunning settings hidden
// (Q97). `?invoice=` opens the drawer 36:1598 (also the target of global search).
export function BillingPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'all') as Tab;
  const provider = params.get('method') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const invoiceId = params.get('invoice');
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 300);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch) && !('invoice' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if ((params.get('q') ?? '') !== debouncedQ) update({ q: debouncedQ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filters: AdminInvoiceFilters = {
    status: tab === 'all' ? undefined : tab,
    provider: provider || undefined,
    q: params.get('q') ?? undefined,
    page,
    per_page: 25,
  };
  const list = useQuery({
    queryKey: ['admin', 'invoices', filters],
    queryFn: () => api.admin.invoices.list(filters),
    placeholderData: keepPreviousData,
  });
  const filtered = tab !== 'all' || !!provider || !!filters.q;

  return (
    <>
      <PageHeader title="Billing & subscriptions" subtitle="Platform invoices for every shop · times in Asia/Dhaka" />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-4">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-body-lg font-semibold text-text-primary">Invoices</h2>
            {list.data && <p className="text-caption text-text-muted">{formatCount(list.data.meta.total)} invoice{list.data.meta.total === 1 ? '' : 's'}</p>}
          </div>
          <div className="flex-1" />
          {/* Figma 34:859 card header: title · tabs · search · Method, one row (wraps when narrow). */}
          <PillTabs aria-label="Invoice status" value={tab} onChange={(v) => update({ tab: v === 'all' ? null : v })} items={TABS} />
          <label className="flex h-10 w-full items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus sm:w-56">
            <Search aria-hidden className="size-4 text-text-muted" />
            <input
              type="search"
              aria-label="Invoice no. or shop"
              placeholder="Invoice no. or shop"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
          </label>
          <Select aria-label="Method" value={provider} onChange={(e) => update({ method: e.target.value })} containerClassName="w-44" className="h-10">
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                Method: {m.label}
              </option>
            ))}
          </Select>
        </div>
        <InvoicesTable
          rows={list.data?.data ?? []}
          onOpen={(i) => update({ invoice: i.id })}
          state={
            list.isPending ? (
              <LoadingRows label="Loading invoices" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.data.data.length === 0 ? (
              <Empty
                icon={<FileText />}
                title={filtered ? 'No invoices match these filters' : 'No invoices yet'}
                description={filtered ? 'Try another tab, method or search.' : 'Invoices appear when shops subscribe to a paid plan.'}
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
                noun="invoices"
                onPage={(p) => update({ page: p > 1 ? String(p) : null })}
              />
            ) : undefined
          }
        />
      </Card>
      {invoiceId && <InvoiceDrawer invoiceId={invoiceId} onClose={() => update({ invoice: null })} />}
    </>
  );
}
