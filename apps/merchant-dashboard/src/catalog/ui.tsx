import type { MediaRef, ProductStatus } from '@storeplix/types';
import { Badge, cn } from '@storeplix/ui';
import { ChevronDown, Package, Search, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ReactNode, type SelectHTMLAttributes } from 'react';

// Small shared pieces for the Phase 4 catalog screens (Products 60:8986 toolbar, Inventory 11:743, Customers 63:14974).

const MOBILE_QUERY = '(max-width: 767px)';

/** True under `md` (Figma mobile layouts, contract §9.3). False when matchMedia is unavailable (tests). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(MOBILE_QUERY);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia(MOBILE_QUERY).matches : false),
    () => false,
  );
}

/** Debounced copy of a value (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function mediaThumbUrl(m: MediaRef | null | undefined): string | null {
  return m?.url ?? null;
}

/** Product photo (radius 10, 44px in tables, 64 on mobile cards); package icon when there's no photo. */
export function Thumb({ src, size = 44, className, alt = '' }: { src: string | null | undefined; size?: number; className?: string; alt?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface-subtle text-text-muted', className)} style={{ width: size, height: size }}>
      {src ? <img src={src} alt={alt} loading="lazy" className="size-full object-cover" /> : <Package aria-hidden className="size-1/2 max-h-5 max-w-5" />}
    </span>
  );
}

const statusMeta: Record<ProductStatus, { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  active: { label: 'Active', tone: 'success' },
  draft: { label: 'Draft', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const m = statusMeta[status];
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

/** Toolbar search (60:11452): surface-subtle, h 38, radius md, 24px icon/search (stroke 2, text-muted). */
export function SearchBox({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <label className={cn('flex h-[38px] min-w-0 items-center gap-2 rounded-md bg-surface-subtle px-3 focus-within:shadow-focus', className)}>
      <Search aria-hidden className="size-6 shrink-0 text-text-muted" />
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="text-text-muted hover:text-text-primary">
          <X aria-hidden className="size-4" />
        </button>
      )}
    </label>
  );
}

/** Toolbar dropdown (60:11463): card, border-default, radius md, px 12 py 9, Body/14 Medium + 14px chevron. */
export function FilterSelect({ label, className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <select
        aria-label={label}
        {...props}
        className="h-[38px] w-full appearance-none rounded-md border border-border-default bg-surface-card pr-8 pl-3 text-body font-medium text-text-primary outline-none focus-visible:shadow-focus"
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-muted" />
    </span>
  );
}

/** Two-line table cell (Body/14 + Caption muted). */
export function Cell2({ top, bottom, topClass, bottomClass }: { top: ReactNode; bottom?: ReactNode; topClass?: string; bottomClass?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn('truncate text-body font-semibold text-text-primary', topClass)}>{top}</span>
      {bottom !== undefined && bottom !== null && bottom !== '' && <span className={cn('truncate text-caption text-text-muted', bottomClass)}>{bottom}</span>}
    </span>
  );
}

/** Icon button 39:9458 — 32px square, card + border-default, 16px icon. */
export const iconButton =
  'flex size-8 shrink-0 items-center justify-center rounded-md border border-border-default bg-surface-card text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus [&_svg]:size-4';

/**
 * Catalog form card (Product editor 61:13088 / right rail 62:12901, Import 60:10177): card + border-default + Elevation/1,
 * radius 16, gap 16, padding 24 (20 with `compact`, right-rail cards). Header: Body/16 Medium title, Caption muted description
 * (2px gap), actions on the right.
 */
export function CatalogPanel({
  title,
  description,
  actions,
  children,
  className,
  compact = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <section className={cn('flex flex-col gap-4 rounded-card border border-border-default bg-surface-card shadow-elevation-1', compact ? 'p-5' : 'p-4 sm:p-6', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>}
            {description && <p className="text-caption text-text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** StatTile 3:81 (Inventory 11:812): card px 20 py 16, gap 6 — Body/14 secondary label, Heading/24 value, Caption muted hint. */
export function StatTile({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-card border border-border-default bg-surface-card px-5 py-4 shadow-elevation-1', className)}>
      <span className="truncate text-body text-text-secondary">{label}</span>
      <span className="truncate text-heading-24 text-text-primary">{value}</span>
      {hint && <span className="truncate text-caption text-text-muted">{hint}</span>}
    </div>
  );
}
