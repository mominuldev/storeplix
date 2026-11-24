import type { MarketingOverview, MarketingRange } from '@storeplix/types';
import { BarChart, ChartLegend, cn, formatBdtCompact, KpiTile, Skeleton, buttonVariants, type BarDatum } from '@storeplix/ui';
import { BarChart3, CreditCard, Mail, MessageCircle, Send, ShoppingBag, ShoppingCart } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { FilterSelect } from '../catalog/ui';
import { couponValue } from '../coupons/labels';
import { PageHeader } from '../layout/PageHeader';
import { useFeatures } from '../plan/useFeatures';
import { allowanceOf, campaignsLocked } from './campaigns';
import { useMarketingOverview } from './queries';
import { CampaignPlanNote, CampaignsTable, MarketingTabs } from './ui';

// Figma Marketing overview 66:19179 (Main 66:19181), PHASE-8-5 §8.1 as amended by PHASE-8-6 §10.5. Header + range
// dropdown + "+ Create coupon" / "+ New campaign"; tabs Overview · Coupons · Campaigns · Automations (n on); KPI tiles
// Revenue from marketing, Orders from campaigns, Carts recovered, Messages sent (composed in the hidden "Return on spend"
// slot); weekly stacked bars Coupons + Campaigns + Cart recovery ("Best week yet" banner hidden); Active coupons card;
// "Start something new" Discount coupon / SMS campaign / Email campaign (WhatsApp slot, PO) / Abandoned cart recovery;
// Recent campaigns table. Below `lg` the chart and coupons cards stack (Q151).

const RANGES: { value: MarketingRange; label: string; days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
];

export function MarketingOverviewPage() {
  const scope = useStoreScope();
  const features = useFeatures();
  const [params, setParams] = useSearchParams();
  const range = (RANGES.some((r) => r.value === params.get('range')) ? params.get('range') : '30d') as MarketingRange;
  const days = RANGES.find((r) => r.value === range)!.days;
  const overview = useMarketingOverview(range);
  const locked = !features.data || campaignsLocked(features.data);
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const data = overview.data;

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle="Bring buyers back and turn browsers into orders. Every taka you earn from marketing is tracked here."
        actions={
          <>
            <FilterSelect
              label="Date range"
              value={range}
              onChange={(e) =>
                setParams(
                  (p) => {
                    if (e.target.value === '30d') p.delete('range');
                    else p.set('range', e.target.value);
                    return p;
                  },
                  { replace: true },
                )
              }
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </FilterSelect>
            <Link to="/marketing/coupons/new" className={buttonVariants({ variant: 'secondary' })}>
              + Create coupon
            </Link>
            {locked ? (
              <button type="button" disabled className={buttonVariants()}>
                + New campaign
              </button>
            ) : (
              <Link to="/marketing/campaigns/new" className={buttonVariants()}>
                + New campaign
              </Link>
            )}
          </>
        }
      />
      <MarketingTabs value="overview" counts={data?.counts} />
      {features.data && locked && <CampaignPlanNote canSeePlans={scope.canViewBilling} />}

      {overview.isPending ? (
        <OverviewSkeleton />
      ) : overview.isError ? (
        <StateCard>
          <ErrorBlock title="We couldn’t load marketing" error={overview.error} onRetry={() => void overview.refetch()} />
        </StateCard>
      ) : (
        <>
          <Kpis data={overview.data} days={days} features={features.data} />
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <RevenueChart data={overview.data} />
            <ActiveCoupons data={overview.data} />
          </div>
        </>
      )}

      <h2 className="text-heading text-text-primary">Start something new</h2>
      <section aria-label="Start something new" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <QuickCard icon={<CreditCard />} tone="bg-brand-50 text-brand-600" title="Discount coupon" text="% off, ৳ off or free delivery with limits and dates." action="Create coupon" to="/marketing/coupons/new" />
        <QuickCard icon={<MessageCircle />} tone="bg-info-bg text-info" title="SMS campaign" text="Send a Bangla or English SMS to any segment." action="Write SMS" to="/marketing/campaigns/new?channel=sms" disabled={locked} />
        <QuickCard icon={<Mail />} tone="bg-success-bg text-success" title="Email campaign" text="Send an email with your logo to any segment." action="Write email" to="/marketing/campaigns/new?channel=email" disabled={locked} />
        <QuickCard icon={<ShoppingCart />} tone="bg-accent-100 text-accent-500" title="Abandoned cart recovery" text="Auto-message buyers who left checkout. Runs 24/7." action="Set up flow" to="/marketing/automations/checkout-recovery" />
      </section>

      <RecentCampaigns data={data} pending={overview.isPending} error={overview.isError} tz={tz} locked={locked} />
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading marketing" className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-[340px] rounded-card" />
    </div>
  );
}

function pctLabel(pct: number | null, days: number): string {
  if (pct === null) return `No marketing revenue in the previous ${days} days`;
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '';
  return `${arrow} ${Math.abs(Math.round(pct))}% vs last ${days} days`.trim();
}

function Kpis({ data, days, features }: { data: MarketingOverview; days: number; features: Parameters<typeof allowanceOf>[0] }) {
  const k = data.kpis;
  const sms = allowanceOf(features, 'sms');
  const email = allowanceOf(features, 'email');
  const used = (sms?.used ?? 0) + (email?.used ?? 0);
  const limit = sms?.limit === null || email?.limit === null ? null : (sms?.limit ?? 0) + (email?.limit ?? 0);
  const allowanceHint = sms || email ? `SMS + email, this month: ${formatCount(used)}${limit === null ? '' : ` of ${formatCount(limit)}`}` : 'SMS + email';
  return (
    <section aria-label="Marketing summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile icon={<BarChart3 />} label="Revenue from marketing" value={formatBdt(k.revenue_amount)} hint={pctLabel(k.revenue_change_pct, days)} />
      <KpiTile icon={<ShoppingBag />} label="Orders from campaigns" value={formatCount(k.campaign_orders)} hint={`${k.campaign_orders_share_pct}% of all orders`} />
      <KpiTile icon={<ShoppingCart />} label="Carts recovered" value={formatCount(k.carts_recovered)} hint={`${formatBdt(k.recovered_revenue_amount)} won back`} />
      <KpiTile icon={<Send />} label="Messages sent" value={formatCount(k.messages_sent)} hint={allowanceHint} />
    </section>
  );
}

/** ISO week number of a `YYYY-MM-DD` Monday. */
function isoWeek(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

function Card({ title, subtitle, action, children, className }: { title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
          {subtitle && <p className="text-caption text-text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RevenueChart({ data }: { data: MarketingOverview }) {
  const bars: BarDatum[] = data.series.map((w, i) => ({
    label: i === data.series.length - 1 ? 'This wk' : `W${isoWeek(w.week_start)}`,
    value: w.coupons_amount + w.campaigns_amount + w.recovery_amount,
    segments: [
      { label: 'Coupons', value: w.coupons_amount, tone: 'brand-500' },
      { label: 'Campaigns', value: w.campaigns_amount, tone: 'accent' },
      { label: 'Cart recovery', value: w.recovery_amount, tone: 'success' },
    ],
  }));
  return (
    <Card
      title="Revenue from marketing"
      subtitle="By source, last 8 weeks"
      className="relative flex-1 gap-5 overflow-hidden"
      action={
        <ChartLegend
          className="max-sm:hidden"
          items={[
            { label: 'Coupons', tone: 'brand-500' },
            { label: 'Campaigns', tone: 'accent' },
            { label: 'Cart recovery', tone: 'success' },
          ]}
        />
      }
    >
      <ChartLegend
        className="sm:hidden"
        items={[
          { label: 'Coupons', tone: 'brand-500' },
          { label: 'Campaigns', tone: 'accent' },
          { label: 'Cart recovery', tone: 'success' },
        ]}
      />
      <BarChart caption="Revenue from marketing by week" bars={bars} height={220} formatValue={(n) => formatBdt(n)} formatTick={(n) => formatBdtCompact(n, { tight: true })} series={['Coupons', 'Campaigns', 'Cart recovery']} />
    </Card>
  );
}

function ActiveCoupons({ data }: { data: MarketingOverview }) {
  const rows = data.active_coupons;
  const maxUsed = Math.max(1, ...rows.map((c) => c.used_count));
  return (
    <Card
      title="Active coupons"
      subtitle={rows.length ? `Top ${rows.length} by revenue` : 'None running now'}
      className="gap-1 lg:w-[360px] lg:shrink-0"
      action={
        <Link to="/marketing/coupons?tab=active" className="text-caption font-medium text-brand-600">
          See all →
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="border-t border-border-default py-3 text-body text-text-secondary">No active coupons. Create one to see what it earns.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((c) => {
            const ratio = c.usage_limit ? Math.min(1, c.used_count / c.usage_limit) : c.used_count / maxUsed;
            return (
              <li key={c.id} className="flex flex-col gap-2 border-t border-border-default py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-sm border border-dashed border-brand-500 bg-brand-50 px-2 py-1 text-caption font-medium text-brand-700">{c.code}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{couponValue({ ...c, max_discount_amount: null })}</span>
                  <span className="shrink-0 text-body font-semibold text-text-primary">{formatBdt(c.revenue_amount)}</span>
                </div>
                <span aria-hidden className="flex h-1 rounded-full bg-surface-subtle">
                  <span className="h-1 rounded-full bg-brand-600" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </span>
                <span className="text-caption text-text-muted">{c.usage_limit ? `${formatCount(c.used_count)} used of ${formatCount(c.usage_limit)}` : `${formatCount(c.used_count)} used · no limit`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function QuickCard({ icon, tone, title, text, action, to, disabled }: { icon: ReactNode; tone: string; title: string; text: string; action: string; to: string; disabled?: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <span aria-hidden className={cn('flex size-10 items-center justify-center rounded-md [&_svg]:size-5', tone)}>
        {icon}
      </span>
      <h3 className="text-body-lg font-medium text-text-primary">{title}</h3>
      <p className="text-caption text-text-secondary">{text}</p>
      {disabled ? (
        <button type="button" disabled className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          {action}
        </button>
      ) : (
        <Link to={to} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          {action}
        </Link>
      )}
    </div>
  );
}

function RecentCampaigns({ data, pending, error, tz, locked }: { data: MarketingOverview | undefined; pending: boolean; error: boolean; tz: string; locked: boolean }) {
  const navigate = useNavigate();
  if (error) return null; // the page-level error block already explains
  const rows = data?.recent_campaigns ?? [];
  return (
    <CampaignsTable
      label="Recent campaigns"
      rows={rows}
      tz={tz}
      toolbar={
        <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-body-lg font-medium text-text-primary">Recent campaigns</h2>
            <p className="text-caption text-text-muted">Your latest campaigns</p>
          </div>
          {data && data.counts.campaigns > 0 && (
            <Link to="/marketing/campaigns" className="text-caption font-medium text-brand-600">
              See all {formatCount(data.counts.campaigns)} →
            </Link>
          )}
        </div>
      }
      state={
        pending ? (
          <LoadingRows rows={3} label="Loading campaigns" />
        ) : rows.length === 0 ? (
          <NoResults title="No campaigns yet" description="Send a Bangla or English SMS or an email to bring buyers back." onClear={locked ? undefined : () => navigate('/marketing/campaigns/new')} clearLabel="+ New campaign" />
        ) : undefined
      }
    />
  );
}

export default MarketingOverviewPage;
