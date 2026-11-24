import type { PurchaseOrder, PurchaseOrderStatus, PurchaseOrderSummary } from '@storeplix/types';
import { Button, buttonVariants, Chip, cn, DataTable, EmptyState, KpiTile, Pagination, type DataTableColumn } from '@storeplix/ui';
import { AlertTriangle, ClipboardList, CreditCard, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { SearchBox, Thumb, useDebounced } from '../catalog/ui';
import { InventoryTabs } from '../inventory/InventoryTabs';
import { PageHeader } from '../layout/PageHeader';
import { useFeatures } from '../plan/useFeatures';
import { localToday } from '../reports/range';
import { KpiLoading, PoStatusBadge, PurchasingPlanNote, ReceivingBar } from './components';
import { QuickPurchaseDialog } from './dialogs';
import { expectedCell, itemsLine, orderedCell, PO_STATUS_CHIPS, poStatusMeta, purchasingLocked } from './purchasing';
import { usePurchaseOrders, usePurchaseOrderSummary } from './queries';
import { ReorderCard } from './ReorderCard';

// PHASE-8-8B §10.2 Purchase orders — Figma 35:5619: KPI tiles, status chips with counts, search, table (PO, supplier ·
// items with up to 2 thumbnails, receiving bar, ordered, expected "· late", total, paid, status), reorder suggestions.
// "Suppliers" header button hidden (the tab exists); "Quick purchase" composed. Adjust-only receivers see the list
// without money (no KPIs, total/paid columns hidden). Below md the table stacks as cards (DataTable).

const isStatus = (s: string | null): s is PurchaseOrderStatus => !!s && s in poStatusMeta;

export default function PurchaseOrdersPage() {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: PurchaseOrderStatus | null = isStatus(rawStatus) ? rawStatus : null;
  const page = Number(params.get('page') ?? '1') || 1;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const manage = scope.canManagePurchasing;
  const summary = usePurchaseOrderSummary(manage);
  const list = usePurchaseOrders({ status: status ? [status] : undefined, q: debounced || undefined, page, per_page: 25 });
  const locked = purchasingLocked(useFeatures().data);
  const [quickOpen, setQuickOpen] = useState(false);
  const today = localToday(scope.store?.timezone);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const counts = list.data?.meta.counts;
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = !!(status || debounced);

  const columns: DataTableColumn<PurchaseOrder>[] = [
    {
      key: 'number',
      header: 'PO',
      width: 96,
      mobileLabel: false,
      cell: (po) => (
        <Link to={`/inventory/purchase-orders/${po.id}`} className="text-body-lg font-medium text-brand-600 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>
          {po.number}
        </Link>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier · Items',
      mobileLabel: false,
      cell: (po) => (
        <div className="flex min-w-0 items-center gap-3">
          {po.preview_items.length > 0 && (
            <span className="flex shrink-0 -space-x-2">
              {po.preview_items.slice(0, 2).map((p, i) => (
                <Thumb key={i} src={p.image?.url} size={32} className="ring-2 ring-surface-card" />
              ))}
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-medium text-text-primary">{po.supplier.name}</span>
            <span className="truncate text-caption text-text-secondary">{itemsLine(po)}</span>
          </span>
        </div>
      ),
    },
    { key: 'receiving', header: 'Receiving', width: 120, cell: (po) => <ReceivingBar po={po} /> },
    { key: 'ordered', header: 'Ordered', width: 76, cell: (po) => <span className="text-body text-text-secondary">{orderedCell(po, today, scope.store?.timezone)}</span> },
    {
      key: 'expected',
      header: 'Expected',
      width: 104,
      cell: (po) => {
        const e = expectedCell(po);
        return <span className={cn('text-body', e.late ? 'text-danger' : 'text-text-secondary')}>{e.text}</span>;
      },
    },
    ...(manage
      ? ([
          { key: 'total', header: 'Total', width: 96, align: 'end', cell: (po) => <span className="text-body font-semibold text-text-primary">{formatBdt(po.total_amount)}</span> },
          { key: 'paid', header: 'Paid', width: 88, align: 'end', cell: (po) => <span className="text-body text-text-primary">{formatBdt(po.paid_amount)}</span> },
        ] satisfies DataTableColumn<PurchaseOrder>[])
      : []),
    { key: 'status', header: 'Status', width: 116, cell: (po) => <PoStatusBadge status={po.status} /> },
  ];

  const state = list.isPending ? (
    <LoadingRows label="Loading purchase orders" />
  ) : list.isError ? (
    <ErrorBlock error={list.error} title="We couldn’t load your purchase orders" onRetry={() => void list.refetch()} />
  ) : rows.length === 0 ? (
    filtered ? (
      <NoResults
        title={debounced ? `Nothing matches “${debounced}”` : `No ${poStatusMeta[status!].label.toLowerCase()} purchase orders`}
        onClear={() => {
          setQ('');
          setParams(new URLSearchParams(), { replace: true });
        }}
        clearLabel="Clear filters"
      />
    ) : (
      <EmptyState
        icon={<ClipboardList />}
        title="No purchase orders yet"
        description={manage ? 'No purchase orders yet — create one or record a quick purchase.' : 'Purchase orders your shop sends to suppliers show here.'}
        action={
          manage && (
            <Link to="/inventory/purchase-orders/new" className={buttonVariants({ size: 'sm' })}>
              New purchase order
            </Link>
          )
        }
      />
    )
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Every stock change is recorded. Available = on hand − held for orders."
        actions={
          manage && (
            <>
              <Button variant="secondary" onClick={() => setQuickOpen(true)}>
                Quick purchase
              </Button>
              <Link to="/inventory/purchase-orders/new" className={buttonVariants()}>
                + New purchase order
              </Link>
            </>
          )
        }
      />
      <InventoryTabs value="purchase-orders" />
      {locked && <PurchasingPlanNote canSeePlans={scope.canViewBilling} />}
      {manage &&
        (summary.isPending ? (
          <KpiLoading label="Loading purchase order summary" />
        ) : summary.isError ? (
          <StateCard>
            <ErrorBlock error={summary.error} title="We couldn’t load the summary" onRetry={() => void summary.refetch()} />
          </StateCard>
        ) : (
          <Kpis s={summary.data} />
        ))}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="group" aria-label="Status" className="-mx-1 flex min-w-0 flex-1 gap-2 overflow-x-auto px-1 py-0.5">
          {PO_STATUS_CHIPS.filter((c) => c === 'all' || c !== 'closed' || (counts?.closed ?? 0) > 0).map((c) => {
            const label = c === 'all' ? 'All' : poStatusMeta[c].label;
            const n = counts?.[c];
            const selected = c === 'all' ? status === null : status === c;
            return (
              <Chip key={c} check={false} selected={selected} onClick={() => set({ status: c === 'all' ? null : c })} className="shrink-0">
                {n === undefined ? label : `${label} · ${formatCount(n)}`}
              </Chip>
            );
          })}
        </div>
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            set({ q: v });
          }}
          placeholder="PO number or supplier"
          label="Search purchase orders"
          className="h-10 w-full lg:w-60"
        />
      </div>

      <DataTable
        label="Purchase orders"
        className={cn(list.isPlaceholderData && 'opacity-60')}
        columns={columns}
        rows={rows}
        getRowId={(po) => po.id}
        rowLabel={(po) => `${po.number} · ${po.supplier.name}`}
        onRowClick={(po) => navigate(`/inventory/purchase-orders/${po.id}`)}
        state={state}
        footer={meta && meta.total > meta.per_page && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="purchase orders" onPage={(p) => set({ page: String(p) })} />}
      />

      <ReorderCard />

      {quickOpen && (
        <QuickPurchaseDialog
          onClose={() => setQuickOpen(false)}
          onDone={(po) => {
            setQuickOpen(false);
            navigate(`/inventory/purchase-orders/${po.id}`);
          }}
        />
      )}
    </>
  );
}

function Kpis({ s }: { s: PurchaseOrderSummary }) {
  return (
    <section aria-label="Purchase order summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <KpiTile icon={<ClipboardList aria-hidden />} label="Open orders" value={formatCount(s.open_count)} hint={`${formatBdt(s.open_total_amount)} in total`} />
      <KpiTile icon={<Truck aria-hidden />} label="Units coming" value={formatCount(s.units_coming)} hint={`Across ${plural(s.suppliers_coming, 'supplier')}`} />
      <KpiTile
        icon={<CreditCard aria-hidden />}
        label="Owed to suppliers"
        value={<span className={s.owed_amount > 0 ? 'text-warning' : undefined}>{formatBdt(s.owed_amount)}</span>}
        hint={s.payments_due_this_week > 0 ? `${plural(s.payments_due_this_week, 'payment')} due this week` : 'Nothing due this week'}
      />
      <KpiTile
        icon={<AlertTriangle aria-hidden />}
        label="Late deliveries"
        value={<span className={s.late_count > 0 ? 'text-danger' : undefined}>{formatCount(s.late_count)}</span>}
        hint={s.first_late ? `${s.first_late.number} · ${plural(s.first_late.days_late, 'day')} late` : 'Everything on time'}
      />
    </section>
  );
}
