import { Check } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Merchant Onboarding L1/L4 checkbox — 18×18, radius 5, checked = brand-600 with 12px white check;
// label Body/14 text-secondary, gap 8. `size="sm"` = Online store V3 dialogs (2046:49428): 14px box,
// label Caption/12 Medium text-primary.
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: ReactNode;
  size?: 'md' | 'sm';
  ref?: React.Ref<HTMLInputElement>;
}

export function Checkbox({ label, id, className, size = 'md', ...props }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const sm = size === 'sm';
  return (
    <label
      htmlFor={inputId}
      className={cn('inline-flex cursor-pointer items-center gap-2', sm ? 'text-caption font-medium text-text-primary' : 'text-body text-text-secondary', className)}
    >
      <span className={cn('relative inline-flex shrink-0', sm ? 'size-3.5' : 'size-[18px]')}>
        <input
          id={inputId}
          type="checkbox"
          className={cn(
            'peer cursor-pointer appearance-none border border-border-strong bg-surface-card outline-none checked:border-brand-600 checked:bg-brand-600 focus-visible:shadow-focus disabled:opacity-50',
            sm ? 'size-3.5 rounded-[4px]' : 'size-[18px] rounded-[5px]',
          )}
          {...props}
        />
        <Check
          aria-hidden
          strokeWidth={3}
          className={cn('pointer-events-none absolute inset-0 m-auto text-text-inverse opacity-0 peer-checked:opacity-100', sm ? 'size-2.5' : 'size-3')}
        />
      </span>
      {label}
    </label>
  );
}
