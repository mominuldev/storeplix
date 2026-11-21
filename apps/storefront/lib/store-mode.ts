import type { RawStorefrontConfig } from './storefront-api';

/**
 * live        - active store, public visitor
 * preview     - valid merchant preview token (API said preview:true): real store + banner
 * coming_soon - draft store without a valid preview: branded Coming Soon on every path
 */
export type StoreMode = 'live' | 'preview' | 'coming_soon';

export function storeMode(config: Pick<RawStorefrontConfig, 'store' | 'preview'>): StoreMode {
  if (config.preview) return 'preview';
  return config.store.status === 'active' ? 'live' : 'coming_soon';
}
