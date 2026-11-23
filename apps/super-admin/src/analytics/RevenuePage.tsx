import type { AdminRevenueReport, AnalyticsMeta, AnalyticsQuery, AnalyticsRange, RevenueByPlanRow, TopPayingMerchant } from '@storeplix/types';
import {
  Avatar,
  Badge,
  BarChart,
  Button,
  Card,
  ChartLegend,
  chartToneClass,
  cn,
  DataTable,
  formatBdt,
  formatBdtCompact,
  formatCount,
  Heatmap,
  HeatmapScale,
  Input,
  Toggle,
  type ChartTone,
  type DataTableColumn,
} from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Calendar } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Empty, ErrorState } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { providerLabel } from '../lib/format';
import { useCan } from '../lib/permissions';
import { daysAgo } from '../merchants/MerchantsPage';
import { customRangeSchema, MIN_FROM } from './range';
import { bucketLabel, dataAsOf, delta, historyNote, monthLong, monthShort, monthYear, rangeFromParam, rangeLabel, rate, RANGES } from './format';
import { ChartCard, DataCaption, InfoPill, KpiCard, KpiSkeletons, NoAnalytics, RangeTabs, WidgetBody } from './ui';

const compact = (paisa: number | null | undefined) => formatBdtCompact(paisa);
const movementSeries: { key: 'new' | 'expansion' | 'contraction' | 'churned'; label: string; tone: ChartTone }[] = [
  { key: 'new', label: 'New', tone: 'brand' },
  { key: 'expansion', label: 'Expansion', tone: 'soft' },
  { key: 'contraction', label: 'Contraction', tone: 'warning' },
  { key: 'churned', label: 'Churn', tone: 'accent' },
];

const signedCompact = (paisa: number) => `${paisa > 0 ? '+' : paisa < 0 ? '−' : ''}${formatBdtCompact(Math.abs(paisa), { symbol: false, tight: true })}`;

// Figma Revenue reports 39:12705 (PHASE-8-2 §7.1, `view_analytics`): header 39:17079 with range tabs 39:17083
// (default 12 months), Custom popover, Compare toggle 39:17092 (Export 39:17096 hidden, Q109); KPIs 39:17098; MRR
// movement 39:17141; Cohort retention 39:18323 (by first paid month, Q107; footnote dropped); Revenue by plan 39:18587
// (no Pro, Q111); Trial funnel 39:18655 (no "Started 14-day trial" step, P82-15); Top paying merchants 39:18704.
export function RevenuePage() {
  const can = useCan();
  const allowed = can('view_analytics');
  const [params, setParams] = useSearchParams();
  const range = rangeFromParam(params.get('range'), '12m', true);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const query: AnalyticsQuery = range === 'custom' && from && to ? { range, from, to } : { range: range === 'custom' ? '12m' : range };
  const [compare, setCompare] = useState(true);
  const [customOpen, setCustomOpen] = useState(range === 'custom' && !(from && to));

  const report = useQuery({
    queryKey: ['admin', 'analytics', 'revenue', query],
    queryFn: () => api.admin.revenueReport(query),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const pickRange = (r: AnalyticsRange) => {
    if (r === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    update({ range: r, from: null, to: null });
  };

  if (!allowed) {
    return (
      <>
        <PageHeader title="Revenue reports" />
        <Card>
          <Empty title="You don’t have access to revenue reports" description="Ask a super admin for the “View analytics” permission." />
        </Card>
      </>
    );
  }

  const meta = report.data?.meta;
  const d = report.data?.data;
  const hasData = !!meta?.as_of;
  const maxTo = meta?.as_of ?? daysAgo(1);

  return (
    <>
      <div className="flex flex-col gap-1">
        <PageHeader
          stackActions
          title="Revenue reports"
          subtitle={meta ? `Subscription revenue · ${rangeLabel({ ...meta, granularity: 'day' })} · all plans` : 'Subscription revenue · all plans'}
          actions={
            <div className="flex flex-wrap items-center gap-3 xl:justify-end">
              <RangeTabs value={customOpen ? 'custom' : range} onChange={pickRange} ranges={RANGES} />
              <label className="flex h-10 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 text-body font-medium text-text-primary">
                <Toggle checked={compare} onChange={setCompare} label="Compare to previous period" />
                <span aria-hidden>Compare to previous period</span>
              </label>
            </div>
          }
        />
        {meta && <DataCaption asOf={dataAsOf(meta)} history={hasData ? historyNote(meta) : null} />}
      </div>
      {customOpen && (
        <CustomRangeForm
          key={`${from}-${to}`}
          initial={{ from, to }}
          maxTo={maxTo}
          onCancel={() => setCustomOpen(range === 'custom' && !(from && to))}
          onApply={(r) => {
            setCustomOpen(false);
            update({ range: 'custom', from: r.from, to: r.to });
          }}
        />
      )}
      {report.isError ? (
        <Card>
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        </Card>
      ) : report.isPending ? (
        <>
          <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <KpiSkeletons count={6} />
          </section>
          <ChartCard title="MRR movement">
            <WidgetBody loading error={null} onRetry={() => undefined} empty={false} loadingLabel="Loading MRR movement">
              {() => null}
            </WidgetBody>
          </ChartCard>
        </>
      ) : !hasData || !d || !meta ? (
        <Card>
          <NoAnalytics />
        </Card>
      ) : (
        <>
          <Kpis data={d} meta={meta} compare={compare} />
          <MovementCard data={d} meta={meta} />
          <CohortCard data={d} />
          <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_400px]">
            <ByPlanCard data={d} meta={meta} compare={compare} />
            <FunnelCard data={d} meta={meta} />
          </div>
          <TopMerchantsCard rows={d.top_merchants} meta={meta} />
        </>
      )}
    </>
  );
}

function CustomRangeForm({
  initial,
  maxTo,
  onApply,
  onCancel,
}: {
  initial: { from: string; to: string };
  maxTo: string;
  onApply: (r: { from: string; to: string }) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="px-5 py-4">
      <form
        aria-label="Custom range"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = customRangeSchema(maxTo).safeParse(draft);
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Check the dates.');
            return;
          }
          setError(null);
          onApply(parsed.data);
        }}
      >
        <Calendar aria-hidden className="mb-3 size-4 text-text-muted" />
        <Input
          label="From"
          type="date"
          min={MIN_FROM}
          max={maxTo}
          value={draft.from}
          onChange={(e) => setDraft((x) => ({ ...x, from: e.target.value }))}
          aria-invalid={!!error}
          containerClassName="w-44"
        />
        <Input
          label="To"
          type="date"
          min={MIN_FROM}
          max={maxTo}
          value={draft.to}
          onChange={(e) => setDraft((x) => ({ ...x, to: e.target.value }))}
          aria-invalid={!!error}
          containerClassName="w-44"
        />
        <Button type="submit">Apply</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {error && (
          <p role="alert" className="basis-full text-caption text-danger">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

/** KPIs 39:17098: MRR 39:17099, ARR 39:17106, Net new MRR 39:17113, Churned MRR 39:17120, ARPA 39:17127, LTV 39:17134. */
function Kpis({ data, meta, compare }: { data: AdminRevenueReport; meta: AnalyticsMeta; compare: boolean }) {
  const k = data.kpis;
  const c = <T,>(v: T) => (compare ? v : null);
  return (
    <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <KpiCard
        layout="report"
        label="MRR"
        value={compact(k.mrr.amount)}
        change={c(delta(k.mrr.amount, k.mrr.previous_amount, 'ratio'))}
        caption={compare && k.mrr.previous_amount !== null ? `vs ${compact(k.mrr.previous_amount)} in ${monthShort(meta.previous_to)}` : undefined}
      />
      <KpiCard
        layout="report"
        label="ARR"
        value={compact(k.arr.amount)}
        change={c(delta(k.arr.amount, k.arr.previous_amount, 'ratio'))}
        caption={`Run-rate · ${formatCount(k.arpa.paying)} paying`}
      />
      <KpiCard
        layout="report"
        label="Net new MRR"
        value={signedMoney(k.net_new_mrr.amount)}
        change={c(delta(k.net_new_mrr.amount, k.net_new_mrr.previous_amount, 'ratio'))}
        caption="New + expansion − losses"
      />
      <KpiCard
        layout="report"
        label="Churned MRR"
        value={compact(k.churned_mrr.amount)}
        change={c(delta(k.churned_mrr.rate, k.churned_mrr.previous_rate, 'points', { higherIsBetter: false }))}
        caption={`${rate(k.churned_mrr.rate)} of opening MRR`}
      />
      <KpiCard
        layout="report"
        label="ARPA"
        value={formatBdt(k.arpa.amount === null ? null : Math.round(k.arpa.amount / 100) * 100)}
        change={c(delta(k.arpa.amount, k.arpa.previous_amount, 'money', { formatMoney: (p) => formatBdt(Math.round(p / 100) * 100) }))}
        caption="Per paying account"
      />
      <KpiCard
        layout="report"
        label="LTV"
        value={compact(k.ltv.amount)}
        caption={`ARPA ÷ churn · ${k.ltv.lifetime_months === null ? '—' : `${k.ltv.lifetime_months} mo`}`}
      />
    </section>
  );
}

function signedMoney(paisa: number | null): string {
  if (paisa === null) return '—';
  return paisa < 0 ? `−${formatBdtCompact(-paisa)}` : formatBdtCompact(paisa);
}

/** MRR movement 39:17141: diverging stacked bars (legend 39:17146, chart 39:17159) + last-bucket breakdown 39:17248. */
function MovementCard({ data, meta }: { data: AdminRevenueReport; meta: AnalyticsMeta }) {
  const rows = data.movement;
  const last = rows.at(-1);
  const lastLabel = last ? bucketLabel(last.bucket_start, meta.granularity) : '';
  const per = meta.granularity === 'month' ? 'month' : meta.granularity === 'week' ? 'week' : 'day';
  const breakdown = [
    { key: 'new', label: 'New', tone: 'brand' as ChartTone, amount: last?.new_amount, hint: (n: number) => `${formatCount(n)} new paying shop${n === 1 ? '' : 's'}`, count: last?.counts?.new },
    { key: 'expansion', label: 'Expansion', tone: 'soft' as ChartTone, amount: last?.expansion_amount, hint: (n: number) => `${formatCount(n)} upgrade${n === 1 ? '' : 's'}`, count: last?.counts?.expansion },
    { key: 'contraction', label: 'Contraction', tone: 'warning' as ChartTone, amount: last?.contraction_amount, hint: (n: number) => `${formatCount(n)} downgrade${n === 1 ? '' : 's'}`, count: last?.counts?.contraction },
    { key: 'churn', label: 'Churn', tone: 'accent' as ChartTone, amount: last?.churned_amount, hint: (n: number) => `${formatCount(n)} cancellation${n === 1 ? '' : 's'}`, count: last?.counts?.churned },
  ];
  return (
    <ChartCard
      title="MRR movement"
      subtitle={`New, expansion, contraction and churned MRR per ${per}`}
      actions={<ChartLegend items={movementSeries.map((s) => ({ label: s.label, tone: s.tone }))} />}
      bodyClassName="flex flex-col gap-5"
    >
      {rows.every((r) => r.net_new_amount === null) ? (
        <NoAnalytics />
      ) : (
        <>
          <BarChart
            caption="MRR movement"
            height={240}
            ticks={6}
            maxXLabels={12}
            series={movementSeries.map((s) => s.label)}
            formatValue={(n) => formatBdtCompact(n)}
            formatTick={(n) => (n === 0 ? '0' : signedCompact(n).replace('+', ''))}
            bars={rows.map((r) => ({
              label: bucketLabel(r.bucket_start, meta.granularity),
              value: r.net_new_amount,
              note: 'No data',
              display: r.net_new_amount === null ? undefined : signedCompact(r.net_new_amount),
              segments:
                r.net_new_amount === null
                  ? null
                  : [
                      { label: 'New', value: r.new_amount ?? 0, tone: 'brand' },
                      { label: 'Expansion', value: r.expansion_amount ?? 0, tone: 'soft' },
                      { label: 'Contraction', value: -(r.contraction_amount ?? 0), tone: 'warning' },
                      { label: 'Churn', value: -(r.churned_amount ?? 0), tone: 'accent' },
                    ],
            }))}
          />
          <ul aria-label={`Breakdown · ${lastLabel}`} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {breakdown.map((b) => (
              <li key={b.key} className="flex gap-2.5 rounded-lg bg-surface-subtle px-3.5 py-3">
                <span aria-hidden className={cn('h-10 w-1 shrink-0 rounded-[2px]', chartToneClass(b.tone))} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-caption font-medium text-text-secondary">
                      {b.label} · {lastLabel}
                    </span>
                    <span className="text-body font-semibold text-text-primary">{compact(b.amount ?? null)}</span>
                  </span>
                  <span className="truncate text-caption text-text-muted">{b.count === undefined || b.count === null ? 'No data' : b.hint(b.count)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}

/** Cohort retention 39:18323: scale 39:18328, M3 pill 39:18336, heatmap 39:18338 (≤ 12 columns M0–M11). */
function CohortCard({ data }: { data: AdminRevenueReport }) {
  const rows = data.cohorts.rows;
  const width = Math.min(12, Math.max(0, ...rows.map((r) => r.retention.length)));
  const columns = Array.from({ length: width }, (_, i) => `M${i}`);
  return (
    <ChartCard
      title="Cohort retention"
      subtitle="Share of paying shops still subscribed, by first paid month"
      actions={
        <div className="flex items-center gap-3">
          <HeatmapScale />
          {data.cohorts.m3_average !== null && <InfoPill>M3 avg {rate(data.cohorts.m3_average)}</InfoPill>}
        </div>
      }
    >
      {rows.length === 0 ? (
        <NoAnalytics description="Cohorts appear once shops pay their first invoice." />
      ) : (
        <div className="overflow-x-auto">
          <Heatmap
            caption="Cohort retention"
            className="min-w-[720px]"
            columns={columns}
            asideHeader="Shops"
            rows={rows.map((r) => ({ key: r.cohort, label: monthYear(r.cohort), aside: formatCount(r.size), values: r.retention.slice(0, 12) }))}
          />
        </div>
      )}
    </ChartCard>
  );
}

function planTone(row: RevenueByPlanRow, paidOrder: string[]): ChartTone {
  if (row.monthly_price_amount === 0) return 'subtle';
  const tones: ChartTone[] = ['soft', 'brand-500', 'brand-700', 'brand'];
  return tones[paidOrder.indexOf(row.plan_code) % tones.length] ?? 'brand';
}

/** Revenue by plan 39:18587 (rows 39:18598…, total 39:18649): rows from data in plans order desc. */
function ByPlanCard({ data, meta, compare }: { data: AdminRevenueReport; meta: AnalyticsMeta; compare: boolean }) {
  const { rows, total } = data.by_plan;
  const paidOrder = [...rows].filter((r) => r.monthly_price_amount > 0).sort((a, b) => a.monthly_price_amount - b.monthly_price_amount).map((r) => r.plan_code);
  const change = (cur: number | null, prev: number | null) => delta(cur, prev, 'ratio');
  const head = 'px-5 py-2.5 text-[11px] font-medium tracking-wide text-text-muted uppercase';
  return (
    <Card role="region" aria-label="Revenue by plan" className="min-w-0 overflow-hidden">
      <div className="flex flex-col gap-0.5 px-5 pt-5 pb-4">
        <h2 className="text-body-lg font-medium text-text-primary">Revenue by plan</h2>
        <p className="text-caption text-text-secondary">{monthLong(meta.to)} · MRR and share of total</p>
      </div>
      {rows.length === 0 ? (
        <NoAnalytics />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-body whitespace-nowrap">
            <caption className="sr-only">Revenue by plan</caption>
            <thead className="bg-surface-subtle text-left">
              <tr>
                <th scope="col" className={head}>Plan</th>
                <th scope="col" className={cn(head, 'text-right')}>Shops</th>
                <th scope="col" className={cn(head, 'text-right')}>MRR</th>
                <th scope="col" className={head}>Share</th>
                {compare && <th scope="col" className={cn(head, 'text-right')}>vs prev.</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const free = r.monthly_price_amount === 0;
                const ch = change(r.mrr_amount, r.previous_mrr_amount);
                return (
                  <tr key={r.plan_code} className="border-t border-border-default">
                    <th scope="row" className="px-5 py-3.5 text-left font-normal">
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', chartToneClass(planTone(r, paidOrder)), free && 'border border-border-strong')} />
                        <span className="flex flex-col">
                          <span className="font-semibold text-text-primary">{r.plan_name}</span>
                          <span className="text-caption text-text-muted">
                            {free ? 'Free plan' : `${formatBdt(r.monthly_price_amount)}/mo · ${rate(r.yearly_share)} annual`}
                          </span>
                        </span>
                      </span>
                    </th>
                    <td className="px-5 py-3.5 text-right text-text-secondary tabular-nums">{formatCount(r.shops)}</td>
                    <td className="px-5 py-3.5 text-right font-semibold text-text-primary tabular-nums">{compact(r.mrr_amount)}</td>
                    <td className="px-5 py-3.5">
                      <span className="flex items-center gap-2">
                        <span className="relative h-1.5 w-24 shrink-0 rounded-[3px] bg-surface-subtle">
                          <span className="absolute inset-y-0 left-0 rounded-[3px] bg-brand-600" style={{ width: `${Math.min(100, (r.share ?? 0) * 100)}%` }} />
                        </span>
                        <span className="text-caption font-medium text-text-secondary">{rate(r.share)}</span>
                      </span>
                    </td>
                    {compare && (
                      <td className={cn('px-5 py-3.5 text-right font-medium', ch ? (ch.good ? 'text-success' : 'text-danger') : 'text-text-muted')}>
                        {ch?.label ?? '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-surface-subtle">
              <tr>
                <th scope="row" className="px-5 py-3 text-left font-semibold text-text-primary">
                  Total · {formatCount(total.paying)} paying
                </th>
                <td className="px-5 py-3 text-right font-semibold text-text-primary tabular-nums">{formatCount(total.shops)}</td>
                <td className="px-5 py-3 text-right font-semibold text-text-primary tabular-nums">{compact(total.mrr_amount)}</td>
                <td className="px-5 py-3 text-caption text-text-secondary">100%</td>
                {compare && (
                  <td className="px-5 py-3 text-right font-medium">
                    <TotalChange cur={total.mrr_amount} prev={total.previous_mrr_amount} />
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function TotalChange({ cur, prev }: { cur: number | null; prev: number | null }) {
  const ch = delta(cur, prev, 'ratio');
  return <span className={ch ? (ch.good ? 'text-success' : 'text-danger') : 'text-text-muted'}>{ch?.label ?? '—'}</span>;
}

/** Trial funnel 39:18655: Signed up → Store published → Converted to paid (P82-15), with drop-off lines. */
function FunnelCard({ data, meta }: { data: AdminRevenueReport; meta: AnalyticsMeta }) {
  const f = data.trial_funnel;
  const base = f.signed_up;
  const steps: { label: string; value: number; tone: string; drop?: string }[] = [
    { label: 'Signed up', value: f.signed_up, tone: 'bg-brand-100', drop: `${formatCount(Math.max(0, f.signed_up - f.store_published))} never published a store` },
    { label: 'Store published', value: f.store_published, tone: 'bg-brand-500', drop: `${formatCount(Math.max(0, f.store_published - f.converted))} did not convert` },
    { label: 'Converted to paid', value: f.converted, tone: 'bg-brand-700' },
  ];
  return (
    <ChartCard
      title="Trial funnel"
      subtitle={`Shops created ${rangeLabel({ ...meta, granularity: 'day' })} → paid`}
      actions={f.trial_to_paid_rate !== null && <InfoPill tone="brand">{rate(f.trial_to_paid_rate)} trial → paid</InfoPill>}
      bodyClassName="flex flex-col gap-4"
    >
      {base === 0 ? (
        <NoAnalytics description="No shops signed up in this range." />
      ) : (
        <>
          <ol aria-label="Trial funnel steps" className="flex flex-col gap-4">
            {steps.map((s) => (
              <li key={s.label} className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-body font-medium text-text-primary">{s.label}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-body font-semibold text-text-primary tabular-nums">{formatCount(s.value)}</span>
                    <span className="text-caption text-text-muted">{rate(s.value / base)}</span>
                  </span>
                </span>
                <span aria-hidden className="relative h-[22px] rounded-sm bg-brand-50">
                  <span className={cn('absolute inset-y-0 left-0 rounded-sm', s.tone)} style={{ width: `${Math.min(100, (s.value / base) * 100)}%` }} />
                </span>
                {s.drop && <span className="text-caption text-text-muted">↓ {s.drop}</span>}
              </li>
            ))}
          </ol>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-0.5 rounded-lg bg-surface-subtle px-3.5 py-3">
              <span className="text-caption text-text-muted">Median time to paid</span>
              <span className="text-body font-semibold text-text-primary">
                {f.median_days_to_paid === null ? '—' : `${formatCount(f.median_days_to_paid)} day${f.median_days_to_paid === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg bg-surface-subtle px-3.5 py-3">
              <span className="text-caption text-text-muted">Signup → paid</span>
              <span className="text-body font-semibold text-text-primary">{rate(f.signup_to_paid_rate)}</span>
            </div>
          </div>
        </>
      )}
    </ChartCard>
  );
}

/** Top paying merchants 39:18704: row click → merchant; "All merchants →" → /merchants?sort=-mrr. */
function TopMerchantsCard({ rows, meta }: { rows: TopPayingMerchant[]; meta: AnalyticsMeta }) {
  const navigate = useNavigate();
  const columns: DataTableColumn<TopPayingMerchant>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      mobileLabel: false,
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={m.tenant.name} size="sm" className="rounded-md" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-text-primary">{m.tenant.name}</span>
            <span className="truncate text-caption text-text-muted">{m.primary_host ?? '—'}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      width: 100,
      cell: (m) => (
        <Badge size="sm" tone="brand">
          {m.plan_code.charAt(0).toUpperCase() + m.plan_code.slice(1)}
        </Badge>
      ),
    },
    {
      key: 'billing',
      header: 'Billing',
      width: 170,
      cell: (m) => (
        <span className="text-caption text-text-secondary">
          {m.last_payment_provider ? `${providerLabel(m.last_payment_provider)} · ${m.billing_interval === 'year' ? 'yearly' : 'monthly'}` : '—'}
        </span>
      ),
    },
    { key: 'orders', header: 'Orders / 30d', width: 110, align: 'end', cell: (m) => <span className="tabular-nums">{formatCount(m.orders_30d)}</span> },
    { key: 'mrr', header: 'MRR', width: 100, align: 'end', cell: (m) => <span className="font-semibold tabular-nums">{formatBdt(m.mrr_amount)}</span> },
    { key: 'since', header: 'Customer since', width: 120, cell: (m) => <span className="text-text-secondary">{m.customer_since ? monthYear(m.customer_since) : '—'}</span> },
    { key: 'lifetime', header: 'Lifetime paid', width: 120, align: 'end', cell: (m) => <span className="tabular-nums">{formatBdt(m.lifetime_paid_amount)}</span> },
  ];
  return (
    <Card role="region" aria-label="Top paying merchants" className="min-w-0 overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">Top paying merchants</h2>
          <p className="text-caption text-text-secondary">By MRR · {monthLong(meta.to)}</p>
        </div>
        <Link to="/merchants?sort=-mrr" className="flex items-center gap-1 text-body font-medium text-brand-600 hover:underline">
          All merchants <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
      <div className="overflow-x-auto">
        <DataTable
          label="Top paying merchants"
          className="min-w-[900px] rounded-none border-x-0 border-b-0 shadow-none"
          columns={columns}
          rows={rows}
          getRowId={(m) => m.tenant.id}
          onRowClick={(m) => navigate(`/merchants/${m.tenant.id}`)}
          state={rows.length === 0 ? <Empty title="No paying merchants yet" description="Shops appear here once they pay for a plan." /> : undefined}
        />
      </div>
    </Card>
  );
}

