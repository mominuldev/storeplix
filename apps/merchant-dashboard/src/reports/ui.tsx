import { cn, formatBdt, LineChart, Skeleton, type ChartTone } from '@storeplix/ui';
import type { ReactNode } from 'react';

// Reports local components 60:11811: KPI header 60:11842 (36px brand-50 icon tile radius 10, Body/14 Medium label,
// delta pill), Card title 60:11856 (Body/16 Medium + Caption muted), KPI card 61:12643 (radius 16, pt 18, px 20,
// Heading/32 value, Caption muted hint, 56px sparkline flush to the bottom).

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
export const pct1 = (v: number | null | undefined) => pct(v, 1);
export const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-IN'));
export const bdt = (paisa: number | null | undefined) => formatBdt(paisa);
/** Whole taka for per-order averages (the API floors to paisa; Figma shows "৳ 1,318"). */
export const bdtWhole = (paisa: number | null | undefined) => formatBdt(paisa === null || paisa === undefined ? paisa : Math.round(paisa / 100) * 100);
/** Axis top and tick count for a 0–1 rate axis so ticks land on 5 % / 10 % steps. */
export function rateAxis(lo: number, hi: number): { min: number; max: number; ticks: number } {
  const step = hi - lo > 0.3 ? 0.1 : 0.05;
  const min = Math.floor(lo / step) * step;
  const max = Math.max(min + step, Math.ceil(hi / step) * step);
  return { min, max, ticks: Math.max(1, Math.round((max - min) / step)) };
}

/** Axis ticks in taka: "৳ 40k", "৳ 1.5L" (lakh) — Figma "৳ 30k" / "৳ 5L". */
export function compactBdt(paisa: number): string {
  const taka = paisa / 100;
  if (Math.abs(taka) >= 100_000) return `৳ ${trim(taka / 100_000)}L`;
  if (Math.abs(taka) >= 1_000) return `৳ ${trim(taka / 1_000)}k`;
  return `৳ ${trim(taka)}`;
}
const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));

export interface Delta {
  label: string;
  /** good = success tone, bad = danger tone. */
  good: boolean;
}

/**
 * Change vs the previous period. `kind: 'ratio'` → relative % ("↑ 14%"), `'points'` → percentage points for rates
 * ("↓ 1.2 pts"), `'days'` → absolute days ("↓ 0.3 d"), `'count'` → absolute ("↑ 4"). `higherIsBetter` picks the tone.
 * Null when there is nothing to compare.
 */
export function delta(cur: number | null | undefined, prev: number | null | undefined, kind: 'ratio' | 'points' | 'days' | 'count', higherIsBetter = true): Delta | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const diff = cur - prev;
  if (diff === 0) return null;
  const up = diff > 0;
  let text: string;
  if (kind === 'ratio') {
    if (prev === 0) return null;
    const r = Math.abs(diff / prev) * 100;
    text = `${r >= 10 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, '')}%`;
  } else if (kind === 'points') text = `${(Math.abs(diff) * 100).toFixed(1).replace(/\.0$/, '')} pts`;
  else if (kind === 'days') text = `${Math.abs(diff).toFixed(1).replace(/\.0$/, '')} d`;
  else text = Math.abs(diff).toLocaleString('en-IN');
  return { label: `${up ? '↑' : '↓'} ${text}`, good: up === higherIsBetter };
}

export function ReportKpi({
  icon,
  label,
  value,
  hint,
  change,
  spark,
  sparkTone = 'brand',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  change?: Delta | null;
  spark?: number[];
  sparkTone?: ChartTone;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-card border border-border-default bg-surface-card pt-[18px] shadow-elevation-1">
      <div className="flex flex-col gap-1.5 px-4 sm:px-5">
        <div className="flex h-8 items-center gap-2.5">
          <span className="flex shrink-0 items-center justify-center rounded-control bg-brand-50 p-2 text-brand-600 max-sm:hidden [&_svg]:size-4">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-body font-medium text-text-secondary">{label}</span>
          {change && (
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap', change.good ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger')}>
              <span className="sr-only">vs previous period: </span>
              {change.label}
            </span>
          )}
        </div>
        <span className="pt-1.5 text-heading-24 break-words text-text-primary sm:text-heading-32">{value}</span>
        {hint && <span className="text-caption text-text-muted">{hint}</span>}
      </div>
      {spark && spark.length > 1 ? (
        <LineChart bare caption={`${label} trend`} labels={spark.map((_, i) => String(i + 1))} series={[{ name: label, values: spark, tone: sparkTone, area: true }]} height={56} className="mt-auto" />
      ) : (
        <div className="h-4" />
      )}
    </div>
  );
}

export function ReportCard({ title, description, action, children, className }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
          {description && <p className="text-caption text-text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function KpiSkeletons() {
  return (
    <div role="status" aria-label="Loading report" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <Skeleton className="h-4 w-2/3 rounded-full" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-3 w-3/4 rounded-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ height = 'h-64' }: { height?: string }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
      <Skeleton className="h-4 w-40 rounded-full" />
      <Skeleton className={cn('w-full', height)} />
    </div>
  );
}

/** Small stat used above charts ("Best day", "Weekend share"). */
export function MiniStat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'success' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-caption text-text-muted">{label}</span>
      <span className={cn('text-body font-semibold', tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary')}>{value}</span>
    </div>
  );
}
