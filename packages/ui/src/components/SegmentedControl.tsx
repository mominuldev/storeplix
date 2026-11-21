import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Merchant Onboarding L1 "Sign-in method" — surface-subtle track, rounded-lg, p 4, gap 4;
// equal tabs py 9, radius 9; active = surface-card + elevation-1, Body/14 Semibold text-primary;
// inactive = Body/14 Medium text-secondary.
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  'aria-label': string;
  className?: string;
  /** `sm` = Online store V3 compact track (Figma 2045:48344): p 3, radius 10, 13px labels. */
  size?: 'md' | 'sm';
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({ value, onChange, options, className, size = 'md', disabled, ...aria }: SegmentedControlProps<T>) {
  const sm = size === 'sm';
  return (
    <div
      role="tablist"
      aria-label={aria['aria-label']}
      className={cn('flex rounded-lg bg-surface-subtle', sm ? 'gap-0.5 rounded-control p-[3px]' : 'gap-1 p-1', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60',
              sm ? 'rounded-md px-3 py-[5px] text-[13px] leading-[18px] whitespace-nowrap' : 'rounded-[9px] py-[9px] text-body',
              active ? 'bg-surface-card font-semibold text-text-primary shadow-elevation-1' : 'font-medium text-text-secondary',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
