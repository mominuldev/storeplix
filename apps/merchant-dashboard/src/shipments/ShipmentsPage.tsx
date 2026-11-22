import { isApiError } from '@storeplix/api-client';
import type { CourierProvider, ShipmentListFilters, ShipmentListMeta, ShipmentSummary } from '@storeplix/types';
import { Button, buttonVariants, Chip, cn, DataTable, KpiTile, Pagination, ProviderLogo, ShipmentStatusBadge, type DataTableColumn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, MapPin, Phone, Printer, Truck, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount, plural, shortDate } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, useDebounced } from '../catalog/ui';
import { clock, localPhone, timeAgo } from '../commerce/format';
import { usePrintJob } from '../documents/usePrintJob';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { BulkBookDialog } from './BulkBookDialog';
import { codCell, COURIERS, courierName, isCourier, manifestCsv, problemLabels, RANGES, rangeFilter, statusFilters, type StatusFilter } from './labels';
import { useShipmentInvalidate, useShipments } from './queries';

// Figma Shipments 39:10347 (PHASE-5B §10): header with "Synced with couriers N min ago", Sync now (1/min, P5B-38),
// Book parcels (bulk 39:18808); KPI tiles incl. COD held by couriers (P5B-43); Needs attention (problems, Call
// customer); COD with couriers per provider; courier chips with counts, status, date range, search; table (cards
// under md, OrderCard pattern 30:3171); bulk bar Print labels + Download manifest (client CSV). Not built (§14):
// Reschedule, Request return, View payouts, "Next payout" hints.

export const SYNC_COOLDOWN_S = 60;

export function ShipmentsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const providerParam = params.get('courier');
  const provider = providerParam && (isCourier(providerParam) || providerParam === 'manual') ? (providerParam as CourierProvider | 'manual') : null;
  const status = (statusFilters.some((s) => s.value === params.get('status')) ? params.get('status') : '') as StatusFilter;
  const range = RANGES.some((r) => r.value === params.get('range')) ? params.get('range')! : '7';
  const page = Number(params.get('page') ?? '1') || 1;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const [selected, setSelected] = useState<string[]>([]);
  const [booking, setBooking] = useState(false);
  const print = usePrintJob();

  const filters: ShipmentListFilters = {
    provider: provider ? [provider] : undefined,
    status: status ? [status] : undefined,
    ...rangeFilter(range),
    q: debounced || undefined,
    sort: '-booked_at',
    page,
    per_page: 25,
  };
  const list = useShipments(filters);
  const problems = useShipments({ status: ['problems'], sort: '-booked_at', per_page: 5 });
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
    setSelected([]);
  };

  const selectedRows = rows.filter((r) => selected.includes(r.id));
  // counts are per courier over the store's parcels; 0 everywhere means "no parcels yet" rather than "no match".
  const hasParcels = (meta?.counts.all ?? 0) > 0 || !!debounced;

  const columns: DataTableColumn<ShipmentSummary>[] = [
    {
      key: 'consignment',
      header: 'Consignment',
      width: 150,
      mobileLabel: false,
      cell: (s) => <Cell2 top={s.consignment_id ?? s.tracking_code ?? '—'} bottom={s.booked_at ? `Booked ${shortDate(s.booked_at)}` : s.shipped_at ? `Shipped ${shortDate(s.shipped_at)}` : undefined} />,
    },
    {
      key: 'order',
      header: 'Order',
      width: 96,
      cell: (s) => (
        <Link to={`/orders/${s.order.id}`} onClick={(e) => e.stopPropagation()} className="text-body font-semibold text-brand-600 hover:text-brand-700">
          {s.order.number}
        </Link>
      ),
    },
    { key: 'customer', header: 'Customer', mobileLabel: false, cell: (s) => <Cell2 top={s.order.customer_name} bottom={`${s.order.thana}, ${s.order.district}`} topClass="font-medium" /> },
    {
      key: 'courier',
      header: 'Courier',
      width: 130,
      cell: (s) => (
        <span className="inline-flex items-center gap-2">
          {isCourier(s.provider) && <ProviderLogo provider={s.provider} size="sm" />}
          <span className="text-body text-text-primary">{isCourier(s.provider) ? courierName[s.provider] : (s.carrier_name ?? courierName.manual)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status · Last scan',
      width: 200,
      cell: (s) => (
        <span className="flex min-w-0 flex-col items-end gap-1 md:items-start">
          <ShipmentStatusBadge status={s.status} />
          <span className="truncate text-caption text-text-muted">{[s.last_location, s.last_event_at ? lastScan(s.last_event_at) : null].filter(Boolean).join(' · ') || (s.problem ? problemLabels[s.problem] : '')}</span>
        </span>
      ),
    },
    { key: 'attempts', header: 'Attempts', width: 80, align: 'center', hideOnMobile: true, cell: (s) => <span className={cn('text-body', s.attempts >= 2 ? 'font-semibold text-danger' : 'text-text-primary')}>{formatCount(s.attempts)}</span> },
    {
      key: 'cod',
      header: 'COD',
      width: 110,
      align: 'end',
      cell: (s) => {
        const c = codCell(s);
        return <Cell2 top={formatBdt(c.amount)} bottom={c.label} bottomClass={c.tone === 'danger' ? 'text-danger' : undefined} />;
      },
    },
    { key: 'age', header: 'Age', width: 56, align: 'end', hideOnMobile: true, cell: (s) => <span className={cn('text-body', s.age_days >= 5 ? 'text-warning' : 'text-text-secondary')}>{s.age_days} d</span> },
  ];

  const downloadManifest = () => {
    const blob = new Blob(['\uFEFF', manifestCsv(selectedRows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `manifest-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <PageHeader
        title="Shipments"
        subtitle="Every parcel with your couriers: where it is, what’s stuck, and the COD money they’re holding."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <span className="hidden items-center gap-1.5 text-caption text-text-muted md:flex">
              <Clock aria-hidden className="size-3.5" /> {meta?.last_synced_at ? `Synced with couriers ${timeAgo(meta.last_synced_at)}` : 'Not synced yet'}
            </span>
            <SyncButton />
            <Button onClick={() => setBooking(true)}>Book parcels</Button>
          </div>
        }
      />
      <Kpis meta={meta} pending={list.isPending} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <NeedsAttention rows={problems.data?.data ?? []} total={problems.data?.meta.total ?? 0} pending={problems.isPending} failed={problems.isError} onAll={() => set({ status: 'problems', range: 'all' })} />
        <CodWithCouriers meta={meta} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Courier" className="flex flex-wrap gap-2">
          <Chip selected={!provider} onClick={() => set({ courier: null })}>
            All couriers <Count n={meta?.counts.all} on={!provider} />
          </Chip>
          {COURIERS.map((c) => (
            <Chip key={c} selected={provider === c} onClick={() => set({ courier: provider === c ? null : c })}>
              <ProviderLogo provider={c} size="sm" className="-my-1 size-6 border-0" /> {courierName[c]} <Count n={meta?.counts[c]} on={provider === c} />
            </Chip>
          ))}
          {(meta?.counts.manual ?? 0) > 0 && (
            <Chip selected={provider === 'manual'} onClick={() => set({ courier: provider === 'manual' ? null : 'manual' })}>
              {courierName.manual} <Count n={meta?.counts.manual} on={provider === 'manual'} />
            </Chip>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <FilterSelect label="Status" value={status} onChange={(e) => set({ status: e.target.value || null })}>
            {statusFilters.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Date range" value={range} onChange={(e) => set({ range: e.target.value === '7' ? null : e.target.value })}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </FilterSelect>
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              set({ q: v });
            }}
            placeholder="Consignment, order or phone"
            label="Search shipments"
            className="h-[38px] w-full border border-border-default bg-surface-card sm:w-[214px] [&>svg]:size-4"
          />
        </div>
      </div>

      <DataTable
        label="Shipments"
        columns={columns}
        rows={rows}
        getRowId={(s) => s.id}
        rowLabel={(s) => s.consignment_id ?? s.order.number}
        selected={selected}
        onSelectedChange={setSelected}
        rowClassName={(s) => (s.problem === 'delivery_failed' || s.problem === 'on_hold' || s.problem === 'unknown' ? 'bg-danger-bg/60' : undefined)}
        bulkActions={
          <>
            <span className="text-body text-text-secondary">· {formatBdt(selectedRows.reduce((sum, r) => sum + codCell(r).amount, 0))} COD</span>
            <Button size="sm" variant="secondary" loading={print.pending} disabled={selected.length > 100} onClick={() => print.start('label_4x6', Array.from(new Set(selectedRows.map((r) => r.order.id))))}>
              <Printer aria-hidden className="size-4" /> Print labels
            </Button>
            <Button size="sm" onClick={downloadManifest}>
              Download manifest
            </Button>
          </>
        }
        onRowClick={(s) => navigate(`/shipments/${s.id}`)}
        state={
          list.isPending ? (
            <LoadingRows label="Loading shipments" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            hasParcels ? (
              <NoResults
                title={debounced ? `No parcels match “${debounced}”` : 'No parcels here'}
                description="Try another courier, status or date range."
                onClear={() => {
                  setQ('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
                clearLabel="Clear filters"
              />
            ) : (
              <EmptyShipments onBook={() => setBooking(true)} />
            )
          ) : undefined
        }
        footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="parcels" onPage={(p) => set({ page: String(p) })} />}
      />
      {booking && <BulkBookDialog onClose={() => setBooking(false)} />}
    </>
  );
}

function lastScan(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(iso);
  return timeAgo(iso);
}

function Count({ n, on }: { n: number | undefined; on: boolean }) {
  if (n === undefined) return null;
  return <span className={cn('rounded-full px-1.5 text-caption font-medium', on ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-secondary')}>{formatCount(n)}</span>;
}

/** Sync now (P5B-38): 202 `{queued}`; throttled 1/min per store, so the button cools down for 60 s (429 too). */
function SyncButton() {
  const { storeId } = useStoreScope();
  const invalidate = useShipmentInvalidate();
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const sync = useMutation({
    mutationFn: () => api.shipments.sync(storeId!),
    onSuccess: async (r) => {
      setCooldown(SYNC_COOLDOWN_S);
      toast(r.queued > 0 ? `Checking ${plural(r.queued, 'courier account')} for updates.` : 'Everything is up to date.');
      await invalidate();
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 429) {
        setCooldown(e.retryAfter ?? SYNC_COOLDOWN_S);
        return toast('Synced a moment ago. Try again in a minute.', 'error');
      }
      toast(errorMessage(e, 'We couldn’t reach the couriers.'), 'error');
    },
  });
  return (
    <Button variant="secondary" loading={sync.isPending} disabled={cooldown > 0} onClick={() => sync.mutate()}>
      {cooldown > 0 ? `Sync again in ${cooldown}s` : 'Sync now'}
    </Button>
  );
}

function Kpis({ meta, pending }: { meta: ShipmentListMeta | undefined; pending: boolean }) {
  const k = meta?.kpis;
  const v = (n: number | undefined) => (pending || n === undefined ? '—' : formatCount(n));
  const couriers = COURIERS.filter((c) => (meta?.counts[c] ?? 0) > 0).length;
  return (
    <div role="group" aria-label="Shipment KPIs" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      <KpiTile wrapLabel icon={<Truck aria-hidden />} label="In transit" value={v(k?.in_transit)} hint={meta ? `Across ${plural(couriers, 'courier')}` : undefined} />
      <KpiTile wrapLabel icon={<MapPin aria-hidden />} label="Out for delivery today" value={v(k?.out_for_delivery_today)} hint="Riders on the road now" />
      <KpiTile
        wrapLabel
        icon={<CheckCircle2 aria-hidden />}
        label="Delivered this week"
        value={v(k?.delivered_7d)}
        hint={k?.delivery_rate_7d !== null && k?.delivery_rate_7d !== undefined ? `${Math.round(k.delivery_rate_7d * 100)}% delivery rate` : undefined}
      />
      <KpiTile
        wrapLabel
        icon={<AlertTriangle aria-hidden />}
        label="Problems"
        value={<span className={k && k.problems.total > 0 ? 'text-warning' : undefined}>{v(k?.problems.total)}</span>}
        hint={k ? `${formatCount(k.problems.delivery_failed)} failed · ${formatCount(k.problems.on_hold)} on hold · ${formatCount(k.problems.returning)} returning` : undefined}
      />
      <KpiTile wrapLabel icon={<Wallet aria-hidden />} label="COD held by couriers" value={k ? formatBdt(k.cod_held.total_amount) : '—'} hint="Collected, not paid to you yet" className="col-span-2 lg:col-span-1" />
    </div>
  );
}

/** "Needs attention" 39:10347: parcels with a `problem`; Call customer only (Reschedule has no courier API, §14). */
function NeedsAttention({ rows, total, pending, failed, onAll }: { rows: ShipmentSummary[]; total: number; pending: boolean; failed: boolean; onAll: () => void }) {
  return (
    <section aria-label="Needs attention" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-warning-bg text-warning">
          <AlertTriangle aria-hidden className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-heading text-text-primary">Needs attention</h2>
          <p className="text-body text-text-secondary">Riders couldn’t deliver these. Sort them out today so they don’t come back as returns.</p>
        </div>
        {total > 0 && <span className="shrink-0 rounded-full bg-warning-bg px-2.5 py-0.5 text-caption font-medium text-warning">{plural(total, 'parcel')}</span>}
      </div>
      {pending ? (
        <LoadingRows rows={2} label="Loading problems" />
      ) : failed ? (
        <p className="text-body text-text-muted">We couldn’t load the problem parcels.</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg bg-surface-subtle px-4 py-3 text-body text-text-secondary">No problems right now. Failed attempts and parcels on hold show up here.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((s) => {
            const c = codCell(s);
            return (
              <li key={s.id} className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4 sm:flex-row sm:items-center">
                {isCourier(s.provider) && <ProviderLogo provider={s.provider} size="sm" className="hidden sm:flex" />}
                <Link to={`/shipments/${s.id}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body">
                    <span className="font-semibold text-text-primary">{s.order.customer_name}</span>{' '}
                    <span className="text-caption text-text-muted">
                      {s.order.number}
                      {s.consignment_id ? ` · ${s.consignment_id}` : ''}
                    </span>
                  </span>
                  <span className="text-body text-danger">{s.failure_reason ?? (s.problem ? problemLabels[s.problem] : '')}</span>
                  <span className="truncate text-caption text-text-muted">{[s.last_location, s.last_event_at ? lastScan(s.last_event_at) : null].filter(Boolean).join(' · ')}</span>
                </Link>
                <div className="flex items-center gap-3">
                  <span className="flex flex-col text-right">
                    <span className="text-body font-semibold text-text-primary">{formatBdt(c.amount)}</span>
                    <span className="text-caption text-text-muted">{c.label}</span>
                  </span>
                  <a href={`tel:+${s.order.customer_phone}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })} aria-label={`Call ${s.order.customer_name} ${localPhone(s.order.customer_phone)}`}>
                    <Phone aria-hidden className="size-4" /> Call customer
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > rows.length && (
        <button type="button" onClick={onAll} className="self-start text-caption font-medium text-brand-600">
          See all {plural(total, 'problem parcel')}
        </button>
      )}
    </section>
  );
}

/** COD with couriers (P5B-43): delivered, not settled, last 60 days, per provider. "View payouts" is Phase 7. */
function CodWithCouriers({ meta }: { meta: ShipmentListMeta | undefined }) {
  const cod = meta?.kpis.cod_held;
  return (
    <section aria-label="COD with couriers" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <h2 className="text-body-lg font-medium text-text-primary">COD with couriers</h2>
      <div className="flex flex-col gap-1 border-b border-border-default pb-4">
        <span className="text-heading-32 text-text-primary">{cod ? formatBdt(cod.total_amount) : '—'}</span>
        <span className="text-caption text-text-muted">Collected from buyers, not yet paid to you</span>
      </div>
      {cod && cod.by_provider.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border-default">
          {cod.by_provider.map((p) => (
            <li key={p.provider} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <ProviderLogo provider={p.provider} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold text-text-primary">{courierName[p.provider]}</span>
                <span className="text-caption text-text-muted">{plural(p.parcels, 'parcel')}</span>
              </span>
              <span className="text-body font-semibold text-text-primary">{formatBdt(p.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-text-muted">Delivered COD money shows up here until the courier pays you.</p>
      )}
    </section>
  );
}

/** Empty Shipments (148:35352 pattern). */
function EmptyShipments({ onBook }: { onBook: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <Truck aria-hidden className="size-6" />
      </span>
      <h3 className="text-body-lg font-medium text-text-primary">No parcels yet</h3>
      <p className="max-w-sm text-body text-text-secondary">Book confirmed orders with Steadfast, Pathao or RedX and track every parcel here.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={onBook}>
          Book parcels
        </Button>
        <Link to="/integrations" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
          Connect a courier
        </Link>
      </div>
    </div>
  );
}

export default ShipmentsPage;
