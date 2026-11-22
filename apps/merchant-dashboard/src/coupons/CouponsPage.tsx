import type { Coupon, CouponDisplayStatus, CouponListFilters, CouponType } from '@storeplix/types';
import { buttonVariants, CouponStatusBadge, couponStatusMeta, DataTable, KpiTile, Pagination, Tabs, type DataTableColumn } from '@storeplix/ui';
import { Plus, Ticket } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount, shortDate } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, useDebounced } from '../catalog/ui';
import { useCoupons } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { couponTypeLabels, couponValue } from './labels';

// Figma Discounts & coupons 67:18689. Contract §9: tabs All / Active / Scheduled / Expired with counts, only the
// "Active coupons" tile, code search, Type and Status dropdowns, sort Most revenue; row → edit; "+ Create coupon" O A.
// Not built (§11): tip card, Marketing overview, campaigns, abandoned cart.

type Tab = 'all' | 'active' | 'scheduled' | 'expired';
const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'expired', label: 'Expired' },
];

export function CouponsPage() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'all') as Tab;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const type = (params.get('type') ?? '') as CouponType | '';
  const status = (params.get('status') ?? '') as CouponDisplayStatus | '';
  const sort = params.get('sort') === '-revenue' ? '-revenue' : '-created_at';
  const page = Number(params.get('page') ?? '1') || 1;

  const statusFilter: CouponDisplayStatus[] | undefined = status ? [status] : tab === 'all' ? undefined : tab === 'expired' ? ['expired', 'used_up'] : [tab];
  const filters: CouponListFilters = { q: debounced || undefined, type: type ? [type] : undefined, status: statusFilter, sort, page, per_page: 25 };
  const list = useCoupons(filters);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: DataTableColumn<Coupon>[] = [
    { key: 'code', header: 'Code', mobileLabel: false, cell: (c) => <Cell2 top={c.code} bottom={couponValue(c)} /> },
    { key: 'type', header: 'Type', width: 120, cell: (c) => <span className="text-body text-text-primary">{couponTypeLabels[c.type]}</span> },
    { key: 'min', header: 'Min order', width: 100, cell: (c) => <span className="text-body text-text-secondary">{c.min_subtotal_amount ? formatBdt(c.min_subtotal_amount) : '—'}</span> },
    {
      key: 'usage',
      header: 'Usage',
      width: 90,
      cell: (c) => (
        <span className="text-body text-text-primary">
          {formatCount(c.stats.used_count)}
          {c.usage_limit ? ` / ${formatCount(c.usage_limit)}` : ''}
        </span>
      ),
    },
    { key: 'revenue', header: 'Revenue', width: 110, cell: (c) => <span className="text-body font-semibold text-text-primary">{formatBdt(c.stats.revenue_amount)}</span> },
    { key: 'valid', header: 'Valid', width: 140, cell: (c) => <span className="text-body text-text-secondary">{`${shortDate(c.starts_at)} – ${c.ends_at ? shortDate(c.ends_at) : 'no end'}`}</span> },
    { key: 'status', header: 'Status', width: 110, cell: (c) => <CouponStatusBadge status={c.display_status} /> },
  ];

  const filtered = !!(debounced || type || status || tab !== 'all');

  return (
    <>
      <PageHeader
        title="Discounts & coupons"
        subtitle="Codes customers type at checkout or open from your share link."
        actions={
          scope.canManageMarketing && (
            <Link to="/marketing/coupons/new" className={buttonVariants()}>
              <Plus aria-hidden className="size-4" /> Create coupon
            </Link>
          )
        }
      />
      <Tabs aria-label="Coupon groups" value={tab} onChange={(v) => set({ tab: v === 'all' ? null : v, status: null })} items={TABS.map((t) => ({ ...t, count: meta?.counts[t.value] }))} />
      <section aria-label="Coupon summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon={<Ticket />} label="Active coupons" value={formatCount(meta?.counts.active ?? 0)} hint={`${formatCount(meta?.counts.scheduled ?? 0)} scheduled`} />
      </section>
      <DataTable
        label="Coupons"
        toolbar={
          <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                set({ q: v });
              }}
              placeholder="Search code"
              label="Search coupons"
              className="w-full sm:max-w-[260px]"
            />
            <FilterSelect label="Type" value={type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">Type</option>
              {(Object.keys(couponTypeLabels) as CouponType[]).map((t) => (
                <option key={t} value={t}>
                  {couponTypeLabels[t]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Status" value={status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Status</option>
              {(Object.keys(couponStatusMeta) as CouponDisplayStatus[]).map((s) => (
                <option key={s} value={s}>
                  {couponStatusMeta[s].label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === '-created_at' ? null : e.target.value })} className="sm:ml-auto">
              <option value="-created_at">Newest</option>
              <option value="-revenue">Most revenue</option>
            </FilterSelect>
          </div>
        }
        columns={columns}
        rows={rows}
        getRowId={(c) => c.id}
        onRowClick={(c) => navigate(`/marketing/coupons/${c.id}`)}
        state={
          list.isPending ? (
            <LoadingRows label="Loading coupons" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            filtered ? (
              <NoResults
                title={debounced ? `No coupons match “${debounced}”` : 'No coupons here'}
                onClear={() => {
                  setQ('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
                clearLabel="Clear filters"
              />
            ) : (
              <NoResults
                title="No coupons yet"
                description="Create a code like EID20 and share the link on Facebook."
                onClear={scope.canManageMarketing ? () => navigate('/marketing/coupons/new') : undefined}
                clearLabel="Create coupon"
              />
            )
          ) : undefined
        }
        footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="coupons" onPage={(p) => set({ page: String(p) })} />}
      />
    </>
  );
}

export default CouponsPage;
