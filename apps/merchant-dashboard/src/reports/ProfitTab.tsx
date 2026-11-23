import type { ProfitReport, ReportMeta } from '@storeplix/types';
import { BarChart, buttonVariants, ChartLegend, chartToneClass, cn, EmptyState, LineChart, StackedMeter, type BarDatum, type MeterSegment } from '@storeplix/ui';
import { AlertTriangle, BarChart3, Lock, Percent, Receipt, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock } from '../catalog/states';
import { can } from '../lib/permissions';
import { useFeatures } from '../plan/useFeatures';
import { fetchers, useReport } from './queries';
import { dayLabel, weekLabel, type ReportRange } from './range';
import { bdt, bdtWhole, CardSkeleton, rateAxis, compactBdt, count, delta, KpiSkeletons, MiniStat, pct1, ReportCard, ReportKpi } from './ui';

// Profit & loss 60:12264: KPIs 63:15793, waterfall 63:15896, "Each ৳ 100" 63:15949, Margin trend 63:15992, Per order
// 63:16035, Daily P&L 63:16061. Growth + owner/admin only (P7-19). No target line and no ad-spend tip (§8.3).

const DAYS_SHOWN = 7;

/** Waterfall bars: Revenue → costs (floating) → Net profit. Untracked costs are labelled, not drawn. */
export function waterfallBars(s: ProfitReport['summary']): BarDatum[] {
  let running = s.revenue_amount;
  const step = (label: string, amount: number | null, note: string): BarDatum => {
    if (amount === null) return { label, value: null, note };
    const bar: BarDatum = { label, value: amount, base: Math.max(0, running - amount), tone: 'accent', display: `− ${bdt(amount)}` };
    running -= amount;
    return bar;
  };
  return [
    { label: 'Revenue', value: s.revenue_amount, tone: 'brand', display: bdt(s.revenue_amount) },
    step('Product cost', s.product_cost_amount, ''),
    step('Delivery charges', s.delivery_cost_amount, ''),
    step('Courier COD fee', s.cod_fee_amount, ''),
    step('Gateway fees', s.gateway_fee_amount, 'Not tracked'),
    step('Ad spend', s.ad_spend_amount, 'Coming with Expenses'),
    { label: 'Net profit', value: Math.max(0, s.net_profit_amount), tone: s.net_profit_amount < 0 ? 'danger' : 'success', display: bdt(s.net_profit_amount) },
  ];
}

export function ProfitTab({ range, onMeta }: { range: ReportRange; onMeta: (m: ReportMeta) => void }) {
  const { activeTenant } = useAuth();
  const features = useFeatures();
  const allowedRole = can.viewCosts(activeTenant?.role);
  const included = features.data?.features.profit_reports ?? false;
  const q = useReport<ProfitReport>('profit', range, fetchers.profit(range), allowedRole && included);
  const [showAll, setShowAll] = useState(false);
  const meta = q.data?.meta;
  useEffect(() => {
    if (meta) onMeta(meta);
  }, [meta, onMeta]);

  if (!allowedRole) return <EmptyState icon={<Lock />} title="Profit is for owners and managers" description="Ask your shop owner for access." />;
  if (features.isPending) return <KpiSkeletons />;
  if (!included) {
    return (
      <section aria-label="Upgrade for profit reports" className="flex flex-col items-start gap-3 rounded-card border border-brand-100 bg-brand-50 p-6 sm:flex-row sm:items-center">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-card text-brand-600">
          <Percent aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">See what you actually keep</h2>
          <p className="text-body text-text-secondary">Profit & loss is part of the Growth plan: revenue, product and courier costs, and profit per order and per day.</p>
        </div>
        {can.manageBilling(activeTenant?.role) ? (
          <Link to="/settings/plan?upgrade=growth" className={buttonVariants({ size: 'md' })}>
            Upgrade to Growth
          </Link>
        ) : (
          <span className="text-caption text-text-secondary">Ask your shop owner to upgrade.</span>
        )}
      </section>
    );
  }
  if (q.isPending) {
    return (
      <>
        <KpiSkeletons />
        <CardSkeleton />
      </>
    );
  }
  if (q.isError) return <ErrorBlock error={q.error} title="We couldn’t load the profit report" onRetry={() => void q.refetch()} className="rounded-card border border-border-default bg-surface-card" />;

  const r = q.data.data;
  const s = r.summary;
  const p = r.previous;
  const chrono = [...r.daily].sort((a, b) => a.date.localeCompare(b.date));
  const rows = showAll ? r.daily : r.daily.slice(0, DAYS_SHOWN);
  const per100 = (amount: number | null) => (amount === null || s.revenue_amount <= 0 ? null : (amount / s.revenue_amount) * 100);
  const shareSegments: (MeterSegment & { amount: number | null })[] = [
    { label: 'Product cost', value: per100(s.product_cost_amount) ?? 0, amount: s.product_cost_amount, tone: 'brand' },
    { label: 'Delivery charges', value: per100(s.delivery_cost_amount) ?? 0, amount: s.delivery_cost_amount, tone: 'info' },
    { label: 'Courier COD fee', value: per100(s.cod_fee_amount) ?? 0, amount: s.cod_fee_amount, tone: 'warning' },
    { label: 'You keep', value: Math.max(0, per100(s.net_profit_amount) ?? 0), amount: s.net_profit_amount, tone: 'success' },
  ];
  const margins = r.weekly.filter((w) => w.margin !== null) as (ProfitReport['weekly'][number] & { margin: number })[];
  const best = margins.reduce<(typeof margins)[number] | null>((a, w) => (!a || w.margin > a.margin ? w : a), null);
  const worst = margins.reduce<(typeof margins)[number] | null>((a, w) => (!a || w.margin < a.margin ? w : a), null);
  const rev12 = r.weekly.reduce((a, w) => a + w.revenue_amount, 0);
  const avg12 = rev12 > 0 ? r.weekly.reduce((a, w) => a + w.net_profit_amount, 0) / rev12 : null;
  const marginMax = Math.max(0.1, ...margins.map((w) => w.margin));
  const dq = r.data_quality;

  return (
    <div className={cn('flex flex-col gap-5 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <ReportKpi icon={<BarChart3 />} label="Revenue" value={bdt(s.revenue_amount)} hint="Delivered orders only" change={delta(s.revenue_amount, p.revenue_amount, 'ratio')} spark={chrono.map((d) => d.revenue_amount)} />
        <ReportKpi
          icon={<Receipt />}
          label="Total costs"
          value={bdt(s.total_cost_amount)}
          hint="Product, delivery and COD fees"
          change={delta(s.total_cost_amount, p.total_cost_amount, 'ratio', false)}
          spark={chrono.map((d) => d.total_cost_amount)}
          sparkTone="accent"
        />
        <ReportKpi
          icon={<Wallet />}
          label="Net profit"
          value={bdt(s.net_profit_amount)}
          hint={s.profit_per_order_amount !== null ? `${bdtWhole(s.profit_per_order_amount)} profit per order` : 'No delivered orders yet'}
          change={delta(s.net_profit_amount, p.net_profit_amount, 'ratio')}
          spark={chrono.map((d) => d.net_profit_amount)}
          sparkTone="success"
        />
        <ReportKpi
          icon={<Percent />}
          label="Profit margin"
          value={pct1(s.margin)}
          hint={p.margin !== null ? `${s.margin !== null && s.margin < p.margin ? 'Down' : 'Up'} from ${pct1(p.margin)}` : 'Net profit ÷ revenue'}
          change={delta(s.margin, p.margin, 'points')}
          spark={r.weekly.map((w) => w.margin ?? 0)}
        />
      </div>

      {(dq.items_without_cost > 0 || dq.shipments_without_fee > 0) && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="flex flex-col gap-0.5">
            {dq.items_without_cost > 0 && (
              <span>
                {count(dq.items_without_cost)} {dq.items_without_cost === 1 ? 'item has' : 'items have'} no cost price — add it in{' '}
                <Link to="/products" className="font-semibold text-brand-600 hover:underline">
                  Products
                </Link>{' '}
                for a true profit.
              </span>
            )}
            {dq.shipments_without_fee > 0 && <span>{count(dq.shipments_without_fee)} delivered parcels have no courier charge recorded (own delivery or missing fee), so delivery costs may be low.</span>}
          </p>
        </div>
      )}

      {s.delivered_orders_count === 0 ? (
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <EmptyState icon={<Wallet />} title="No delivered orders in this period" description="Profit counts orders on the day they were delivered. Pick another range." />
        </section>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,744fr)_minmax(0,360fr)]">
            <ReportCard
              title="From sales to profit"
              description="Every taka of revenue, step by step"
              action={
                <ChartLegend
                  items={[
                    { label: 'Money in', tone: 'brand' },
                    { label: 'Costs', tone: 'accent' },
                    { label: 'Profit', tone: 'success' },
                  ]}
                />
              }
            >
              <BarChart caption="Revenue to net profit" bars={waterfallBars(s)} formatValue={bdt} formatTick={compactBdt} height={220} />
            </ReportCard>
            <ReportCard title="Where each ৳ 100 goes" description="Share of revenue, this period">
              <StackedMeter caption="Share of each ৳ 100 of revenue" segments={shareSegments.map((x) => ({ ...x, display: x.amount === null ? '—' : `৳ ${(per100(x.amount) ?? 0).toFixed(1)}` }))} height="h-3" />
              <ul className="flex flex-col gap-3">
                {shareSegments.map((x) => (
                  <li key={x.label} className="flex items-center gap-2.5 text-body">
                    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', chartToneClass(x.tone))} />
                    <span className={cn('flex-1', x.label === 'You keep' ? 'font-semibold text-text-primary' : 'text-text-primary')}>{x.label}</span>
                    <span className={cn('font-semibold', x.label === 'You keep' ? (s.net_profit_amount < 0 ? 'text-danger' : 'text-success') : 'text-text-primary')}>৳ {(per100(x.amount) ?? 0).toFixed(1)}</span>
                  </li>
                ))}
                <li className="flex items-center gap-2.5 text-body">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-text-muted" />
                  <span className="flex-1 text-text-primary">Gateway fees</span>
                  <span className="text-caption text-text-muted">Not tracked</span>
                </li>
              </ul>
            </ReportCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ReportCard title="Margin trend" description="Net profit margin by week, last 12 weeks" action={<ChartLegend items={[{ label: 'Margin', tone: 'brand' }]} />}>
              <LineChart
                caption="Margin by week"
                labels={r.weekly.map((w) => weekLabel(w.week))}
                series={[{ name: 'Margin', values: r.weekly.map((w) => w.margin), area: true }]}
                formatValue={(n) => pct1(n)}
                formatTick={(n) => `${Math.round(n * 100)}%`}
                {...rateAxis(Math.min(0, ...margins.map((w) => w.margin)), marginMax)}
                height={180}
              />
              <div className="grid grid-cols-3 gap-3 rounded-lg bg-surface-subtle p-3">
                <MiniStat label="Best week" value={best ? `${weekLabel(best.week)} · ${pct1(best.margin)}` : '—'} tone="success" />
                <MiniStat label="Lowest week" value={worst ? `${weekLabel(worst.week)} · ${pct1(worst.margin)}` : '—'} tone="danger" />
                <MiniStat label="12-week average" value={pct1(avg12)} />
              </div>
            </ReportCard>
            <ReportCard title="One average order" description={r.per_order ? `${bdtWhole(r.per_order.order_value_amount)} order value, broken down` : undefined}>
              {r.per_order && (
                <dl className="flex flex-col divide-y divide-border-default text-body">
                  <div className="flex justify-between py-2.5">
                    <dt className="font-semibold text-text-primary">Order value</dt>
                    <dd className="font-semibold text-text-primary">{bdtWhole(r.per_order.order_value_amount)}</dd>
                  </div>
                  {(
                    [
                      ['Product cost', r.per_order.product_cost_amount],
                      ['Delivery charge', r.per_order.delivery_cost_amount],
                      ['Courier COD fee', r.per_order.cod_fee_amount],
                      ['Gateway fee', r.per_order.gateway_fee_amount],
                    ] as const
                  ).map(([label, v]) => (
                    <div key={label} className="flex justify-between py-2.5">
                      <dt className="text-text-secondary">{label}</dt>
                      <dd className={v === null ? 'text-caption text-text-muted' : 'text-danger'}>{v === null ? 'Not tracked' : `− ${bdtWhole(v)}`}</dd>
                    </div>
                  ))}
                  <div className={cn('mt-2 flex items-center justify-between rounded-lg px-3 py-3', r.per_order.profit_amount < 0 ? 'bg-danger-bg' : 'bg-success-bg')}>
                    <dt className={cn('font-semibold', r.per_order.profit_amount < 0 ? 'text-danger' : 'text-success')}>Profit per order</dt>
                    <dd className={cn('text-heading font-semibold', r.per_order.profit_amount < 0 ? 'text-danger' : 'text-success')}>{bdtWhole(r.per_order.profit_amount)}</dd>
                  </div>
                </dl>
              )}
            </ReportCard>
          </div>

          <ReportCard
            title="Day by day"
            description="Delivered orders, costs and profit per day"
            action={<span className="text-caption text-text-muted">{showAll ? `All ${r.daily.length} days` : `Showing ${Math.min(DAYS_SHOWN, r.daily.length)} of ${r.daily.length} days`}</span>}
          >
            <div className="-mx-4 overflow-x-auto max-md:hidden sm:-mx-6">
              <table className="w-full min-w-[880px] text-body">
                <thead className="border-y border-border-default text-caption font-medium text-text-muted uppercase">
                  <tr>
                    {['Date', 'Orders', 'Revenue', 'Product cost', 'Delivery', 'COD fee', 'Gateway', 'Ad spend', 'Net profit', 'Margin'].map((h, i) => (
                      <th key={h} scope="col" className={cn('px-3 py-2.5 font-medium', i === 0 ? 'pl-6 text-left' : 'text-right', i === 9 && 'pr-6')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.date} className="border-b border-border-default">
                      <th scope="row" className="py-3 pr-3 pl-6 text-left font-medium text-text-primary">
                        {dayLabel(d.date)}
                      </th>
                      <td className="px-3 text-right text-text-primary">{count(d.orders_count)}</td>
                      <td className="px-3 text-right font-semibold text-text-primary">{bdt(d.revenue_amount)}</td>
                      <td className="px-3 text-right text-text-secondary">{bdt(d.product_cost_amount)}</td>
                      <td className="px-3 text-right text-text-secondary">{bdt(d.delivery_cost_amount)}</td>
                      <td className="px-3 text-right text-text-secondary">{bdt(d.cod_fee_amount)}</td>
                      <td className="px-3 text-right text-text-muted">{d.gateway_fee_amount === null ? '—' : bdt(d.gateway_fee_amount)}</td>
                      <td className="px-3 text-right text-text-muted">{d.ad_spend_amount === null ? '—' : bdt(d.ad_spend_amount)}</td>
                      <td className={cn('px-3 text-right font-semibold', d.net_profit_amount < 0 ? 'text-danger' : 'text-success')}>{bdt(d.net_profit_amount)}</td>
                      <td className="py-3 pr-6 pl-3 text-right">
                        <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-caption font-medium text-text-secondary">{pct1(d.margin)}</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold text-text-primary">
                    <th scope="row" className="py-3 pr-3 pl-6 text-left">
                      Total
                    </th>
                    <td className="px-3 text-right">{count(s.delivered_orders_count)}</td>
                    <td className="px-3 text-right">{bdt(s.revenue_amount)}</td>
                    <td className="px-3 text-right">{bdt(s.product_cost_amount)}</td>
                    <td className="px-3 text-right">{bdt(s.delivery_cost_amount)}</td>
                    <td className="px-3 text-right">{bdt(s.cod_fee_amount)}</td>
                    <td className="px-3 text-right text-text-muted">{s.gateway_fee_amount === null ? '—' : bdt(s.gateway_fee_amount)}</td>
                    <td className="px-3 text-right text-text-muted">{s.ad_spend_amount === null ? '—' : bdt(s.ad_spend_amount)}</td>
                    <td className={cn('px-3 text-right', s.net_profit_amount < 0 ? 'text-danger' : 'text-success')}>{bdt(s.net_profit_amount)}</td>
                    <td className="py-3 pr-6 pl-3 text-right">{pct1(s.margin)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col divide-y divide-border-default md:hidden">
              {rows.map((d) => (
                <li key={d.date} className="flex flex-col gap-1 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-body font-medium text-text-primary">{dayLabel(d.date)}</span>
                    <span className={cn('text-body font-semibold', d.net_profit_amount < 0 ? 'text-danger' : 'text-success')}>{bdt(d.net_profit_amount)}</span>
                  </div>
                  <span className="text-caption text-text-secondary">
                    {count(d.orders_count)} orders · revenue {bdt(d.revenue_amount)} · costs {bdt(d.total_cost_amount)} · margin {pct1(d.margin)}
                  </span>
                </li>
              ))}
              <li className="flex items-center gap-2 py-3 text-body font-semibold text-text-primary">
                <span className="flex-1">Total</span>
                <span className={s.net_profit_amount < 0 ? 'text-danger' : 'text-success'}>{bdt(s.net_profit_amount)}</span>
              </li>
            </ul>
            {r.daily.length > DAYS_SHOWN && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="self-start text-body font-semibold text-brand-600 hover:text-brand-700">
                {showAll ? 'Show fewer days' : `Show all ${r.daily.length} days`}
              </button>
            )}
          </ReportCard>
        </>
      )}
    </div>
  );
}
