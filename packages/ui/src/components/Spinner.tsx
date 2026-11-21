import { cn } from '../lib/cn';

const sizes = { sm: 'size-4 border-2', md: 'size-5 border-2', lg: 'size-8 border-[3px]' } as const;

export interface SpinnerProps {
  size?: keyof typeof sizes;
  /** Accessible label; announced by screen readers. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)}>
      <span
        aria-hidden
        className={cn('animate-spin rounded-full border-current border-r-transparent text-brand-600', sizes[size])}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
