import type { StockTransfer, StockTransferStatus, StockTransferSummary } from '@storeplix/types';
import { Badge, buttonVariants, Chip, cn, DataTable, Drawer, EmptyState, KpiTile, Pagination, type DataTableColumn } from '@storeplix/ui';
import { ArrowRight, Building2, Check, FileText, Lock, Truck, Warehouse } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatCount, plural } from '../../catalog/format';
import { useStoreScope } from '../../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../../catalog/states';
import { SearchBox, useDebounced } from '../../catalog/ui';
import { PageHeader } from '../../layout/PageHeader';
import { useFeatures } from '../../plan/useFeatures';
import { KpiLoading } from '../../purchasing/components';
import { InventoryTabs } from '../InventoryTabs';
import { multiWarehouseLocked, useStockLocations } from '../locations';
import { TransferPanel } from './TransferPanel';
import { sentRelative, TRANSFER_CHIPS, transferDate, transferPill, useTransfer, useTransfers, useTransferSummary, type TransferChip } from './transfers';

// PHASE-8-8C §10.4 Stock transfers — Figma 153:34425: header 153:34430 ("+ New transfer"), KPI tiles 153:35021 (Drafts
// replaces "Waiting for approval", sub "Not sent yet"; In transit; Received this month; Locations), table card 153:35084
// (chips All / Draft / In transit / Received + Cancelled (composed), TRANSFER · ROUTE · ITEMS · STATUS · DATE), side panel
// 153:35202 at ≥ 1400 px (same breakpoint as Inventory), a right sheet below that and a full-screen sheet below md.
// Routes: /inventory/transfers, /inventory/transfers/new (?from=LOC), /inventory/transfers/:id.

const WIDE = '(min-width: 1400px)';
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(WIDE);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia(WIDE).matches : false),
    () => false,
  );
}

const chipLabel: Record<TransferChip, string> = { all: 'All', draft: 'Draft', in_transit: 'In transit', received: 'Received', cancelled: 'Cancelled' };
const isStatus = (s: string | null): s is StockTransferStatus => !!s && s !== 'all' && (TRANSFER_CHIPS as readonly string[]).includes(s);

export default function TransfersPage() {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const locs = useStockLocations();
  const features = useFeatures().data;
  const locked = multiWarehouseLocked(features);
  const canWrite = scope.canAdjustInventory;
  const rawStatus = params.get('status');
  const status = isStatus(rawStatus) ? rawStatus : null;
  const page = Number(params.get('page') ?? '1') || 1;
  const [qText, setQText] = [params.get('q') ?? '', (v: string) => set({ q: v })];
  const debounced = useDebounced(qText);
  const enoughLocations = locs.active.length > 1;
  const list = useTransfers({ status: status ? [status] : undefined, q: debounced || undefined, page, per_page: 25 });
  const summary = useTransferSummary();
  const isNew = id === 'new';
  const selected = useTransfer(!isNew ? id : null);
  const canCreate = canWrite && !locked && enoughLocations;

  function set(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }

  const listSearch = () => {
    const next = new URLSearchParams(params);
    next.delete('from');
    const s = next.toString();
    return s ? `?${s}` : '';
  };
  const closePanel = () => navigate(`/inventory/transfers${listSearch()}`);
  const open = (t: { id: string }) => navigate(`/inventory/transfers/${t.id}${listSearch()}`);

  const counts = list.data?.meta.counts;
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = !!(status || debounced);

  const columns: DataTableColumn<StockTransfer>[] = [
    {
      key: 'number',
      header: 'Transfer',
      width: 90,
      mobileLabel: false,
      cell: (t) => (
        <Link to={`/inventory/transfers/${t.id}${listSearch()}`} onClick={(e) => e.stopPropagation()} className="text-body font-medium text-brand-600 hover:text-brand-700">
          {t.number}
        </Link>
      ),
    },
    {
      key: 'route',
      header: 'Route',
      cell: (t) => (
        <span className="flex min-w-0 items-center gap-1.5 text-body text-text-primary">
          <span className="truncate">{t.from_location.name}</span>
          <ArrowRight aria-label="to" className="size-3.5 shrink-0 text-text-muted" />
          <span className="truncate">{t.to_location.name}</span>
        </span>
      ),
    },
    { key: 'items', header: 'Items', width: 60, cell: (t) => <span className="text-body text-text-primary">{formatCount(t.units_sent)}</span> },
    {
      key: 'status',
      header: 'Status',
      width: 150,
      cell: (t) => {
        const p = transferPill(t);
        return (
          <Badge tone={p.tone} dot>
            {p.label}
          </Badge>
        );
      },
    },
    { key: 'date', header: 'Date', width: 80, cell: (t) => <span className="text-body text-text-primary">{transferDate(t)}</span> },
  ];

  const state = list.isPending ? (
    <LoadingRows label="Loading transfers" />
  ) : list.isError ? (
    <ErrorBlock error={list.error} title="We couldn’t load your transfers" onRetry={() => void list.refetch()} />
  ) : rows.length === 0 ? (
    filtered ? (
      <NoResults
        title={debounced ? `Nothing matches “${debounced}”` : `No ${chipLabel[status!].toLowerCase()} transfers`}
        onClear={() => setParams(new URLSearchParams(), { replace: true })}
        clearLabel="Clear filters"
      />
    ) : !enoughLocations && !locs.query.isPending ? (
      <EmptyState
        icon={<Warehouse />}
        title="No other locations yet"
        description="Add a shop or another warehouse to move stock between them."
        action={
          <Link to="/inventory/warehouses" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
            Go to Warehouses
          </Link>
        }
      />
    ) : (
      <EmptyState
        icon={<Truck />}
        title="No transfers yet"
        description="No transfers yet — move stock between your locations."
        action={
          canCreate && (
            <Link to="/inventory/transfers/new" className={buttonVariants({ size: 'sm' })}>
              New transfer
            </Link>
          )
        }
      />
    )
  ) : undefined;

  const panelOpen = isNew ? canCreate : !!id;
  const panelBody = isNew ? (
    canCreate ? (
      <TransferPanel key="new" transfer={null} locations={locs.active} initialFrom={params.get('from')} canWrite={canWrite} locked={locked} onClose={closePanel} onSaved={open} inSheet={!wide} />
    ) : null
  ) : selected.isPending ? (
    <LoadingRows rows={4} label="Loading transfer" />
  ) : selected.isError ? (
    <ErrorBlock error={selected.error} title="We couldn’t load this transfer" onRetry={() => void selected.refetch()} />
  ) : selected.data ? (
    <TransferPanel
      key={`${selected.data.id}:${selected.data.revision}:${selected.data.status}`}
      transfer={selected.data}
      locations={locs.active}
      canWrite={canWrite}
      locked={locked}
      onClose={closePanel}
      onSaved={open}
      inSheet={!wide}
    />
  ) : null;

  return (
    <>
      <PageHeader
        title="Stock transfers"
        subtitle="Move stock between your warehouse and shops. Stock leaves on send and arrives when received."
        actions={
          canCreate && (
            <Link to="/inventory/transfers/new" className={buttonVariants()}>
              + New transfer
            </Link>
          )
        }
      />
      <InventoryTabs value="transfers" />
      {locked && <TransferPlanNote canSeePlans={scope.canViewBilling} />}
      {summary.isPending ? (
        <KpiLoading label="Loading transfer summary" />
      ) : summary.isError ? (
        <StateCard>
          <ErrorBlock error={summary.error} title="We couldn’t load the summary" onRetry={() => void summary.refetch()} />
        </StateCard>
      ) : (
        <Kpis s={summary.data} />
      )}

      <div className={cn('grid gap-6', panelOpen && wide && 'grid-cols-[minmax(0,1fr)_380px] items-start')}>
        <section aria-label="Transfers" className="flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div role="group" aria-label="Status" className="-mx-1 flex min-w-0 flex-1 gap-2 overflow-x-auto px-1 py-0.5">
              {TRANSFER_CHIPS.filter((c) => c !== 'cancelled' || (counts?.cancelled ?? 0) > 0 || status === 'cancelled').map((c) => {
                const n = counts?.[c];
                const on = c === 'all' ? status === null : status === c;
                return (
                  <Chip key={c} check={false} selected={on} onClick={() => set({ status: c === 'all' ? null : c })} className="shrink-0">
                    {n === undefined ? chipLabel[c] : `${chipLabel[c]} · ${formatCount(n)}`}
                  </Chip>
                );
              })}
            </div>
            <SearchBox value={qText} onChange={setQText} placeholder="Transfer number" label="Search transfers" className="h-10 w-full lg:w-52" />
          </div>
          <DataTable
            label="Stock transfers"
            className={cn('shadow-none', list.isPlaceholderData && 'opacity-60')}
            columnGap={16}
            columns={columns}
            rows={rows}
            getRowId={(t) => t.id}
            rowLabel={(t) => `${t.number} · ${t.from_location.name} to ${t.to_location.name}`}
            onRowClick={open}
            rowClassName={(t) => (t.id === id ? 'bg-brand-50' : undefined)}
            state={state}
            footer={meta && meta.total > meta.per_page && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="transfers" onPage={(p) => set({ page: String(p) })} />}
          />
        </section>
        {panelOpen && wide && (
          <aside aria-label="Transfer" className="flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
            {panelBody}
          </aside>
        )}
      </div>

      {panelOpen && !wide && (
        <Drawer
          open
          onClose={closePanel}
          title={isNew ? 'New transfer' : (selected.data?.number ?? 'Transfer')}
          className="w-[min(420px,100%)] max-md:w-full max-md:max-w-full max-md:rounded-none max-md:border-0"
        >
          <div className="p-4 sm:p-5">{panelBody}</div>
        </Drawer>
      )}
    </>
  );
}

function Kpis({ s }: { s: StockTransferSummary }) {
  return (
    <section aria-label="Transfer summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <KpiTile icon={<FileText aria-hidden />} label="Drafts" value={formatCount(s.drafts_count)} hint="Not sent yet" />
      <KpiTile
        icon={<Truck aria-hidden />}
        label="In transit"
        value={formatCount(s.in_transit_count)}
        hint={s.in_transit_count > 0 ? [plural(s.in_transit_units, 'item'), sentRelative(s.last_sent_at)].filter(Boolean).join(' · ') : 'Nothing on the way'}
      />
      <KpiTile icon={<Check aria-hidden />} label="Received this month" value={formatCount(s.received_this_month_count)} hint={`${plural(s.received_this_month_units, 'item')} moved`} />
      <KpiTile icon={<Building2 aria-hidden />} label="Locations" value={formatCount(s.locations.count)} hint={s.locations.names.join(' · ') || undefined} />
    </section>
  );
}

function TransferPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Stock transfers are on the Growth plan. You can still receive or cancel transfers already on their way.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

