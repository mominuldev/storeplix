import { Check, ChevronRight, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type ChecklistState = 'done' | 'todo' | 'locked';

// Figma Merchant Onboarding · Checklist item 45:8102 — px 16, py 14, gap 12, rounded-lg, 24px indicator.
// done 45:8087: surface-subtle, success check, Medium text-secondary title, "Done" · todo 45:8095: card + border,
// empty circle (1.5px border-strong), Semibold title, chevron. `locked` (later phase) is derived: muted + lock.
export interface ChecklistItemProps {
  title: ReactNode;
  hint?: ReactNode;
  state: ChecklistState;
  /** Shown instead of the chevron for locked items, e.g. "Coming soon". */
  lockedLabel?: ReactNode;
  onSelect?: () => void;
  className?: string;
}

export function ChecklistItem({ title, hint, state, lockedLabel = 'Coming soon', onSelect, className }: ChecklistItemProps) {
  const interactive = state === 'todo' && !!onSelect;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onSelect : undefined}
      aria-disabled={state === 'locked' || undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left',
        state === 'done' && 'bg-surface-subtle',
        state === 'todo' && 'border border-border-default bg-surface-card',
        state === 'locked' && 'border border-dashed border-border-default bg-surface-card opacity-70',
        interactive && 'outline-none hover:bg-surface-subtle focus-visible:shadow-focus',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          state === 'done' && 'bg-success text-text-inverse',
          state === 'todo' && 'border-[1.5px] border-border-strong bg-surface-card',
          state === 'locked' && 'bg-surface-subtle text-text-muted',
        )}
      >
        {state === 'done' && <Check aria-hidden className="size-3.5" />}
        {state === 'locked' && <Lock aria-hidden className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'text-body',
            state === 'done' && 'font-medium text-text-secondary',
            state === 'todo' && 'font-semibold text-text-primary',
            state === 'locked' && 'font-medium text-text-muted',
          )}
        >
          {title}
        </span>
        {hint && <span className="text-caption text-text-muted">{hint}</span>}
      </span>
      {state === 'done' && <span className="text-caption font-medium text-success">Done</span>}
      {state === 'todo' && <ChevronRight aria-hidden className="size-[18px] text-text-muted" />}
      {state === 'locked' && <span className="text-caption font-medium text-text-muted">{lockedLabel}</span>}
    </Tag>
  );
}
