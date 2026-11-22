import type { ReturnListFilters } from '@storeplix/api-client';
import type { CourierProvider, ReturnReason, ReturnSummary } from '@storeplix/types';
import { DataTable, KpiTile, Pagination, ReturnStatusBadge, ReturnTypeBadge, Tabs, type DataTableColumn } from '@storeplix/ui';
import { AlertTriangle, PackageCheck, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, useDebounced } from '../catalog/ui';
import { localPhone, timeAgo } from '../commerce/format';
import { PageHeader } from '../layout/PageHeader';
import { courierLabels, returnReasonLabels, returnTabs, type ReturnTab } from './labels';
import { ReturnPanel } from './ReturnPanel';
import { useReturns } from './queries';

// Figma Returns & exchanges 39:9900, detail panel 146:32329. Contract §10: KPI tiles, status tabs with counts, search,
// reason and courier selects, table, side panel. Not built (§14): Return policy button, customer photos, courier
// return pickup ("Pickup booked" tab), "Booked automatically after you approve".

const percent = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(1).replace(/\.0$/, '')}%`);

export function ReturnsPage() {
  const navigate = useNavigate();
  const { returnId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (returnTabs.some((t) => t.value === params.get('status')) ? params.get('status') : 'open') as ReturnTab;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const reason = (params.get('reason') ?? '') as ReturnReason | '';
  const courier = (params.get('courier') ?? '') as CourierProvider | 'manual' | '';
  const page = Number(params.get('page') ?? '1') || 1;

  const filters: ReturnListFilters = {
    status: [tab],
    reason: reason ? [reason] : undefined,
    provider: courier ? [courier] : undefined,
    q: debounced || undefined,
    sort: '-created_at',
    page,
    per_page: 25,
  };
  const list = useReturns(filters);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const search = params.toString() ? `?${params.toString()}` : '';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: DataTableColumn<ReturnSummary>[] = [
    {
      key: 'return',
      header: 'Return',
      width: 130,
      mobileLabel: false,
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="text-body font-semibold text-text-primary">{r.number}</span>
          <Link to={`/orders/${r.order.id}`} onClick={(e) => e.stopPropagation()} className="text-caption font-medium text-brand-600">
            {r.order.number}
          </Link>
          <span className="text-caption text-text-muted">{timeAgo(r.created_at)}</span>
        </div>
      ),
    },
    { key: 'customer', header: 'Customer', mobileLabel: false, cell: (r) => <Cell2 top={r.customer.name} bottom={localPhone(r.customer.phone)} topClass="font-medium" /> },
    {
      key: 'item',
      header: 'Item',
      cell: (r) => {
        const first = r.items_preview[0];
        const more = r.items_preview.length - 1;
        if (!first) return <span className="text-caption text-text-muted">Lines added on receipt</span>;
        return (
          <Cell2
            top={`${first.product_name}${first.quantity > 1 ? ` ×${first.quantity}` : ''}${more > 0 ? ` +${more} more` : ''}`}
            bottom={`${first.variant_title !== 'Default' ? `${first.variant_title} · ` : ''}${formatBdt(r.requested_amount)}`}
          />
        );
      },
    },
    {
      key: 'reason',
      header: 'Reason · Type',
      width: 150,
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <span className="text-body text-text-primary">{returnReasonLabels[r.reason]}</span>
          <ReturnTypeBadge type={r.type} />
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Courier · Status',
      width: 160,
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <ReturnStatusBadge status={r.status} />
          <span className="text-caption text-text-muted">{r.status === 'refunded' && r.refunded_amount > 0 ? `${formatBdt(r.refunded_amount)} back` : r.courier ? courierLabels[r.courier] : r.source === 'courier' ? 'From courier' : ''}</span>
        </div>
      ),
    },
  ];

  const filtered = !!(debounced || reason || courier || tab !== 'open');
  const k = meta?.kpis;

  return (
    <>
      <PageHeader title="Returns & exchanges" subtitle="Approve, inspect and restock. Create a return from a delivered order." />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" aria-label="Return KPIs" role="group">
        <KpiTile icon={<RefreshCw aria-hidden />} label="Open returns" value={k ? formatCount(k.open) : '—'} hint={meta ? `${formatCount(meta.counts.requested)} waiting for your decision` : undefined} />
        <KpiTile icon={<RotateCcw aria-hidden />} label="Return rate · 30 days" value={percent(k?.return_rate_30d)} hint="Of delivered orders" />
        <KpiTile icon={<AlertTriangle aria-hidden />} label="Money lost to returns" value={k ? formatBdt(k.money_lost_amount) : '—'} hint="Refunds and return costs" />
        <KpiTile icon={<PackageCheck aria-hidden />} label="Restocked units" value={k ? formatCount(k.restocked_units_month) : '—'} hint="Back on sale this month" />
      </div>
      <Tabs
        aria-label="Return status"
        value={tab}
        onChange={(v) => set({ status: v === 'open' ? null : v })}
        className="overflow-x-auto"
        items={returnTabs.map((t) => ({ value: t.value, label: t.label, count: meta ? meta.counts[t.value] : undefined }))}
      />
      <div className={returnId ? 'grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start' : undefined}>
        {returnId && (
          <div className="lg:order-2">
            <ReturnPanel id={returnId} onClose={() => navigate(`/returns${search}`)} />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-4 lg:order-1">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                set({ q: v });
              }}
              placeholder="Return id, order or phone"
              label="Search returns"
              className="h-[38px] w-full border border-border-default bg-surface-card sm:max-w-[260px] [&>svg]:size-4"
            />
            <FilterSelect label="Reason" value={reason} onChange={(e) => set({ reason: e.target.value })}>
              <option value="">Any reason</option>
              {(Object.keys(returnReasonLabels) as ReturnReason[]).map((r) => (
                <option key={r} value={r}>
                  {returnReasonLabels[r]}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Courier" value={courier} onChange={(e) => set({ courier: e.target.value })}>
              <option value="">Any courier</option>
              {(Object.keys(courierLabels) as (CourierProvider | 'manual')[]).map((c) => (
                <option key={c} value={c}>
                  {courierLabels[c]}
                </option>
              ))}
            </FilterSelect>
          </div>
        <DataTable
          label="Returns"
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          rowLabel={(r) => r.number}
          onRowClick={(r) => navigate(`/returns/${r.id}${search}`)}
          state={
            list.isPending ? (
              <LoadingRows label="Loading returns" />
            ) : list.isError ? (
              <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
            ) : rows.length === 0 ? (
              filtered ? (
                <NoResults
                  title={debounced ? `No returns match “${debounced}”` : 'No returns here'}
                  description="Try another status or filter."
                  onClear={() => {
                    setQ('');
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                  clearLabel="Clear filters"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <h3 className="text-body-lg font-medium text-text-primary">No open returns</h3>
                  <p className="max-w-sm text-body text-text-secondary">When a customer wants to send something back, open the delivered order and choose “Create return”.</p>
                </div>
              )
            ) : undefined
          }
          footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="returns" onPage={(p) => set({ page: String(p) })} />}
        />
        </div>
      </div>
    </>
  );
}

export default ReturnsPage;
