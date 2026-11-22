import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { getPreviewToken } from '@/lib/preview';
import { listProducts } from '@/lib/commerce-api';
import { catalogApiQuery, parseCatalogState } from '@/lib/catalog-query';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { CatalogView } from '@/themes/modern-commerce/commerce/catalog-view';
import { EmptyState, PageTitle } from '@/themes/modern-commerce/commerce/ui';
import { ButtonLink } from '@/themes/modern-commerce/components/button';
import { Icon } from '@/themes/modern-commerce/components/icon';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q } = parseCatalogState(await searchParams);
  return { title: q ? `Search: ${q}` : 'Search', robots: NOINDEX_ROBOTS };
}

/** `/search?q=` — Figma 1:12443. Same grid and pagination as the PLP; never indexed. */
export default async function SearchPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const state = parseCatalogState(await searchParams);
  const token = store.mode === 'preview' ? await getPreviewToken() : null;
  const result = state.q ? await listProducts(store.host, catalogApiQuery(state, { q: state.q }), token) : null;

  return (
    <div className="flex flex-col pb-10 lg:pb-24">
      <header className="flex flex-col gap-3 px-4 pt-2 pb-5 lg:gap-4 lg:px-20 lg:pt-10 lg:pb-6">
        <p className="type-eyebrow text-sale">Search results</p>
        <PageTitle size="m" title={state.q ? `“${state.q}”` : 'Search'} count={result ? `${result.total} ${result.total === 1 ? 'product' : 'products'}` : undefined} />
        {state.q ? null : (
          <form role="search" action="/search" className="flex h-12 max-w-[640px] items-center gap-3 rounded-full border border-line-subtle bg-sunken py-1 pr-1 pl-5">
            <Icon name="search" className="text-ink-muted" />
            <label htmlFor="search-page-q" className="sr-only">
              Search
            </label>
            <input id="search-page-q" name="q" type="search" defaultValue={state.q} maxLength={100} placeholder="Search the store…" className="type-body-m min-w-0 flex-1 bg-transparent text-ink outline-none" />
            <button type="submit" className="type-label-s rounded-control bg-brand px-4 py-2 text-on-brand hover:brightness-110">
              Search
            </button>
          </form>
        )}
      </header>
      {result ? (
        <CatalogView
          variant="search"
          basePath="/search"
          state={state}
          result={result}
          scope={{ q: state.q }}
          empty={
            <EmptyState title={`No results for “${state.q}”`} action={<ButtonLink href="/">Back to home</ButtonLink>}>
              Check the spelling or try a shorter word.
            </EmptyState>
          }
        />
      ) : (
        <p className="type-body-m px-4 text-ink-secondary lg:px-20">Type what you&apos;re looking for above.</p>
      )}
    </div>
  );
}
