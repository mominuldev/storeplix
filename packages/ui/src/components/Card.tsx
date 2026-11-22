import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

// Foundations 128:221: "card · 16 — Cards and sheets", Elevation/1 = "Cards, tables, sheets — the default".
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-border-default bg-surface-card shadow-elevation-1', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-6 pt-6', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-text-primary">{title}</h2>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6', className)} {...props} />;
}

// Figma Components · StatTile 3:81 — px 20, py 16, gap 6, radius lg, border-default, no shadow.
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-lg border border-border-default bg-surface-card px-5 py-4', className)}>
      <span className="text-body text-text-secondary">{label}</span>
      <span className="text-heading-24 text-text-primary">{value}</span>
      {hint && <span className="text-caption text-text-muted">{hint}</span>}
    </div>
  );
}

// Figma KPI tile 39:9401 (Products 60:11401, Customers 63:14974): card radius 16, px 20, py 18, gap 8; head =
// 28px brand-50 icon tile (radius 8, 16px icon brand-600) + Body/14 Medium secondary label; Heading/24 value;
// Caption muted supporting line.
export function KpiTile({
  icon,
  label,
  value,
  hint,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 rounded-card border border-border-default bg-surface-card px-5 py-[18px] shadow-elevation-1', className)}>
      <div className="flex items-center gap-2.5">
        {icon && <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600 [&_svg]:size-4">{icon}</span>}
        <span className="truncate text-body font-medium text-text-secondary">{label}</span>
      </div>
      <span className="text-heading-24 text-text-primary">{value}</span>
      {hint && <span className="text-caption text-text-muted">{hint}</span>}
    </div>
  );
}
