import type { InventoryItem, InventoryListFilters, StockMovement, StockMovementReason } from '@storeplix/types';
import { Button, cn, DataTable, Dialog, Pagination, StockBadge, Tabs, type DataTableColumn } from '@storeplix/ui';
import { AlertTriangle, ArrowRight, Minus, Plus, RefreshCw, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '../layout/PageHeader';
import { dateTime, formatBdt, formatCount, plural, shortDate } from '../catalog/format';
import { useCategories, useInventory, useMovements } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, StatTile, Thumb, useDebounced } from '../catalog/ui';
import { AdjustDialog, reasonLabels } from './AdjustDialog';

// Figma Inventory 11:589 (Main 11:743). Contract §9.1: tabs Stock levels + Stock movements only; Transfer stock,
// Purchase order, Incoming, warehouse selector, reorder suggestion and barcode scan are deferred (Phase 8).

const movementReasonLabel: Record<StockMovementReason, string> = {
  initial: 'Opening stock',
  received: 'Received',
  correction: 'Corrected',
  damaged: 'Adjusted · damaged',
  lost: 'Adjusted · lost',
  returned: 'Returned',
  import: 'CSV import',
  other: 'Adjusted',
  order_shipped: 'Order shipped',
  order_returned: 'Order returned',
};

function MovementIcon({ m }: { m: StockMovement }) {
  const tone = m.delta > 0 ? 'bg-success-bg text-success' : m.reason === 'damaged' || m.reason === 'lost' ? 'bg-danger-bg text-danger' : 'bg-surface-subtle text-text-secondary';
  const Icon = m.reason === 'import' ? Upload : m.reason === 'returned' ? RefreshCw : m.reason === 'damaged' || m.reason === 'lost' ? AlertTriangle : m.delta > 0 ? Plus : Minus;
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', tone)}>
      <Icon aria-hidden className="size-4" />
    </span>
  );
}

const deltaText = (d: number) => (d > 0 ? `+${formatCount(d)}` : formatCount(d));

export function InventoryPage() {
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'movements' ? 'movements' : 'levels';
  const [adjusting, setAdjusting] = useState<{ item: InventoryItem; reason: 'received' | 'correction' } | null>(null);
  const [receiving, setReceiving] = useState(false);

  const setTab = (t: 'levels' | 'movements') => {
    const next = new URLSearchParams(params);
    if (t === 'movements') next.set('tab', 'movements');
    else next.delete('tab');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Every stock change is recorded. Available = on hand − held for orders."
        actions={<Button onClick={() => setReceiving(true)}>+ Receive stock</Button>}
      />
      <Tabs
        aria-label="Inventory"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'levels', label: 'Stock levels' },
          { value: 'movements', label: 'Stock movements' },
        ]}
      />
      {tab === 'levels' ? (
        <StockLevels canViewCosts={scope.canViewCosts} onAdjust={(item) => setAdjusting({ item, reason: 'correction' })} onLedger={() => setTab('movements')} />
      ) : (
        <Movements />
      )}
      {adjusting && <AdjustDialog key={`${adjusting.item.variant_id}:${adjusting.reason}`} open item={adjusting.item} initialReason={adjusting.reason} onClose={() => setAdjusting(null)} />}
      <ReceivePicker
        open={receiving}
        onClose={() => setReceiving(false)}
        onPick={(item) => {
          setReceiving(false);
          setAdjusting({ item, reason: 'received' });
        }}
      />
    </>
  );
}

function StockLevels({ canViewCosts, onAdjust, onLedger }: { canViewCosts: boolean; onAdjust: (i: InventoryItem) => void; onLedger: () => void }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const stock = (params.get('stock') ?? '').split(',').filter(Boolean) as NonNullable<InventoryListFilters['stock']>;
  const categoryId = params.get('category') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;
  const categories = useCategories();
  const filters: InventoryListFilters = { q: debounced || undefined, stock: stock.length ? stock : undefined, category_id: categoryId || undefined, page, per_page: 25 };
  const list = useInventory(filters);
  const latest = useMovements({ per_page: 6 });
  const summary = list.data?.meta.summary;
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

  const columns: DataTableColumn<InventoryItem>[] = [
    {
      key: 'product',
      header: 'Product',
      mobileLabel: false,
      cell: (i) => (
        <Link to={`/products/${i.product.id}`} className="flex min-w-0 items-center gap-3">
          <Thumb src={i.product.image?.url} size={40} />
          <Cell2 top={i.product.name} bottom={[i.title !== 'Default' ? i.title : null, i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ') || '—'} />
        </Link>
      ),
    },
    { key: 'on_hand', header: 'On hand', width: 80, align: 'end', cell: (i) => <span className="text-body text-text-primary">{formatCount(i.on_hand)}</span> },
    { key: 'held', header: 'Held', width: 64, align: 'end', cell: (i) => <span className="text-body text-text-primary">{formatCount(i.committed)}</span> },
    {
      key: 'available',
      header: 'Available',
      width: 84,
      align: 'end',
      cell: (i) => <span className={cn('text-body font-semibold', i.track_inventory && i.available <= 0 ? 'text-danger' : 'text-text-primary')}>{formatCount(i.available)}</span>,
    },
    { key: 'status', header: 'Status', width: 110, align: 'center', cell: (i) => <StockBadge status={i.status} /> },
    {
      key: 'adjust',
      header: <span className="sr-only">Adjust</span>,
      mobileLabel: false,
      width: 76,
      align: 'end',
      cell: (i) => (
        <Button size="sm" variant="secondary" aria-label={`Adjust ${i.product.name}${i.title !== 'Default' ? ` ${i.title}` : ''}`} onClick={() => onAdjust(i)}>
          Adjust
        </Button>
      ),
    },
  ];

  const rows = list.data?.data ?? [];
  const state = list.isPending ? (
    <LoadingRows label="Loading stock" />
  ) : list.isError ? (
    <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
  ) : rows.length === 0 ? (
    debounced || stock.length || categoryId ? (
      <NoResults
        title={debounced ? `Nothing matches “${debounced}”` : 'No variants match these filters'}
        onClear={() => {
          setQ('');
          setParams(new URLSearchParams(), { replace: true });
        }}
        clearLabel="Clear filters"
      />
    ) : (
      <NoResults title="No products yet" description="Stock appears here once you add products." />
    )
  ) : undefined;

  return (
    <>
      <section aria-label="Stock summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {canViewCosts ? (
          <StatTile label="Stock value (cost)" value={formatBdt(summary?.stock_value_cost_amount ?? null)} hint={`Selling value ${formatBdt(summary?.stock_value_price_amount ?? 0)}`} />
        ) : (
          <StatTile label="Selling value" value={formatBdt(summary?.stock_value_price_amount ?? null)} hint="At current prices" />
        )}
        <StatTile label="Units on hand" value={formatCount(summary?.units_on_hand ?? 0)} hint={`${plural(summary?.products_count ?? 0, 'product')} · ${plural(summary?.variants_count ?? 0, 'variant')}`} />
        <StatTile label="Held for orders" value={formatCount(summary?.committed_units ?? 0)} hint="Starts with orders" />
        <StatTile label="Low or out of stock" value={`${formatCount(summary?.low_stock_variants ?? 0)} · ${formatCount(summary?.out_of_stock_variants ?? 0)}`} hint="low · out" />
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <DataTable
          className="min-w-0"
          label="Stock levels"
          toolbar={
            <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <SearchBox value={q} onChange={(v) => { setQ(v); set({ q: v }); }} placeholder="Product, SKU or barcode" label="Search stock" className="h-9 w-full sm:w-[230px] [&>svg]:size-4" />
              <FilterSelect label="Stock status" value={stock.join(',')} onChange={(e) => set({ stock: e.target.value })}>
                <option value="">All stock</option>
                <option value="low,out">Low or out</option>
                <option value="low">Low</option>
                <option value="out">Out of stock</option>
                <option value="in">In stock</option>
                <option value="untracked">Not tracked</option>
              </FilterSelect>
              <FilterSelect label="Category" value={categoryId} onChange={(e) => set({ category: e.target.value })}>
                <option value="">All categories</option>
                {(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {'— '.repeat(c.depth - 1)}
                    {c.name}
                  </option>
                ))}
              </FilterSelect>
            </div>
          }
          columns={columns}
          rows={rows}
          getRowId={(i) => i.variant_id}
          state={state}
          footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="variants" onPage={(p) => set({ page: String(p) })} />}
        />
        <section aria-label="Latest stock changes" className="flex min-w-0 flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <div className="flex items-center justify-between">
            <h2 className="text-body-lg font-medium text-text-primary">Latest stock changes</h2>
            <button type="button" onClick={onLedger} className="flex items-center gap-1 text-caption font-medium text-brand-600 hover:text-brand-700">
              Ledger <ArrowRight aria-hidden className="size-3.5" />
            </button>
          </div>
          {latest.isPending ? (
            <LoadingRows rows={3} label="Loading changes" />
          ) : latest.isError ? (
            <ErrorBlock error={latest.error} onRetry={() => void latest.refetch()} />
          ) : (latest.data?.data.length ?? 0) === 0 ? (
            <p className="text-body text-text-muted">No stock changes yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {latest.data!.data.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-[9px]">
                  <MovementIcon m={m} />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-body font-medium text-text-primary">
                      {movementReasonLabel[m.reason]} · {m.product.name}
                    </span>
                    <span className="truncate text-caption text-text-muted">
                      {[m.variant_title !== 'Default' ? m.variant_title : null, m.actor?.name ? `By ${m.actor.name}` : null, shortDate(m.created_at)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={cn('text-body font-semibold', m.delta > 0 ? 'text-success' : 'text-danger')}>{deltaText(m.delta)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

const reasonOptions: StockMovementReason[] = ['received', 'correction', 'damaged', 'lost', 'returned', 'import', 'initial', 'other'];

function Movements() {
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productQ, setProductQ] = useState('');
  const [productId, setProductId] = useState('');
  const [page, setPage] = useState(1);
  const productMatches = useInventory({ q: useDebounced(productQ) || undefined, per_page: 8 });
  const list = useMovements({
    reason: reason ? [reason as StockMovementReason] : undefined,
    product_id: productId || undefined,
    created_from: from ? `${from}T00:00:00` : undefined,
    created_to: to ? `${to}T23:59:59` : undefined,
    page,
    per_page: 25,
  });
  const products = Array.from(new Map((productMatches.data?.data ?? []).map((i) => [i.product.id, i.product])).values());

  const columns: DataTableColumn<StockMovement>[] = [
    { key: 'when', header: 'Date', width: 150, cell: (m) => <span className="text-body text-text-secondary">{dateTime(m.created_at)}</span> },
    {
      key: 'product',
      header: 'Product',
      mobileLabel: false,
      cell: (m) => <Cell2 top={m.product.name} bottom={[m.variant_title !== 'Default' ? m.variant_title : null, m.sku ? `SKU ${m.sku}` : null].filter(Boolean).join(' · ')} />,
    },
    { key: 'reason', header: 'Reason', width: 150, cell: (m) => <Cell2 top={movementReasonLabel[m.reason]} bottom={m.note ?? undefined} topClass="font-medium" /> },
    { key: 'delta', header: 'Change', width: 80, align: 'end', cell: (m) => <span className={cn('text-body font-semibold', m.delta > 0 ? 'text-success' : 'text-danger')}>{deltaText(m.delta)}</span> },
    { key: 'after', header: 'On hand after', width: 110, align: 'end', cell: (m) => <span className="text-body text-text-primary">{formatCount(m.on_hand_after)}</span> },
    { key: 'by', header: 'By', width: 120, cell: (m) => <span className="truncate text-body text-text-secondary">{m.actor?.name ?? (m.reason === 'import' ? 'CSV import' : '—')}</span> },
  ];

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = !!(reason || from || to || productId);
  return (
    <DataTable
      label="Stock movements"
      toolbar={
        <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
          <FilterSelect label="Reason" value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }}>
            <option value="">All reasons</option>
            {reasonOptions.map((r) => (
              <option key={r} value={r}>
                {r in reasonLabels ? reasonLabels[r as keyof typeof reasonLabels] : movementReasonLabel[r]}
              </option>
            ))}
          </FilterSelect>
          <span className="flex items-center gap-1.5">
            <SearchBox value={productQ} onChange={setProductQ} placeholder="Find a product" label="Find a product" className="w-44" />
            <FilterSelect label="Product" value={productId} onChange={(e) => { setProductId(e.target.value); setPage(1); }}>
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </FilterSelect>
          </span>
          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            From
            <input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-[38px] rounded-md border border-border-default px-2 text-body text-text-primary" />
          </label>
          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            To
            <input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-[38px] rounded-md border border-border-default px-2 text-body text-text-primary" />
          </label>
        </div>
      }
      columns={columns}
      rows={rows}
      getRowId={(m) => m.id}
      state={
        list.isPending ? (
          <LoadingRows label="Loading stock movements" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <NoResults
            title={filtered ? 'No stock changes match these filters' : 'No stock changes yet'}
            onClear={
              filtered
                ? () => {
                    setReason('');
                    setFrom('');
                    setTo('');
                    setProductId('');
                    setProductQ('');
                  }
                : undefined
            }
            clearLabel="Clear filters"
          />
        ) : undefined
      }
      footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="changes" onPage={setPage} />}
    />
  );
}

/** "+ Receive stock": pick a variant, then the adjust dialog opens with reason `received`. */
function ReceivePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (i: InventoryItem) => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const list = useInventory({ q: debounced || undefined, per_page: 20 });
  return (
    <Dialog open={open} size="md" title="Receive stock" description="Pick the product variant you received." confirmLabel="Close" cancelLabel={null} onCancel={onClose} onConfirm={onClose}>
      <div className="flex flex-col gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Product, SKU or barcode" label="Search variants" />
        {list.isPending ? (
          <LoadingRows rows={3} />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <StateCard>
            <NoResults title="No matching variants" />
          </StateCard>
        ) : (
          <ul className="flex max-h-80 flex-col divide-y divide-border-default overflow-y-auto rounded-lg border border-border-default">
            {list.data!.data.map((i) => (
              <li key={i.variant_id}>
                <button type="button" onClick={() => onPick(i)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-subtle">
                  <Thumb src={i.product.image?.url} size={36} />
                  <Cell2 top={i.product.name} bottom={[i.title !== 'Default' ? i.title : null, i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ')} />
                  <span className="ml-auto text-caption text-text-muted">{formatCount(i.on_hand)} on hand</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export default InventoryPage;
