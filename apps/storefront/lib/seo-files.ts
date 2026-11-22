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

/**
 * robots.txt / sitemap.xml on a non-primary host: 301 to the same path on the primary
 * (PHASE-6-CONTRACT P6-15). Not cached, so switching the primary back takes effect at once.
 */
export function primaryRedirectResponse(target: string): Response {
  return new Response(null, { status: 301, headers: { location: target, 'cache-control': NO_STORE } });
}

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
    'Disallow: /track',
    'Disallow: /search',
    'Disallow: /discount',
    'Disallow: /pay',
    '',
    `Sitemap: ${canonicalOrigin(store.config.store, store.host)}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Sitemap URL cap (PHASE-5-CONTRACT §5). */
export const SITEMAP_MAX_URLS = 5000;

export interface SitemapEntries {
  pages?: Array<{ slug: string; updated_at: string | null }>;
  products?: Array<{ slug: string; updated_at: string | null }>;
  categories?: Array<{ slug: string }>;
}

/**
 * sitemap.xml: `/`, published pages, public products (`/products/{slug}`, lastmod) and visible
 * categories (`/c/{slug}`) for live, indexable stores (canonical origin = primary host), capped at
 * 5 000 URLs; an empty urlset for draft, preview and "hidden from search" stores.
 */
export function sitemapResponse(store: SeoTarget | null, entries: SitemapEntries | SitemapEntries['pages'] = {}): Response {
  if (!store) return new Response('Not found', { status: 404 });
  const e: SitemapEntries = Array.isArray(entries) ? { pages: entries } : entries;
  const live = crawlable(store);
  const origin = canonicalOrigin(store.config.store, store.host);
  const urls: Array<{ path: string; lastmod: string | null }> = live
    ? [
        { path: '/', lastmod: null },
        ...(e.pages ?? []).map((p) => ({ path: `/pages/${encodeURIComponent(p.slug)}`, lastmod: p.updated_at })),
        ...(e.categories ?? []).map((c) => ({ path: `/c/${encodeURIComponent(c.slug)}`, lastmod: null })),
        ...(e.products ?? []).map((p) => ({ path: `/products/${encodeURIComponent(p.slug)}`, lastmod: p.updated_at })),
      ].slice(0, SITEMAP_MAX_URLS)
    : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => {
    const lastmod = u.lastmod && !Number.isNaN(Date.parse(u.lastmod)) ? `<lastmod>${escapeXml(new Date(u.lastmod).toISOString())}</lastmod>` : '';
    return `  <url><loc>${escapeXml(origin + u.path)}</loc>${lastmod}</url>`;
  })
  .join('\n')}
</urlset>
`;
  return new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8', ...(live ? {} : { 'cache-control': NO_STORE }) },
  });
}
