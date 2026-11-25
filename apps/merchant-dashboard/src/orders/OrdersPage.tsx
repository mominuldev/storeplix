import { RISK_TIERS, type OrderChannel, type OrderListFilters, type OrderStatus, type OrderSummary, type PaymentStatus, type RiskTier } from '@storeplix/types';
import { Avatar, Button, buttonVariants, Chip, cn, DataTable, Menu, OrderStatusBadge, Pagination, paymentStatusMeta, RiskBadge, riskTierMeta, Tabs, type DataTableColumn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Package, Phone, Printer, ShoppingBag, Truck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, useDebounced, useIsMobile } from '../catalog/ui';
import { customerLine, daysAgoIso, localPhone, nextStep, orderChannelLabels, orderTabs, timeAgo } from '../commerce/format';
import { useCommerceInvalidate, useGeoIndex, useOrders } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { documentKindLabels, documentKinds } from '../documents/labels';
import { usePrintJob } from '../documents/usePrintJob';
import { BulkBookDialog } from '../shipments/BulkBookDialog';
import { ShipOrderDialog } from './actions';
import { useQuickTransition } from './transitions';
import { holdLabels, orderTier } from '../fraud/fraud';
import { HoldTag } from '../fraud/OrderGuard';
import { PosTag } from './PosTag';

// Figma Orders 7:276 (mobile Orders 31:4886, OrderCard 30:3171). Contract §9: status tabs with counts, search,
// Payment / Source / District / date filters, Next step button, bulk Confirm / Mark packed. Not built (§11): Courier
// problems tab, "Advance unpaid" quick chip, Export. PHASE-8-8 §10.2: RISK column (guard tier, else the customer's),
// Risk filter, composed quick chip "On hold · n" (`filter[guard_hold]`), hold Tag beside Pending; held orders show
// "Call first" / "Review" instead of Confirm (API 409 `order_held`). 5b-3: bulk "Book courier" (39:18808). 5b-4: bulk Print (documents)
// and the Printed filter (`filter[printed]` / `filter[not_printed]`).

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

type Tab = 'all' | OrderStatus;

const PRINTED = [
  { value: 'invoice_not', label: 'Invoice not printed', filter: { not_printed: 'invoice' } },
  { value: 'label_not', label: 'Label not printed', filter: { not_printed: 'label' } },
  { value: 'invoice_today', label: 'Invoice printed today', filter: { printed: 'invoice' } },
  { value: 'label_today', label: 'Label printed today', filter: { printed: 'label' } },
] as const satisfies readonly { value: string; label: string; filter: Pick<OrderListFilters, 'printed' | 'not_printed'> }[];

export function OrdersPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const geo = useGeoIndex();
  const [params, setParams] = useSearchParams();
  const tab = (orderTabs.some((t) => t.value === params.get('status')) ? params.get('status') : 'all') as Tab;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const page = Number(params.get('page') ?? '1') || 1;
  const payment = (params.get('payment') ?? '') as PaymentStatus | '';
  const channel = (params.get('channel') ?? '') as OrderChannel | '';
  const district = params.get('district') ?? '';
  const range = params.get('range') ?? '30';
  const printedParam = PRINTED.find((p) => p.value === params.get('printed'));
  const risk = (RISK_TIERS as readonly string[]).includes(params.get('risk') ?? '') ? (params.get('risk') as RiskTier) : '';
  const heldOnly = params.get('held') === '1';
  // PHASE-8-8D §8: "POS" quick chip (`filter[created_via]=pos`).
  const posOnly = params.get('via') === 'pos';
  const print = usePrintJob();
  const [selected, setSelected] = useState<string[]>([]);
  const [shipping, setShipping] = useState<OrderSummary | null>(null);
  const [bulkBook, setBulkBook] = useState<OrderSummary[] | null>(null);

  // Day-granular so the query key stays stable within a session.
  const placedFrom = range === 'all' ? undefined : daysAgoIso(Number(range)).slice(0, 10);
  const filters: OrderListFilters = {
    status: tab === 'all' ? undefined : [tab],
    payment_status: payment ? [payment] : undefined,
    channel: channel ? [channel] : undefined,
    district_code: district || undefined,
    ...(printedParam?.filter ?? {}),
    risk: risk ? [risk] : undefined,
    guard_hold: heldOnly || undefined,
    created_via: posOnly ? ['pos'] : undefined,
    placed_from: placedFrom,
    q: debounced || undefined,
    page,
    per_page: 25,
  };
  const list = useOrders(filters);
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

  const quick = useQuickTransition();
  const bulk = useMutation({
    mutationFn: (action: 'confirm' | 'ready') => api.orders.bulk(scope.storeId!, { action, ids: selected }),
    onSuccess: async (r) => {
      const verb = r.action === 'confirm' ? 'Confirmed' : 'Marked packed';
      const held = r.skipped.filter((x) => x.reason === 'order_held').length;
      const other = r.skipped.length - held;
      const why = [held ? `${held} held by the fake order guard` : null, other ? `${other} changed status` : null].filter(Boolean).join(', ');
      toast(r.skipped.length ? `${verb} ${r.updated}. ${r.skipped.length} skipped — ${why}.` : `${verb} ${r.updated} ${r.updated === 1 ? 'order' : 'orders'}.`);
      setSelected([]);
      await invalidate.afterOrderChange();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const runNext = (o: OrderSummary) => {
    if (o.guard?.hold) return navigate(`/orders/${o.id}`);
    const step = nextStep(o.status);
    if (!step) return;
    if (step.to === 'shipped') return setShipping(o);
    quick.mutate({ target: { id: o.id, number: o.number, customerId: o.customer.id }, to: step.to as 'confirmed' | 'ready_to_ship' | 'delivered' });
  };

  const columns: DataTableColumn<OrderSummary>[] = [
    {
      key: 'order',
      header: 'Order',
      width: 96,
      mobileLabel: false,
      cell: (o) => (
        <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body font-semibold text-text-primary">{o.number}</span>
          <span className="text-caption text-text-muted">{`${timeAgo(o.placed_at)} · ${orderChannelLabels[o.channel]}`}</span>
        </Link>
      ),
    },
    { key: 'customer', header: 'Customer', mobileLabel: false, cell: (o) => <Cell2 top={o.customer.name} bottom={customerLine(o.customer)} topClass="font-medium" /> },
    {
      key: 'risk',
      header: 'Risk',
      width: 112,
      cell: (o) => {
        const t = orderTier(o);
        return t ? <RiskBadge tier={t} /> : <span className="text-text-muted">—</span>;
      },
    },
    { key: 'district', header: 'District', width: 120, cell: (o) => <span className="truncate text-body text-text-primary">{o.district || '—'}</span> },
    {
      key: 'total',
      header: 'Total · Due',
      width: 104,
      cell: (o) => (
        <Cell2
          top={formatBdt(o.total_amount)}
          bottom={o.due_amount > 0 ? `Due ${formatBdt(o.due_amount)}` : paymentStatusMeta[o.payment_status].label}
          bottomClass={o.due_amount === 0 && o.payment_status === 'paid' ? 'text-success' : undefined}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      cell: (o) => (
        <span className="flex flex-col items-start gap-1">
          <OrderStatusBadge status={o.status} />
          {o.guard?.hold && <HoldTag hold={o.guard.hold} />}
          <PosTag order={o} />
        </span>
      ),
    },
    {
      key: 'next',
      header: 'Next step',
      width: 120,
      align: 'end',
      mobileLabel: false,
      cell: (o) => {
        if (o.guard?.hold) return <HeldStep order={o} />;
        const step = nextStep(o.status);
        if (!step) return null;
        const busy = quick.isPending && quick.variables?.target.id === o.id;
        return (
          <Button
            size="sm"
            variant={o.status === 'pending' ? 'primary' : 'secondary'}
            loading={busy}
            aria-label={`${step.label} ${o.number}`}
            onClick={(e) => {
              e.stopPropagation();
              runNext(o);
            }}
          >
            {step.label}
          </Button>
        );
      },
    },
  ];

  const filtered = !!(debounced || payment || channel || district || printedParam || risk || heldOnly || posOnly || tab !== 'all');
  const counts = meta?.counts;

  const listState =
    list.isPending ? (
      <LoadingRows label="Loading orders" />
    ) : list.isError ? (
      <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
    ) : rows.length === 0 ? (
      filtered ? (
        <NoResults
          title={debounced ? `No orders match “${debounced}”` : 'No orders here'}
          description="Try another status, filter or date range."
          onClear={() => {
            setQ('');
            setParams(new URLSearchParams(), { replace: true });
          }}
          clearLabel="Clear filters"
        />
      ) : (
        <EmptyOrders />
      )
    ) : undefined;
  const pagination = meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="orders" onPage={(p) => set({ page: String(p) })} />;

  return (
    <>
      <div className="flex flex-col gap-4">
      <PageHeader
        title="Orders"
        subtitle="Confirm, ship and collect. Each order shows its next step."
        actions={
          <>
            <Link to="/orders/print" className={cn(buttonVariants({ variant: 'secondary' }), 'max-md:hidden')}>
              Invoices & labels
            </Link>
            {scope.canViewOrders && (
              <Link to="/orders/new" className={cn(buttonVariants(), 'max-md:hidden')}>
                Create order
              </Link>
            )}
          </>
        }
      />
      {isMobile ? (
        <div role="tablist" aria-label="Order status" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {orderTabs.map((t) => {
            const active = t.value === tab;
            const n = counts ? counts[t.value] : undefined;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => set({ status: t.value === 'all' ? null : t.value })}
                className={cn(
                  'flex h-10 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-body font-medium whitespace-nowrap outline-none focus-visible:shadow-focus',
                  active ? 'bg-brand-600 text-text-inverse' : 'border border-border-default bg-surface-card text-text-primary',
                )}
              >
                {t.label}
                {n !== undefined && (
                  <span className={cn('rounded-full px-[7px] py-px text-caption font-medium', active ? 'bg-surface-card/20 text-text-inverse' : 'bg-surface-subtle text-text-secondary')}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
      <Tabs
        aria-label="Order status"
        value={tab}
        onChange={(v) => set({ status: v === 'all' ? null : v })}
        className="overflow-x-auto"
        items={orderTabs.map((t) => ({ value: t.value, label: t.label, count: counts ? counts[t.value] : undefined }))}
      />
      )}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            set({ q: v });
          }}
          placeholder="Order no, name or phone"
          label="Search orders"
          className="h-12 w-full rounded-lg border border-border-strong bg-surface-card md:h-9 md:w-[280px] md:rounded-md md:border-border-default md:[&>svg]:size-4"
        />
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:contents">
        <FilterSelect label="Risk" value={risk} onChange={(e) => set({ risk: e.target.value })}>
          <option value="">Risk</option>
          {RISK_TIERS.map((t) => (
            <option key={t} value={t}>
              {riskTierMeta[t].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Payment" value={payment} onChange={(e) => set({ payment: e.target.value })}>
          <option value="">Payment</option>
          {(Object.keys(paymentStatusMeta) as PaymentStatus[]).map((p) => (
            <option key={p} value={p}>
              {paymentStatusMeta[p].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Source" value={channel} onChange={(e) => set({ channel: e.target.value })}>
          <option value="">Source</option>
          {(Object.keys(orderChannelLabels) as OrderChannel[]).map((c) => (
            <option key={c} value={c}>
              {orderChannelLabels[c]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="District" value={district} onChange={(e) => set({ district: e.target.value })} className="max-w-44">
          <option value="">District</option>
          {geo.index.districts.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Printed" value={printedParam?.value ?? ''} onChange={(e) => set({ printed: e.target.value })}>
          <option value="">Printed</option>
          {PRINTED.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Date range" value={range} onChange={(e) => set({ range: e.target.value === '30' ? null : e.target.value })}>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </FilterSelect>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-caption text-text-muted max-md:hidden">Quick:</span>
          <Chip check={false} selected={posOnly} onClick={() => set({ via: posOnly ? null : 'pos' })} className="h-[38px] shrink-0 py-0" data-testid="orders-pos-chip">
            POS
          </Chip>
        </span>
        {(heldOnly || (counts?.held ?? 0) > 0) && (
          <span className="flex shrink-0 items-center gap-2">
            <Chip
              check={false}
              selected={heldOnly}
              onClick={() => set({ held: heldOnly ? null : '1' })}
              className={cn('h-[38px] shrink-0 py-0', !heldOnly && 'bg-warning-bg text-warning shadow-none hover:bg-warning-bg')}
            >
              On hold · {counts?.held ?? 0}
            </Chip>
          </span>
        )}
        </div>
      </div>
      {isMobile ? (
        <MobileOrderList
          rows={rows}
          state={listState}
          footer={pagination}
          busyId={quick.isPending ? quick.variables?.target.id : undefined}
          onOpen={(o) => navigate(`/orders/${o.id}`)}
          onNext={runNext}
        />
      ) : (
      <DataTable
        label="Orders"
        columnGap={16}
        headTone="canvas"
        columns={columns}
        rows={rows}
        getRowId={(o) => o.id}
        rowLabel={(o) => o.number}
        selected={selected}
        onSelectedChange={setSelected}
        bulkActions={
          <>
            <Menu
              label="Print selected"
              align="start"
              disabled={print.pending || selected.length > 100}
              triggerClassName={cn(buttonVariants({ size: 'sm', variant: 'secondary' }), 'size-auto text-text-primary')}
              trigger={
                <>
                  <Printer aria-hidden className="size-4" /> Print <ChevronDown aria-hidden className="size-4" />
                </>
              }
              entries={documentKinds.map((k) => ({ key: k, label: documentKindLabels[k].noun(selected.length), onSelect: () => print.start(k, selected) }))}
            />
            <Button size="sm" variant="secondary" onClick={() => setBulkBook(rows.filter((o) => selected.includes(o.id)))}>
              <Truck aria-hidden className="size-4" /> Book courier
            </Button>
            <Button size="sm" variant="secondary" loading={bulk.isPending && bulk.variables === 'ready'} onClick={() => bulk.mutate('ready')}>
              Mark packed
            </Button>
            <Button size="sm" loading={bulk.isPending && bulk.variables === 'confirm'} onClick={() => bulk.mutate('confirm')}>
              Confirm {selected.length} {selected.length === 1 ? 'order' : 'orders'}
            </Button>
          </>
        }
        onRowClick={(o) => navigate(`/orders/${o.id}`)}
        state={listState}
        footer={pagination}
      />
      )}
      </div>
      {bulkBook && (
        <BulkBookDialog
          orders={bulkBook}
          onClose={() => setBulkBook(null)}
          onDone={() => setSelected([])}
        />
      )}
      {shipping && <ShipOrderDialog open order={{ id: shipping.id, number: shipping.number, customerId: shipping.customer.id }} onClose={() => setShipping(null)} />}
    </>
  );
}

/** Mobile Orders 31:4886 — OrderCard 30:3171 grouped by day. */
function MobileOrderList({
  rows,
  state,
  footer,
  busyId,
  onOpen,
  onNext,
}: {
  rows: OrderSummary[];
  state: ReactNode;
  footer: ReactNode;
  busyId: string | undefined;
  onOpen: (o: OrderSummary) => void;
  onNext: (o: OrderSummary) => void;
}) {
  if (state) return <section aria-label="Orders" className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">{state}</section>;
  const groups: { label: string; orders: OrderSummary[] }[] = [];
  for (const o of rows) {
    const label = dayLabel(o.placed_at);
    const g = groups.at(-1);
    if (g && g.label === label) g.orders.push(o);
    else groups.push({ label, orders: [o] });
  }
  return (
    <section aria-label="Orders" className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-body text-text-secondary">
            <span className="font-semibold">
              {g.label} · {g.orders.length} {g.orders.length === 1 ? 'order' : 'orders'}
            </span>
            <span className="font-medium">Total {formatBdt(g.orders.reduce((n, o) => n + o.total_amount, 0))}</span>
          </div>
          {g.orders.map((o) => (
            <OrderCard key={o.id} order={o} busy={busyId === o.id} onOpen={() => onOpen(o)} onNext={() => onNext(o)} />
          ))}
        </div>
      ))}
      {footer && <div className="overflow-hidden rounded-card border border-border-default bg-surface-card">{footer}</div>}
    </section>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** OrderCard 30:3171: customer, number · time, total + due, phone and items, status badge, one next-step button. */
function OrderCard({ order: o, busy, onOpen, onNext }: { order: OrderSummary; busy: boolean; onOpen: () => void; onNext: () => void }) {
  const step = nextStep(o.status);
  const tier = orderTier(o);
  const time = new Date(o.placed_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return (
    <article
      aria-label={o.number}
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-3.5 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1"
    >
      <div className="flex items-center gap-3">
        <Avatar name={o.customer.name} className="size-10 bg-brand-50 text-body font-semibold text-brand-600" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="truncate text-body-lg font-medium text-text-primary">
            {o.customer.name}
          </Link>
          <span className="truncate text-caption text-text-muted">
            {o.number} · {time}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-body-lg font-semibold text-text-primary">{formatBdt(o.total_amount)}</span>
          <span className={cn('text-caption', o.due_amount === 0 && o.payment_status === 'paid' ? 'text-success' : 'text-text-muted')}>
            {o.due_amount > 0 ? `${formatBdt(o.due_amount)} due` : paymentStatusMeta[o.payment_status].label}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg bg-surface-subtle px-3 py-2.5 text-body text-text-secondary">
        <span className="flex items-center gap-1.5">
          <Phone aria-hidden className="size-4 shrink-0" /> {o.customer.phone ? localPhone(o.customer.phone) : 'Walk-in'}
        </span>
        <span className="flex items-center gap-1.5">
          <Package aria-hidden className="size-4 shrink-0" /> {o.items_count} {o.items_count === 1 ? 'item' : 'items'}
          {o.district ? ` · ${o.district}` : ''}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <OrderStatusBadge status={o.status} />
          {o.guard?.hold && <HoldTag hold={o.guard.hold} />}
          <PosTag order={o} />
          {tier && <RiskBadge tier={tier} />}
        </span>
        {o.guard?.hold ? (
          <HeldStep order={o} className="h-11" />
        ) : step && (
          <Button
            variant={o.status === 'pending' ? 'primary' : 'secondary'}
            className="h-11"
            loading={busy}
            aria-label={`${step.label} ${o.number}`}
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
          >
            {step.label}
          </Button>
        )}
      </div>
    </article>
  );
}

/** Next step of a held order (7:276 "Call first"): opens the order, where the guard banner releases or cancels it. */
function HeldStep({ order: o, className }: { order: OrderSummary; className?: string }) {
  const hold = o.guard!.hold!;
  if (hold === 'checking')
    return (
      <Button size="sm" variant="secondary" disabled className={className}>
        {holdLabels.checking}
      </Button>
    );
  return (
    <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} aria-label={`${hold === 'call_first' ? 'Call first' : 'Review'} ${o.number}`} className={cn(buttonVariants({ size: 'sm', variant: 'secondary' }), className)}>
      {hold === 'call_first' ? 'Call first' : 'Review'}
    </Link>
  );
}

/** Empty Orders 148:34033. */
function EmptyOrders() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <ShoppingBag aria-hidden className="size-6" />
      </span>
      <h3 className="text-body-lg font-medium text-text-primary">No orders yet</h3>
      <p className="max-w-sm text-body text-text-secondary">Orders from your shop and the ones you add from chats and calls show up here.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link to="/orders/new" className={buttonVariants({ size: 'sm' })}>
          Create an order
        </Link>
        <Link to="/onboarding/live" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
          Share your shop
        </Link>
      </div>
    </div>
  );
}

export default OrdersPage;
