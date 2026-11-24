import { Badge, cn, Menu, Skeleton, type BadgeTone, type MenuEntry } from '@storeplix/ui';
import { MoreHorizontal } from 'lucide-react';
import { useId, type ReactNode } from 'react';

// Figma 144:40726 shared pieces: card (radius 16, p 24, gap 16, Elevation/1) with a Body/16 Medium title + Body/14
// secondary description, bordered table (radius 12, surface-subtle header row, Caption/12 Medium muted heads, rows
// px 16 py 12 gap 16, border-t), Tag 39:4554 (= Badge size sm) and the 18px icon/more row menu.

export function DevCard({ title, description, action, children, gap = 'gap-4' }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; gap?: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn('flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', gap)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={headingId} className="text-body-lg font-medium text-text-primary">
            {title}
          </h2>
          {description && <p className="text-body text-text-secondary">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export type Column = { label: string; className?: string };

/** Bordered table that scrolls horizontally inside its card below its min width (Q137). */
export function DevTable({ label, columns, minWidth, children }: { label: string; columns: Column[]; minWidth: number; children: ReactNode }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-default">
      <table aria-label={label} className="w-full table-fixed border-collapse text-left" style={{ minWidth }}>
        <thead className="bg-surface-subtle">
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" className={cn('py-2.5 pr-4 text-caption font-medium whitespace-nowrap text-text-muted uppercase first:pl-4', c.className)}>
                {c.label || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const cellClass = 'border-t border-border-default py-3 pr-4 align-middle first:pl-4';

export function Tag({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <Badge size="sm" tone={tone}>
      {children}
    </Badge>
  );
}

/** First `max` tags + "+n" (Figma EVENTS / ACCESS columns). */
export function TagList({ items, max = 2, budget = 26 }: { items: { key: string; label: string; tone?: BadgeTone }[]; max?: number; budget?: number }) {
  // Keep tags whole (Figma "shipment.updated  +1"): a further tag only when the labels still fit the column.
  const shown: typeof items = [];
  let used = 0;
  for (const t of items) {
    if (shown.length >= max || (shown.length > 0 && used + t.label.length > budget)) break;
    shown.push(t);
    used += t.label.length;
  }
  const rest = items.length - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {shown.map((t) => (
        <Tag key={t.key} tone={t.tone}>
          {t.label}
        </Tag>
      ))}
      {rest > 0 && <Tag>{`+${rest}`}</Tag>}
    </div>
  );
}

export function RowMenu({ label, entries, disabled }: { label: string; entries: MenuEntry[]; disabled?: boolean }) {
  return <Menu label={label} trigger={<MoreHorizontal aria-hidden className="size-[18px]" />} entries={entries} disabled={disabled || entries.length === 0} align="end" triggerClassName="size-7" className="w-[220px]" />;
}

export function TableSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col overflow-hidden rounded-lg border border-border-default">
      <Skeleton className="h-9 rounded-none" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-t border-border-default px-4 py-3">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-2.5 w-3/5 rounded-full" />
            <Skeleton className="h-2.5 w-1/3 rounded-full" />
          </div>
          <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
          <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}
