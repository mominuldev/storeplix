import type { MediaPurpose, PreviewToken, StoreTheme } from '@storeplix/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { useTenantStore } from '../stores/useTenantStore';

export const osKeys = {
  catalog: ['themes', 'catalog'] as const,
  storeThemes: (storeId?: string) => ['store-themes', storeId] as const,
  storeTheme: (storeId?: string, code?: string) => ['store-theme', storeId, code] as const,
  pages: (storeId?: string) => ['pages', storeId] as const,
  page: (storeId?: string, pageId?: string) => ['page', storeId, pageId] as const,
  templates: ['page-templates'] as const,
  navigation: (storeId?: string) => ['navigation', storeId] as const,
  media: (purposes: MediaPurpose[], page: number) => ['media', purposes.join(','), page] as const,
};

/** O and A edit Online store; staff read only (contract §6, Permission::ManageSettings). */
export function useCanEditStore() {
  const { activeTenant } = useAuth();
  return can.editSettings(activeTenant?.role);
}

export function useStoreId() {
  return useTenantStore().data?.id;
}

export function useThemeCatalog() {
  return useQuery({ queryKey: osKeys.catalog, queryFn: () => api.themes.catalog(), staleTime: 5 * 60_000 });
}

export function useStoreThemes() {
  const storeId = useStoreId();
  return useQuery({ queryKey: osKeys.storeThemes(storeId), queryFn: () => api.storeThemes.list(storeId!), enabled: !!storeId });
}

/** The active theme with its draft/published configs. */
export function useActiveTheme() {
  const storeId = useStoreId();
  const list = useStoreThemes();
  const active = list.data?.find((t) => t.is_active) ?? list.data?.[0];
  const theme = useQuery<StoreTheme>({
    queryKey: osKeys.storeTheme(storeId, active?.code),
    queryFn: () => api.storeThemes.get(storeId!, active!.code),
    enabled: !!storeId && !!active,
  });
  return { summary: active, list, theme, isPending: list.isPending || (!!active && theme.isPending), isError: list.isError || theme.isError };
}

export function useStorePages() {
  const storeId = useStoreId();
  return useQuery({ queryKey: osKeys.pages(storeId), queryFn: () => api.pages.list(storeId!), enabled: !!storeId });
}

export function useNavigationMenus() {
  const storeId = useStoreId();
  return useQuery({ queryKey: osKeys.navigation(storeId), queryFn: () => api.navigation.list(storeId!), enabled: !!storeId });
}

export function usePageTemplates() {
  return useQuery({ queryKey: osKeys.templates, queryFn: () => api.pageTemplates.list(), staleTime: 10 * 60_000 });
}

export function useMediaLibrary(purposes: MediaPurpose[], page = 1, enabled = true) {
  return useQuery({
    queryKey: osKeys.media(purposes, page),
    queryFn: () => api.media.list({ purpose: purposes, page, per_page: 24 }),
    enabled,
  });
}

const RENEW_BEFORE_MS = 5 * 60_000;

/** Builds the embedded preview URL for `path` from a preview token URL (contract P3-10: `&embed=1`). */
export function embedUrl(tokenUrl: string, path = '/', embed = true): string {
  const url = new URL(tokenUrl);
  url.pathname = path;
  if (embed) url.searchParams.set('embed', '1');
  return url.toString();
}

/**
 * Signed preview link for the storefront draft. Re-issues the token when `expires_at` is < 5 min away
 * (contract §3.6); callers reload the iframe when `token.token` changes.
 */
export function usePreviewToken(enabled = true) {
  const storeId = useStoreId();
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery<PreviewToken>({
    queryKey: ['preview-token', storeId],
    queryFn: () => api.stores.createPreviewToken(storeId!),
    enabled: !!storeId && enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: 1,
  });
  const expiresAt = query.data ? Date.parse(query.data.expires_at) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const wait = Math.max(0, expiresAt - RENEW_BEFORE_MS - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const { refetch } = query;
  useEffect(() => {
    if (Number.isFinite(expiresAt) && expiresAt - now < RENEW_BEFORE_MS) void refetch();
  }, [now, expiresAt, refetch]);
  return query;
}

/** "Saved 10:42" style time. */
export function useClockLabel(iso: string | null | undefined) {
  return useMemo(() => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null), [iso]);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const day = 86_400_000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < day && new Date(iso).getDate() === new Date().getDate()) return 'today';
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.round(diff / day)} days ago`;
  if (diff < 30 * day) return `${Math.round(diff / (7 * day))} week${diff < 14 * day ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
