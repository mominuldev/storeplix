import { findCurrentStore } from '@/lib/store';
import { getStorefrontPageIndex } from '@/lib/storefront-api';
import { getCategoryTree, listProducts } from '@/lib/commerce-api';
import { isIndexable } from '@/lib/seo';
import { SITEMAP_MAX_URLS, sitemapResponse } from '@/lib/seo-files';
import type { StorefrontCategory } from '@storeplix/types';

export const dynamic = 'force-dynamic';

const flatten = (cats: StorefrontCategory[]): Array<{ slug: string }> => cats.flatMap((c) => [{ slug: c.slug }, ...flatten(c.children)]);

/** Public products, 48 per page, until the sitemap cap (public fetches share the tagged cache). */
async function allProducts(host: string, room: number): Promise<Array<{ slug: string; updated_at: string | null }>> {
  const out: Array<{ slug: string; updated_at: string | null }> = [];
  for (let page = 1; out.length < room && page <= Math.ceil(SITEMAP_MAX_URLS / 48); page++) {
    const r = await listProducts(host, new URLSearchParams({ page: String(page), per_page: '48', sort: 'latest' }), null);
    // The card payload has no updated_at, so products carry no lastmod.
    out.push(...r.products.map((p) => ({ slug: p.slug, updated_at: null })));
    if (page >= r.last_page || r.products.length === 0) break;
  }
  return out.slice(0, room);
}

/** Per-host sitemap: home, published pages, visible categories, public products; empty unless live. */
export async function GET() {
  const store = await findCurrentStore();
  if (!store || !isIndexable(store.mode, store.config.seo)) return sitemapResponse(store);
  const [pages, tree] = await Promise.all([getStorefrontPageIndex(store.host), getCategoryTree(store.host)]);
  const categories = flatten(tree);
  const products = await allProducts(store.host, Math.max(0, SITEMAP_MAX_URLS - 1 - pages.length - categories.length));
  return sitemapResponse(store, { pages, categories, products });
}
