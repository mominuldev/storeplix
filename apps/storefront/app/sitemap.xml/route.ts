import { findCurrentStore } from '@/lib/store';
import { sitemapResponse } from '@/lib/seo-files';

export const dynamic = 'force-dynamic';

/** Per-host sitemap; empty for draft stores. Product/category URLs come with those APIs. */
export async function GET() {
  return sitemapResponse(await findCurrentStore());
}
