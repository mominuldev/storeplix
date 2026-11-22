import type { OrderChannel, OrderListFilters, OrderStatus, OrderSummary, PaymentStatus } from '@storeplix/types';
import { Button, buttonVariants, cn, DataTable, Menu, OrderStatusBadge, Pagination, paymentStatusMeta, Tabs, type DataTableColumn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Plus, Printer, ShoppingBag, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, useDebounced } from '../catalog/ui';
import { customerLine, daysAgoIso, nextStep, orderChannelLabels, orderTabs, timeAgo } from '../commerce/format';
import { useCommerceInvalidate, useGeoIndex, useOrders } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { documentKindLabels, documentKinds } from '../documents/labels';
import { usePrintJob } from '../documents/usePrintJob';
import { BulkBookDialog } from '../shipments/BulkBookDialog';
import { ShipOrderDialog } from './actions';
import { useQuickTransition } from './transitions';

// Figma Orders 7:276 (mobile Orders 31:4886, OrderCard 30:3171). Contract §9: status tabs with counts, search,
// Payment / Source / District / date filters, Next step button, bulk Confirm / Mark packed. Not built (§11): Risk
// column and filter, Courier problems tab, Quick chips (advance), Export. 5b-3: bulk "Book courier" (39:18808). 5b-4: bulk Print (documents)
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
      toast(r.skipped.length ? `${verb} ${r.updated}. ${r.skipped.length} skipped — their status had changed.` : `${verb} ${r.updated} ${r.updated === 1 ? 'order' : 'orders'}.`);
      setSelected([]);
      await invalidate.afterOrderChange();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const runNext = (o: OrderSummary) => {
    const step = nextStep(o.status);
    if (!step) return;
    if (step.to === 'shipped') return setShipping(o);
    quick.mutate({ target: { id: o.id, number: o.number, customerId: o.customer.id }, to: step.to as 'confirmed' | 'ready_to_ship' | 'delivered' });
  };

  const columns: DataTableColumn<OrderSummary>[] = [
    {
      key: 'order',
      header: 'Order',
      width: 150,
      mobileLabel: false,
      cell: (o) => (
        <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="block min-w-0">
          <Cell2 top={o.number} bottom={`${timeAgo(o.placed_at)} · ${orderChannelLabels[o.channel]}`} />
        </Link>
      ),
    },
    { key: 'customer', header: 'Customer', mobileLabel: false, cell: (o) => <Cell2 top={o.customer.name} bottom={customerLine(o.customer)} topClass="font-medium" /> },
    { key: 'district', header: 'District', width: 120, cell: (o) => <span className="truncate text-body text-text-primary">{o.district || '—'}</span> },
    {
      key: 'total',
      header: 'Total · Due',
      width: 120,
      cell: (o) => (
        <Cell2
          top={formatBdt(o.total_amount)}
          bottom={o.due_amount > 0 ? `Due ${formatBdt(o.due_amount)}` : paymentStatusMeta[o.payment_status].label}
          bottomClass={o.due_amount === 0 && o.payment_status === 'paid' ? 'text-success' : undefined}
        />
      ),
    },
    { key: 'status', header: 'Status', width: 130, cell: (o) => <OrderStatusBadge status={o.status} /> },
    {
      key: 'next',
      header: 'Next step',
      width: 140,
      align: 'end',
      mobileLabel: false,
      cell: (o) => {
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

  const filtered = !!(debounced || payment || channel || district || printedParam || tab !== 'all');
  const counts = meta?.counts;

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Confirm, ship and collect. Each order shows its next step."
        actions={
          <>
            <Link to="/orders/print" className={buttonVariants({ variant: 'secondary' })}>
              <Printer aria-hidden className="size-4" /> Invoices & labels
            </Link>
            <Link to="/orders/new" className={buttonVariants()}>
              <Plus aria-hidden className="size-4" /> Create order
            </Link>
          </>
        }
      />
      <Tabs
        aria-label="Order status"
        value={tab}
        onChange={(v) => set({ status: v === 'all' ? null : v })}
        className="overflow-x-auto"
        items={orderTabs.map((t) => ({ value: t.value, label: t.label, count: counts ? counts[t.value] : undefined }))}
      />
      <DataTable
        label="Orders"
        toolbar={
          <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                set({ q: v });
              }}
              placeholder="Order no, name or phone"
              label="Search orders"
              className="w-full sm:max-w-[270px]"
            />
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
          </div>
        }
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
        state={
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
          ) : undefined
        }
        footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="orders" onPage={(p) => set({ page: String(p) })} />}
      />
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
