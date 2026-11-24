import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma Components · ChoiceCard 39:4640 — selectable option row (delivery zone, payment method, campaign channel):
// px 16, py 14, gap 12, radius 12; 20px radio; title Body/14 Semibold, detail Caption/12 text-secondary, value
// Body/14 Semibold on the right. default = 1px border-default on surface-card; selected = 2px brand-600 on brand-50
// (padding trimmed by 1px so the row doesn't move).
export interface ChoiceCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'title'> {
  name: string;
  value: string;
  title: ReactNode;
  detail?: ReactNode;
  /** Right-hand value (Figma "৳ 70"). */
  aside?: ReactNode;
  className?: string;
}

export function ChoiceCard({ title, detail, aside, checked, disabled, className, ...input }: ChoiceCardProps) {
  return (
    <label
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-lg',
        checked ? 'border-2 border-brand-600 bg-brand-50 px-[15px] py-[13px]' : 'border border-border-default bg-surface-card px-4 py-3.5',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        'has-[:focus-visible]:shadow-focus',
        className,
      )}
    >
      <input type="radio" checked={checked} disabled={disabled} className="size-5 shrink-0 accent-brand-600 outline-none" {...input} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        {detail && <span className="text-caption text-text-secondary">{detail}</span>}
      </span>
      {aside !== undefined && aside !== null && <span className="shrink-0 text-body font-semibold whitespace-nowrap text-text-primary">{aside}</span>}
    </label>
  );
}
