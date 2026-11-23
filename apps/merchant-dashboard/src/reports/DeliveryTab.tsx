import type { DeliveryReport, ReportMeta, ReturnReason } from '@storeplix/types';
import { Badge, ChartLegend, chartToneClass, cn, DonutMeter, EmptyState, LineChart, ProviderLogo, StackedMeter, type ChartTone } from '@storeplix/ui';
import { Box, Clock, RotateCcw, Truck } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { ErrorBlock } from '../catalog/states';
import { relativeTime } from '../online-store/hooks';
import { courierLabels, returnReasonLabels } from '../returns/labels';
import { fetchers, useReport } from './queries';
import { weekLabel, type ReportRange } from './range';
import { bdt, CardSkeleton, rateAxis, count, delta, KpiSkeletons, pct, pct1, ReportCard, ReportKpi } from './ui';

// Delivery & returns 60:12662: KPIs 64:15238, Success by courier 64:15334, Return reasons 64:15421, Success trend
// 64:15466, Returning now 64:15513, District heatmap 64:15559. No "Fake order guard" tip (Phase 8).

const reasonTone: Record<ReturnReason, ChartTone> = {
  refused_at_door: 'accent',
  wrong_size: 'brand',
  wrong_item: 'info',
  changed_mind: 'warning',
  damaged: 'danger',
  other: 'muted',
};

const days = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })} ${n === 1 ? 'day' : 'days'}`);
const shortDays = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })} d`);

/** District heat tile tone (Figma legend 90%+ / 80–89% / below 80%). */
export function heatTone(rate: number | null): string {
  if (rate === null) return 'bg-surface-subtle text-text-secondary';
  if (rate >= 0.9) return 'bg-success-bg text-success';
  if (rate >= 0.8) return 'bg-warning-bg text-warning';
  return 'bg-danger-bg text-danger';
}

export function DeliveryTab({ range, onMeta }: { range: ReportRange; onMeta: (m: ReportMeta) => void }) {
  const q = useReport<DeliveryReport>('delivery', range, fetchers.delivery(range));
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
  if (q.isError) return <ErrorBlock error={q.error} title="We couldn’t load the delivery report" onRetry={() => void q.refetch()} className="rounded-card border border-border-default bg-surface-card" />;
  const r = q.data.data;
  const s = r.summary;
  const p = r.previous;
  const rates = r.weekly.map((w) => w.success_rate).filter((v): v is number => v !== null);
  const low = rates.length ? Math.max(0, Math.floor((Math.min(...rates) - 0.05) * 20) / 20) : 0;

  return (
    <div className={cn('flex flex-col gap-5 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <ReportKpi
          icon={<Truck />}
          label="Delivery success"
          value={pct1(s.success_rate)}
          hint={`${count(s.delivered_count)} delivered of ${count(s.parcels_count)} parcels`}
          change={delta(s.success_rate, p.success_rate, 'points')}
          spark={r.weekly.map((w) => w.success_rate ?? 0)}
          sparkTone="success"
        />
        <ReportKpi
          icon={<RotateCcw />}
          label="Parcels returning"
          value={count(s.returning_count)}
          hint={`On the way back · ${bdt(s.returning_charges_amount)} charges`}
          change={delta(s.returning_count, p.returning_count, 'count', false)}
          sparkTone="accent"
        />
        <ReportKpi
          icon={<Clock />}
          label="Avg delivery time"
          value={days(s.avg_delivery_days)}
          hint={`Inside Dhaka ${shortDays(s.avg_delivery_days_inside_dhaka)} · outside ${shortDays(s.avg_delivery_days_outside_dhaka)}`}
          change={delta(s.avg_delivery_days, p.avg_delivery_days, 'days', false)}
        />
        <ReportKpi
          icon={<Box />}
          label="Return rate"
          value={pct1(s.return_rate)}
          hint={`${count(s.returned_count)} parcels came back this period`}
          change={delta(s.return_rate, p.return_rate, 'points', false)}
        />
      </div>

      {s.parcels_count === 0 && r.returning.length === 0 ? (
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <EmptyState icon={<Truck />} title="No parcels in this period" description="This report counts parcels booked with a courier. Pick another range or book parcels from Orders." />
        </section>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,744fr)_minmax(0,360fr)]">
            <ReportCard
              title="Delivery success by courier"
              description="Share of booked parcels, this period"
              action={
                <ChartLegend
                  items={[
                    { label: 'Delivered', tone: 'success' },
                    { label: 'Returned', tone: 'accent' },
                    { label: 'Still moving', tone: 'soft' },
                  ]}
                />
              }
            >
              {r.couriers.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">No courier parcels in this period.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border-default">
                  {r.couriers.map((c) => (
                    <li key={c.provider} className="flex flex-col gap-2.5 py-4 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-3">
                        <ProviderLogo provider={c.provider} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-body font-semibold text-text-primary">{courierLabels[c.provider]}</span>
                          <span className="text-caption text-text-muted">
                            {count(c.parcels_count)} parcels · avg {shortDays(c.avg_delivery_days)} · {bdt(c.cod_held_amount)} held
                          </span>
                        </span>
                        <span className="flex flex-col items-end">
                          <span className={cn('text-heading', c.delivered_share >= 0.85 ? 'text-success' : c.delivered_share < 0.8 ? 'text-warning' : 'text-text-primary')}>{pct(c.delivered_share)}</span>
                          <span className="text-caption text-text-muted">delivered</span>
                        </span>
                      </div>
                      <StackedMeter
                        caption={`${courierLabels[c.provider]} parcels`}
                        segments={[
                          { label: 'Delivered', value: c.delivered_share, tone: 'success', display: pct(c.delivered_share) },
                          { label: 'Returned', value: c.returned_share, tone: 'accent', display: pct(c.returned_share) },
                          { label: 'Still moving', value: c.in_progress_share, tone: 'soft', display: pct(c.in_progress_share) },
                        ]}
                      />
                      <p aria-hidden className="flex flex-wrap gap-x-4 text-caption text-text-secondary">
                        <span>Delivered {pct(c.delivered_share)}</span>
                        <span>Returned {pct(c.returned_share)}</span>
                        <span>Still moving {pct(c.in_progress_share)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </ReportCard>
            <ReportCard title="Why parcels came back" description={`${count(r.returns_count)} returns, by reason`}>
              {r.return_reasons.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">No returns in this period.</p>
              ) : (
                <>
                  <DonutMeter
                    className="self-center"
                    caption="Return reasons"
                    centerValue={count(r.returns_count)}
                    centerLabel="returns"
                    segments={r.return_reasons.map((x) => ({ label: returnReasonLabels[x.reason] ?? x.reason, value: x.count, tone: reasonTone[x.reason] ?? 'muted', display: pct(x.share) }))}
                  />
                  <ul className="flex flex-col gap-3">
                    {r.return_reasons.map((x) => (
                      <li key={x.reason} className="flex items-center gap-2.5 text-body">
                        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', chartToneClass(reasonTone[x.reason] ?? 'muted'))} />
                        <span className="flex-1 text-text-primary">{returnReasonLabels[x.reason] ?? x.reason}</span>
                        <span className="font-semibold text-text-primary">{pct(x.share)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </ReportCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ReportCard title="Success rate over time" description="Weekly delivery success, all couriers">
              <LineChart
                caption="Delivery success by week"
                labels={r.weekly.map((w) => weekLabel(w.week))}
                series={[{ name: 'Delivery success', values: r.weekly.map((w) => w.success_rate), tone: 'brand' }]}
                formatValue={(n) => pct1(n)}
                formatTick={(n) => `${Math.round(n * 100)}%`}
                {...rateAxis(low, 1)}
                height={200}
              />
            </ReportCard>
            <ReportCard title="Parcels returning" description={`${count(s.returning_count)} on the way back to you`}>
              {r.returning.length === 0 ? (
                <p className="py-6 text-center text-body text-text-secondary">Nothing is on the way back right now.</p>
              ) : (
                <ul className="-mx-4 flex flex-col divide-y divide-border-default sm:-mx-6">
                  {r.returning.map((x) => (
                    <li key={x.shipment_id}>
                      <Link to={`/orders/${x.order_id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-subtle sm:px-6">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body font-semibold text-text-primary">
                            {x.order_number} · {x.customer_name}
                          </span>
                          <span className="truncate text-caption text-text-secondary">{[x.district_name, courierLabels[x.provider], x.problem].filter(Boolean).join(' · ')}</span>
                        </span>
                        <Badge tone="danger" dot className="max-sm:hidden">
                          Returning
                        </Badge>
                        <span className="w-24 shrink-0 text-right text-caption text-text-muted">{x.last_location ?? relativeTime(x.last_event_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </ReportCard>
          </div>

          <ReportCard
            title="Delivery success by district"
            description="Greener is better · parcels booked this period"
            action={
              <ChartLegend
                items={[
                  { label: '90%+', tone: 'success' },
                  { label: '80–89%', tone: 'warning' },
                  { label: 'Below 80%', tone: 'danger' },
                ]}
              />
            }
          >
            {r.districts.length === 0 ? (
              <p className="py-6 text-center text-body text-text-secondary">No districts yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                {r.districts.map((d) => (
                  <li key={d.district_code} className={cn('flex flex-col gap-0.5 rounded-lg px-3 py-2.5', heatTone(d.success_rate))}>
                    <span className="truncate text-caption font-medium text-text-primary">{d.district_name}</span>
                    <span className="text-heading">{pct(d.success_rate)}</span>
                    <span className="text-caption text-text-secondary">{count(d.parcels_count)} parcels</span>
                  </li>
                ))}
              </ul>
            )}
          </ReportCard>
        </>
      )}
    </div>
  );
}
