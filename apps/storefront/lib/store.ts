import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getRequestHost } from './request-host';
import { getPreviewToken } from './preview';
import { storeMode, type StoreMode } from './store-mode';

export type { StoreMode };
import { getStorefrontConfig, type RawStorefrontConfig } from './storefront-api';
import { defaultSettings, resolveStoreTheme } from '@/themes/registry';
import { themeCssVars } from '@/themes/css-vars';

export interface CurrentStore {
  host: string;
  mode: StoreMode;
  config: RawStorefrontConfig;
  theme: ReturnType<typeof resolveStoreTheme>['theme'];
  themeConfig: ReturnType<typeof resolveStoreTheme>['config'];
}

/** Current request's store, or null when the host is invalid / not registered. Per-request cached. */
export const findCurrentStore = cache(async (): Promise<CurrentStore | null> => {
  const host = await getRequestHost();
  if (!host) return null;
  const result = await getStorefrontConfig(host, await getPreviewToken());
  if (result.status === 'not_found') return null;
  const { theme, config: themeConfig } = resolveStoreTheme(result.config.theme);
  return { host, mode: storeMode(result.config), config: result.config, theme, themeConfig };
});

/** Current store or the branded "Store not found" 404. */
export async function requireCurrentStore(): Promise<CurrentStore> {
  const store = await findCurrentStore();
  if (!store) notFound();
  return store;
}

export function storeCssVars(store: CurrentStore) {
  return themeCssVars(store.themeConfig.settings, defaultSettings(store.theme));
}
