import { originForHost } from './seo';
import type { StoreMode } from './store-mode';

const NO_STORE = 'private, no-store';

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export interface SeoTarget {
  host: string;
  mode: StoreMode;
}

/** robots.txt for a store (or null = unknown host). Only live stores are crawlable. */
export function robotsResponse(store: SeoTarget | null): Response {
  if (!store || store.mode !== 'live') {
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
    '',
    `Sitemap: ${originForHost(store.host)}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** sitemap.xml: empty urlset for draft/preview, home page (for now) for live stores. */
export function sitemapResponse(store: SeoTarget | null): Response {
  if (!store) return new Response('Not found', { status: 404 });
  const live = store.mode === 'live';
  const origin = originForHost(store.host);
  const urls = live ? ['/'] : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${escapeXml(origin + path)}</loc></url>`).join('\n')}
</urlset>
`;
  return new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8', ...(live ? {} : { 'cache-control': NO_STORE }) },
  });
}
