import type { AnalyticsRange } from '@storeplix/types';
import { Card, cn, Skeleton } from '@storeplix/ui';
import { BarChart3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { PillTabs } from '../components/PillTabs';
import { Empty, ErrorState } from '../components/States';
import { rangeLabels, type Delta } from './format';

/** Figma StatusPill 31:6633 as a delta: success-bg/success (good) or danger-bg/danger, px 8 py 2, Caption/12 Medium. */
export function DeltaPill({ delta, className }: { delta: Delta | null | undefined; className?: string }) {
  if (!delta) return null;
  return (
    <span
      data-tone={delta.good ? 'good' : 'bad'}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap',
        delta.good ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger',
        className,
      )}
    >
      {delta.label}
    </span>
  );
}

/** Pill without a delta: M3 avg 39:18336 (success) and "27% trial → paid" (brand-50 / brand-700). */
export function InfoPill({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'brand' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap',
        tone === 'success' ? 'bg-success-bg text-success' : 'bg-brand-50 text-brand-700',
      )}
    >
      {children}
    </span>
  );
}

/** Range tabs 15:263 / 39:17083 on the PillTabs track. */
export function RangeTabs({ value, onChange, ranges }: { value: AnalyticsRange; onChange: (r: AnalyticsRange) => void; ranges: AnalyticsRange[] }) {
  return <PillTabs aria-label="Date range" value={value} onChange={onChange} items={ranges.map((r) => ({ value: r, label: rangeLabels[r] }))} />;
}

/**
 * KPI tiles. `dashboard` = Figma KPI/MRR 15:273 (label + delta pill on top, Heading/24 value, caption; px 20 py 22);
 * `report` = Revenue KPI 39:17099 (label, value + delta pill row, caption; px 18 py 20).
 */
export function KpiCard({
  label,
  value,
  caption,
  change,
  layout = 'dashboard',
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  change?: Delta | null;
  layout?: 'dashboard' | 'report';
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-card border border-border-default bg-surface-card shadow-elevation-1',
        layout === 'dashboard' ? 'px-4 py-[22px] 2xl:px-5' : 'px-4 py-5 2xl:px-[18px]',
      )}
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate text-body font-medium whitespace-nowrap text-text-secondary" title={label}>
          {label}
        </h3>
        {layout === 'dashboard' && <DeltaPill delta={change} />}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-heading-24 text-text-primary tabular-nums">{value}</span>
        {layout === 'report' && <DeltaPill delta={change} />}
      </div>
      {caption && <p className="text-caption text-text-muted">{caption}</p>}
    </section>
  );
}

export function KpiSkeletons({ count, label = 'Loading key numbers' }: { count: number; label?: string }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role={i === 0 ? 'status' : undefined}
          aria-label={i === 0 ? label : undefined}
          className="flex flex-col gap-2 rounded-card border border-border-default bg-surface-card px-5 py-[22px]"
        >
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </>
  );
}

/** Card with Body/16 Medium title + Caption subtitle (15:314 / 39:17141), actions on the right. */
export function ChartCard({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card aria-label={title} role="region" className={cn('flex min-w-0 flex-col gap-4 px-6 py-[22px]', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
          {subtitle && <p className="text-caption text-text-secondary">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className={cn('min-w-0', bodyClassName)}>{children}</div>
    </Card>
  );
}

export const NO_DATA_TITLE = 'No data yet';
export const NO_DATA_DESCRIPTION = 'Analytics are computed nightly.';

/** Figma States 148:34032 empty state for analytics ("No data yet — analytics are computed nightly"). */
export function NoAnalytics({ description = NO_DATA_DESCRIPTION }: { description?: string }) {
  return <Empty icon={<BarChart3 />} title={NO_DATA_TITLE} description={description} />;
}

/** Loading / error / empty switch for one widget's body. */
export function WidgetBody({
  loading,
  error,
  onRetry,
  empty,
  emptyDescription,
  skeletonHeight = 'h-56',
  loadingLabel,
  children,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: boolean;
  emptyDescription?: string;
  skeletonHeight?: string;
  loadingLabel: string;
  children: () => ReactNode;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading)
    return (
      <div role="status" aria-label={loadingLabel}>
        <Skeleton className={cn('w-full rounded-lg', skeletonHeight)} />
      </div>
    );
  if (empty) return <NoAnalytics description={emptyDescription} />;
  return <>{children()}</>;
}

/** Caption under the page header: "Data as of 22 Nov · updated 00:24" + optional history note. */
export function DataCaption({ asOf, history }: { asOf: string | null; history?: string | null }) {
  if (!asOf && !history) return null;
  return (
    <p className="text-caption text-text-muted" data-testid="analytics-as-of">
      {[asOf, history].filter(Boolean).join(' · ')}
    </p>
  );
}
