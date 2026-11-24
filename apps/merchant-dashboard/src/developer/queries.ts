import type { ApiKey, CreateApiKeyInput, CreateWebhookEndpointInput, UpdateWebhookEndpointInput, WebhookDeliveryFilters, WebhookEndpoint } from '@storeplix/types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// PHASE-8-4 §6.1 / §7. Keys: API keys are tenant-level `[tenantId, 'api-keys']`; webhooks are store-scoped
// `[tenantId, storeId, 'webhooks', …]` (contract §9.2 key prefix).

type Scope = { tenantId: string | null; storeId: string | null };

export const devKeys = {
  apiKeys: (s: Scope) => [s.tenantId, 'api-keys'] as const,
  scopes: (s: Scope) => [s.tenantId, 'api-scopes'] as const,
  eventTypes: (s: Scope) => [s.tenantId, 'webhook-event-types'] as const,
  webhooks: (s: Scope) => [s.tenantId, s.storeId, 'webhooks'] as const,
  endpoints: (s: Scope) => [s.tenantId, s.storeId, 'webhooks', 'endpoints'] as const,
  secret: (s: Scope) => [s.tenantId, s.storeId, 'webhooks', 'secret'] as const,
  recent: (s: Scope) => [s.tenantId, s.storeId, 'webhooks', 'deliveries', 'recent'] as const,
  /** Infinite (drawer) — kept apart from the plain queries: same key, different cache shape. */
  log: (s: Scope, filters: Omit<WebhookDeliveryFilters, 'cursor'>) => [s.tenantId, s.storeId, 'webhooks', 'deliveries', 'log', filters] as const,
  failed: (s: Scope) => [s.tenantId, s.storeId, 'webhooks', 'deliveries', 'failed-24h'] as const,
  delivery: (s: Scope, id: string | null) => [s.tenantId, s.storeId, 'webhooks', 'delivery', id] as const,
};

export function useApiKeys() {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.apiKeys(s), queryFn: () => api.apiKeys.list(), enabled: !!s.tenantId });
}

export function useApiScopes(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.scopes(s), queryFn: () => api.apiKeys.scopes(), enabled: enabled && !!s.tenantId, staleTime: 5 * 60_000 });
}

export function useCreateApiKey() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => api.apiKeys.create(input),
    // Never cache `plain_key`: refetch the list (which has no secret) instead of inserting the created row.
    onSuccess: () => qc.invalidateQueries({ queryKey: devKeys.apiKeys(s) }),
  });
}

function usePutKey() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (row: ApiKey) => qc.setQueryData<ApiKey[]>(devKeys.apiKeys(s), (old) => old?.map((k) => (k.id === row.id ? row : k)));
}

export function useRenameApiKey() {
  const put = usePutKey();
  return useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.apiKeys.rename(id, { name }), onSuccess: put });
}

export function useRevokeApiKey() {
  const put = usePutKey();
  return useMutation({ mutationFn: (id: string) => api.apiKeys.revoke(id), onSuccess: put });
}

export function useEventTypes() {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.eventTypes(s), queryFn: () => api.webhooks.eventTypes(), enabled: !!s.tenantId, staleTime: 5 * 60_000 });
}

export function useWebhookEndpoints() {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.endpoints(s), queryFn: () => api.webhooks.endpoints.list(s.storeId!), enabled: !!s.storeId });
}

export function useWebhookSecret() {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.secret(s), queryFn: () => api.webhooks.secret.get(s.storeId!), enabled: !!s.storeId });
}

/** The last 5 deliveries (Recent deliveries card). */
export function useRecentDeliveries() {
  const s = useStoreScope();
  return useQuery({
    queryKey: devKeys.recent(s),
    queryFn: () => api.webhooks.deliveries.list(s.storeId!, {}),
    enabled: !!s.storeId,
    refetchInterval: 30_000,
  });
}

const DAY_MS = 86_400_000;

/** "Resend failed (n)": failed deliveries of the last 24 h (first page; `more` when it may be longer). */
export function useFailedLastDay() {
  const s = useStoreScope();
  return useQuery({
    queryKey: devKeys.failed(s),
    queryFn: () => api.webhooks.deliveries.list(s.storeId!, { status: 'failed' }),
    enabled: !!s.storeId,
    refetchInterval: 60_000,
    select: (page) => {
      const since = Date.now() - DAY_MS;
      const recent = page.data.filter((d) => d.status === 'failed' && Date.parse(d.created_at) >= since);
      return { count: recent.length, more: !!page.meta.next_cursor && recent.length === page.data.length };
    },
  });
}

/** Deliveries log (drawer): cursor pages of 25. */
export function useDeliveryLog(filters: Omit<WebhookDeliveryFilters, 'cursor'>, enabled: boolean) {
  const s = useStoreScope();
  return useInfiniteQuery({
    queryKey: devKeys.log(s, filters),
    queryFn: ({ pageParam }) => api.webhooks.deliveries.list(s.storeId!, { ...filters, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor,
    enabled: enabled && !!s.storeId,
  });
}

export function useDeliveryDetail(id: string | null) {
  const s = useStoreScope();
  return useQuery({ queryKey: devKeys.delivery(s, id), queryFn: () => api.webhooks.deliveries.get(s.storeId!, id!), enabled: !!s.storeId && !!id, retry: false });
}

/** Endpoint rows + deliveries + secret all move together after a webhook write. */
function useInvalidateWebhooks() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: devKeys.webhooks(s) });
}

export function useSaveEndpoint() {
  const s = useStoreScope();
  const invalidate = useInvalidateWebhooks();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: CreateWebhookEndpointInput | UpdateWebhookEndpointInput }) =>
      id ? api.webhooks.endpoints.update(s.storeId!, id, input) : api.webhooks.endpoints.create(s.storeId!, input as CreateWebhookEndpointInput),
    onSuccess: () => invalidate(),
  });
}

export function useSetEndpointActive() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.webhooks.endpoints.update(s.storeId!, id, { is_active: active }),
    onSuccess: (row) => qc.setQueryData<WebhookEndpoint[]>(devKeys.endpoints(s), (old) => old?.map((e) => (e.id === row.id ? row : e))),
  });
}

export function useDeleteEndpoint() {
  const s = useStoreScope();
  const invalidate = useInvalidateWebhooks();
  return useMutation({ mutationFn: (id: string) => api.webhooks.endpoints.remove(s.storeId!, id), onSuccess: () => invalidate() });
}

export function useTestEndpoint() {
  const s = useStoreScope();
  const invalidate = useInvalidateWebhooks();
  return useMutation({ mutationFn: (id: string) => api.webhooks.endpoints.test(s.storeId!, id), onSuccess: () => invalidate() });
}

export function useRevealSecret() {
  const s = useStoreScope();
  return useMutation({ mutationFn: () => api.webhooks.secret.reveal(s.storeId!) });
}

export function useRotateSecret() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.webhooks.secret.rotate(s.storeId!),
    // Cache only the masked shape; the new plain secret stays in component state (shown once).
    onSuccess: ({ secret: _secret, ...masked }) => qc.setQueryData(devKeys.secret(s), masked),
  });
}

export function useResendDelivery() {
  const s = useStoreScope();
  const invalidate = useInvalidateWebhooks();
  return useMutation({ mutationFn: (id: string) => api.webhooks.deliveries.resend(s.storeId!, id), onSuccess: () => invalidate() });
}

export function useResendFailed() {
  const s = useStoreScope();
  const invalidate = useInvalidateWebhooks();
  return useMutation({ mutationFn: () => api.webhooks.deliveries.resendFailed(s.storeId!), onSuccess: () => invalidate() });
}
