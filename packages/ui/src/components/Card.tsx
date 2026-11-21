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
