import type { DashboardSummary } from '@storeplix/types';
import { buttonVariants, cn, KpiTile, Skeleton } from '@storeplix/ui';
import { AlertTriangle, Box, ChevronRight, Copy, MinusCircle, Package, PackagePlus, RefreshCw, ShoppingBag, Truck, Users, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { formatCount, plural } from '../catalog/format';
import { useDashboard } from '../catalog/queries';
import { ErrorBlock } from '../catalog/states';
import { PageHeader } from '../layout/PageHeader';
import { SetupChecklist } from '../onboarding/SetupChecklist';
import { toast } from '../online-store/components/Toast';
import { PreviewStoreButton } from '../stores/PreviewStoreButton';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Dashboard 10:600 (Main 10:754): header 10:782, KPI row 10:797 (tiles 13:964, hero money card 10:798),
// "Needs you today" 10:958 (Restock task 10:1011); Card / Empty 148:34624; mobile Today 31:4281.
// Contract §9.1 / P4-24: order and money metrics are null in Phase 4 → "—" with "Starts with your first order";
// range toggle, sales chart, sources, couriers, money flow, orders waiting and best sellers are Phase 5/7.

function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const EMPTY_HINT = 'Starts with your first order';

export function DashboardPage() {
  const { user } = useAuth();
  const store = useTenantStore().data;
  const dashboard = useDashboard();
  const d = dashboard.data;
  const firstName = user?.name.split(' ')[0] ?? '';
  // Low and out-of-stock are reported separately so the greeting agrees with the Low stock tile (QA F-L2).
  const stockNote = d
    ? `${formatCount(d.inventory.low_stock_variants)} low on stock${d.inventory.out_of_stock_variants > 0 ? `, ${formatCount(d.inventory.out_of_stock_variants)} out of stock` : ''}`
    : '';
  const subtitle = store ? (d ? `${store.name} · ${plural(d.products.total, 'product')}, ${stockNote}` : `${store.name} · here is what is happening today.`) : 'Welcome to Store Plix.';
  const shopUrl = store ? `https://${storeDomain(store)}` : '';

  return (
    <>
      <PageHeader title={`${greeting()}, ${firstName}`} subtitle={subtitle} actions={store && <PreviewStoreButton store={store} />} />

      <section aria-label="Sales overview" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* Hero money card 10:798 with the Card / Empty pattern 148:34624 */}
        <div className="flex flex-col gap-4 rounded-card bg-linear-to-br from-brand-500 to-brand-700 p-5 text-text-inverse shadow-elevation-1">
          <div className="flex flex-col gap-1">
            <span className="text-body font-medium text-text-inverse/80">Received this month</span>
            <span className="text-heading-32">—</span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-3 rounded-lg bg-text-inverse/10 p-4">
            <span className="flex items-center gap-2 text-body font-semibold">
              <Wallet aria-hidden className="size-4" /> No sales yet
            </span>
            <span className="text-caption text-text-inverse/80">Share your shop link on Facebook and WhatsApp to get your first order.</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!store}
                onClick={() =>
                  void (navigator.clipboard?.writeText(shopUrl) ?? Promise.reject(new Error('no clipboard'))).then(
                    () => toast('Shop link copied.'),
                    () => toast(shopUrl),
                  )
                }
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-surface-card px-3 text-caption font-medium text-brand-700 hover:bg-brand-50"
              >
                <Copy aria-hidden className="size-3.5" /> Share your shop link
              </button>
              {store && store.status !== 'draft' && (
                <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center rounded-md bg-text-inverse/15 px-3 text-caption font-medium hover:bg-text-inverse/25">
                  Preview shop
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 lg:grid-cols-2 lg:gap-4">
          <KpiTile icon={<ShoppingBag />} label="Orders" value="—" hint={EMPTY_HINT} className="max-lg:px-3 max-lg:py-3" />
          <KpiTile icon={<Truck />} label="Delivery success" value="—" hint={EMPTY_HINT} className="max-lg:px-3 max-lg:py-3" />
          <KpiTile icon={<Wallet />} label="Net profit" value="—" hint={EMPTY_HINT} className="hidden lg:flex" />
          <KpiTile icon={<RefreshCw />} label="Returns cost" value="—" hint={EMPTY_HINT} className="max-lg:px-3 max-lg:py-3" />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <CatalogCard query={dashboard} />
        <TodayCard summary={d} loading={dashboard.isPending} failed={dashboard.isError} />
      </div>

      <SetupChecklist />
    </>
  );
}

/** Reuses the Products KPI card style (60:8984): Active products, Low stock, Out of stock, Customers. */
function CatalogCard({ query }: { query: ReturnType<typeof useDashboard> }) {
  const d = query.data;
  if (query.isError) {
    return (
      <section aria-label="Catalog" className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
        <ErrorBlock title="We couldn’t load your numbers" error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }
  const value = (n: number | undefined) => (query.isPending ? <Skeleton className="h-8 w-16" /> : formatCount(n ?? 0));
  return (
    <section aria-label="Catalog" className="grid grid-cols-2 gap-3 lg:gap-4">
      <KpiTile
        icon={<Package />}
        label="Active products"
        value={value(d?.products.active)}
        hint={d ? (d.products.limit === null ? `${plural(d.products.total, 'product')} in total` : `${formatCount(d.products.total)} of ${formatCount(d.products.limit)} on your plan`) : undefined}
      />
      <KpiTile icon={<AlertTriangle />} label="Low stock" value={value(d?.inventory.low_stock_variants)} hint="variants running low" />
      <KpiTile icon={<MinusCircle />} label="Out of stock" value={value(d?.inventory.out_of_stock_variants)} hint="shown as “Sold out”" />
      <KpiTile icon={<Users />} label="Customers" value={value(d?.customers.total)} hint={d ? `+${formatCount(d.customers.new_this_month)} this month` : undefined} />
    </section>
  );
}

/** "Needs you today" 10:958 — only the Restock task (10:1011) and "Add your first product" exist in Phase 4. */
function TodayCard({ summary, loading, failed }: { summary: DashboardSummary | undefined; loading: boolean; failed: boolean }) {
  const restock = summary ? summary.inventory.low_stock_variants + summary.inventory.out_of_stock_variants : 0;
  const tasks = [
    ...(summary && !summary.setup.has_products
      ? [{ key: 'add', to: '/products/new', icon: <PackagePlus />, tone: 'bg-brand-50 text-brand-600', title: 'Add your first product', hint: 'Photo, name, price and sizes', count: null as number | null }]
      : []),
    { key: 'restock', to: '/inventory?stock=low,out', icon: <Box />, tone: 'bg-warning-bg text-warning', title: 'Restock products', hint: 'Low or sold out', count: restock as number | null },
  ];
  const open = tasks.filter((t) => t.count === null || t.count > 0).length;
  return (
    <section aria-label="Needs you today" className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex items-center justify-between">
        <h2 className="text-body-lg font-semibold text-text-primary">Needs you today</h2>
        {summary && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-caption font-medium text-brand-700">{plural(open, 'task')}</span>}
      </div>
      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : failed ? (
        <Link to="/products" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          Go to products
        </Link>
      ) : (
        <ul className="flex flex-col gap-1">
          {tasks.map((t) => (
            <li key={t.key}>
              <Link to={t.to} className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-surface-subtle">
                <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control [&_svg]:size-[18px]', t.tone)}>{t.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-semibold text-text-primary">{t.title}</span>
                  <span className="truncate text-caption text-text-muted">{t.hint}</span>
                </span>
                {t.count !== null && <span className="text-heading text-text-primary">{formatCount(t.count)}</span>}
                <ChevronRight aria-hidden className="size-4 text-text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {summary && restock === 0 && summary.setup.has_products && <p className="text-caption text-text-muted">All caught up — stock looks healthy.</p>}
    </section>
  );
}
