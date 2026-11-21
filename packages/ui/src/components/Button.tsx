import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Spinner } from './Spinner';

// Figma Components · Button 3:19 — variant=primary|secondary|ghost|danger × size=md|sm.
// Hover/focus/disabled are not drawn in Figma; derived from tokens (focus ring = shadow-focus).
const variants = {
  primary: 'bg-brand-600 text-text-inverse hover:bg-brand-700',
  secondary: 'border border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
  ghost: 'bg-transparent text-brand-600 hover:bg-brand-50',
  danger: 'bg-danger text-text-inverse hover:opacity-90',
} as const;

const sizes = {
  md: 'min-h-10 px-4 py-2 text-body font-semibold gap-2',
  sm: 'min-h-8 px-3 py-1 text-caption font-medium gap-1.5',
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export function buttonVariants({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}) {
  return cn(
    'inline-flex items-center justify-center rounded-md whitespace-nowrap transition-colors',
    'outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    fullWidth && 'w-full',
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  variant,
  size,
  fullWidth,
  loading = false,
  leftIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonVariants({ variant, size, fullWidth, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" label="Please wait" className="text-current [&>span:first-child]:text-current" /> : leftIcon}
      {children}
    </button>
  );
}
