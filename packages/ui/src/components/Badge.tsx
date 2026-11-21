import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

// Figma Components · Pill 39:9438 / StatusBadge 3:44 — h 22, px 10, py 3, gap 6, radius full,
// Caption/12 Medium, optional 6px dot in the text colour.
const tones = {
  neutral: 'bg-surface-subtle text-text-secondary',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  brand: 'bg-brand-50 text-brand-700',
} as const;

export type BadgeTone = keyof typeof tones;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({ tone = 'neutral', dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 py-[3px] text-caption font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Maps API status strings to Figma tones. */
export const storeStatusTone: Record<'draft' | 'active' | 'suspended', BadgeTone> = {
  draft: 'neutral',
  active: 'success',
  suspended: 'danger',
};
