import { Check } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

// Figma Merchant Onboarding · Chip 45:8043 — px 14, py 8, radius full, gap 6, Body/14 Medium.
// default: surface-card, 1px border-default, text-primary · selected: brand-50, 1.5px brand-600, Check 16, brand-700.
// `check={false}` = Components · Chip 39:4594 (settings language chips 64:15114): no check, selected 1px brand-600,
// unselected text-secondary.
export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  selected?: boolean;
  check?: boolean;
}

export function Chip({ selected = false, check = true, className, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-body font-medium outline-none transition-colors focus-visible:shadow-focus',
        selected
          ? cn('bg-brand-50 text-brand-700', check ? 'shadow-[inset_0_0_0_1.5px_var(--color-brand-600)]' : 'shadow-[inset_0_0_0_1px_var(--color-brand-600)]')
          : cn('bg-surface-card shadow-[inset_0_0_0_1px_var(--color-border-default)] hover:bg-surface-subtle', check ? 'text-text-primary' : 'text-text-secondary'),
        className,
      )}
      {...props}
    >
      {selected && check && <Check aria-hidden className="size-4 text-brand-600" />}
      {children}
    </button>
  );
}
