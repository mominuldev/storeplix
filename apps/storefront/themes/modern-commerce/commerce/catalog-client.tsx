'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { loadMoreProducts } from '@/app/actions/commerce';
import type { ProductCardView } from '@/lib/products';
import { ProductCard } from '../components/product-card';
import { Icon } from '../components/icon';

/**
 * Sort pill (Figma 1:10862 desktop "Sort: Most popular ⌄", 1:10969 mobile half-width "Most popular ⌄").
 * Navigates to a server-built href (no client-side query building).
 */
export function SortSelect({ value, options }: { value: string; options: Array<{ value: string; label: string; href: string }> }) {
  const router = useRouter();
  return (
    <label className="relative flex h-[45px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-ink lg:h-[43px] lg:flex-none">
      <span className="type-body-s hidden text-ink-muted lg:inline">Sort:</span>
      <span className="sr-only lg:hidden">Sort</span>
      <select
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) router.push(next.href);
        }}
        className="type-label-m lg:type-label-s min-w-0 cursor-pointer appearance-none bg-transparent text-ink outline-none [field-sizing:content]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="caret-down" size={16} className="pointer-events-none text-ink lg:hidden" />
      <Icon name="caret-down" size={14} className="pointer-events-none hidden text-ink-muted lg:inline-block" />
    </label>
  );
}

interface LayoutProps {
  variant: 'plp' | 'search';
  activeCount: number;
  /** Desktop toolbar, left side (Filters + active chips, or "Filter by" dropdowns). */
  desktopLeft: ReactNode;
  /** Toolbar right side (result count + sort). */
  right: ReactNode;
  /** Phones: active filter chips under the toolbar. */
  mobileChips: ReactNode;
  /** The server-rendered GET filter form (sidebar on PLP desktop, toggle panel on phones). */
  filters: ReactNode;
  children: ReactNode;
}

/**
 * Toolbar + filters + results (Figma 1:10845 / 1:10965 / 1:12462). The filter form is server-rendered;
 * this only owns the phone "Filter (n)" toggle.
 */
export function CatalogLayout({ variant, activeCount, desktopLeft, right, mobileChips, filters, children }: LayoutProps) {
  const [open, setOpen] = useState(false);
  const panel = (
    <div id="plp-filters" className={`${open ? 'block pb-4 lg:pb-0' : 'hidden'} ${variant === 'plp' ? 'lg:block' : 'lg:hidden'}`}>
      {filters}
    </div>
  );
  return (
    <div className="flex flex-col">
      <div className={`flex items-center gap-2.5 border-y border-line bg-canvas px-4 py-2.5 lg:justify-between lg:gap-6 lg:px-20 ${variant === 'search' ? 'lg:py-3.5' : 'lg:py-4'}`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="plp-filters"
          onClick={() => setOpen((o) => !o)}
          className="type-label-m flex h-[43px] min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-inverse px-4 text-paper lg:hidden"
        >
          <Icon name="sliders" />
          Filter{activeCount ? ` (${activeCount})` : ''}
        </button>
        <div className="hidden min-w-0 lg:flex">{desktopLeft}</div>
        {right}
      </div>
      {mobileChips}
      <div className="flex flex-col px-4 pt-4 lg:flex-row lg:gap-10 lg:px-20 lg:pt-8">
        {variant === 'plp' ? (
          <aside className="lg:w-[272px] lg:shrink-0" aria-label="Filters">
            {panel}
          </aside>
        ) : (
          <aside className="lg:hidden" aria-label="Filters">
            {panel}
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

interface GridProps {
  variant: 'plp' | 'search';
  initial: ProductCardView[];
  page: number;
  lastPage: number;
  total: number;
  /** Products before the first one shown (from earlier pages). */
  offset: number;
  scope: { category: string } | { q: string };
  params: Record<string, string>;
  perPage: number;
  /** Numbered pages, shown under Load more (desktop PLP). */
  pagination?: ReactNode;
}

/**
 * Card grid + "You've seen N of M" / "Load N more" (Figma 1:10939, 1:10990, search 1:12494).
 * Appends the next page client-side via a read-only action.
 */
export function ProductGrid({ variant, initial, page, lastPage, total, offset, scope, params, perPage, pagination }: GridProps) {
  const [cards, setCards] = useState(initial);
  const [current, setCurrent] = useState(page);
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  const more = () =>
    start(async () => {
      const r = await loadMoreProducts({ scope, params: { ...params, page: String(current + 1) } });
      if (r.products.length === 0) {
        setFailed(true);
        return;
      }
      setCards((c) => [...c, ...r.products.filter((p) => !c.some((x) => x.id === p.id))]);
      setCurrent(r.page);
    });

  const seen = Math.min(total, offset + cards.length);
  const pct = total > 0 ? Math.round((seen / total) * 100) : 0;
  const search = variant === 'search';

  return (
    <div className="flex flex-col gap-8 lg:gap-12">
      <ul className={`grid grid-cols-2 gap-x-3 gap-y-6 md:grid-cols-3 lg:gap-x-6 lg:gap-y-10 ${search ? 'lg:grid-cols-4' : ''}`} aria-label="Products">
        {cards.map((p) => (
          <li key={p.id} className="min-w-0">
            <ProductCard product={p} />
          </li>
        ))}
      </ul>
      {lastPage > 1 ? (
        <div className={`flex flex-col items-center gap-3 ${search ? '' : 'lg:gap-4'}`}>
          <p className="type-body-s text-ink-muted" aria-live="polite">
            {search ? `Showing ${seen} of ${total}` : `You’ve seen ${seen} of ${total}`}
          </p>
          {search ? null : (
            <span className="hidden h-1 w-60 overflow-hidden rounded-[2px] bg-sunken lg:block" aria-hidden>
              <span className="block h-full bg-brand" style={{ width: `${pct}%` }} />
            </span>
          )}
          {current < lastPage ? (
            <button
              type="button"
              onClick={more}
              disabled={pending}
              className="type-label-m flex h-[54px] w-full items-center justify-center gap-2 rounded-control border-[1.5px] border-ink px-7 text-ink hover:bg-ink/5 disabled:opacity-60 lg:w-auto"
            >
              {pending ? (
                'Loading…'
              ) : search ? (
                'Show more results'
              ) : (
                <>
                  <span className="lg:hidden">Load more</span>
                  <span className="hidden lg:inline">Load {perPage} more</span>
                </>
              )}
            </button>
          ) : null}
          {failed ? <p className="type-body-s text-sale">Couldn&apos;t load more. Use the page numbers below.</p> : null}
          {pagination}
        </div>
      ) : null}
    </div>
  );
}
