import Link from 'next/link';
import type { ReactNode } from 'react';

type Variant = 'primary' | 'outline' | 'accent' | 'inverse';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:brightness-110',
  outline: 'border-[1.5px] border-ink text-ink hover:bg-ink/5',
  // Figma Button "Accent" (promotions) and "Inverse" (on dark/brand surfaces).
  accent: 'bg-accent text-on-accent hover:brightness-105',
  inverse: 'bg-surface text-[#0e1a33] hover:bg-sunken',
};

interface ButtonLinkProps {
  href: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}

/** Figma "Button" (1:9455): pill, Label/M, 28px x 16px padding. */
export function ButtonLink({ href, variant = 'primary', className = '', children }: ButtonLinkProps) {
  return (
    <Link
      href={href}
      className={`type-label-m inline-flex items-center justify-center gap-2 rounded-control px-7 py-4 whitespace-nowrap transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
