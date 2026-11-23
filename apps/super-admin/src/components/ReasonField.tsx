import { Label, cn } from '@storeplix/ui';
import { useId, type TextareaHTMLAttributes } from 'react';

// Change plan 45:4989 "Internal reason · Required" — textarea (radius md, border-default, px 14 py 12, Body/14),
// hint "Visible to platform staff only · saved to the audit log".
export interface ReasonFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function ReasonField({
  label = 'Internal reason',
  error,
  hint = 'Visible to platform staff only · saved to the audit log',
  id,
  className,
  ...props
}: ReasonFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>
        {label} <span className="font-medium text-danger">Required</span>
      </Label>
      <textarea
        id={fieldId}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${fieldId}-help`}
        className={cn(
          'min-h-[76px] w-full resize-y rounded-md border bg-surface-card px-3.5 py-3 text-body text-text-primary outline-none placeholder:text-text-muted',
          'focus:border-brand-600 focus:shadow-[inset_0_0_0_1px_var(--color-brand-600),var(--shadow-focus)]',
          error ? 'border-danger' : 'border-border-default',
          className,
        )}
        {...props}
      />
      <p id={`${fieldId}-help`} className={cn('text-caption', error ? 'text-danger' : 'text-text-muted')}>
        {error ?? hint}
      </p>
    </div>
  );
}
