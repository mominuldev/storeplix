import { findCurrentStore } from '@/lib/store';
import { getStorefrontPageIndex } from '@/lib/storefront-api';
import { isIndexable } from '@/lib/seo';
import { sitemapResponse } from '@/lib/seo-files';

export const dynamic = 'force-dynamic';

/** Per-host sitemap: home + published pages; empty for draft/preview/hidden stores. */
export async function GET() {
  const store = await findCurrentStore();
  const pages = store && isIndexable(store.mode, store.config.seo) ? await getStorefrontPageIndex(store.host) : [];
  return sitemapResponse(store, pages);
}
