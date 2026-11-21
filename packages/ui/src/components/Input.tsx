import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Label } from './Label';

// Figma Components · Input 3:58 — stack gap 6; field min-h 44, px 12, py 8, radius md,
// surface-card, 1px border-default, Body/14; placeholder text-muted; optional 20px trailing icon.
// Focus/error/hint states are not drawn in Figma; derived from tokens.
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  trailing?: ReactNode;
  containerClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}

export function Input({ label, hint, error, trailing, id, className, containerClassName, ...props }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <div
        className={cn(
          'flex min-h-11 items-center gap-2 rounded-md border bg-surface-card px-3 transition-shadow',
          'focus-within:border-brand-600 focus-within:shadow-focus',
          error ? 'border-danger' : 'border-border-default',
        )}
      >
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full min-w-0 bg-transparent py-2 text-body text-text-primary outline-none placeholder:text-text-muted',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        />
        {trailing && <span className="flex shrink-0 items-center text-text-muted [&_svg]:size-5">{trailing}</span>}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-caption text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-caption text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
