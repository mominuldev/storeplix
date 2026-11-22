import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Order detail 33:3676 Timeline: 32px tinted icon square, title Body/14 Medium, caption detail, time right.
export interface TimelineEntry {
  id: string;
  icon?: ReactNode;
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral';
  title: ReactNode;
  detail?: ReactNode;
  time?: ReactNode;
}

const tones = {
  brand: 'bg-brand-50 text-brand-600',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  neutral: 'bg-surface-subtle text-text-secondary',
} as const;

export function Timeline({ items, label = 'Timeline', className }: { items: TimelineEntry[]; label?: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn('flex flex-col', className)}>
      {items.map((e, i) => (
        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
          {i < items.length - 1 && <span aria-hidden className="absolute top-9 bottom-0 left-4 w-px bg-border-default" />}
          <span className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-control [&_svg]:size-4', tones[e.tone ?? 'neutral'])}>{e.icon}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
            <span className="text-body font-medium text-text-primary">{e.title}</span>
            {e.detail && <span className="text-caption break-words whitespace-pre-line text-text-muted">{e.detail}</span>}
          </div>
          {e.time && <span className="shrink-0 pt-1 text-caption text-text-muted">{e.time}</span>}
        </li>
      ))}
    </ol>
  );
}
