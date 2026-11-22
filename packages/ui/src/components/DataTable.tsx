import { Check, Minus } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';

// Products table 60:11450 (Figma): header row surface-subtle, Caption/12 Medium muted UPPERCASE labels, px 16 py 10,
// gap 12; rows px 16 py 12 + border-b (row height follows content: 44px thumb → 69, 40px photo → 65), selected rows brand-50; 20px checkbox (radius 6, border-strong 1.5 /
// brand-600 checked). Bulk bar (60:11481): brand-50, "N selected" Body/14 Semibold brand-600, small buttons.
// Orders table head 7:509 uses `columnGap={16}` + `headTone="canvas"` (surface-canvas). Under `md` every row stacks as label/value pairs (contract §9.3); one DOM, so tests and a11y see one table.
export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  /** Fixed width on md+ (px). Omit for the flexible column. */
  width?: number;
  align?: 'start' | 'end' | 'center';
  cell: (row: T) => ReactNode;
  /** Label shown on stacked (mobile) rows; defaults to `header`. `false` hides the label (e.g. the main cell). */
  mobileLabel?: ReactNode | false;
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  label: string;
  /** Selection is enabled when `selected` and `onSelectedChange` are passed. */
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  /** Rendered in the bulk bar while ≥ 1 row is selected. */
  bulkActions?: ReactNode;
  rowLabel?: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Replaces the body (loading, empty, error states keep the header). */
  state?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Column gap on md+ (Products 60:11450 = 12, Orders 7:509 = 16). */
  columnGap?: 12 | 16;
  /** Header fill: `subtle` (Products 60:11450) or `canvas` (Orders 7:509). */
  headTone?: 'subtle' | 'canvas';
}

function Box({ checked, indeterminate, label, onChange }: { checked: boolean; indeterminate?: boolean; label: string; onChange: () => void }) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:shadow-focus',
        on ? 'bg-brand-600 text-text-inverse' : 'border-[1.5px] border-border-strong bg-surface-card',
      )}
    >
      {indeterminate ? <Minus aria-hidden strokeWidth={3} className="size-3.5" /> : checked ? <Check aria-hidden strokeWidth={3} className="size-3.5" /> : null}
    </button>
  );
}

const alignClass = { start: 'md:text-left md:justify-start', end: 'md:text-right md:justify-end', center: 'md:text-center md:justify-center' } as const;
// Mobile stacks cells as "label … value" with the value right-aligned; from md the value follows the column's align.
// (`md:text-[inherit]` was read by Tailwind as a colour, so text-right leaked to desktop — QA F-L5.)
const valueAlignClass = { start: 'md:text-left', end: 'md:text-right', center: 'md:text-center' } as const;

function widthStyle(width?: number): CSSProperties | undefined {
  return width ? ({ '--col-w': `${width}px` } as CSSProperties) : undefined;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  label,
  selected,
  onSelectedChange,
  bulkActions,
  rowLabel,
  onRowClick,
  rowClassName,
  state,
  toolbar,
  footer,
  className,
  columnGap = 12,
  headTone = 'subtle',
}: DataTableProps<T>) {
  const gapClass = columnGap === 16 ? 'md:gap-4' : 'md:gap-3';
  const selectable = !!selected && !!onSelectedChange;
  const ids = rows.map(getRowId);
  const selectedOnPage = selectable ? ids.filter((id) => selected.includes(id)) : [];
  const allOn = ids.length > 0 && selectedOnPage.length === ids.length;
  const someOn = selectedOnPage.length > 0 && !allOn;

  const toggleAll = () => {
    if (!onSelectedChange || !selected) return;
    onSelectedChange(allOn ? selected.filter((id) => !ids.includes(id)) : Array.from(new Set([...selected, ...ids])));
  };
  const toggle = (id: string) => {
    if (!onSelectedChange || !selected) return;
    onSelectedChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const cellClass = (c: DataTableColumn<T>) =>
    cn(
      'flex min-w-0 items-center justify-between gap-3 md:block',
      c.width ? 'md:w-(--col-w) md:shrink-0' : 'md:min-w-0 md:flex-1',
      alignClass[c.align ?? 'start'],
      c.hideOnMobile && 'hidden md:block',
    );

  return (
    <div className={cn('overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1', className)}>
      {toolbar}
      {selectable && selected.length > 0 && (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 border-b border-border-default bg-brand-50 px-4 py-2.5">
          <Box checked={allOn} indeterminate={someOn} label="Select all on this page" onChange={toggleAll} />
          <span className="min-w-0 flex-1 text-body font-semibold text-brand-600">{selected.length} selected</span>
          {bulkActions}
          <Button variant="ghost" size="sm" onClick={() => onSelectedChange([])}>
            Clear
          </Button>
        </div>
      )}
      <div role="table" aria-label={label} aria-rowcount={rows.length + 1}>
        <div role="rowgroup">
          <div
            role="row"
            className={cn('hidden items-center border-b border-border-default px-4 py-2.5 md:flex', gapClass, headTone === 'canvas' ? 'bg-surface-canvas' : 'bg-surface-subtle')}
          >
            {selectable && (
              <span role="columnheader" className="flex">
                <Box checked={allOn} indeterminate={someOn} label="Select all" onChange={toggleAll} />
              </span>
            )}
            {columns.map((c) => (
              <span
                key={c.key}
                role="columnheader"
                style={widthStyle(c.width)}
                className={cn('text-caption font-medium tracking-[0.02em] text-text-muted uppercase', c.width ? 'w-(--col-w) shrink-0' : 'min-w-0 flex-1', alignClass[c.align ?? 'start'])}
              >
                {c.header}
              </span>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {state ??
            rows.map((row) => {
              const id = getRowId(row);
              const isOn = selectable && selected.includes(id);
              return (
                <div
                  key={id}
                  role="row"
                  aria-selected={selectable ? isOn : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'relative flex flex-col gap-2 border-b border-border-default px-4 py-3 last:border-b-0 md:flex-row md:items-center',
                    gapClass,
                    isOn && 'bg-brand-50',
                    onRowClick && 'cursor-pointer hover:bg-surface-subtle',
                    rowClassName?.(row),
                  )}
                >
                  {selectable && (
                    <span role="cell" className="absolute top-3.5 right-4 md:static">
                      <Box checked={isOn} label={`Select ${rowLabel?.(row) ?? id}`} onChange={() => toggle(id)} />
                    </span>
                  )}
                  {columns.map((c) => (
                    <div key={c.key} role="cell" style={widthStyle(c.width)} className={cellClass(c)}>
                      {c.mobileLabel !== false && <span className="text-caption text-text-muted md:hidden">{c.mobileLabel ?? c.header}</span>}
                      <div className={cn('min-w-0', c.mobileLabel === false ? 'flex-1' : cn('text-right', valueAlignClass[c.align ?? 'start']))}>{c.cell(row)}</div>
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      </div>
      {footer}
    </div>
  );
}

/** Table footer 60:11798: "Showing a–b of n {noun}" + Previous / Next (small secondary buttons). */
export function Pagination({
  page,
  perPage,
  total,
  lastPage,
  noun = 'items',
  onPage,
  className,
}: {
  page: number;
  perPage: number;
  total: number;
  lastPage: number;
  noun?: string;
  onPage: (page: number) => void;
  className?: string;
}) {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <div className={cn('flex items-center gap-2 border-t border-border-default px-4 py-3', className)}>
      <p className="min-w-0 flex-1 text-caption text-text-secondary">
        Showing {from}–{to} of {total} {noun}
      </p>
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}
