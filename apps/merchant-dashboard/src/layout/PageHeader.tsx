import type { ReactNode } from 'react';

// Figma page header 10:782 — Heading/24 title, 4px gap, Body/14 text-secondary subtitle; actions right.
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-heading-24 text-text-primary">{title}</h1>
        {subtitle && <p className="text-body text-text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </div>
  );
}
