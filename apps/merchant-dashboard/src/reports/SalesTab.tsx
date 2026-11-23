import type { OrderChannel, ReportMeta, SalesReport } from '@storeplix/types';
import { ChartLegend, chartToneClass, cn, DonutMeter, EmptyState, LineChart, StackedMeter, type ChartTone } from '@storeplix/ui';
import { BarChart3, Package, ShoppingBag, ShoppingCart, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { ErrorBlock } from '../catalog/states';
import { orderChannelLabels } from '../commerce/format';
import { fetchers, useReport } from './queries';
import { dayLabel, type ReportRange } from './range';
import { bdt, bdtWhole, CardSkeleton, compactBdt, count, delta, KpiSkeletons, MiniStat, pct, ReportCard, ReportKpi } from './ui';

// Sales overview 60:11866: KPIs 61:12642, Sales over time 61:12738, Orders by channel 61:12786, Top products 61:12825,
// Sales by district 61:12908.

export const channelTone: Record<OrderChannel, ChartTone> = {
  facebook: 'brand',
  website: 'info',
  walk_in: 'accent',
  instagram: 'success',
  whatsapp: 'warning',
  phone: 'muted',
  landing_page: 'danger',
  other: 'soft',
};

export function SalesTab({ range, onMeta }: { range: ReportRange; onMeta: (m: ReportMeta) => void }) {
  const q = useReport<SalesReport>('sales', range, fetchers.sales(range));
  const meta = q.data?.meta;
  useEffect(() => {
    if (meta) onMeta(meta);
  }, [meta, onMeta]);

  if (q.isPending) {
    return (
      <>
        <KpiSkeletons />
        <CardSkeleton />
      </>
    );
  }
  if (q.isError) return <ErrorBlock error={q.error} title="We couldn’t load the sales report" onRetry={() => void q.refetch()} className="rounded-card border border-border-default bg-surface-card" />;
  const r = q.data.data;
  const s = r.summary;
  const p = r.previous;

  return (
    <div className={cn('flex flex-col gap-5 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <ReportKpi
          icon={<BarChart3 />}
          label="Sales"
          value={bdt(s.sales_amount)}
          hint={`vs ${bdt(p.sales_amount)} in the previous period`}
          change={delta(s.sales_amount, p.sales_amount, 'ratio')}
          spark={r.daily.map((d) => d.sales_amount)}
        />
        <ReportKpi
          icon={<ShoppingBag />}
          label="Orders"
          value={count(s.orders_count)}
          hint={`${s.orders_per_day.toLocaleString('en-IN', { maximumFractionDigits: 1 })} a day on average`}
          change={delta(s.orders_count, p.orders_count, 'ratio')}
          spark={r.daily.map((d) => d.orders_count)}
        />
        <ReportKpi
          icon={<ShoppingCart />}
          label="Average order"
          value={bdtWhole(s.average_order_value_amount)}
          hint={s.items_per_order !== null ? `Basket of ${s.items_per_order.toLocaleString('en-IN', { maximumFractionDigits: 1 })} items` : 'No sold orders yet'}
          change={delta(s.average_order_value_amount, p.average_order_value_amount, 'ratio')}
          spark={r.daily.map((d) => (d.sold_orders_count ? Math.floor(d.sales_amount / d.sold_orders_count) : 0))}
          sparkTone="info"
        />
        <ReportKpi
          icon={<XCircle />}
          label="Cancelled"
          value={count(s.cancelled_count)}
          hint={`${pct(s.cancelled_rate, 1)} of orders · fake orders: ${count(s.fake_cancelled_count)}`}
          change={delta(s.cancelled_count, p.cancelled_count, 'ratio', false)}
          sparkTone="accent"
        />
      </div>

      {s.orders_count === 0 ? (
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <EmptyState icon={<ShoppingBag />} title="No orders in this period" description="Pick another range, or come back when orders start coming in." />
        </section>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,744fr)_minmax(0,360fr)]">
            <ReportCard title="Sales over time" description="Shipped and delivered sales per day" action={<ChartLegend items={[{ label: 'This period', tone: 'brand' }]} />}>
              <div className="flex flex-wrap gap-x-8 gap-y-2">
                <MiniStat label="Sales" value={bdt(s.sales_amount)} />
                <MiniStat label="Best day" value={r.best_day ? `${dayLabel(r.best_day.date)} · ${bdt(r.best_day.sales_amount)}` : '—'} />
                <MiniStat label="Weekend share" value={r.weekend_share !== null ? `${pct(r.weekend_share)} of sales` : '—'} />
              </div>
              <LineChart
                caption="Sales per day"
                labels={r.daily.map((d) => dayLabel(d.date, false))}
                series={[{ name: 'Sales', values: r.daily.map((d) => d.sales_amount), area: true }]}
                formatValue={bdt}
                formatTick={compactBdt}
                highlightIndex={r.best_day ? r.daily.findIndex((d) => d.date === r.best_day!.date) : null}
                height={260}
              />
            </ReportCard>
            <ReportCard title="Orders by channel" description={`Where this period’s ${count(s.sold_orders_count)} sold orders came from`}>
              {r.channels.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">No sold orders yet.</p>
              ) : (
                <>
                  <DonutMeter
                    className="self-center"
                    caption="Sales by channel"
                    centerValue={count(s.sold_orders_count)}
                    centerLabel="orders"
                    segments={r.channels.map((c) => ({ label: orderChannelLabels[c.channel] ?? c.channel, value: c.sales_amount, tone: channelTone[c.channel] ?? 'soft', display: pct(c.share) }))}
                  />
                  <ul className="flex flex-col gap-3">
                    {r.channels.map((c) => (
                      <li key={c.channel} className="flex items-center gap-2.5">
                        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', chartToneClass(channelTone[c.channel] ?? 'soft'))} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-body font-medium text-text-primary">{orderChannelLabels[c.channel] ?? c.channel}</span>
                          <span className="text-caption text-text-muted">
                            {count(c.orders_count)} orders · {pct(c.share)}
                          </span>
                        </span>
                        <span className="text-body font-semibold text-text-primary">{bdt(c.sales_amount)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </ReportCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,528fr)_minmax(0,576fr)]">
            <ReportCard title="Top products" description="By shipped and delivered sales this period">
              {r.top_products.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">No products sold in this period.</p>
              ) : (
                <div className="-mx-4 sm:-mx-6">
                  <div className="grid grid-cols-[minmax(0,1fr)_48px_88px] gap-3 border-y border-border-default bg-surface-subtle px-4 py-2 text-caption font-medium text-text-muted uppercase sm:grid-cols-[minmax(0,1fr)_56px_100px_96px] sm:px-6">
                    <span>Product</span>
                    <span className="text-right">Units</span>
                    <span className="text-right">Sales</span>
                    <span className="max-sm:hidden">Share</span>
                  </div>
                  <ul>
                    {r.top_products.map((tp) => (
                      <li key={tp.product_id ?? tp.name} className="grid grid-cols-[minmax(0,1fr)_48px_88px] items-center gap-3 border-b border-border-default px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_56px_100px_96px] sm:px-6">
                        <span className="flex min-w-0 items-center gap-3">
                          {tp.image ? (
                            <img src={tp.image.url} alt="" className="size-10 shrink-0 rounded-md object-cover" />
                          ) : (
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-text-muted">
                              <Package aria-hidden className="size-4" />
                            </span>
                          )}
                          <span className="truncate text-body font-semibold text-text-primary">{tp.name}</span>
                        </span>
                        <span className="text-right text-body text-text-primary">{count(tp.units)}</span>
                        <span className="text-right text-body font-semibold text-text-primary">{bdt(tp.sales_amount)}</span>
                        <span className="flex items-center gap-2 max-sm:hidden">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                            <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.min(1, tp.share) * 100}%` }} />
                          </span>
                          <span className="w-8 text-right text-caption text-text-secondary">{pct(tp.share)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </ReportCard>
            <ReportCard title="Sales by district" description="Where your shipped and delivered parcels went">
              {r.areas.inside_dhaka_share !== null && (
                <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3">
                  <div className="flex justify-between text-caption font-medium text-text-primary">
                    <span>Inside Dhaka · {pct(r.areas.inside_dhaka_share)}</span>
                    <span>Outside Dhaka · {pct(1 - r.areas.inside_dhaka_share)}</span>
                  </div>
                  <StackedMeter
                    caption="Inside and outside Dhaka"
                    segments={[
                      { label: 'Inside Dhaka', value: r.areas.inside_dhaka_share, tone: 'brand', display: pct(r.areas.inside_dhaka_share) },
                      { label: 'Outside Dhaka', value: 1 - r.areas.inside_dhaka_share, tone: 'accent', display: pct(1 - r.areas.inside_dhaka_share) },
                    ]}
                  />
                </div>
              )}
              {r.areas.districts.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">No delivery districts yet.</p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {r.areas.districts.map((d, i) => (
                    <li key={d.district_code} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="w-4 text-caption text-text-muted">{i + 1}</span>
                        <span className="text-body font-semibold text-text-primary">{d.district_name}</span>
                        <span className="min-w-0 flex-1 truncate text-caption text-text-muted">{count(d.orders_count)} orders</span>
                        <span className="text-body font-semibold text-text-primary">{bdt(d.sales_amount)}</span>
                        <span className="w-9 text-right text-caption text-text-secondary">{pct(d.share)}</span>
                      </div>
                      <span className="ml-6 h-1.5 overflow-hidden rounded-full bg-surface-subtle">
                        <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.min(1, d.share) * 100}%` }} />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </ReportCard>
          </div>
        </>
      )}
    </div>
  );
}
