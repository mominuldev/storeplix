import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type StepState = 'done' | 'current' | 'upcoming';

// Figma Merchant Onboarding · Step 45:8034 — px 12, py 10, radius 10, gap 12, 28px indicator, title/hint gap 2.
export interface StepProps {
  index: number;
  title: ReactNode;
  hint?: ReactNode;
  state: StepState;
  className?: string;
}

export function Step({ index, title, hint, state, className }: StepProps) {
  return (
    <div
      aria-current={state === 'current' ? 'step' : undefined}
      className={cn('flex w-full items-center gap-3 rounded-control px-3 py-2.5', state === 'current' && 'bg-brand-50', className)}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-medium',
          state === 'done' && 'bg-brand-600 text-text-inverse',
          state === 'current' && 'border-2 border-brand-600 bg-surface-card text-brand-600',
          state === 'upcoming' && 'border border-border-default bg-surface-subtle text-text-muted',
        )}
      >
        {state === 'done' ? <Check aria-hidden className="size-4" /> : index}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            'truncate text-body',
            state === 'current' ? 'font-semibold text-text-primary' : 'font-medium',
            state === 'done' && 'text-text-secondary',
            state === 'upcoming' && 'text-text-muted',
          )}
        >
          {title}
        </span>
        {hint && (
          <span className={cn('truncate text-caption', state === 'current' ? 'text-text-secondary' : 'text-text-muted')}>{hint}</span>
        )}
      </span>
    </div>
  );
}

/** Figma onboarding progress bar — surface-subtle track, brand-600 fill. */
export function ProgressBar({ value, className, label }: { value: number; className?: string; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('h-1.5 overflow-hidden rounded-[3px] bg-surface-subtle', className)}
    >
      <div className="h-full rounded-[3px] bg-brand-600" style={{ width: `${pct}%` }} />
    </div>
  );
}
