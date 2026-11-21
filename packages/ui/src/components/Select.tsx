import { ChevronDown } from 'lucide-react';
import { useId, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Label } from './Label';

// Figma Field / Select 39:4614 — h 44, pl 14, pr 12, radius 10, surface-card, border-default, 18px chevron.
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
  ref?: React.Ref<HTMLSelectElement>;
}

export function Select({ label, hint, error, id, className, containerClassName, children, ...props }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      {label && <Label htmlFor={selectId}>{label}</Label>}
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-11 w-full appearance-none rounded-control border bg-surface-card pr-10 pl-3.5 text-body text-text-primary outline-none',
            'focus:border-brand-600 focus:shadow-[inset_0_0_0_1px_var(--color-brand-600),var(--shadow-focus)] disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-text-muted',
            error ? 'border-danger' : 'border-border-default',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-[18px] -translate-y-1/2 text-text-muted" />
      </div>
      {error ? (
        <p id={`${selectId}-error`} className="text-caption text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${selectId}-hint`} className="text-caption text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
