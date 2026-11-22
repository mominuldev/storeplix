import Link from 'next/link';
import type { ReactNode } from 'react';
import { catalogHref, pageList, PLP_PER_PAGE, SORT_LABELS, SORTS, type CatalogState } from '@/lib/catalog-query';
import type { ProductPage } from '@/lib/commerce-schemas';
import { formatBdt } from '@/lib/format';
import { toCardView } from '@/lib/products';
import { Icon } from '../components/icon';
import { CatalogLayout, ProductGrid, SortSelect } from './catalog-client';

interface Props {
  basePath: string;
  state: CatalogState;
  result: ProductPage;
  scope: { category: string } | { q: string };
  empty: ReactNode;
  /** `plp`: filter sidebar (1:10821); `search`: "Filter by" dropdown pills + 4-col grid (1:12443). */
  variant?: 'plp' | 'search';
}

const chipCls = 'type-label-s flex shrink-0 items-center gap-1.5 rounded-full bg-brand-soft py-1.5 pr-2 pl-3 text-brand hover:brightness-95 lg:pl-3.5';
const pillCls = 'type-label-s flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-ink hover:border-ink [&::-webkit-details-marker]:hidden';
const pageCls = 'type-label-m flex size-11 items-center justify-center rounded-full';
const inputBoxCls = 'flex h-[43px] min-w-0 flex-1 items-center gap-1 rounded-sf-md border border-line bg-surface px-3 focus-within:border-ink';
const inputCls = 'type-body-s w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-ink-muted';
const applyCls = 'type-label-m h-12 w-full rounded-control bg-brand px-6 text-on-brand hover:brightness-110';

/** Figma Toggle (44×26, 1:10920) driven by a real checkbox. */
function StockToggle({ checked }: { checked: boolean }) {
  return (
    <span className="relative inline-flex h-[26px] w-11 shrink-0">
      <input name="stock" type="checkbox" value="1" defaultChecked={checked} aria-label="In stock only" className="peer absolute inset-0 z-10 cursor-pointer opacity-0" />
      <span aria-hidden className="absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand" />
      <span aria-hidden className="absolute top-[3px] left-[3px] size-5 rounded-full bg-surface transition-transform peer-checked:translate-x-[18px]" />
    </span>
  );
}

function PriceInputs({ state }: { state: CatalogState }) {
  return (
    <div className="flex gap-2">
      <label className={inputBoxCls}>
        <span className="type-body-s text-ink">৳</span>
        <span className="sr-only">Minimum price</span>
        <input name="min" type="number" inputMode="numeric" min={0} step={1} defaultValue={state.min ?? ''} placeholder="0" className={inputCls} />
      </label>
      <label className={inputBoxCls}>
        <span className="type-body-s text-ink">৳</span>
        <span className="sr-only">Maximum price</span>
        <input name="max" type="number" inputMode="numeric" min={0} step={1} defaultValue={state.max ?? ''} placeholder="Any" className={inputCls} />
      </label>
    </div>
  );
}

/**
 * PLP / search body (Figma 1:10821 / 1:10946 / 1:12443): toolbar with active chips and sort, Price and
 * In-stock filters (other facets deferred, §11), card grid, Load more + numbered pagination.
 */
export function CatalogView({ basePath, state, result, scope, empty, variant = 'plp' }: Props) {
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

  const keep = (
    <>
      {'q' in scope ? <input type="hidden" name="q" value={scope.q} /> : null}
      {state.sort !== 'bestsellers' ? <input type="hidden" name="sort" value={state.sort} /> : null}
    </>
  );
  const chipLinks = chips.map((c) => (
    <Link key={c.label} href={c.href} className={chipCls} aria-label={`Remove filter ${c.label}`}>
      {c.label}
      <Icon name="x" size={14} />
    </Link>
  ));
  const clearAll = chips.length ? (
    <Link href={href({ min: null, max: null, inStock: false, page: 1 })} className="type-label-s shrink-0 text-brand hover:underline">
      Clear all
    </Link>
  ) : null;

  const desktopLeft =
    variant === 'plp' ? (
      <div className="flex items-center gap-3">
        <p className="type-label-m flex items-center gap-3 text-ink">
          <Icon name="sliders" size={20} />
          Filters
        </p>
        {chips.length ? (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            {chipLinks}
            {clearAll}
          </div>
        ) : null}
      </div>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <p className="type-label-m flex items-center gap-2 text-ink">
          <Icon name="sliders" />
          Filter by
        </p>
        <details className="relative">
          <summary className={`${pillCls} ${state.min !== null || state.max !== null ? 'border-ink' : ''}`}>
            Price
            <Icon name="caret-down" size={12} className="text-ink" />
          </summary>
          <form action={basePath} method="get" className="absolute top-full left-0 z-20 mt-2 flex w-[300px] flex-col gap-3.5 rounded-sf-sm border border-line bg-surface p-4 shadow-e3">
            {keep}
            {state.inStock ? <input type="hidden" name="stock" value="1" /> : null}
            <PriceInputs state={state} />
            <button type="submit" className={applyCls}>
              Apply
            </button>
          </form>
        </details>
        <details className="relative">
          <summary className={`${pillCls} ${state.inStock ? 'border-ink' : ''}`}>
            In stock
            <Icon name="caret-down" size={12} className="text-ink" />
          </summary>
          <form action={basePath} method="get" className="absolute top-full left-0 z-20 mt-2 flex w-[260px] flex-col gap-3.5 rounded-sf-sm border border-line bg-surface p-4 shadow-e3">
            {keep}
            {state.min !== null ? <input type="hidden" name="min" value={state.min} /> : null}
            {state.max !== null ? <input type="hidden" name="max" value={state.max} /> : null}
            <div className="type-label-m flex items-center justify-between gap-3 text-ink">
              In stock only
              <StockToggle checked={state.inStock} />
            </div>
            <button type="submit" className={applyCls}>
              Apply
            </button>
          </form>
        </details>
        {chips.length ? <span className="ml-2 flex items-center gap-2">{clearAll}</span> : null}
      </div>
    );

  const right = (
    <div className="flex min-w-0 flex-1 items-center gap-5 lg:flex-none">
      {variant === 'plp' ? (
        <p className="type-body-s hidden text-ink-muted lg:block" aria-live="polite">
          {result.total > 0 ? `Showing ${from}–${to} of ${result.total}` : 'No results'}
        </p>
      ) : null}
      <SortSelect value={state.sort} options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s], href: href({ sort: s, page: 1 }) }))} />
    </div>
  );

  const mobileChips = chips.length ? (
    <div className="flex items-center gap-2 overflow-x-auto px-4 pt-3 lg:hidden">
      {chipLinks}
      {clearAll}
    </div>
  ) : null;

  const filters = (
    <form action={basePath} method="get" className="flex flex-col">
      {keep}
      <details open className="group border-b border-line py-5">
        <summary className="type-label-m flex cursor-pointer list-none items-center justify-between text-ink [&::-webkit-details-marker]:hidden">
          Price
          <Icon name="caret-down" size={16} className="text-ink-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3.5">
          <PriceInputs state={state} />
        </div>
      </details>
      <div className="type-label-m flex items-center justify-between gap-3 py-5 text-ink">
        In stock only
        <StockToggle checked={state.inStock} />
      </div>
      <button type="submit" className={applyCls}>
        Apply filters
      </button>
    </form>
  );

  const pagination =
    variant === 'plp' && result.last_page > 1 ? (
      <nav aria-label="Pages" className="hidden flex-wrap items-center justify-center gap-2 lg:flex">
        {result.page > 1 ? (
          <Link href={href({ page: result.page - 1 })} rel="prev" aria-label="Previous page" className={`${pageCls} border border-line bg-surface text-ink hover:border-ink`}>
            <Icon name="caret-down" size={16} className="rotate-90" />
          </Link>
        ) : (
          <span aria-hidden className={`${pageCls} border border-line bg-surface text-ink-muted opacity-50`}>
            <Icon name="caret-down" size={16} className="rotate-90" />
          </span>
        )}
        {pageList(result.page, result.last_page).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className={`${pageCls} border border-line bg-surface text-ink`}>
              …
            </span>
          ) : (
            <Link
              key={p}
              href={href({ page: p })}
              aria-current={p === result.page ? 'page' : undefined}
              className={`${pageCls} ${p === result.page ? 'bg-inverse text-paper' : 'border border-line bg-surface text-ink hover:border-ink'}`}
            >
              {p}
            </Link>
          ),
        )}
        {result.page < result.last_page ? (
          <Link href={href({ page: result.page + 1 })} rel="next" aria-label="Next page" className={`${pageCls} border border-line bg-surface text-ink hover:border-ink`}>
            <Icon name="caret-down" size={16} className="-rotate-90" />
          </Link>
        ) : (
          <span aria-hidden className={`${pageCls} border border-line bg-surface text-ink-muted opacity-50`}>
            <Icon name="caret-down" size={16} className="-rotate-90" />
          </span>
        )}
      </nav>
    ) : null;

  return (
    <CatalogLayout variant={variant} activeCount={chips.length} desktopLeft={desktopLeft} right={right} mobileChips={mobileChips} filters={filters}>
      {result.products.length === 0 ? (
        empty
      ) : (
        <ProductGrid
          // Remount when the URL state changes so Load more restarts from this page.
          key={JSON.stringify(params) + result.page}
          variant={variant}
          initial={result.products.map(toCardView)}
          page={result.page}
          lastPage={result.last_page}
          total={result.total}
          offset={from === 0 ? 0 : from - 1}
          scope={scope}
          params={params}
          perPage={PLP_PER_PAGE}
          pagination={pagination}
        />
      )}
    </CatalogLayout>
  );
}
