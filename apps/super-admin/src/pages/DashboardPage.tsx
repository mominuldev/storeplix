import type { AdminAnalyticsOverview, AnalyticsMeta, AnalyticsRange } from '@storeplix/types';
import { Avatar, BarChart, Card, ChartLegend, chartToneClass, cn, DonutMeter, formatBdtCompact, formatCount, KpiTile, Skeleton } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Building, ChevronRight, CheckCircle2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { bucketLabel, dataAsOf, delta, historyNote, planTones, rangeFromParam, rangeLabel, rate } from '../analytics/format';
import { ChartCard, DataCaption, KpiCard, KpiSkeletons, NoAnalytics, RangeTabs, WidgetBody } from '../analytics/ui';
import { TenantStatusBadge } from '../components/badges';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { formatDate, formatMonth, money, planName } from '../lib/format';
import { useCan } from '../lib/permissions';

const DASHBOARD_RANGES: AnalyticsRange[] = ['30d', 'quarter', '12m'];
const compact = (paisa: number | null | undefined) => formatBdtCompact(paisa);

// Figma Platform / Dashboard 15:123. 8.1 (every role): "New merchants" list (15:419 without orders / at-risk) +
// "Needs attention" (8.1 rows). 8.2 (`view_analytics`, PHASE-8-2 §7.1): range tabs 15:263 (?range=, Export hidden),
// KPI row MRR / Active shops / Trial → paid / Merchant GMV / Revenue churn, "Monthly recurring revenue by plan" 15:314
// and "Plan mix" 15:387 (nudge box hidden, Q111). Integration health 15:490 stays hidden (Q106).
export function DashboardPage() {
  const can = useCan();
  const analyticsOn = can('view_analytics');
  const [params, setParams] = useSearchParams();
  const range = rangeFromParam(params.get('range'), '30d', false);
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.admin.overview(),
  });
  const analytics = useQuery({
    queryKey: ['admin', 'analytics', 'overview', { range }],
    queryFn: () => api.admin.analyticsOverview({ range }),
    enabled: analyticsOn,
    placeholderData: keepPreviousData,
  });
  const o = overview.data;
  const a = analyticsOn ? analytics.data : undefined;
  const hasData = !!a?.meta.as_of;
  const setRange = (r: AnalyticsRange) => {
    const next = new URLSearchParams(params);
    next.set('range', r);
    setParams(next, { replace: true });
  };

  const attention = o
    ? [
        o.past_due.count > 0 && {
          key: 'past_due',
          to: '/merchants?tab=past_due',
          tone: 'warning' as const,
          title: `${formatCount(o.past_due.count)} subscription${o.past_due.count === 1 ? '' : 's'} past due`,
          hint: `${money(o.past_due.amount)} to collect`,
        },
        o.domains.failing > 0 && {
          key: 'domains',
          to: '/domains?state=ssl_failing',
          tone: 'danger' as const,
          title: `${formatCount(o.domains.failing)} custom domain${o.domains.failing === 1 ? '' : 's'} failing`,
          hint: 'DNS, verification or SSL checks failed',
        },
        o.active_impersonations > 0 && {
          key: 'impersonations',
          to: '/impersonations',
          tone: 'brand' as const,
          title: `${formatCount(o.active_impersonations)} active impersonation${o.active_impersonations === 1 ? '' : 's'}`,
          hint: 'Read-only support sessions running now',
        },
      ].filter((x): x is Exclude<typeof x, false> => !!x)
    : [];

  return (
    <>
      <div className="flex flex-col gap-1">
        <PageHeader
          title="Platform overview"
          subtitle={`All merchants · ${formatMonth()}`}
          actions={analyticsOn ? <RangeTabs value={range} onChange={setRange} ranges={DASHBOARD_RANGES} /> : undefined}
        />
        {a && <DataCaption asOf={dataAsOf(a.meta)} history={hasData ? historyNote(a.meta) : null} />}
      </div>
      {overview.isError ? (
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      ) : (
        <>
          <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {analyticsOn && analytics.isError ? (
              <Card className="sm:col-span-2 lg:col-span-3 xl:col-span-5">
                <ErrorState error={analytics.error} onRetry={() => void analytics.refetch()} />
              </Card>
            ) : analyticsOn && analytics.isPending ? (
              <KpiSkeletons count={5} />
            ) : a && hasData ? (
              <AnalyticsKpis data={a.data} />
            ) : o ? (
              <KpiTile
                label="Active shops"
                value={formatCount(o.tenants.active)}
                hint={`${formatCount(o.subscriptions.paying)} paying · ${formatCount(o.subscriptions.free)} free`}
              />
            ) : (
              <div
                role="status"
                aria-label="Loading key numbers"
                className="flex flex-col gap-2 rounded-card border border-border-default bg-surface-card px-5 py-[18px]"
              >
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3 w-32" />
              </div>
            )}
          </section>
          {analyticsOn && !analytics.isError && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
              {a && !hasData ? (
                <Card className="xl:col-span-2">
                  <NoAnalytics />
                </Card>
              ) : (
                <>
                  <MrrByPlanCard data={a?.data} meta={a?.meta} loading={analytics.isPending} />
                  <PlanMixCard data={a?.data} loading={analytics.isPending} />
                </>
              )}
            </div>
          )}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
                <h2 className="text-heading text-text-primary">New merchants</h2>
                <Link to="/merchants" className="flex items-center gap-1 text-body font-medium text-brand-600 hover:underline">
                  All merchants <ArrowRight aria-hidden className="size-4" />
                </Link>
              </div>
              {!o ? (
                <LoadingRows label="Loading new merchants" />
              ) : o.newest_tenants.length === 0 ? (
                <Empty icon={<Building />} title="No merchants yet" description="Shops appear here as soon as merchants sign up." />
              ) : (
                <ul aria-label="New merchants" className="border-t border-border-default">
                  {o.newest_tenants.map((t) => (
                    <li key={t.id} className="border-b border-border-default last:border-b-0">
                      <Link
                        to={`/merchants/${t.id}`}
                        className="flex items-center gap-3 px-6 py-4 outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle"
                      >
                        <Avatar name={t.name} className="rounded-md" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body font-semibold text-text-primary">{t.name}</span>
                          <span className="truncate text-caption text-text-muted">{t.store?.primary_host}</span>
                        </span>
                        <span className="hidden w-28 shrink-0 text-body text-text-primary md:block">
                          {planName(t.plan_code)}
                          {t.subscription_status === 'trialing' ? ' · trial' : ''}
                        </span>
                        <span className="hidden w-24 shrink-0 text-caption text-text-muted md:block">{formatDate(t.created_at)}</span>
                        <span className="w-20 shrink-0">
                          <TenantStatusBadge tenant={t} />
                        </span>
                        <ChevronRight aria-hidden className="size-4 text-text-muted" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="h-fit">
              <h2 className="px-6 pt-6 pb-4 text-heading text-text-primary">Needs attention</h2>
              <div className="flex flex-col gap-3 px-6 pb-6">
                {!o ? (
                  <>
                    <Skeleton className="h-14 w-full rounded-lg" />
                    <Skeleton className="h-14 w-full rounded-lg" />
                  </>
                ) : attention.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-body text-success">
                    <CheckCircle2 aria-hidden className="size-4" /> Nothing needs attention right now.
                  </p>
                ) : (
                  attention.map((a) => (
                    <Link
                      key={a.key}
                      to={a.to}
                      className={cn(
                        'flex flex-col gap-0.5 rounded-lg px-4 py-3 outline-none focus-visible:shadow-focus',
                        a.tone === 'warning' && 'bg-warning-bg text-warning',
                        a.tone === 'danger' && 'bg-danger-bg text-danger',
                        a.tone === 'brand' && 'bg-brand-50 text-brand-700',
                      )}
                    >
                      <span className="text-body font-semibold">{a.title}</span>
                      <span className="text-caption text-text-secondary">{a.hint}</span>
                    </Link>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** KPI row 15:272 (§7.1): MRR 15:273, Active shops 15:281, Trial → paid 15:289, Merchant GMV 15:297, Revenue churn 15:305. */
function AnalyticsKpis({ data: d }: { data: AdminAnalyticsOverview }) {
  const shops = d.active_shops;
  const shopsCaption = [
    `${formatCount(shops.paying)} paying`,
    `${formatCount(shops.free)} free`,
    shops.trialing ? `${formatCount(shops.trialing)} trial` : null,
    shops.comp ? `${formatCount(shops.comp)} comp` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <KpiCard
        label="MRR"
        value={compact(d.mrr.amount)}
        change={delta(d.mrr.amount, d.mrr.previous_amount, 'ratio')}
        caption={`ARR ${compact(d.mrr.arr_amount)}`}
      />
      <KpiCard
        label="Active shops"
        value={formatCount(shops.total)}
        change={delta(shops.total, shops.previous_total, 'count')}
        caption={shopsCaption}
      />
      <KpiCard
        label="Trial → paid"
        value={rate(d.trial_conversion.rate)}
        change={delta(d.trial_conversion.rate, d.trial_conversion.previous_rate, 'points')}
        caption={`${formatCount(d.trial_conversion.trialing_now)} trials running`}
      />
      <KpiCard
        label="Merchant GMV"
        value={compact(d.gmv.amount)}
        change={delta(d.gmv.amount, d.gmv.previous_amount, 'ratio')}
        caption={`${formatCount(d.gmv.orders_count)} orders`}
      />
      <KpiCard
        label="Revenue churn"
        value={rate(d.revenue_churn.rate)}
        change={delta(d.revenue_churn.rate, d.revenue_churn.previous_rate, 'points', { higherIsBetter: false })}
        caption={`${formatCount(d.revenue_churn.cancellations)} cancellations`}
      />
    </>
  );
}

/** MRR chart 15:314: stacked by paid plan in `plans` order (legend 15:319 / 15:322; no "Pro" unless it exists). */
function MrrByPlanCard({ data, meta, loading }: { data?: AdminAnalyticsOverview; meta?: AnalyticsMeta; loading: boolean }) {
  const paid = (data?.plans ?? []).filter((p) => p.monthly_price_amount > 0).sort((x, y) => x.sort - y.sort);
  const tones = planTones(data?.plans ?? []);
  const series = data?.mrr_series ?? [];
  return (
    <ChartCard
      title="Monthly recurring revenue by plan"
      subtitle={rangeLabel(meta)}
      actions={paid.length > 0 && <ChartLegend items={paid.map((p) => ({ label: p.name, tone: tones[p.code]! }))} />}
    >
      <WidgetBody
        loading={loading}
        error={null}
        onRetry={() => undefined}
        empty={series.every((p) => p.mrr_amount === null)}
        loadingLabel="Loading MRR chart"
      >
        {() => (
          <BarChart
            caption="Monthly recurring revenue by plan"
            height={220}
            ticks={4}
            maxXLabels={12}
            formatValue={(n) => formatBdtCompact(n)}
            formatTick={(n) => (n === 0 ? '0' : formatBdtCompact(n, { tight: true }))}
            series={paid.map((p) => p.name)}
            bars={series.map((p) => ({
              label: bucketLabel(p.bucket_start, meta?.granularity ?? 'day'),
              value: p.mrr_amount,
              note: 'No data',
              display: undefined,
              segments:
                p.mrr_amount === null ? null : paid.map((pl) => ({ label: pl.name, value: p.by_plan[pl.code] ?? 0, tone: tones[pl.code]! })),
            }))}
          />
        )}
      </WidgetBody>
    </ChartCard>
  );
}

/** Plan mix 15:387: donut (centre = Σ shops) + legend rows; nudge box 15:416 hidden (Q111). */
function PlanMixCard({ data, loading }: { data?: AdminAnalyticsOverview; loading: boolean }) {
  const tones = planTones(data?.plans ?? []);
  const mix = data?.plan_mix ?? [];
  const total = mix.reduce((acc, p) => acc + p.count, 0);
  return (
    <ChartCard title="Plan mix">
      <WidgetBody loading={loading} error={null} onRetry={() => undefined} empty={total === 0} loadingLabel="Loading plan mix" skeletonHeight="h-40">
        {() => (
          <div className="flex items-center gap-5">
            <DonutMeter
              caption="Plan mix"
              centerValue={formatCount(total)}
              centerLabel="shops"
              segments={mix.map((p) => ({ label: p.plan_name, value: p.count, tone: tones[p.plan_code] ?? 'subtle', display: formatCount(p.count) }))}
            />
            <ul aria-label="Shops by plan" className="flex min-w-0 flex-1 flex-col gap-2.5">
              {mix.map((p) => (
                <li key={p.plan_code} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2.5 shrink-0 rounded-[3px]',
                      chartToneClass(tones[p.plan_code] ?? 'subtle'),
                      (tones[p.plan_code] ?? 'subtle') === 'subtle' && 'border border-border-strong',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{p.plan_name}</span>
                  <span className="text-body font-semibold text-text-primary tabular-nums">{formatCount(p.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </WidgetBody>
    </ChartCard>
  );
}
