import { cn } from '../lib/cn';

const sizes = { sm: 'size-8 text-caption', md: 'size-9 text-caption', lg: 'size-16 text-heading' } as const;

export function initialsOf(name: string | null | undefined, fallback = '?'): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || fallback;
}

// Figma TopBar avatar (36, brand-100/brand-700) · Account profile avatar (64, brand-100/brand-600).
export function Avatar({ name, size = 'md', className }: { name: string | null | undefined; size?: keyof typeof sizes; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-medium text-brand-700',
        size === 'lg' && 'font-semibold text-brand-600',
        sizes[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
