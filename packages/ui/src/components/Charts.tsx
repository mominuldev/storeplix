import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Phase 7 §8.3 charts without a chart library. Reports 60:11810 (Sales over time 61:12738, Orders by channel 61:12786,
// Profit waterfall 63:15896, Each ৳100 63:15949, Margin trend 63:15992, Success by courier 64:15334, Return reasons
// 64:15421, Success trend 64:15466) and the KPI sparklines (Report KPI 61:12643). Colours are tokens only; every chart
// draws aria-hidden graphics and carries a screen-reader table with the same numbers.

export type ChartTone = 'brand' | 'info' | 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'soft';

const fill: Record<ChartTone, string> = {
  brand: 'bg-brand-600',
  info: 'bg-info',
  accent: 'bg-accent-500',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-text-muted',
  soft: 'bg-brand-100',
};
const stroke: Record<ChartTone, string> = {
  brand: 'stroke-brand-600',
  info: 'stroke-info',
  accent: 'stroke-accent-500',
  success: 'stroke-success',
  warning: 'stroke-warning',
  danger: 'stroke-danger',
  muted: 'stroke-text-muted',
  soft: 'stroke-brand-100',
};
const area: Record<ChartTone, string> = {
  brand: 'fill-brand-600/10',
  info: 'fill-info/10',
  accent: 'fill-accent-500/15',
  success: 'fill-success/10',
  warning: 'fill-warning/10',
  danger: 'fill-danger/10',
  muted: 'fill-text-muted/10',
  soft: 'fill-brand-100/40',
};

/** Background class for a legend dot / segment of the given tone. */
export const chartToneClass = (tone: ChartTone) => fill[tone];

/** Legend entry (Figma Chart legend 60:11853: 8px dot, Caption/12 secondary). */
export function ChartLegend({ items, className }: { items: { label: ReactNode; tone: ChartTone; dashed?: boolean }[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {items.map((i, idx) => (
        <li key={idx} className="flex items-center gap-1.5 text-caption text-text-secondary">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-sm', fill[i.tone], i.dashed && 'opacity-60')} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 1 / 2 / 2.5 / 5 × 10ⁿ ceiling so the axis reads in round numbers. */
export function niceCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(n));
  const f = n / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/** Evenly spaced indexes (first and last included) so at most `max` x labels show. */
export function thinIndexes(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out = new Set<number>();
  const step = (count - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.add(Math.round(i * step));
  return [...out];
}

export interface ChartSeries {
  name: string;
  values: (number | null)[];
  tone?: ChartTone;
  dashed?: boolean;
  /** Soft fill under the line (Sales over time, Margin trend). */
  area?: boolean;
}

export interface LineChartProps {
  /** Screen-reader caption of the data table. */
  caption: string;
  labels: string[];
  series: ChartSeries[];
  formatValue?: (n: number) => string;
  formatTick?: (n: number) => string;
  /** Fixed axis bounds (e.g. 0–1 for rates); otherwise 0 → a round ceiling of the data. */
  min?: number;
  max?: number;
  ticks?: number;
  /** Plot height in px. */
  height?: number;
  /** Vertical marker + dot on this index (Figma "Best day" tooltip anchor). */
  highlightIndex?: number | null;
  maxXLabels?: number;
  /** Sparkline mode: no axes, no labels. */
  bare?: boolean;
  className?: string;
}

export function LineChart({
  caption,
  labels,
  series,
  formatValue = (n) => String(n),
  formatTick,
  min = 0,
  max,
  ticks = 4,
  height = 200,
  highlightIndex = null,
  maxXLabels = 7,
  bare = false,
  className,
}: LineChartProps) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  // Sparklines (bare) scale to the data so small moves stay visible; axes start at `min` (0) and end on a round number.
  const top = max ?? (bare ? Math.max(...all, 0) : niceCeil(Math.max(0, ...all)));
  const lo = bare && all.length ? Math.min(...all) - (Math.max(...all) - Math.min(...all)) * 0.15 : Math.min(min, ...all);
  const span = top - lo || 1;
  const n = labels.length;
  const W = 1000;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => 100 - ((v - lo) / span) * 100;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => lo + (span * i) / ticks);
  const xIdx = thinIndexes(n, maxXLabels);

  const paths = series.map((s) => {
    let d = '';
    let started = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(2)}`;
      started = true;
    });
    const firstIdx = s.values.findIndex((v) => v !== null);
    let lastIdx = -1;
    s.values.forEach((v, i) => v !== null && (lastIdx = i));
    const areaD = s.area && firstIdx >= 0 ? `${d}L${x(lastIdx).toFixed(1)},100L${x(firstIdx).toFixed(1)},100Z` : null;
    return { s, d, areaD };
  });
  const hi = highlightIndex !== null && highlightIndex >= 0 && highlightIndex < n ? highlightIndex : null;
  const hiValue = hi !== null ? series[0]?.values[hi] ?? null : null;

  return (
    <figure className={cn('m-0 flex flex-col gap-2', className)}>
      <div className={cn('relative', !bare && 'pl-14')} style={{ height }}>
        {!bare &&
          tickValues.map((t) => (
            <div key={t} aria-hidden className="absolute inset-x-0 flex items-center" style={{ top: `${y(t)}%`, transform: 'translateY(-50%)' }}>
              <span className="w-14 shrink-0 pr-2 text-caption whitespace-nowrap text-text-muted">{(formatTick ?? formatValue)(t)}</span>
              <span className="h-px flex-1 bg-border-default" />
            </div>
          ))}
        <div className="absolute inset-y-0 right-0" style={{ left: bare ? 0 : '3.5rem' }}>
          <svg aria-hidden viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="size-full overflow-visible">
            {paths.map(({ s, areaD }) => areaD && <path key={`${s.name}-a`} d={areaD} className={area[s.tone ?? 'brand']} />)}
            {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={0} y2={100} className="stroke-text-primary" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            {paths.map(({ s, d }) => (
              <path
                key={s.name}
                d={d}
                fill="none"
                className={stroke[s.tone ?? 'brand']}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? '5 5' : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {hi !== null && hiValue !== null && (
            <span
              aria-hidden
              className="absolute size-2.5 rounded-full border-2 border-brand-600 bg-surface-card"
              style={{ left: `${(x(hi) / W) * 100}%`, top: `${y(hiValue)}%`, transform: 'translate(-50%, -50%)' }}
            />
          )}
        </div>
      </div>
      {!bare && (
        <div aria-hidden className="relative ml-14 h-4">
          {xIdx.map((i, k) => (
            <span
              key={i}
              className={cn('absolute text-caption whitespace-nowrap text-text-muted', k % 2 === 1 && xIdx.length > 4 && 'max-sm:hidden')}
              style={{ left: `${(x(i) / W) * 100}%`, transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
            >
              {labels[i]}
            </span>
          ))}
        </div>
      )}
      <SrTable caption={caption} head={['', ...series.map((s) => s.name)]} rows={labels.map((l, i) => [l, ...series.map((s) => (s.values[i] === null ? '—' : formatValue(s.values[i] as number)))])} />
    </figure>
  );
}

export interface BarDatum {
  label: string;
  /** Bar height; null draws an empty slot with `note` ("Not tracked"). */
  value: number | null;
  /** Floating bars (waterfall): the bar spans base → base + value. */
  base?: number;
  tone?: ChartTone;
  /** Text above the bar, e.g. "− ৳ 52,300". */
  display?: string;
  note?: string;
}

/** Vertical bars; with `base` set it is the Profit waterfall (63:15896). */
export function BarChart({
  caption,
  bars,
  formatValue = (n) => String(n),
  formatTick,
  height = 200,
  ticks = 5,
  className,
}: {
  caption: string;
  bars: BarDatum[];
  formatValue?: (n: number) => string;
  formatTick?: (n: number) => string;
  height?: number;
  ticks?: number;
  className?: string;
}) {
  const top = niceCeil(Math.max(0, ...bars.map((b) => (b.base ?? 0) + Math.max(0, b.value ?? 0))));
  const pct = (v: number) => (v / top) * 100;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => (top * i) / ticks);
  return (
    <figure className={cn('m-0 flex flex-col gap-2', className)}>
      <div className="relative pl-14" style={{ height }}>
        {tickValues.map((t) => (
          <div key={t} aria-hidden className="absolute inset-x-0 flex items-center" style={{ bottom: `${pct(t)}%`, transform: 'translateY(50%)' }}>
            <span className="w-14 shrink-0 pr-2 text-caption whitespace-nowrap text-text-muted">{(formatTick ?? formatValue)(t)}</span>
            <span className="h-px flex-1 bg-border-default" />
          </div>
        ))}
        <div aria-hidden className="absolute inset-y-0 right-0 left-14 flex gap-1 px-1 sm:gap-4">
          {bars.map((b) => {
            const v = b.value ?? 0;
            const bottom = pct(b.base ?? 0);
            const h = Math.max(pct(Math.abs(v)), b.value ? 0.8 : 0);
            return (
              <div key={b.label} className="relative min-w-0 flex-1">
                {b.value === null ? (
                  b.note && <span className="absolute inset-x-0 text-center text-[11px] leading-4 text-text-muted max-sm:hidden" style={{ bottom: `${bottom}%` }}>{b.note}</span>
                ) : (
                  <>
                    <span className={cn('absolute inset-x-0 rounded-sm', fill[b.tone ?? 'brand'])} style={{ bottom: `${bottom}%`, height: `${h}%` }} />
                    {b.display && (
                      <span
                        className={cn('absolute inset-x-[-8px] text-center text-[11px] leading-4 font-semibold whitespace-nowrap max-sm:hidden', b.tone === 'accent' || b.tone === 'danger' ? 'text-danger' : 'text-text-primary')}
                        style={{ bottom: `calc(${bottom + h}% + 4px)` }}
                      >
                        {b.display}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="ml-14 flex gap-1 px-1 sm:gap-4">
        {bars.map((b) => (
          <span key={b.label} className="min-w-0 flex-1 text-center text-[11px] leading-4 break-words text-text-secondary max-sm:text-[10px] max-sm:leading-3">
            {b.label}
          </span>
        ))}
      </div>
      <SrTable caption={caption} head={['', 'Amount']} rows={bars.map((b) => [b.label, b.value === null ? b.note ?? '—' : b.display ?? formatValue(b.value)])} />
    </figure>
  );
}

export interface MeterSegment {
  label: string;
  value: number;
  tone: ChartTone;
  /** Screen-reader value (defaults to the share). */
  display?: string;
}

/** Horizontal stacked bar (Each ৳100 63:15949, courier delivered/returned/moving 64:15334, inside/outside Dhaka). */
export function StackedMeter({ caption, segments, className, height = 'h-2.5' }: { caption: string; segments: MeterSegment[]; className?: string; height?: string }) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  return (
    <figure className={cn('m-0', className)}>
      <div aria-hidden className={cn('flex w-full gap-0.5 overflow-hidden rounded-full', height, total === 0 && 'bg-surface-subtle')}>
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => <span key={s.label} className={cn('h-full first:rounded-l-full last:rounded-r-full', fill[s.tone])} style={{ width: `${(s.value / total) * 100}%` }} />)}
      </div>
      <SrTable caption={caption} head={['', 'Share']} rows={segments.map((s) => [s.label, s.display ?? (total ? `${Math.round((s.value / total) * 100)}%` : '0%')])} />
    </figure>
  );
}

/** Donut with a centre label (Orders by channel 61:12786, Why parcels came back 64:15421). */
export function DonutMeter({
  caption,
  segments,
  centerValue,
  centerLabel,
  size = 160,
  className,
}: {
  caption: string;
  segments: MeterSegment[];
  centerValue: ReactNode;
  centerLabel?: ReactNode;
  size?: number;
  className?: string;
}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const r = 40;
  const c = 2 * Math.PI * r;
  const gap = segments.filter((s) => s.value > 0).length > 1 ? 1.5 : 0;
  let offset = 0;
  return (
    <figure className={cn('relative m-0 shrink-0', className)} style={{ width: size, height: size }}>
      <svg aria-hidden viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx={50} cy={50} r={r} fill="none" strokeWidth={14} className="stroke-surface-subtle" />
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * c;
              const el = (
                <circle
                  key={s.label}
                  cx={50}
                  cy={50}
                  r={r}
                  fill="none"
                  strokeWidth={14}
                  className={stroke[s.tone]}
                  strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
      </svg>
      <div aria-hidden className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-heading text-text-primary">{centerValue}</span>
        {centerLabel && <span className="text-caption text-text-muted">{centerLabel}</span>}
      </div>
      <SrTable caption={caption} head={['', 'Share']} rows={segments.map((s) => [s.label, s.display ?? (total ? `${Math.round((s.value / total) * 100)}%` : '0%')])} />
    </figure>
  );
}
