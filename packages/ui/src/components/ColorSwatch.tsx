import { Check } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

// Figma Onboarding 04 "Make it yours" 48:8119 (lg) / V3 Design tab colours 2050:49660 (sm, md) — round swatch;
// sm/md selected = 2px brand-600 ring with a 3px card gap and a white check. `color` is data (merchant/theme value),
// applied as an inline style; only `#rrggbb` reaches the DOM.
export interface ColorSwatchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'color'> {
  color: string;
  label: string;
  selected?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const sizes = { sm: 'size-6', md: 'size-7', lg: 'size-10' } as const;

/** Relative luminance (WCAG 2.x) for a #rrggbb colour. */
export function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 1;
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

export function ColorSwatch({ color, label, selected = false, size = 'lg', className, ...props }: ColorSwatchProps) {
  const safe = HEX.test(color) ? color : '#ffffff';
  const darkCheck = luminance(safe) > 0.6;
  // Very light colours get a hairline so they don't vanish on the card (not drawn in Figma; derived).
  const hairline = luminance(safe) > 0.85;
  const check = selected && <Check aria-hidden strokeWidth={3} className={cn('size-4', darkCheck ? 'text-text-primary' : 'text-text-inverse')} />;

  if (size === 'lg') {
    // Figma Swatches 48:8283 — 40px box; unselected = 36px disc inset 2px; selected = 2px brand-600 ring
    // around a 30px disc with a 16px check.
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        className={cn(
          'relative inline-flex size-10 shrink-0 items-center justify-center rounded-full outline-none transition-shadow focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
          selected && 'border-2 border-brand-600',
          className,
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn('flex items-center justify-center rounded-full', selected ? 'size-[30px]' : 'size-9', hairline && 'border border-border-default')}
          style={{ backgroundColor: safe }}
        >
          {check}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full border border-border-default outline-none transition-shadow focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
        sizes[size],
        selected && 'shadow-[0_0_0_3px_var(--color-surface-card),0_0_0_5px_var(--color-brand-600)]',
        className,
      )}
      style={{ backgroundColor: safe }}
      {...props}
    >
      {check}
    </button>
  );
}
