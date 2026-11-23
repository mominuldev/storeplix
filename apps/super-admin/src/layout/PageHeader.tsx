import type { ReactNode } from 'react';

// Figma page header 10:782 / Platform Dashboard 15:259 — Heading/24 title, 4px gap, Body/14 text-secondary
// subtitle; actions right, vertically centred, gap 12.
// `stackActions`: wide action rows (Revenue reports tabs + compare toggle) sit under the title until xl.
export function PageHeader({
  title,
  subtitle,
  actions,
  stackActions = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  stackActions?: boolean;
}) {
  return (
    <div
      className={
        stackActions
          ? 'flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between'
          : 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-heading-24 text-text-primary">{title}</h1>
        {subtitle && <p className="text-body text-text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className={stackActions ? 'flex min-w-0 flex-wrap items-center gap-3' : 'flex shrink-0 items-center gap-3'}>{actions}</div>}
    </div>
  );
}
