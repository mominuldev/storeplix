import type { DashboardSummary, OrderDashboard } from '@storeplix/types';
import { buttonVariants, cn, KpiTile, Skeleton } from '@storeplix/ui';
import { AlertTriangle, ChartColumn, ChevronRight, Copy, CreditCard, Minus, Package, PackageCheck, PackagePlus, RefreshCw, ShoppingBag, Truck, Users, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { Thumb } from '../catalog/ui';
import { useDashboard } from '../catalog/queries';
import { ErrorBlock } from '../catalog/states';
import { PageHeader } from '../layout/PageHeader';
import { SetupChecklist } from '../onboarding/SetupChecklist';
import { toast } from '../online-store/components/Toast';
import { PreviewStoreButton } from '../stores/PreviewStoreButton';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Dashboard 10:600 (Main 10:754): header 10:782, KPI row 10:797 (tiles 13:964, hero money card 10:798),
// "Needs you today" 10:958 (Restock task 10:1011); Card / Empty 148:34624; mobile Today 31:4281.
// Phase 5a §9: KPI tiles 13:964 (Orders, Delivery success, Sales, Returns — this month), "Needs you today" gains
// Confirm / Pack tasks, Orders waiting 10:1115 and Best sellers 10:1168. `orders: null` (no order yet) keeps the
// Phase 4 empty states. Not built (§11): range toggle, sales chart, sources, couriers, money flow, net profit.

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
  const o = d?.orders ?? null;
  const m = o?.this_month;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={subtitle}
        actions={
          <>
            {store && <PreviewStoreButton store={store} />}
            <Link to="/orders/new" className={cn(buttonVariants(), 'max-md:hidden')}>
              + Create order
            </Link>
          </>
        }
      />

      <section aria-label="Sales overview" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* Hero money card 10:798 with the Card / Empty pattern 148:34624 */}
        <div className="flex flex-col gap-3.5 rounded-card bg-linear-[124deg] from-brand-600 from-0% to-brand-700 to-70% p-5 text-text-inverse lg:px-6 lg:py-[22px]">
          <span className="text-body font-medium opacity-85">Received this month</span>
          <span className="text-heading-32 lg:text-display">{m ? formatBdt(m.sales_amount) : '—'}</span>
          {m && <span className="-mt-2 text-caption text-text-inverse/80">From {plural(m.delivered_count, 'delivered order')}</span>}
          <div className="mt-auto flex flex-col gap-2.5 rounded-lg bg-text-inverse/12 px-3.5 py-3">
            <span className="flex items-center gap-2 text-body font-semibold">
              <Wallet aria-hidden className="size-4" /> {o ? 'Keep the orders coming' : 'No sales yet'}
            </span>
            <span className="text-caption text-text-inverse/80">{o ? 'Share your shop link again — every share brings new buyers.' : 'Share your shop link on Facebook and WhatsApp to get your first order.'}</span>
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
          <MoneyKpi icon={<ShoppingBag />} tone="bg-brand-50 text-brand-600" label="Orders" value={m ? formatCount(m.count) : '—'} hint={m ? `this month · ${formatCount(m.cancelled_count)} cancelled` : EMPTY_HINT} />
          <MoneyKpi
            icon={<Truck />}
            tone="bg-success-bg text-success"
            label="Delivery success"
            value={m && m.delivery_success_rate !== null ? `${Math.round(m.delivery_success_rate * 100)}%` : '—'}
            hint={m ? `${formatCount(m.delivered_count)} delivered · ${formatCount(m.returned_count)} returned` : EMPTY_HINT}
          />
          <MoneyKpi icon={<ChartColumn />} tone="bg-info-bg text-info" label="Sales" value={m ? formatBdt(m.sales_amount) : '—'} hint={m ? 'delivered this month' : EMPTY_HINT} className="hidden lg:flex" />
          <MoneyKpi icon={<RefreshCw />} tone="bg-accent-100 text-accent-500" label="Returns" value={m ? formatCount(m.returned_count) : '—'} hint={m ? 'came back this month' : EMPTY_HINT} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <CatalogCard query={dashboard} />
        <TodayCard summary={d} loading={dashboard.isPending} failed={dashboard.isError} />
      </div>

      {o && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
          <OrdersWaiting orders={o} />
          <BestSellers orders={o} />
        </div>
      )}

      <SetupChecklist />
    </>
  );
}

/**
 * KPI tile 13:965 (dashboard money row): 32px tinted icon tile (radius 10, 16px icon, stroke 2), Body/14 Medium label,
 * Heading/32 Bold value with 6px top pad, Caption muted hint. Trend pill and sparkline are deferred (§11).
 */
function MoneyKpi({ icon, tone, label, value, hint, className }: { icon: ReactNode; tone: string; label: string; value: ReactNode; hint: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-card border border-border-default bg-surface-card p-3 shadow-elevation-1 lg:gap-1.5 lg:px-5 lg:py-[18px]', className)}>
      <div className="flex items-center gap-2.5">
        <span className={cn('hidden size-8 shrink-0 items-center justify-center rounded-control lg:flex [&_svg]:size-4 [&_svg]:stroke-3', tone)}>{icon}</span>
        <span className="truncate text-caption text-text-secondary lg:text-body lg:font-medium">{label}</span>
      </div>
      <span className="truncate text-heading text-text-primary lg:pt-1.5 lg:text-heading-32">{value}</span>
      <span className="line-clamp-2 text-caption text-text-muted">{hint}</span>
    </div>
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
        icon={<Package strokeWidth={3} />}
        label="Active products"
        value={value(d?.products.active)}
        hint={d ? (d.products.limit === null ? `${plural(d.products.total, 'product')} in total` : `${formatCount(d.products.total)} of ${formatCount(d.products.limit)} on your plan`) : undefined}
      />
      <KpiTile icon={<AlertTriangle strokeWidth={3} />} label="Low stock" value={value(d?.inventory.low_stock_variants)} hint="variants running low" />
      <KpiTile icon={<Minus strokeWidth={3} />} label="Out of stock" value={value(d?.inventory.out_of_stock_variants)} hint="shown as “Sold out”" />
      <KpiTile icon={<Users strokeWidth={3} />} label="Customers" value={value(d?.customers.total)} hint={d ? `+${formatCount(d.customers.new_this_month)} this month` : undefined} />
    </section>
  );
}

/**
 * "Needs you today" 10:958 — Confirm / Pack orders (Phase 5a), unpaid online orders (5b §10), Restock (10:1011) and
 * "Add your first product", plus 5b-3 "Book N parcels" (`waiting.to_book`) and "N delivery problems" (`shipments.problems`).
 */
function TodayCard({ summary, loading, failed }: { summary: DashboardSummary | undefined; loading: boolean; failed: boolean }) {
  const restock = summary ? summary.inventory.low_stock_variants + summary.inventory.out_of_stock_variants : 0;
  const waiting = summary?.orders?.waiting;
  const tasks = [
    ...(waiting
      ? [
          { key: 'confirm', to: '/orders?status=pending', icon: <ShoppingBag />, tone: 'bg-brand-50 text-brand-600', title: `Confirm ${plural(waiting.pending, 'order')}`, hint: 'Call or message to confirm', count: waiting.pending as number | null },
          { key: 'pack', to: '/orders?status=confirmed', icon: <PackageCheck />, tone: 'bg-info-bg text-info', title: `Pack ${plural(waiting.confirmed, 'order')}`, hint: 'Confirmed and ready to pack', count: waiting.confirmed as number | null },
          {
            key: 'unpaid',
            to: '/orders?status=pending_payment',
            icon: <CreditCard />,
            tone: 'bg-success-bg text-success',
            title: `${plural(waiting.pending_payment, 'unpaid online order')}`,
            hint: 'Cancelled on their own if not paid in time',
            count: waiting.pending_payment as number | null,
          },
          {
            key: 'book',
            to: '/shipments',
            icon: <Truck />,
            tone: 'bg-info-bg text-info',
            title: `Book ${plural(waiting.to_book, 'parcel')}`,
            hint: 'Confirmed orders without a courier yet',
            count: waiting.to_book as number | null,
          },
        ]
      : []),
    ...(summary?.orders?.shipments
      ? [
          {
            key: 'problems',
            to: '/shipments?status=problems&range=all',
            icon: <AlertTriangle />,
            tone: 'bg-danger-bg text-danger',
            title: plural(summary.orders.shipments.problems, 'delivery problem'),
            hint: 'Failed, on hold or coming back',
            count: summary.orders.shipments.problems as number | null,
          },
        ]
      : []),
    ...(summary && !summary.setup.has_products
      ? [{ key: 'add', to: '/products/new', icon: <PackagePlus />, tone: 'bg-brand-50 text-brand-600', title: 'Add your first product', hint: 'Photo, name, price and sizes', count: null as number | null }]
      : []),
    { key: 'restock', to: '/inventory?stock=low,out', icon: <Package />, tone: 'bg-warning-bg text-warning', title: 'Restock products', hint: 'Low or sold out', count: restock as number | null },
  ];
  const open = tasks.filter((t) => t.count === null || t.count > 0).length;
  return (
    <section aria-label="Needs you today" className="flex flex-col gap-1 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 lg:px-6 lg:py-[22px]">
      <div className="flex items-start justify-between pb-2">
        <h2 className="text-heading text-text-primary lg:text-body-lg lg:font-medium">Needs you today</h2>
        {summary && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700">{plural(open, 'task')}</span>}
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
              <Link to={t.to} className="flex items-center gap-3 rounded-control px-2 py-2.5 hover:bg-surface-subtle">
                <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control [&_svg]:size-[18px] [&_svg]:stroke-[2.67]', t.tone)}>{t.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-body font-semibold text-text-primary">{t.title}</span>
                  <span className="truncate text-caption text-text-secondary">{t.hint}</span>
                </span>
                {t.count !== null && <span className="text-heading text-text-primary">{formatCount(t.count)}</span>}
                <ChevronRight aria-hidden strokeWidth={3} className="size-4 text-text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {summary && open === 0 && summary.setup.has_products && <p className="text-caption text-text-muted">All caught up — nothing waits for you.</p>}
    </section>
  );
}

/**
 * Orders waiting 10:1115: pending / confirmed / ready to ship → filtered order lists. 5b §10 adds "Awaiting payment"
 * (`pending_payment`). Figma lists single orders; we show the waiting counts in the same card frame (header px 24 py 14,
 * border-t rows px 24).
 */
function OrdersWaiting({ orders }: { orders: OrderDashboard }) {
  const rows = [
    { label: 'Awaiting payment', status: 'pending_payment', n: orders.waiting.pending_payment },
    { label: 'Waiting to confirm', status: 'pending', n: orders.waiting.pending },
    { label: 'Confirmed, not packed', status: 'confirmed', n: orders.waiting.confirmed },
    { label: 'Packed, ready to ship', status: 'ready_to_ship', n: orders.waiting.ready_to_ship },
  ];
  return (
    <section aria-label="Orders waiting" className="flex flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      <div className="flex items-center justify-between px-6 py-3.5">
        <h2 className="text-body-lg font-medium text-text-primary">Orders waiting for you</h2>
        <Link to="/orders" className="text-body font-medium text-brand-600">
          All orders →
        </Link>
      </div>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.status} className="border-t border-border-default">
            <Link to={`/orders?status=${r.status}`} className="flex min-h-12 items-center gap-3 px-6 py-2 hover:bg-surface-subtle">
              <span className="flex-1 text-body font-semibold text-text-primary">{r.label}</span>
              <span className="text-body font-semibold text-text-primary">{formatCount(r.n)}</span>
              <ChevronRight aria-hidden strokeWidth={3} className="size-4 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Best sellers 10:1168: top 5 products by units, last 30 days (44px photo radius 10, name, "N sold"). */
function BestSellers({ orders }: { orders: OrderDashboard }) {
  return (
    <section aria-label="Best sellers" className="flex flex-col gap-2.5 rounded-card border border-border-default bg-surface-card px-6 py-[22px] shadow-elevation-1">
      <h2 className="text-body-lg font-medium text-text-primary">Best sellers · 30 days</h2>
      {orders.best_sellers.length === 0 ? (
        <p className="text-body text-text-muted">Your best sellers show up after your first orders.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {orders.best_sellers.map((p) => (
            <li key={p.product_id}>
              <Link to={`/products/${p.product_id}`} className="flex items-center gap-3 rounded-control hover:bg-surface-subtle">
                <Thumb src={p.image?.url} size={44} />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-body font-semibold text-text-primary">{p.name}</span>
                  <span className="text-caption text-text-secondary">{plural(p.units, 'sold', 'sold')}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
