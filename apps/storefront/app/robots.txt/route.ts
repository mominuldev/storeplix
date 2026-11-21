import { findCurrentStore } from '@/lib/store';
import { originForHost } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/** Per-host robots.txt. Unknown hosts are fully disallowed so they never get indexed. */
export async function GET() {
  const store = await findCurrentStore();
  const body = store
    ? [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /cart',
        'Disallow: /checkout',
        'Disallow: /account',
        '',
        `Sitemap: ${originForHost(store.host)}/sitemap.xml`,
        '',
      ].join('\n')
    : 'User-agent: *\nDisallow: /\n';

  return new Response(body, {
    status: store ? 200 : 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
