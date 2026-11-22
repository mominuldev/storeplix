import { Check } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../lib/cn';

// Import products 60:10177 step header: card with 4 steps — 28px indicator (done = success check, current =
// brand-600 number, upcoming = surface-subtle), title Body/14 Medium, hint Caption; 2px connectors between steps
// (done = success, else border-default). Stacks vertically under md.
export type StepperState = 'done' | 'current' | 'upcoming';

export interface StepperStep {
  title: ReactNode;
  hint?: ReactNode;
  /** `danger` for "5 errors to fix" (Figma 60:10177). */
  hintTone?: 'muted' | 'danger';
  state: StepperState;
}

export function Stepper({ steps, className, label = 'Progress' }: { steps: StepperStep[]; className?: string; label?: string }) {
  return (
    <ol aria-label={label} className={cn('flex flex-col gap-3 md:flex-row md:items-center md:gap-4', className)}>
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <li aria-hidden className={cn('hidden h-0.5 min-w-6 flex-1 md:block', steps[i - 1]!.state === 'done' ? 'bg-success' : 'bg-border-default')} />}
          <li aria-current={s.state === 'current' ? 'step' : undefined} className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold',
                s.state === 'done' && 'bg-success text-text-inverse',
                s.state === 'current' && 'bg-brand-600 text-text-inverse',
                s.state === 'upcoming' && 'bg-surface-subtle text-text-muted',
              )}
            >
              {s.state === 'done' ? <Check aria-hidden strokeWidth={3} className="size-4" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={cn('truncate text-body font-medium', s.state === 'upcoming' ? 'text-text-muted' : 'text-text-primary')}>{s.title}</span>
              {s.hint && (
                <span className={cn('truncate text-caption', s.hintTone === 'danger' ? 'text-danger' : 'text-text-muted')}>
                  {s.hint}
                </span>
              )}
            </span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
