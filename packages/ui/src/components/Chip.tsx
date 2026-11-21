import { Check } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

// Figma Merchant Onboarding · Chip 45:8043 — px 14, py 8, radius full, gap 6, Body/14 Medium.
// default: surface-card, 1px border-default, text-primary · selected: brand-50, 1.5px brand-600, Check 16, brand-700.
export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  selected?: boolean;
}

export function Chip({ selected = false, className, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-body font-medium outline-none transition-colors focus-visible:shadow-focus',
        selected
          ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]'
          : 'bg-surface-card text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)] hover:bg-surface-subtle',
        className,
      )}
      {...props}
    >
      {selected && <Check aria-hidden className="size-4 text-brand-600" />}
      {children}
    </button>
  );
}
