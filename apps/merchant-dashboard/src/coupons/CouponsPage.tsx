import type { Coupon, CouponDisplayStatus, CouponListFilters, CouponType } from '@storeplix/types';
import { buttonVariants, cn, CouponStatusBadge, couponStatusMeta, DataTable, KpiTile, Pagination, Tabs, type DataTableColumn } from '@storeplix/ui';
import { Ticket } from 'lucide-react';
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
    {
      key: 'code',
      header: 'Coupon',
      mobileLabel: false,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 rounded-md border border-dashed border-brand-500 bg-brand-50 px-2.5 py-1.5 text-body font-semibold text-brand-700">{c.code}</span>
          <Cell2 top={couponValue(c)} bottom={appliesToLabel(c)} topClass="font-medium" />
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 116,
      cell: (c) => <span className={cn('rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap', typeTone[c.type])}>{couponTypeShort[c.type]}</span>,
    },
    { key: 'min', header: 'Min order', width: 84, cell: (c) => <span className="text-body text-text-primary">{c.min_subtotal_amount ? formatBdt(c.min_subtotal_amount) : '—'}</span> },
    { key: 'usage', header: 'Usage', width: 120, cell: (c) => <UsageMeter used={c.stats.used_count} limit={c.usage_limit} /> },
    { key: 'revenue', header: 'Revenue', width: 100, cell: (c) => <span className="text-body font-semibold text-text-primary">{c.stats.revenue_amount > 0 ? formatBdt(c.stats.revenue_amount) : '—'}</span> },
    { key: 'valid', header: 'Valid', width: 100, cell: (c) => <span className="text-body text-text-secondary">{validLabel(c)}</span> },
    { key: 'status', header: 'Status', width: 96, cell: (c) => <CouponStatusBadge status={c.display_status} /> },
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
              + Create coupon
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
              className="h-[38px] w-full border border-border-default bg-surface-card sm:max-w-[260px] [&>svg]:size-4"
            />
            <FilterSelect label="Type" value={type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">Type: Any</option>
              {(Object.keys(couponTypeLabels) as CouponType[]).map((t) => (
                <option key={t} value={t}>
                  {couponTypeLabels[t]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Status" value={status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Status: Any</option>
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

const couponTypeShort: Record<CouponType, string> = { percentage: 'Percentage', fixed: 'Fixed ৳', free_shipping: 'Free delivery' };
// Coupon/Row 61:12521 type Tag tones.
const typeTone: Record<CouponType, string> = { percentage: 'bg-brand-50 text-brand-700', fixed: 'bg-info-bg text-info', free_shipping: 'bg-success-bg text-success' };

function appliesToLabel(c: Coupon): string {
  const scope =
    c.applies_to === 'categories'
      ? `${c.categories.length} ${c.categories.length === 1 ? 'category' : 'categories'}`
      : c.applies_to === 'products'
        ? c.products.length === 1
          ? c.products[0]!.name
          : `${c.products.length} products`
        : 'All products';
  return [c.first_order_only ? 'New customers only' : scope, c.min_subtotal_amount ? `orders over ${formatBdt(c.min_subtotal_amount)}` : null].filter(Boolean).join(' · ');
}

function validLabel(c: Coupon): string {
  if (c.display_status === 'expired' && c.ends_at) return `Ended ${shortDate(c.ends_at)}`;
  if (!c.ends_at) return c.display_status === 'scheduled' ? shortDate(c.starts_at) : 'Always on';
  return `${shortDate(c.starts_at)} – ${shortDate(c.ends_at)}`;
}

/** Usage meter (Coupon/Row 61:12532): "N / limit used" Caption/12 Medium over 10 segments (9×4, gap 2). */
function UsageMeter({ used, limit }: { used: number; limit: number | null }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const filled = Math.round(ratio * 10);
  const tone = ratio >= 0.9 ? 'bg-warning' : 'bg-brand-600';
  return (
    <span className="flex flex-col gap-1.5">
      <span className="text-caption font-medium whitespace-nowrap text-text-primary">{limit ? `${formatCount(used)} / ${formatCount(limit)} used` : `${formatCount(used)} used · no limit`}</span>
      <span aria-hidden className="flex h-1 gap-0.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={cn('h-1 w-[9px] rounded-[2px]', i < filled ? tone : 'bg-surface-subtle')} />
        ))}
      </span>
    </span>
  );
}

export default CouponsPage;
