import { Check } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Merchant Onboarding L1/L4 checkbox — 18×18, radius 5, checked = brand-600 with 12px white check;
// label Body/14 text-secondary, gap 8.
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  ref?: React.Ref<HTMLInputElement>;
}

export function Checkbox({ label, id, className, ...props }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className={cn('inline-flex cursor-pointer items-center gap-2 text-body text-text-secondary', className)}>
      <span className="relative inline-flex size-[18px] shrink-0">
        <input
          id={inputId}
          type="checkbox"
          className="peer size-[18px] cursor-pointer appearance-none rounded-[5px] border border-border-strong bg-surface-card outline-none checked:border-brand-600 checked:bg-brand-600 focus-visible:shadow-focus disabled:opacity-50"
          {...props}
        />
        <Check
          aria-hidden
          strokeWidth={3}
          className="pointer-events-none absolute inset-0 m-auto size-3 text-text-inverse opacity-0 peer-checked:opacity-100"
        />
      </span>
      {label}
    </label>
  );
}
