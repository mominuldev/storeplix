'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { loadMoreProducts } from '@/app/actions/commerce';
import type { ProductCardView } from '@/lib/products';
import { ProductCard } from '../components/product-card';
import { Icon } from '../components/icon';

/** Sort dropdown: navigates to a server-built href (no client-side query building). */
export function SortSelect({ value, options }: { value: string; options: Array<{ value: string; label: string; href: string }> }) {
  const router = useRouter();
  return (
    <label className="type-body-s flex h-12 items-center gap-2 rounded-full border border-line bg-surface pr-3 pl-5 text-ink-muted">
      Sort:
      <select
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) router.push(next.href);
        }}
        className="type-label-s min-w-0 cursor-pointer bg-transparent pr-1 text-ink outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Filters: a toggle on phones, always open from `lg`. The form itself is server-rendered (GET). */
export function FiltersPanel({ children, activeCount }: { children: ReactNode; activeCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="plp-filters"
        onClick={() => setOpen((o) => !o)}
        className="type-label-m flex h-12 items-center gap-2 self-start rounded-full border border-line bg-surface px-5 text-ink lg:hidden"
      >
        <Icon name="sliders" />
        Filters{activeCount ? ` (${activeCount})` : ''}
      </button>
      <div id="plp-filters" className={`${open ? 'block' : 'hidden'} lg:block`}>
        {children}
      </div>
    </div>
  );
}

interface GridProps {
  initial: ProductCardView[];
  page: number;
  lastPage: number;
  scope: { category: string } | { q: string };
  params: Record<string, string>;
  perPage: number;
}

/** Card grid + "Load N more" (appends the next page client-side via a read-only action). */
export function ProductGrid({ initial, page, lastPage, scope, params, perPage }: GridProps) {
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

  return (
    <div className="flex flex-col gap-10">
      <ul className="grid grid-cols-2 gap-x-3 gap-y-8 md:grid-cols-3 lg:gap-x-6 lg:gap-y-10" aria-label="Products">
        {cards.map((p) => (
          <li key={p.id} className="min-w-0">
            <ProductCard product={p} />
          </li>
        ))}
      </ul>
      {current < lastPage ? (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={more}
            disabled={pending}
            className="type-label-m flex h-12 items-center gap-2 rounded-control border-[1.5px] border-ink px-7 text-ink hover:bg-ink/5 disabled:opacity-60"
          >
            {pending ? 'Loading…' : `Load ${perPage} more`}
          </button>
          {failed ? <p className="type-body-s text-sale">Couldn&apos;t load more. Use the page numbers below.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
