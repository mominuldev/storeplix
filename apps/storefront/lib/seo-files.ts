import { canonicalOrigin, isIndexable } from './seo';
import type { StoreMode } from './store-mode';

const NO_STORE = 'private, no-store';

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export interface SeoTarget {
  host: string;
  mode: StoreMode;
  config: { store: { primary_host: string }; seo: { noindex: boolean } };
}

const crawlable = (store: SeoTarget) => isIndexable(store.mode, store.config.seo);

/** robots.txt for a store (or null = unknown host). Only live, not-hidden stores are crawlable. */
export function robotsResponse(store: SeoTarget | null): Response {
  if (!store || !crawlable(store)) {
    return new Response('User-agent: *\nDisallow: /\n', {
      status: store ? 200 : 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE },
    });
  }
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /account',
    'Disallow: /search',
    '',
    `Sitemap: ${canonicalOrigin(store.config.store, store.host)}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * sitemap.xml: `/` + every published page for live, indexable stores (canonical origin = primary
 * host); an empty urlset for draft, preview and "hidden from search" stores.
 */
export function sitemapResponse(store: SeoTarget | null, pages: Array<{ slug: string; updated_at: string | null }> = []): Response {
  if (!store) return new Response('Not found', { status: 404 });
  const live = crawlable(store);
  const origin = canonicalOrigin(store.config.store, store.host);
  const urls: Array<{ path: string; lastmod: string | null }> = live
    ? [{ path: '/', lastmod: null }, ...pages.map((p) => ({ path: `/pages/${encodeURIComponent(p.slug)}`, lastmod: p.updated_at }))]
    : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${escapeXml(origin + u.path)}</loc>${u.lastmod ? `<lastmod>${escapeXml(new Date(u.lastmod).toISOString())}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;
  return new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8', ...(live ? {} : { 'cache-control': NO_STORE }) },
  });
}
