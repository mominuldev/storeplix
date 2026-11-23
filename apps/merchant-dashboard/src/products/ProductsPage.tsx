import type { ProductBulkAction, ProductListFilters, ProductSort, ProductStatus, ProductSummary } from '@storeplix/types';
import { Badge, Button, buttonVariants, Card, cn, DataTable, Dialog, KpiTile, Menu, Pagination, Select, StockBadge, Tabs, Toggle, type DataTableColumn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Minus, Plug, MoreHorizontal, Package, PenLine, Plus, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { formatBdt, formatCount, plural, profitOf } from '../catalog/format';
import { useCategories, useInvalidate, useProducts } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { Cell2, FilterSelect, iconButton, ProductStatusBadge, SearchBox, Thumb, useDebounced, useIsMobile } from '../catalog/ui';
import { useExport } from '../imports/useExport';

// Figma Products 60:8984 (Main 60:8986), Product row 60:11336, empty state 148:34667, mobile 139:1077 / ProductCard
// 139:1065. Contract §4: SOLD column, "Top seller", "Edit prices", "Hide from Facebook shop", barcode scan and
// "Sort: Best selling" are hidden; the 4th KPI card shows the plan's product usage instead.

type Tab = 'all' | ProductStatus;
type MobileChip = 'all' | 'active' | 'low' | 'out';

const sorts: { value: ProductSort; label: string }[] = [
  { value: '-created_at', label: 'Sort: Newest' },
  { value: 'created_at', label: 'Sort: Oldest' },
  { value: 'name', label: 'Sort: Name A–Z' },
  { value: '-name', label: 'Sort: Name Z–A' },
  { value: 'price', label: 'Sort: Price low–high' },
  { value: '-price', label: 'Sort: Price high–low' },
  { value: '-updated_at', label: 'Sort: Recently edited' },
];

export function stockLine(p: Pick<ProductSummary, 'stock'>): { top: string; bottom: string; tone: 'danger' | 'warning' | 'muted' } {
  const s = p.stock;
  if (!s.tracked) return { top: 'Not tracked', bottom: '', tone: 'muted' };
  const top = `${formatCount(s.on_hand)} in stock`;
  if (s.available <= 0) return { top, bottom: 'Sold out', tone: 'danger' };
  if (s.out_variants > 0) return { top, bottom: `Out · ${plural(s.out_variants, 'variant')}`, tone: 'warning' };
  if (s.low_variants > 0) return { top, bottom: `Low · ${plural(s.low_variants, 'variant')}`, tone: 'warning' };
  return { top, bottom: 'Healthy', tone: 'muted' };
}

function stockStatusOf(p: ProductSummary) {
  if (!p.stock.tracked) return 'untracked' as const;
  if (p.stock.available <= 0) return 'out_of_stock' as const;
  if (p.stock.low_variants > 0 || p.stock.out_variants > 0) return 'low_stock' as const;
  return 'in_stock' as const;
}

export function ProductsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const scope = useStoreScope();
  const invalidate = useInvalidate();
  const exporter = useExport();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('status') as Tab | null) ?? 'all';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q);
  const categoryId = params.get('category') ?? '';
  const stock = (params.get('stock') as ProductListFilters['stock'] | null) ?? undefined;
  const sort = (params.get('sort') as ProductSort | null) ?? '-created_at';
  const page = Number(params.get('page') ?? '1') || 1;
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ action: ProductBulkAction | 'delete-one'; ids: string[]; name?: string } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState(false);
  const [bulkCategory, setBulkCategory] = useState('');

  const filters: ProductListFilters = {
    status: tab === 'all' ? undefined : [tab],
    q: debouncedQ || undefined,
    category_id: categoryId || undefined,
    stock,
    sort,
    page,
    per_page: 25,
  };
  const list = useProducts(filters);
  const categories = useCategories();

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
    setSelected([]);
  };

  const bulk = useMutation({
    mutationFn: (input: { action: ProductBulkAction; ids: string[]; category_ids?: string[] }) => api.products.bulk(scope.storeId!, input),
    onSuccess: async (r) => {
      const verb = { activate: 'Published', draft: 'Moved to draft', archive: 'Archived', delete: 'Deleted', set_categories: 'Updated', add_categories: 'Updated' }[r.action];
      toast(`${verb} ${plural(r.updated, 'product')}.`);
      setSelected([]);
      setConfirm(null);
      setCategoryDialog(false);
      await invalidate.afterProductSave();
    },
    onError: (e) => toast(errorMessage(e, 'That didn’t work. Try again.'), 'error'),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.products.duplicate(scope.storeId!, id),
    onSuccess: async (p) => {
      toast(`Copied as “${p.name}” (draft).`);
      await invalidate.afterProductSave();
      navigate(`/products/${p.id}`);
    },
    onError: (e) => {
      if (!handlePlanLimit(e)) toast(errorMessage(e), 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.products.delete(scope.storeId!, id),
    onSuccess: async () => {
      toast('Product deleted.');
      setConfirm(null);
      await invalidate.afterProductSave();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const setStatus = (p: ProductSummary, status: 'activate' | 'draft' | 'archive') => bulk.mutate({ action: status, ids: [p.id] });

  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];
  const counts = meta?.counts;
  const hasFilters = !!(debouncedQ || categoryId || stock || tab !== 'all');
  const isEmptyShop = !!counts && counts.all === 0 && !hasFilters;
  const catName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c])), [categories.data]);

  const columns: DataTableColumn<ProductSummary>[] = [
    {
      key: 'product',
      header: 'Product',
      mobileLabel: false,
      cell: (p) => (
        <Link to={`/products/${p.id}`} className="flex min-w-0 items-center gap-3 pr-8 md:pr-0" onClick={(e) => e.stopPropagation()}>
          <Thumb src={p.image?.url} />
          <Cell2 top={p.name} bottom={[p.first_sku ? `SKU ${p.first_sku}` : null, p.categories[0]?.name].filter(Boolean).join(' · ') || 'No SKU'} />
        </Link>
      ),
    },
    { key: 'variants', header: 'Variants', width: 80, cell: (p) => <Cell2 top={formatCount(p.variants_count)} bottom={p.variants_count === 1 ? 'variant' : 'variants'} topClass="font-medium" /> },
    {
      key: 'stock',
      header: 'Stock',
      width: 110,
      cell: (p) => {
        const s = stockLine(p);
        return <Cell2 top={s.top} bottom={s.bottom} topClass={s.tone === 'danger' ? 'text-danger' : undefined} bottomClass={s.tone === 'danger' ? 'text-danger' : s.tone === 'warning' ? 'text-warning' : undefined} />;
      },
    },
    {
      key: 'price',
      header: 'Price',
      width: 100,
      cell: (p) => (
        <Cell2
          top={formatBdt(p.price_amount)}
          bottom={p.compare_at_amount ? <span className="line-through">{formatBdt(p.compare_at_amount)}</span> : p.price_min_amount !== p.price_max_amount ? `up to ${formatBdt(p.price_max_amount)}` : undefined}
        />
      ),
    },
    ...(scope.canViewCosts
      ? [
          {
            key: 'profit',
            header: 'Profit / unit',
            width: 120,
            cell: (p: ProductSummary) => {
              const profit = profitOf(p.price_amount, p.cost_amount);
              return profit ? (
                <Cell2 top={`${formatBdt(profit.amount)} · ${profit.percent}%`} bottom={`Cost ${formatBdt(p.cost_amount)}`} topClass={profit.amount >= 0 ? 'text-success' : 'text-danger'} />
              ) : (
                <Cell2 top="—" bottom="Add a cost" topClass="font-medium text-text-muted" />
              );
            },
          },
        ]
      : []),
    { key: 'status', header: 'Status', width: 84, cell: (p) => <ProductStatusBadge status={p.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      mobileLabel: false,
      width: 72,
      align: 'end',
      cell: (p) => (
        <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Link to={`/products/${p.id}`} aria-label={`Edit ${p.name}`} className={iconButton}>
            <PenLine aria-hidden className="text-text-secondary" />
          </Link>
          <Menu
            label={`More actions for ${p.name}`}
            triggerClassName={iconButton}
            trigger={<MoreHorizontal aria-hidden />}
            entries={[
              { key: 'dup', label: 'Duplicate', onSelect: () => duplicate.mutate(p.id) },
              p.status === 'active'
                ? { key: 'draft', label: 'Move to draft', onSelect: () => setStatus(p, 'draft') }
                : { key: 'act', label: 'Activate', onSelect: () => setStatus(p, 'activate') },
              ...(p.status !== 'archived' ? [{ key: 'arch', label: 'Archive', onSelect: () => setStatus(p, 'archive') }] : []),
              ...(scope.canManageCatalog
                ? [
                    { kind: 'separator' as const, key: 's' },
                    { key: 'del', label: 'Delete', danger: true, onSelect: () => setConfirm({ action: 'delete-one', ids: [p.id], name: p.name }) },
                  ]
                : []),
            ]}
          />
        </span>
      ),
    },
  ];

  const header = (
    <PageHeader
      title="Products"
      subtitle={isEmptyShop ? 'What you sell — with sizes, colours, stock and photos.' : 'Prices, costs and stock in one place. Profit is shown after product cost.'}
      actions={
        <>
          {scope.canBulkData && (
            <Link to="/products/import" className={buttonVariants({ variant: 'secondary' })}>
              {isEmptyShop ? 'Import' : 'Import CSV'}
            </Link>
          )}
          {scope.canExportData && !isEmptyShop && (
            <Button variant="secondary" loading={exporter.running} onClick={() => void exporter.start({ type: 'products', filters: { status: filters.status, category_id: filters.category_id, stock, q: filters.q } })}>
              Export
            </Button>
          )}
          {scope.canEditProducts && (
            <Link to="/products/new" className={buttonVariants()}>
              + Add product
            </Link>
          )}
        </>
      }
    />
  );

  if (list.isError && !list.data) {
    return (
      <>
        {header}
        <StateCard>
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        </StateCard>
      </>
    );
  }

  if (isEmptyShop) return <ProductsEmpty header={header} canImport={scope.canBulkData} />;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
      <SearchBox value={q} onChange={(v) => { setQ(v); set({ q: v }); }} placeholder="Search by product name or SKU" label="Search products" className="min-w-[220px] flex-1" />
      <FilterSelect label="Category" value={categoryId} onChange={(e) => set({ category: e.target.value })}>
        <option value="">All categories</option>
        {(categories.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {'— '.repeat(c.depth - 1)}
            {c.name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Stock" value={stock ?? ''} onChange={(e) => set({ stock: e.target.value })}>
        <option value="">Stock: any</option>
        <option value="in">Stock: in stock</option>
        <option value="low">Stock: low</option>
        <option value="out">Stock: sold out</option>
      </FilterSelect>
      <FilterSelect label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === '-created_at' ? null : e.target.value })}>
        {sorts.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </FilterSelect>
    </div>
  );

  const bodyState = list.isPending ? (
    <LoadingRows label="Loading products" />
  ) : rows.length === 0 ? (
    <NoResults
      title={debouncedQ ? `No products match “${debouncedQ}”` : 'No products here'}
      description="Check the spelling, or clear the filters."
      onClear={() => {
        setQ('');
        setParams(new URLSearchParams(), { replace: true });
      }}
      clearLabel="Clear filters"
    />
  ) : undefined;

  const pagination = meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="products" onPage={(p) => set({ page: String(p) })} />;

  if (isMobile) {
    return (
      <>
        <MobileProducts
          q={q}
          onQ={(v) => {
            setQ(v);
            set({ q: v });
          }}
          chip={tab === 'active' ? 'active' : stock === 'low' ? 'low' : stock === 'out' ? 'out' : 'all'}
          onChip={(c) => set({ status: c === 'active' ? 'active' : null, stock: c === 'low' ? 'low' : c === 'out' ? 'out' : null })}
          counts={counts}
          summary={meta?.summary}
          rows={rows}
          state={bodyState}
          onToggle={(p) => setStatus(p, p.status === 'active' ? 'draft' : 'activate')}
          busy={bulk.isPending}
        />
        {pagination && <Card className="overflow-hidden">{pagination}</Card>}
      </>
    );
  }

  return (
    <>
      {header}
      <Tabs
        aria-label="Product status"
        value={tab}
        onChange={(v) => set({ status: v === 'all' ? null : v })}
        items={[
          { value: 'all', label: 'All', count: counts?.all },
          { value: 'active', label: 'Active', count: counts?.active },
          { value: 'draft', label: 'Draft', count: counts?.draft },
          { value: 'archived', label: 'Archived', count: counts?.archived },
        ]}
      />
      <section aria-label="Product summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon={<Package strokeWidth={3} />} label="Active products" value={formatCount(meta?.summary.active_products ?? 0)} hint={`on your shop · ${plural(meta?.summary.active_variants ?? 0, 'variant')}`} />
        <KpiTile icon={<AlertTriangle strokeWidth={3} />} label="Low stock" value={formatCount(meta?.summary.low_stock_variants ?? 0)} hint="variants with 5 or fewer left" />
        <KpiTile icon={<Minus strokeWidth={3} />} label="Out of stock" value={formatCount(meta?.summary.out_of_stock_variants ?? 0)} hint="shown as “Sold out” to buyers" />
        <KpiTile
          icon={<Package strokeWidth={3} />}
          label="Products on your plan"
          value={meta ? (meta.plan.limit === null ? formatCount(meta.plan.used) : `${formatCount(meta.plan.used)} of ${formatCount(meta.plan.limit)}`) : '—'}
          hint={meta?.plan.limit === null ? 'Unlimited on your plan' : <Link to="/settings/plan" className="text-brand-600 hover:text-brand-700">See plans</Link>}
        />
      </section>
      <DataTable
        label="Products"
        toolbar={toolbar}
        columns={columns}
        rows={rows}
        getRowId={(p) => p.id}
        rowLabel={(p) => p.name}
        selected={selected}
        onSelectedChange={setSelected}
        state={bodyState}
        footer={pagination}
        bulkActions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setCategoryDialog(true)}>
              Change category
            </Button>
            <Button size="sm" variant="secondary" loading={bulk.isPending && bulk.variables?.action === 'archive'} onClick={() => bulk.mutate({ action: 'archive', ids: selected })}>
              Archive
            </Button>
            {scope.canManageCatalog && (
              <Button size="sm" variant="secondary" className="text-danger" onClick={() => setConfirm({ action: 'delete', ids: selected })}>
                Delete
              </Button>
            )}
            <Button size="sm" loading={bulk.isPending && bulk.variables?.action === 'activate'} onClick={() => bulk.mutate({ action: 'activate', ids: selected })}>
              Publish {selected.length}
            </Button>
          </>
        }
      />

      <Dialog
        open={!!confirm}
        tone="danger"
        title={confirm?.action === 'delete-one' ? `Delete “${confirm.name}”?` : `Delete ${plural(confirm?.ids.length ?? 0, 'product')}?`}
        description="Deleted products disappear from your shop and this list. Their stock history is kept. Archive instead if you might sell it again."
        confirmLabel="Delete"
        loading={bulk.isPending || remove.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === 'delete-one') remove.mutate(confirm.ids[0]!);
          else bulk.mutate({ action: 'delete', ids: confirm.ids });
        }}
      />
      <Dialog
        open={categoryDialog}
        title={`Change category for ${plural(selected.length, 'product')}`}
        description="Replaces their current categories."
        confirmLabel="Save"
        confirmDisabled={!bulkCategory}
        loading={bulk.isPending}
        onCancel={() => setCategoryDialog(false)}
        onConfirm={() => bulk.mutate({ action: 'set_categories', ids: selected, category_ids: [bulkCategory] })}
      >
        <Select label="Category" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
          <option value="">Choose a category</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {'— '.repeat(c.depth - 1)}
              {catName.get(c.id)?.name}
            </option>
          ))}
        </Select>
      </Dialog>
    </>
  );
}

/** Empty state 148:34667: Card / Empty 148:35263 + "Ways to add" 148:35276. */
function ProductsEmpty({ header, canImport }: { header: React.ReactNode; canImport: boolean }) {
  return (
    <>
      {header}
      <Card className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <span className="flex size-15 items-center justify-center rounded-full bg-brand-50 text-text-secondary">
          <Package aria-hidden className="size-7" />
        </span>
        <h2 className="text-heading text-text-primary">Add your first product</h2>
        <p className="max-w-md text-body-lg text-text-secondary">Most shops start with 5–10 best sellers. You can add photos straight from your phone.</p>
        <div className="flex flex-wrap justify-center gap-2.5">
          {canImport && (
            <Link to="/products/import" className={buttonVariants({ variant: 'secondary' })}>
              Import from CSV
            </Link>
          )}
          <Link to="/products/new" className={buttonVariants()}>
            Add a product
          </Link>
        </div>
      </Card>
      <section aria-label="Ways to add" className="grid gap-4 md:grid-cols-3">
        <WayCard to="/products/new" icon={<PenLine />} title="Type it in" hint="Name, price, sizes — about 2 minutes" />
        {canImport ? (
          <WayCard to="/products/import" icon={<Upload />} title="Import a spreadsheet" hint="Save as CSV UTF-8 from Excel or your old shop" />
        ) : (
          <WayCard icon={<Upload />} title="Import a spreadsheet" hint="Ask a manager to import a CSV" />
        )}
        <WayCard icon={<Plug />} title="Copy from Facebook posts" hint="Pick posts, we pull photos and prices" badge="Coming soon" />
      </section>
    </>
  );
}

function WayCard({ to, icon, title, hint, badge }: { to?: string; icon: React.ReactNode; title: string; hint: string; badge?: string }) {
  const body = (
    <>
      <span className="flex size-[30px] items-center justify-center rounded-md bg-brand-50 text-text-secondary [&_svg]:size-4">{icon}</span>
      <span className="flex items-center gap-2 text-body font-semibold text-text-primary">
        {title} {badge && <Badge>{badge}</Badge>}
      </span>
      <span className="text-caption text-text-secondary">{hint}</span>
    </>
  );
  const cls = 'flex flex-col gap-2 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1';
  return to ? (
    <Link to={to} className={`${cls} hover:border-brand-500`}>
      {body}
    </Link>
  ) : (
    <div aria-disabled className={`${cls} opacity-70`}>
      {body}
    </div>
  );
}

/** Mobile Products 139:1077: summary line, search, filter chips, ProductCard 139:1065 with an active↔draft toggle. */
function MobileProducts({
  q,
  onQ,
  chip,
  onChip,
  counts,
  summary,
  rows,
  state,
  onToggle,
  busy,
}: {
  q: string;
  onQ: (v: string) => void;
  chip: MobileChip;
  onChip: (c: MobileChip) => void;
  counts?: Record<'all' | ProductStatus, number>;
  summary?: { low_stock_variants: number; out_of_stock_variants: number };
  rows: ProductSummary[];
  state: React.ReactNode;
  onToggle: (p: ProductSummary) => void;
  busy: boolean;
}) {
  const { canEditProducts } = useStoreScope();
  const chips: { value: MobileChip; label: string; count?: number }[] = [
    { value: 'all', label: 'All', count: counts?.all },
    { value: 'active', label: 'Active', count: counts?.active },
    { value: 'low', label: 'Low stock', count: summary?.low_stock_variants },
    { value: 'out', label: 'Sold out', count: summary?.out_of_stock_variants },
  ];
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-heading-24 text-text-primary">Products</h1>
          <p className="text-body text-text-secondary">
            {plural(counts?.all ?? 0, 'product')}
            {summary && summary.low_stock_variants > 0 ? ` · ${formatCount(summary.low_stock_variants)} running low` : ''}
          </p>
        </div>
        {canEditProducts && (
          <Link to="/products/new" aria-label="Add product" className={cn(iconButton, 'size-11 rounded-full [&_svg]:size-[22px]')}>
            <Plus aria-hidden />
          </Link>
        )}
      </div>
      <SearchBox value={q} onChange={onQ} placeholder="Search product name or SKU" label="Search products" className="h-12 rounded-lg border border-border-default bg-surface-card px-[15px] gap-2.5 [&>svg]:size-5" />
      <div role="tablist" aria-label="Filter products" className="-mx-4 flex gap-2 overflow-x-auto px-4">
        {chips.map((c) => (
          <button
            key={c.value}
            type="button"
            role="tab"
            aria-selected={chip === c.value}
            onClick={() => onChip(c.value)}
            className={
              chip === c.value
                ? 'flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-brand-600 px-3.5 text-body font-medium text-text-inverse'
                : 'flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border-default bg-surface-card px-3.5 text-body font-medium text-text-primary'
            }
          >
            {c.label}
            {c.count !== undefined && <span className={chip === c.value ? 'rounded-full bg-text-inverse/20 px-[7px] py-px text-caption' : 'rounded-full bg-surface-subtle px-[7px] py-px text-caption text-text-secondary'}>{c.count}</span>}
          </button>
        ))}
      </div>
      {state ? (
        <StateCard>{state}</StateCard>
      ) : (
        <ul aria-label="Products" className="flex flex-col gap-4">
          {rows.map((p) => {
            const s = stockLine(p);
            const status = stockStatusOf(p);
            return (
              <li key={p.id} className="flex h-24 items-center gap-3 rounded-card border border-border-default bg-surface-card p-3 shadow-elevation-1">
                <Link to={`/products/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Thumb src={p.image?.url} size={72} className="rounded-lg" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-body font-semibold text-text-primary">{p.name}</span>
                    <span className="truncate text-caption text-text-secondary">
                      {plural(p.variants_count, 'variant')} · {p.stock.tracked ? s.top : 'Not tracked'}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-body font-semibold text-text-primary">{formatBdt(p.price_amount)}</span>
                      <StockBadge status={status} dot label={status === 'out_of_stock' ? 'Sold out' : status === 'low_stock' ? s.bottom || 'Low' : undefined} />
                    </span>
                  </span>
                </Link>
                {p.status !== 'archived' && (
                  <Toggle label={`${p.name} is ${p.status === 'active' ? 'active' : 'draft'}`} checked={p.status === 'active'} disabled={busy} onChange={() => onToggle(p)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
