import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';
import { getPreviewToken } from '@/lib/preview';
import { getCategory, listProducts } from '@/lib/commerce-api';
import { catalogApiQuery, parseCatalogState } from '@/lib/catalog-query';
import { canonicalOrigin, isIndexable, NOINDEX_ROBOTS } from '@/lib/seo';
import { CatalogView } from '@/themes/modern-commerce/commerce/catalog-view';
import { Breadcrumb, PageTitle } from '@/themes/modern-commerce/commerce/ui';
import { ButtonLink } from '@/themes/modern-commerce/components/button';
import { ThemeImage } from '@/themes/modern-commerce/components/theme-image';

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function load(slug: string) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon' || !SLUG_RE.test(slug) || slug.length > 200) return { store, category: null, token: null };
  const token = store.mode === 'preview' ? await getPreviewToken() : null;
  return { store, category: await getCategory(store.host, slug, token), token };
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { store, category } = await load(slug);
  if (!category) return {};
  const { config, host, mode } = store;
  const url = `${canonicalOrigin(config.store, host)}/c/${category.slug}`;
  const filtered = Object.keys(await searchParams).length > 0;
  const description = category.description?.slice(0, 160) ?? config.seo.description ?? undefined;
  const image = category.image?.url;
  return {
    title: category.name,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: config.store.name, title: category.name, description, url, images: image ? [{ url: image }] : undefined },
    // Filtered/sorted/paged variants point at the canonical URL and stay out of the index.
    robots: isIndexable(mode, config.seo) && !filtered ? undefined : NOINDEX_ROBOTS,
  };
}

/** Category PLP `/c/{slug}` — Figma desktop 1:10821, mobile 1:10946 (PHASE-5-CONTRACT §5). */
export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { store, category, token } = await load(slug);
  if (store.mode === 'coming_soon') return null;
  if (!category) notFound();

  const state = parseCatalogState(await searchParams);
  const result = await listProducts(store.host, catalogApiQuery(state, { category: category.slug }), token);
  const filtered = state.min !== null || state.max !== null || state.inStock;

  return (
    <div className="flex flex-col gap-8 pb-16 lg:gap-0 lg:pb-24">
      <header className="flex flex-col gap-8 px-4 pt-6 lg:flex-row lg:items-start lg:justify-between lg:gap-16 lg:px-20 lg:pt-12 lg:pb-14">
        <div className="flex min-w-0 flex-col gap-5 lg:max-w-[760px]">
          <Breadcrumb items={[{ label: 'Home', href: '/' }, ...category.ancestors.map((a) => ({ label: a.name, href: `/c/${a.slug}` })), { label: category.name }]} />
          <PageTitle title={category.name} count={`${result.total} ${result.total === 1 ? 'piece' : 'pieces'}`} />
          {category.description ? <p className="type-body-l text-ink-secondary">{category.description}</p> : null}
          {category.children.length ? (
            <ul className="flex flex-wrap gap-2" aria-label="Subcategories">
              <li>
                <span className="type-label-s inline-flex h-9 items-center rounded-full bg-inverse px-4 text-paper">All {category.name.toLowerCase()}</span>
              </li>
              {category.children.map((c) => (
                <li key={c.slug}>
                  <Link href={c.url_path} className="type-label-s inline-flex h-9 items-center rounded-full border border-line bg-surface px-4 text-ink hover:border-ink">
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {category.image ? (
          <div className="relative h-[200px] w-full shrink-0 pr-2.5 pb-2.5 lg:h-[270px] lg:w-[430px]">
            <div className="relative size-full overflow-hidden rounded-sf-xs border border-line bg-surface p-2.5 shadow-[10px_10px_0_0_var(--color-sky)]">
              <div className="relative size-full overflow-hidden rounded-[2px]">
                <ThemeImage src={category.image.url} alt={category.image.alt ?? ''} sizes="(min-width: 1024px) 430px, 100vw" priority />
              </div>
            </div>
          </div>
        ) : null}
      </header>
      <CatalogView
        basePath={`/c/${category.slug}`}
        state={state}
        result={result}
        scope={{ category: category.slug }}
        empty={
          <div className="flex flex-col items-start gap-4 rounded-sf-sm bg-sunken p-8" data-sp-empty>
            <h2 className="type-h2 text-ink">{filtered ? 'No matches' : 'Nothing here yet'}</h2>
            <p className="type-body-m text-ink-secondary">
              {filtered ? 'Try a wider price range or show items that are out of stock.' : 'New pieces are on the way. Have a look around the rest of the shop.'}
            </p>
            <ButtonLink href={filtered ? `/c/${category.slug}` : '/'}>{filtered ? 'Clear filters' : 'Back to home'}</ButtonLink>
          </div>
        }
      />
    </div>
  );
}
