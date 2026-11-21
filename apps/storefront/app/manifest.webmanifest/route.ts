import { findCurrentStore } from '@/lib/store';
import { manifestIcons } from '@/lib/store-icons';
import { sanitizeColor } from '@/lib/sanitize';

export const dynamic = 'force-dynamic';

/** Per-host web app manifest with the store's 192/512 icons (contract §4). */
export async function GET() {
  const store = await findCurrentStore();
  if (!store) return new Response('Not found', { status: 404 });
  const { config, themeConfig, mode } = store;
  const manifest = {
    name: config.store.name,
    short_name: config.store.name.slice(0, 12),
    start_url: '/',
    display: 'browser',
    theme_color: sanitizeColor(themeConfig.settings.primaryColor) ?? undefined,
    background_color: '#fffcf8',
    icons: manifestIcons(config.store),
  };
  return Response.json(manifest, {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      ...(mode === 'live' ? {} : { 'cache-control': 'private, no-store' }),
    },
  });
}
