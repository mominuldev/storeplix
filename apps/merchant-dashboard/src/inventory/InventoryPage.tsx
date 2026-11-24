import type { InventoryItem, InventoryListFilters, Location, StockMovement, StockMovementReason } from '@storeplix/types';
import { Button, buttonVariants, cn, DataTable, Dialog, Pagination, StockBadge, type DataTableColumn } from '@storeplix/ui';
import { AlertTriangle, ArrowRight, ChevronDown, Minus, Plus, RefreshCw, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '../layout/PageHeader';
import { dateTime, formatBdt, formatCount, plural, shortDate } from '../catalog/format';
import { useCategories, useInventory, useMovements } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { Cell2, FilterSelect, SearchBox, StatTile, Thumb, useDebounced } from '../catalog/ui';
import { ReorderCard } from '../purchasing/ReorderCard';
import { movementPoRef } from '../purchasing/purchasing';
import { AdjustDialog, reasonLabels } from './AdjustDialog';
import { InventoryTabs } from './InventoryTabs';
import { multiWarehouseLocked, stockAt, useStockLocations } from './locations';
import { movementRefLabel } from './transfers/transfers';
import { useFeatures } from '../plan/useFeatures';

// Figma Inventory 11:589 (Main 11:743). Contract §9.1: tabs Stock levels + Stock movements. PHASE-8-8B §10.1 adds the
// Purchase orders + Suppliers tabs (own routes), the INCOMING column, the "Purchase order" header button, the reorder
// suggestion card and "Received · PO-0012" movement rows. PHASE-8-8C part A (§10.1): location selector 11:842 ("All
// locations" + each, only with > 1 active location; with a location the table shows that row's numbers, with All
// locations a row expands to per-location numbers — composed), Warehouses tab 11:808, adjust dialog location select,
// movement rows and the latest-changes card show the location. Part B: "Transfer stock" 11:788 (→ new transfer; only
// with `multi_warehouse`, > 1 active location and `inventory.adjust`), movement rows "Transfer → {location}" /
// "Count · {name}" linking to the transfer / count. A one-location store renders exactly as before (no location UI).

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
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  count: 'Stock count',
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
  const locs = useStockLocations();
  const [adjusting, setAdjusting] = useState<{ item: InventoryItem; reason: 'received' | 'correction' } | null>(null);
  const paramLocation = params.get('location');
  const locationId = locs.multi && paramLocation && locs.active.some((l) => l.id === paramLocation) ? paramLocation : null;
  const [receiving, setReceiving] = useState(false);
  const features = useFeatures().data;
  const canTransfer = scope.canAdjustInventory && locs.multi && !!features && !multiWarehouseLocked(features);

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
        actions={
          <>
            {canTransfer && (
              <Link to={`/inventory/transfers/new${locationId ? `?from=${locationId}` : ''}`} className={buttonVariants({ variant: 'secondary' })}>
                Transfer stock
              </Link>
            )}
            {scope.canManagePurchasing && (
              <Link to="/inventory/purchase-orders/new" className={buttonVariants({ variant: 'secondary' })}>
                Purchase order
              </Link>
            )}
            <Button onClick={() => setReceiving(true)}>+ Receive stock</Button>
          </>
        }
      />
      <InventoryTabs value={tab} onChange={(t) => setTab(t as 'levels' | 'movements')} />
      {tab === 'levels' ? (
        <StockLevels
          canViewCosts={scope.canViewCosts}
          canManagePurchasing={scope.canManagePurchasing}
          locations={locs.multi ? locs.active : null}
          locationId={locationId}
          onAdjust={scope.canAdjustInventory ? (item) => setAdjusting({ item, reason: 'correction' }) : undefined}
          onLedger={() => setTab('movements')}
        />
      ) : (
        <Movements locations={locs.multi ? locs.active : null} />
      )}
      {adjusting && (
        <AdjustDialog
          key={`${adjusting.item.variant_id}:${adjusting.reason}`}
          open
          item={adjusting.item}
          initialReason={adjusting.reason}
          locations={locs.multi ? locs.active : null}
          initialLocationId={locationId}
          onClose={() => setAdjusting(null)}
        />
      )}
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

function StockLevels({
  canViewCosts,
  canManagePurchasing,
  locations,
  locationId,
  onAdjust,
  onLedger,
}: {
  canViewCosts: boolean;
  canManagePurchasing: boolean;
  /** Active locations when the store has more than one; null = no location UI. */
  locations: Location[] | null;
  /** Selected location (null = All locations). */
  locationId: string | null;
  onAdjust?: (i: InventoryItem) => void;
  onLedger: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const stock = (params.get('stock') ?? '').split(',').filter(Boolean) as NonNullable<InventoryListFilters['stock']>;
  const categoryId = params.get('category') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;
  const categories = useCategories();
  const [expanded, setExpanded] = useState<string[]>([]);
  const filters: InventoryListFilters = { q: debounced || undefined, stock: stock.length ? stock : undefined, category_id: categoryId || undefined, ...(locationId ? { location_id: locationId } : {}), page, per_page: 25 };
  const list = useInventory(filters);
  const latest = useMovements({ per_page: 6, ...(locationId ? { location_id: locationId } : {}) });
  const expandable = !!locations && !locationId;
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
      key: 'incoming',
      header: 'Incoming',
      width: 84,
      align: 'end',
      cell: (i) => (i.incoming > 0 ? <span className="text-body font-medium text-brand-600">+{formatCount(i.incoming)}</span> : <span className="text-body text-text-muted">—</span>),
    },
    {
      key: 'available',
      header: 'Available',
      width: 84,
      align: 'end',
      cell: (i) => <span className={cn('text-body font-semibold', i.track_inventory && i.available <= 0 ? 'text-danger' : 'text-text-primary')}>{formatCount(i.available)}</span>,
    },
    { key: 'status', header: 'Status', width: 110, align: 'center', cell: (i) => <StockBadge status={i.status} /> },
    ...(expandable
      ? [
          {
            key: 'locations',
            header: <span className="sr-only">Per location</span>,
            mobileLabel: false as const,
            width: 32,
            align: 'center' as const,
            cell: (i: InventoryItem) => {
              const open = expanded.includes(i.variant_id);
              const name = `${i.product.name}${i.title !== 'Default' ? ` ${i.title}` : ''}`;
              return (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${open ? 'Hide' : 'Show'} stock per location for ${name}`}
                  onClick={() => setExpanded((ids) => (open ? ids.filter((x) => x !== i.variant_id) : [...ids, i.variant_id]))}
                  className="flex h-8 items-center gap-1.5 rounded-md text-caption font-medium text-brand-600 outline-none hover:text-brand-700 focus-visible:shadow-focus md:size-8 md:justify-center"
                >
                  <span className="md:hidden">{open ? 'Hide locations' : 'By location'}</span>
                  <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
                </button>
              );
            },
          },
        ]
      : []),
    {
      key: 'adjust',
      header: <span className="sr-only">Adjust</span>,
      mobileLabel: false,
      width: 76,
      align: 'end',
      cell: (i) =>
        onAdjust ? (
          <Button size="sm" variant="secondary" aria-label={`Adjust ${i.product.name}${i.title !== 'Default' ? ` ${i.title}` : ''}`} onClick={() => onAdjust(i)}>
            Adjust
          </Button>
        ) : null,
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
      {canManagePurchasing && <ReorderCard variant="inventory" />}
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
      <div className="grid gap-4 min-[1400px]:grid-cols-[minmax(0,1fr)_340px] min-[1400px]:items-start">
        <DataTable
          className="min-w-0"
          label="Stock levels"
          toolbar={
            <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <SearchBox value={q} onChange={(v) => { setQ(v); set({ q: v }); }} placeholder="Product, SKU or barcode" label="Search stock" className="h-9 w-full sm:w-[230px] [&>svg]:size-4" />
              {locations && (
                <FilterSelect label="Location" value={locationId ?? ''} onChange={(e) => set({ location: e.target.value })}>
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </FilterSelect>
              )}
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
          renderExpanded={expandable ? (i) => (expanded.includes(i.variant_id) ? <LocationBreakdown item={i} locations={locations} /> : null) : undefined}
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
                      {movementPoRef(m) ? `Received · ${movementPoRef(m)!.number}` : (movementRefLabel(m)?.label ?? movementReasonLabel[m.reason])} · {m.product.name}
                    </span>
                    <span className="truncate text-caption text-text-muted">
                      {[m.variant_title !== 'Default' ? m.variant_title : null, locations && !locationId ? m.location.name : null, movementPoRef(m)?.supplier ?? null, m.actor?.name ? `By ${m.actor.name}` : null, shortDate(m.created_at)].filter(Boolean).join(' · ')}
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

/** All-locations row expansion (composed): each active location's on hand / held / available for the variant. */
function LocationBreakdown({ item, locations }: { item: InventoryItem; locations: Location[] | null }) {
  const name = `${item.product.name}${item.title !== 'Default' ? ` ${item.title}` : ''}`;
  const rows = (locations ?? []).map((l) => ({ id: l.id, name: l.name, isDefault: l.is_default, ...stockAt(item, l.id) }));
  return (
    <ul aria-label={`Stock per location for ${name}`} className="flex flex-col gap-1.5 md:pl-[52px]">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-body">
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
            {r.name}
            {r.isDefault && <span className="ml-1.5 text-caption font-normal text-text-muted">· Online</span>}
          </span>
          <span className="text-text-secondary">
            On hand <span className="font-medium text-text-primary">{formatCount(r.on_hand)}</span>
          </span>
          <span className="text-text-secondary">
            Held <span className="font-medium text-text-primary">{formatCount(r.committed)}</span>
          </span>
          <span className="text-text-secondary">
            Available <span className={cn('font-semibold', item.track_inventory && r.available <= 0 ? 'text-danger' : 'text-text-primary')}>{formatCount(r.available)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const reasonOptions: StockMovementReason[] = ['received', 'correction', 'damaged', 'lost', 'returned', 'import', 'initial', 'other'];

function Movements({ locations }: { locations: Location[] | null }) {
  const canOpenPo = useStoreScope().canReceiveStock;
  const [reason, setReason] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const locationId = locations && locations.some((l) => l.id === locationFilter) ? locationFilter : '';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productQ, setProductQ] = useState('');
  const [productId, setProductId] = useState('');
  const [page, setPage] = useState(1);
  const productMatches = useInventory({ q: useDebounced(productQ) || undefined, per_page: 8 });
  const list = useMovements({
    reason: reason ? [reason as StockMovementReason] : undefined,
    product_id: productId || undefined,
    ...(locationId ? { location_id: locationId } : {}),
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
    {
      key: 'reason',
      header: 'Reason',
      width: 170,
      cell: (m) => {
        const po = movementPoRef(m);
        const ref = po ? null : movementRefLabel(m);
        if (ref)
          return (
            <Cell2
              top={
                ref.to ? (
                  <Link to={ref.to} className="text-brand-600 hover:text-brand-700">
                    {ref.label}
                  </Link>
                ) : (
                  ref.label
                )
              }
              bottom={ref.sub ?? undefined}
              topClass="font-medium"
            />
          );
        if (!po) return <Cell2 top={movementReasonLabel[m.reason]} bottom={m.note ?? undefined} topClass="font-medium" />;
        return (
          <Cell2
            top={
              canOpenPo ? (
                <Link to={`/inventory/purchase-orders/${po.id}`} className="text-brand-600 hover:text-brand-700">
                  Received · {po.number}
                </Link>
              ) : (
                `Received · ${po.number}`
              )
            }
            bottom={po.supplier ?? undefined}
            topClass="font-medium"
          />
        );
      },
    },
    ...(locations
      ? [{ key: 'location', header: 'Location', width: 140, cell: (m: StockMovement) => <span className="truncate text-body text-text-secondary">{m.location.name}</span> }]
      : []),
    { key: 'delta', header: 'Change', width: 80, align: 'end', cell: (m) => <span className={cn('text-body font-semibold', m.delta > 0 ? 'text-success' : 'text-danger')}>{deltaText(m.delta)}</span> },
    { key: 'after', header: 'On hand after', width: 110, align: 'end', cell: (m) => <span className="text-body text-text-primary">{formatCount(m.on_hand_after)}</span> },
    { key: 'by', header: 'By', width: 120, cell: (m) => <span className="truncate text-body text-text-secondary">{m.actor?.name ?? (m.reason === 'import' ? 'CSV import' : '—')}</span> },
  ];

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = !!(reason || from || to || productId || locationId);
  return (
    <DataTable
      label="Stock movements"
      toolbar={
        <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
          <FilterSelect label="Reason" value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }}>
            <option value="">All reasons</option>
            {[...reasonOptions, ...(locations ? (['transfer_out', 'transfer_in'] as const) : []), 'count' as const].map((r) => (
              <option key={r} value={r}>
                {r in reasonLabels ? reasonLabels[r as keyof typeof reasonLabels] : movementReasonLabel[r]}
              </option>
            ))}
          </FilterSelect>
          {locations && (
            <FilterSelect label="Location" value={locationId} onChange={(e) => { setLocationFilter(e.target.value); setPage(1); }}>
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </FilterSelect>
          )}
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
                    setLocationFilter('');
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
