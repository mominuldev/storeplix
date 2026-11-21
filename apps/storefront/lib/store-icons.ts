import type { Metadata } from 'next';
import { sanitizeImageUrl } from './sanitize';
import type { RawStorefrontConfig } from './storefront-api';

export const PLATFORM_FAVICON = '/platform/storeplix-favicon.svg';

type Store = Pick<RawStorefrontConfig['store'], 'favicon_url' | 'icons'>;

/**
 * Contract §4: favicon_url -> icon 32x32, icons.apple_touch -> apple-touch-icon; no icon set ->
 * Store Plix default favicon. Every URL passes sanitizeImageUrl (https or configured media origin).
 */
export function storeIconsMetadata(store: Store): NonNullable<Metadata['icons']> {
  const favicon = sanitizeImageUrl(store.favicon_url);
  const apple = sanitizeImageUrl(store.icons.apple_touch);
  return {
    icon: favicon ? [{ url: favicon, sizes: '32x32', type: 'image/png' }] : [{ url: PLATFORM_FAVICON, type: 'image/svg+xml' }],
    ...(apple ? { apple: [{ url: apple, sizes: '180x180', type: 'image/png' }] } : {}),
  };
}

/** Web-manifest icons from icons.icon_192 / icon_512 (empty when none are set). */
export function manifestIcons(store: Store): Array<{ src: string; sizes: string; type: string; purpose: string }> {
  return (
    [
      [store.icons.icon_192, '192x192'],
      [store.icons.icon_512, '512x512'],
    ] as const
  ).flatMap(([url, sizes]) => {
    const src = sanitizeImageUrl(url);
    return src ? [{ src, sizes, type: 'image/png', purpose: 'any' }] : [];
  });
}
