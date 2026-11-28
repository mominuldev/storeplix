import { isApiError } from '@storeplix/api-client';
import type {
  CatalogItemFilters,
  ChooseFeedAccountInput,
  FeedProvider,
  IntegrationProvider,
  IntegrationSettingsMap,
  SaveIntegrationInput,
  StoreIntegration,
  TrackingEventFilters,
  TrackingProvider,
  TrackingTestEventInput,
} from '@storeplix/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';
import { canViewIntegrations } from './integrations';

// PHASE-8-9D §8 server state. Store-scoped keys: [tenantId, storeId, 'integrations', …].

type Scope = { tenantId: string | null; storeId: string | null };

export const integrationKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'integrations'] as const,
  list: (s: Scope) => [s.tenantId, s.storeId, 'integrations', 'list'] as const,
  one: (s: Scope, p: IntegrationProvider) => [s.tenantId, s.storeId, 'integrations', p] as const,
  sub: (s: Scope, p: IntegrationProvider, ...rest: unknown[]) => [s.tenantId, s.storeId, 'integrations', p, ...rest] as const,
};

/** §4.1 list for the Integrations page groups (only for members who can read integrations). */
export function useIntegrationList() {
  const s = useStoreScope();
  const { activeTenant } = useAuth();
  return useQuery({ queryKey: integrationKeys.list(s), queryFn: () => api.integrations.list(s.storeId!), enabled: !!s.storeId && canViewIntegrations(activeTenant), retry: false });
}

export function useIntegration<P extends IntegrationProvider>(provider: P) {
  const s = useStoreScope();
  return useQuery({ queryKey: integrationKeys.one(s, provider), queryFn: () => api.integrations.get(s.storeId!, provider), enabled: !!s.storeId, retry: false });
}

/** Write the saved row into the cache and refresh the list (status/summary change). */
function useStoreRow() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (row: StoreIntegration) => {
    qc.setQueryData(integrationKeys.one(s, row.provider), row);
    void qc.invalidateQueries({ queryKey: integrationKeys.list(s) });
  };
}

/** On 409 `revision_conflict` reload the row so the next try carries the new revision. */
function useConflictReload(provider: IntegrationProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (e: unknown) => {
    if (isApiError(e) && e.code === 'revision_conflict') void qc.invalidateQueries({ queryKey: integrationKeys.one(s, provider) });
  };
}

export function useSaveIntegration<P extends IntegrationProvider>(provider: P) {
  const s = useStoreScope();
  const store = useStoreRow();
  const onConflict = useConflictReload(provider);
  return useMutation({
    mutationFn: (input: SaveIntegrationInput<P>) => api.integrations.save(s.storeId!, provider, input),
    onSuccess: (row) => store(row as StoreIntegration),
    onError: onConflict,
  });
}

export function useUpdateSettings<P extends IntegrationProvider>(provider: P) {
  const s = useStoreScope();
  const store = useStoreRow();
  const onConflict = useConflictReload(provider);
  return useMutation({
    mutationFn: (input: { settings: Partial<IntegrationSettingsMap[P]>; revision: number }) => api.integrations.update(s.storeId!, provider, input),
    onSuccess: (row) => store(row as StoreIntegration),
    onError: onConflict,
  });
}

export function useDisconnect(provider: IntegrationProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const store = useStoreRow();
  return useMutation({
    mutationFn: () => api.integrations.disconnect(s.storeId!, provider, { confirm: 'DISCONNECT' }),
    onSuccess: (row) => {
      store(row);
      void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, provider) });
    },
  });
}

export function useVerify(provider: IntegrationProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.integrations.verify(s.storeId!, provider),
    onSuccess: () => void qc.invalidateQueries({ queryKey: integrationKeys.one(s, provider) }),
  });
}

// ---------- Tracking ----------

export function useTrackingStats(provider: TrackingProvider, days: 7 | 30, enabled = true) {
  const s = useStoreScope();
  return useQuery({
    queryKey: integrationKeys.sub(s, provider, 'stats', days),
    queryFn: () => api.integrations.tracking.stats(s.storeId!, provider, days),
    enabled: enabled && !!s.storeId,
    retry: false,
  });
}

export function useTrackingEvents(provider: TrackingProvider, filters: TrackingEventFilters, { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  const s = useStoreScope();
  return useQuery({
    queryKey: integrationKeys.sub(s, provider, 'events', filters),
    queryFn: () => api.integrations.tracking.events(s.storeId!, provider, filters),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    refetchInterval: poll ? 5_000 : false,
    retry: false,
  });
}

export function useSendTestEvent(provider: TrackingProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TrackingTestEventInput) => api.integrations.tracking.sendTest(s.storeId!, provider, input),
    onSettled: () => void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, provider, 'events') }),
  });
}

export function useStartTestMode(provider: TrackingProvider) {
  const s = useStoreScope();
  return useMutation({ mutationFn: () => api.integrations.tracking.startTestMode(s.storeId!, provider) });
}

// ---------- Feeds ----------

export function useOauthStart(provider: FeedProvider) {
  const s = useStoreScope();
  return useMutation({ mutationFn: () => api.integrations.feeds.oauthStart(s.storeId!, provider) });
}

export function useFeedAccounts(provider: FeedProvider, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({ queryKey: integrationKeys.sub(s, provider, 'accounts'), queryFn: () => api.integrations.feeds.accounts(s.storeId!, provider), enabled: enabled && !!s.storeId, retry: false });
}

export function useChooseAccount(provider: FeedProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  const store = useStoreRow();
  return useMutation({
    mutationFn: (input: ChooseFeedAccountInput) => api.integrations.feeds.chooseAccount(s.storeId!, provider, input),
    onSuccess: (row) => {
      store(row as StoreIntegration);
      void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, provider) });
    },
  });
}

export function useFeedOverview(provider: FeedProvider, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({ queryKey: integrationKeys.sub(s, provider, 'feed'), queryFn: () => api.integrations.feeds.overview(s.storeId!, provider), enabled: enabled && !!s.storeId, retry: false });
}

export function useSyncRuns(provider: FeedProvider, cursor: string | undefined, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({
    queryKey: integrationKeys.sub(s, provider, 'runs', cursor ?? null),
    queryFn: () => api.integrations.feeds.runs(s.storeId!, provider, cursor),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useCatalogItems(provider: FeedProvider, filters: CatalogItemFilters, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({
    queryKey: integrationKeys.sub(s, provider, 'items', filters),
    queryFn: () => api.integrations.feeds.items(s.storeId!, provider, filters),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSyncNow(provider: FeedProvider) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.integrations.feeds.syncNow(s.storeId!, provider),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, provider, 'runs') });
      void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, provider, 'feed') });
    },
  });
}

export function useClaimWebsite() {
  const s = useStoreScope();
  const store = useStoreRow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.integrations.feeds.claimWebsite(s.storeId!),
    onSuccess: (row) => {
      store(row as StoreIntegration);
      void qc.invalidateQueries({ queryKey: integrationKeys.sub(s, 'google_merchant', 'feed') });
    },
  });
}
