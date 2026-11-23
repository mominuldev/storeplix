import 'server-only';
import { cache } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import { getRedirectablePath, getRequestHost } from './request-host';
import { primaryRedirectTarget } from './primary-host';
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

/**
 * Current request's store, or null when the host is invalid / not registered / suspended (P8-12: a suspended shop has
 * no renderable config; the proxy answers its pages with the 503 page, see lib/suspension.ts). Per-request cached.
 */
export const findCurrentStore = cache(async (): Promise<CurrentStore | null> => {
  const host = await getRequestHost();
  if (!host) return null;
  const result = await getStorefrontConfig(host, await getPreviewToken());
  if (result.status !== 'found') return null;
  const { theme, config: themeConfig } = resolveStoreTheme(result.config.theme);
  // Bad stored config never breaks the page: defaults were used for the invalid parts. Log it.
  if (themeConfig.usedFallback) console.warn(`[theme] invalid theme config for ${host}; rendered with defaults where needed`);
  return { host, mode: storeMode(result.config), config: result.config, theme, themeConfig };
});

/**
 * Phase 8.1: the host belongs to a suspended shop. Used by the root 404 boundary to render "temporarily unavailable"
 * instead of "Store not found" when a page render (not the proxy) is the first to learn about the suspension.
 */
export const isCurrentStoreSuspended = cache(async (): Promise<boolean> => {
  const host = await getRequestHost();
  if (!host) return false;
  const result = await getStorefrontConfig(host, await getPreviewToken());
  return result.status === 'suspended';
});

/**
 * Current store or the branded "Store not found" 404. Every page, layout and generateMetadata of the
 * (store) segment goes through here, so a non-primary host is permanently redirected (308) to the
 * same path + query on the primary before anything renders (PHASE-6-CONTRACT P6-15, §7).
 */
export async function requireCurrentStore(): Promise<CurrentStore> {
  const store = await findCurrentStore();
  if (!store) notFound();
  await redirectToPrimaryIfNeeded(store);
  return store;
}

/** Absolute URL on the primary host for this GET/HEAD request, or null = serve it here. */
export async function primaryRedirectFor(store: CurrentStore): Promise<string | null> {
  if (!store.config.store.redirect_host) return null;
  return primaryRedirectTarget({
    redirectHost: store.config.store.redirect_host,
    requestHost: store.host,
    preview: store.mode === 'preview',
    path: await getRedirectablePath(),
  });
}

/** 308 to the primary host when the API set `redirect_host` and this is a GET/HEAD page request. */
export async function redirectToPrimaryIfNeeded(store: CurrentStore): Promise<void> {
  const target = await primaryRedirectFor(store);
  if (target) permanentRedirect(target);
}

export function storeCssVars(store: CurrentStore) {
  return themeCssVars(store.themeConfig.settings, defaultSettings(store.theme));
}
