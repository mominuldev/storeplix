import Link from 'next/link';
import type { ReactNode } from 'react';
import { catalogHref, pageList, PLP_PER_PAGE, SORT_LABELS, SORTS, type CatalogState } from '@/lib/catalog-query';
import type { ProductPage } from '@/lib/commerce-schemas';
import { formatBdt } from '@/lib/format';
import { toCardView } from '@/lib/products';
import { Icon } from '../components/icon';
import { FiltersPanel, ProductGrid, SortSelect } from './catalog-client';

interface Props {
  basePath: string;
  state: CatalogState;
  result: ProductPage;
  scope: { category: string } | { q: string };
  empty: ReactNode;
}

const chipCls = 'type-label-s flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5 text-brand hover:brightness-95';

/**
 * PLP / search body (Figma 1:10821 / 1:10946 / 1:12443): filter bar with active chips, sort, Price
 * and In-stock filters (other facets deferred, §11), card grid, numbered pagination + Load more.
 */
export function CatalogView({ basePath, state, result, scope, empty }: Props) {
  const href = (over: Partial<CatalogState>) => catalogHref(basePath, state, over);
  const chips: Array<{ label: string; href: string }> = [];
  if (state.min !== null || state.max !== null) {
    const label =
      state.min !== null && state.max !== null
        ? `${formatBdt(state.min * 100)} – ${formatBdt(state.max * 100)}`
        : state.min !== null
          ? `From ${formatBdt(state.min * 100)}`
          : `Under ${formatBdt(state.max! * 100)}`;
    chips.push({ label, href: href({ min: null, max: null, page: 1 }) });
  }
  if (state.inStock) chips.push({ label: 'In stock only', href: href({ inStock: false, page: 1 }) });

  const from = result.total === 0 ? 0 : (result.page - 1) * result.per_page + 1;
  const to = Math.min(result.total, from + result.products.length - 1);
  const params: Record<string, string> = { sort: state.sort };
  if (state.min !== null) params.min = String(state.min);
  if (state.max !== null) params.max = String(state.max);
  if (state.inStock) params.stock = '1';
  if ('q' in scope) params.q = scope.q;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-4 border-y border-line-subtle px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-20 lg:py-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="type-label-m mr-2 hidden items-center gap-2 text-ink lg:flex">
            <Icon name="sliders" />
            Filters
          </p>
          {chips.map((c) => (
            <Link key={c.label} href={c.href} className={chipCls} aria-label={`Remove filter ${c.label}`}>
              {c.label}
              <Icon name="x" size={14} />
            </Link>
          ))}
          {chips.length ? (
            <Link href={href({ min: null, max: null, inStock: false, page: 1 })} className="type-label-s px-1 text-brand hover:underline">
              Clear all
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="type-body-s text-ink-muted" aria-live="polite">
            {result.total > 0 ? `Showing ${from}–${to} of ${result.total}` : 'No results'}
          </p>
          <SortSelect value={state.sort} options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s], href: href({ sort: s, page: 1 }) }))} />
        </div>
      </div>

      <div className="flex flex-col gap-8 px-4 pt-8 lg:flex-row lg:gap-10 lg:px-20 lg:pt-10">
        <aside className="lg:w-[272px] lg:shrink-0" aria-label="Filters">
          <FiltersPanel activeCount={chips.length}>
            <form action={basePath} method="get" className="flex flex-col gap-6">
              {'q' in scope ? <input type="hidden" name="q" value={scope.q} /> : null}
              {state.sort !== 'bestsellers' ? <input type="hidden" name="sort" value={state.sort} /> : null}
              <fieldset className="flex flex-col gap-3 border-b border-line-subtle pb-6">
                <legend className="type-label-m mb-3 text-ink">Price</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex h-12 items-center gap-1.5 rounded-sf-xs border border-line bg-surface px-3">
                    <span className="type-body-s text-ink-muted">৳</span>
                    <span className="sr-only">Minimum price</span>
                    <input name="min" type="number" inputMode="numeric" min={0} step={1} defaultValue={state.min ?? ''} placeholder="0" className="type-body-m w-full min-w-0 bg-transparent text-ink outline-none" />
                  </label>
                  <label className="flex h-12 items-center gap-1.5 rounded-sf-xs border border-line bg-surface px-3">
                    <span className="type-body-s text-ink-muted">৳</span>
                    <span className="sr-only">Maximum price</span>
                    <input name="max" type="number" inputMode="numeric" min={0} step={1} defaultValue={state.max ?? ''} placeholder="Any" className="type-body-m w-full min-w-0 bg-transparent text-ink outline-none" />
                  </label>
                </div>
              </fieldset>
              <label className="type-label-m flex cursor-pointer items-center justify-between gap-3 text-ink">
                In stock only
                <input name="stock" type="checkbox" value="1" defaultChecked={state.inStock} className="size-5 accent-[var(--color-brand)]" />
              </label>
              <button type="submit" className="type-label-m h-12 rounded-control bg-brand px-6 text-on-brand hover:brightness-110">
                Apply filters
              </button>
            </form>
          </FiltersPanel>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-10">
          {result.products.length === 0 ? (
            empty
          ) : (
            <ProductGrid
              // Remount when the URL state changes so Load more restarts from this page.
              key={JSON.stringify(params) + result.page}
              initial={result.products.map(toCardView)}
              page={result.page}
              lastPage={result.last_page}
              scope={scope}
              params={params}
              perPage={PLP_PER_PAGE}
            />
          )}
          {result.last_page > 1 ? (
            <nav aria-label="Pages" className="flex flex-wrap items-center justify-center gap-2">
              {result.page > 1 ? (
                <Link href={href({ page: result.page - 1 })} rel="prev" className="type-label-s flex h-10 items-center rounded-full px-3 text-ink hover:bg-sunken">
                  Previous
                </Link>
              ) : null}
              {pageList(result.page, result.last_page).map((p, i) =>
                p === '…' ? (
                  <span key={`gap-${i}`} className="type-label-s px-1 text-ink-muted">
                    …
                  </span>
                ) : (
                  <Link
                    key={p}
                    href={href({ page: p })}
                    aria-current={p === result.page ? 'page' : undefined}
                    className={`type-label-s flex size-10 items-center justify-center rounded-full ${p === result.page ? 'bg-inverse text-paper' : 'text-ink hover:bg-sunken'}`}
                  >
                    {p}
                  </Link>
                ),
              )}
              {result.page < result.last_page ? (
                <Link href={href({ page: result.page + 1 })} rel="next" className="type-label-s flex h-10 items-center rounded-full px-3 text-ink hover:bg-sunken">
                  Next
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
