import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Components · Tab 39:9419 (state=default|active) — px 12, py 10, gap 6, Body/14 Medium text-secondary;
// active = 2px brand-600 underline, Body/14 Semibold brand-700, count pill brand-600/white. The track has a
// 1px border-default bottom rule (Products 60:11384, Inventory 11:743, Customers 63:14974).
export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number | string | null;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  className?: string;
}

export function Tabs<T extends string>({ items, value, onChange, className, ...aria }: TabsProps<T>) {
  return (
    <div role="tablist" aria-label={aria['aria-label']} className={cn('-mx-4 flex gap-1 overflow-x-auto border-b border-border-default px-4 lg:mx-0 lg:px-0', className)}>
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 px-3 text-body whitespace-nowrap outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
              active ? 'border-b-2 border-brand-600 pt-2.5 pb-2 font-semibold text-brand-700' : 'py-2.5 font-medium text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className={cn('rounded-full px-[7px] py-px text-caption font-medium', active ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-secondary')}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
