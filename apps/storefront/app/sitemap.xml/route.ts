import { findCurrentStore } from '@/lib/store';
import { originForHost } from '@/lib/seo';

export const dynamic = 'force-dynamic';

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Per-host sitemap. Product/category/page URLs are added once those public APIs exist. */
export async function GET() {
  const store = await findCurrentStore();
  if (!store) return new Response('Not found', { status: 404 });

  const origin = originForHost(store.host);
  const urls = ['/'];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${escapeXml(origin + path)}</loc></url>`).join('\n')}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
