import type { AdminTenantFilters } from '@storeplix/api-client';
import type { AdminTenantSummary, AdminTenantTab } from '@storeplix/types';
import { Avatar, DataTable, FloatingMenu, Pagination, Select, formatBdt, formatBdtCompact, formatCount, type DataTableColumn } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building, ExternalLink, Eye, MoreHorizontal, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { relativeTime } from '../analytics/format';
import { TenantStatusBadge } from '../components/badges';
import { PillTabs } from '../components/PillTabs';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { daysUntil, formatDate, intervalLabel, planName } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useDebounced } from '../lib/useDebounced';
import { ImpersonateDialog } from './ImpersonateDialog';

const TABS: {
  value: AdminTenantTab;
  label: string;
  count: 'all' | 'paying' | 'trial' | 'past_due' | 'suspended';
}[] = [
  { value: 'all', label: 'All', count: 'all' },
  { value: 'paying', label: 'Paying', count: 'paying' },
  { value: 'trial', label: 'Trial', count: 'trial' },
  { value: 'past_due', label: 'Past due', count: 'past_due' },
  { value: 'suspended', label: 'Suspended', count: 'suspended' },
];

const SIGNED_UP = [
  { value: '', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const;

const SORTS: {
  value: NonNullable<AdminTenantFilters['sort']>;
  label: string;
}[] = [
  { value: '-created_at', label: 'Newest' },
  { value: '-mrr', label: 'MRR · high to low' },
  { value: '-gmv_30d', label: 'GMV 30d · high to low' },
  { value: '-orders_30d', label: 'Orders 30d · high to low' },
  { value: '-last_active_at', label: 'Last active · recent first' },
  { value: 'created_at', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'current_period_end', label: 'Renewal soonest' },
];

const PER_PAGE = 25;

/** YYYY-MM-DD `days` ago (Asia/Dhaka calendar day). */
export function daysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** URL search params ↔ API filters (tab, q, plan, signed, sort, page). */
export function filtersFromParams(params: URLSearchParams): AdminTenantFilters {
  const tab = params.get('tab') as AdminTenantTab | null;
  const signed = Number(params.get('signed') ?? '');
  const sort = params.get('sort') as AdminTenantFilters['sort'] | null;
  return {
    status: tab && TABS.some((t) => t.value === tab) ? tab : 'all',
    q: params.get('q') ?? undefined,
    plan: params.get('plan') ?? undefined,
    created_from: signed > 0 ? daysAgo(signed) : undefined,
    sort: sort && SORTS.some((s) => s.value === sort) ? sort : undefined,
    page: Math.max(1, Number(params.get('page') ?? '1') || 1),
    per_page: PER_PAGE,
  };
}

function planLine(t: AdminTenantSummary): string {
  if (t.subscription_status === 'trialing') {
    const left = daysUntil(t.trial_ends_at);
    return left !== null && left >= 0 ? `Trial · ${left} day${left === 1 ? '' : 's'} left` : 'Trial';
  }
  if (t.plan_code === 'free') return 'No subscription';
  return intervalLabel(t.billing_interval);
}

// Figma Merchants 32:5527 (8.1 §7.1 + PHASE-8-2 §7.1): header "{n} shops · {paying} paying · {MRR} MRR" (MRR part
// only with `view_analytics`); tabs All / Paying / Trial / Past due / Suspended with counts; search; Plan + Signed up
// filters (District, Health, More filters hidden); columns Shop, Owner, Plan, MRR ৳, Orders 30d, GMV 30d ৳, Last
// active, Status, Signed up (Health hidden, Q105); sort incl. the metric sorts; no checkboxes, bulk bar, Export or Add
// merchant; row menu Open / Impersonate. `metrics` null → "—" in the three metric cells.
export function MerchantsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const filters = filtersFromParams(params);
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q, 300);
  const [impersonate, setImpersonate] = useState<AdminTenantSummary | null>(null);

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
    if ((params.get('q') ?? '') !== debouncedQ.trim()) update({ q: debouncedQ.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.plans.list(),
    staleTime: 10 * 60_000,
  });
  const list = useQuery({
    queryKey: ['admin', 'tenants', 'list', filters],
    queryFn: () => api.admin.tenants.list(filters),
    placeholderData: keepPreviousData,
  });
  const counts = list.data?.meta.counts;
  const analyticsOn = can('view_analytics');
  const mrr = useQuery({
    queryKey: ['admin', 'analytics', 'overview', { range: '30d' }],
    queryFn: () => api.admin.analyticsOverview({ range: '30d' }),
    enabled: analyticsOn,
    staleTime: 5 * 60_000,
  });
  const mrrAmount = analyticsOn && mrr.data?.meta.as_of ? mrr.data.data.mrr.amount : null;
  const metricCell = (t: AdminTenantSummary, value: (m: NonNullable<AdminTenantSummary['metrics']>) => string) => (
    <span className="text-body text-text-primary tabular-nums">{t.metrics ? value(t.metrics) : '—'}</span>
  );

  const columns: DataTableColumn<AdminTenantSummary>[] = [
    {
      key: 'shop',
      header: 'Shop',
      mobileLabel: false,
      cell: (t) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={t.name} size="sm" className="rounded-md" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-text-primary">{t.name}</span>
            <span className="truncate text-caption text-text-muted">{t.store?.primary_host}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      width: 150,
      cell: (t) =>
        t.owner ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body text-text-primary">{t.owner.name}</span>
            <span className="truncate text-caption text-text-muted">{t.owner.phone ?? t.owner.email}</span>
          </span>
        ) : (
          <span className="text-body text-text-muted">—</span>
        ),
    },
    {
      key: 'plan',
      header: 'Plan',
      width: 130,
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body text-text-primary">{planName(t.plan_code)}</span>
          <span className="truncate text-caption text-text-muted">{planLine(t)}</span>
        </span>
      ),
    },
    {
      key: 'mrr',
      header: 'MRR ৳',
      align: 'end',
      width: 72,
      cell: (t) => metricCell(t, (m) => (m.is_comp ? 'Comp' : formatBdt(m.mrr_amount, { symbol: false }))),
    },
    {
      key: 'orders_30d',
      header: 'Orders 30d',
      align: 'end',
      width: 84,
      cell: (t) => metricCell(t, (m) => formatCount(m.orders_30d)),
    },
    {
      key: 'gmv_30d',
      header: 'GMV 30d ৳',
      align: 'end',
      width: 100,
      cell: (t) => metricCell(t, (m) => formatBdt(m.gmv_30d_amount, { symbol: false })),
    },
    {
      key: 'last_active',
      header: 'Last active',
      width: 96,
      cell: (t) => (
        <span className="text-body text-text-secondary" title={t.last_active_at ?? undefined}>
          {relativeTime(t.last_active_at)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 96,
      cell: (t) => <TenantStatusBadge tenant={t} />,
    },
    {
      key: 'created',
      header: 'Signed up',
      width: 100,
      cell: (t) => <span className="text-body text-text-secondary">{formatDate(t.created_at)}</span>,
    },
    {
      key: 'menu',
      header: <span className="sr-only">Actions</span>,
      width: 32,
      align: 'end',
      mobileLabel: false,
      cell: (t) => (
        <span onClick={(e) => e.stopPropagation()}>
          <FloatingMenu
            label={`Actions for ${t.name}`}
            trigger={<MoreHorizontal aria-hidden className="size-5" />}
            entries={[
              {
                key: 'open',
                label: 'Open',
                icon: <ExternalLink />,
                onSelect: () => navigate(`/merchants/${t.id}`),
              },
              ...(can('impersonate')
                ? [
                    {
                      key: 'impersonate',
                      label: 'Impersonate',
                      icon: <Eye />,
                      onSelect: () => setImpersonate(t),
                    },
                  ]
                : []),
            ]}
          />
        </span>
      ),
    },
  ];

  const filtered = !!(filters.q || filters.plan || filters.created_from || filters.status !== 'all');

  return (
    <>
      <PageHeader
        title="Merchants"
        subtitle={
          counts
            ? `${formatCount(counts.all)} shops · ${formatCount(counts.paying)} paying${mrrAmount !== null ? ` · ${formatBdtCompact(mrrAmount)} MRR` : ''}`
            : 'All shops on Storeplix'
        }
      />
      {/* Figma tabs row 32:5666: status tabs · spacer · "Sort" + sort select. */}
      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          aria-label="Merchant status"
          value={filters.status ?? 'all'}
          onChange={(v) => update({ tab: v === 'all' ? null : v })}
          items={TABS.map((t) => ({
            value: t.value,
            label: t.label,
            count: counts ? formatCount(counts[t.count]) : null,
          }))}
        />
        <label className="ml-auto flex items-center gap-3 text-body text-text-secondary">
          Sort
          <Select
            aria-label="Sort"
            value={filters.sort ?? '-created_at'}
            onChange={(e) =>
              update({
                sort: e.target.value === '-created_at' ? null : e.target.value,
              })
            }
            containerClassName="w-56"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex h-11 min-w-[240px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus lg:max-w-[340px]">
          <Search aria-hidden className="size-4 text-text-muted" />
          <input
            type="search"
            aria-label="Search shop, owner, phone or domain"
            placeholder="Search shop, owner, phone or domain"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
          />
        </label>
        <Select aria-label="Plan" value={filters.plan ?? ''} onChange={(e) => update({ plan: e.target.value })} containerClassName="w-40">
          <option value="">Plan: All</option>
          {(plans.data ?? []).map((p) => (
            <option key={p.code} value={p.code}>
              Plan: {p.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Signed up" value={params.get('signed') ?? ''} onChange={(e) => update({ signed: e.target.value })} containerClassName="w-48">
          {SIGNED_UP.map((s) => (
            <option key={s.value} value={s.value}>
              Signed up: {s.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="relative overflow-x-auto rounded-card">
        <DataTable
          label="Merchants"
          className="relative min-w-[1320px]"
          columns={columns}
          rows={list.data?.data ?? []}
          getRowId={(t) => t.id}
          onRowClick={(t) => navigate(`/merchants/${t.id}`)}
          state={
            list.isPending ? (
              <LoadingRows label="Loading merchants" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.data.data.length === 0 ? (
              <Empty
                icon={<Building />}
                title={filtered ? 'No shops match these filters' : 'No merchants yet'}
                description={filtered ? 'Try another search, plan or sign-up range.' : 'Shops appear here as soon as merchants sign up.'}
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
                noun="shops"
                onPage={(p) => update({ page: p > 1 ? String(p) : null })}
              />
            ) : undefined
          }
        />
      </div>
      {impersonate && <ImpersonateDialog tenant={impersonate} onClose={() => setImpersonate(null)} />}
    </>
  );
}
