import { cn, type TabItem } from '@storeplix/ui';

// Figma Platform / Merchants 32:5667 (also Billing 34:859 and Team 39:12019 list tabs): surface-subtle track,
// p 3, gap 2, radius 10; tabs px 12 py 6, radius 8, gap 6, Body/14 Medium text-secondary; active = surface-card +
// elevation-1, Body/14 Semibold text-primary. Count pill px 7 py 1, Caption/12 Medium: brand-50/brand-700 on the
// active tab, surface-card/text-secondary otherwise. Scrolls inside its own track when the row is narrow.
export function PillTabs<T extends string>({
  items,
  value,
  onChange,
  className,
  ...aria
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={aria['aria-label']}
      className={cn('flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-[10px] bg-surface-subtle p-[3px]', className)}
    >
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
              'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-body whitespace-nowrap outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
              active ? 'bg-surface-card font-semibold text-text-primary shadow-elevation-1' : 'font-medium text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span
                className={cn(
                  'rounded-full px-[7px] py-px text-caption font-medium',
                  active ? 'bg-brand-50 text-brand-700' : 'bg-surface-card text-text-secondary',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
