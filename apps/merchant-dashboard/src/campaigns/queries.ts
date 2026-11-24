import { isApiError } from '@storeplix/api-client';
import type {
  AudiencePreviewInput,
  Campaign,
  CampaignEstimateInput,
  CampaignListFilters,
  CampaignRecipientFilters,
  CreateCampaignInput,
  MarketingChannel,
  MarketingRange,
  UpdateCampaignInput,
} from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// PHASE-8-5 §6.1 / §8. Keys are store-scoped `[tenantId, storeId, 'campaigns', …]` and `[…, 'marketing', …]`.

type Scope = { tenantId: string | null; storeId: string | null };

export const campaignKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'campaigns'] as const,
  list: (s: Scope, f: CampaignListFilters) => [s.tenantId, s.storeId, 'campaigns', 'list', f] as const,
  detail: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'campaigns', 'detail', id] as const,
  recipients: (s: Scope, id: string, f: Omit<CampaignRecipientFilters, 'cursor'>) => [s.tenantId, s.storeId, 'campaigns', 'recipients', id, f] as const,
  preview: (s: Scope, input: AudiencePreviewInput) => [s.tenantId, s.storeId, 'campaigns', 'audience-preview', input] as const,
  estimate: (s: Scope, input: CampaignEstimateInput) => [s.tenantId, s.storeId, 'campaigns', 'estimate', input] as const,
  overview: (s: Scope, range?: MarketingRange) => (range ? ([s.tenantId, s.storeId, 'marketing', 'overview', range] as const) : ([s.tenantId, s.storeId, 'marketing'] as const)),
};

export function useMarketingOverview(range: MarketingRange) {
  const s = useStoreScope();
  return useQuery({ queryKey: campaignKeys.overview(s, range), queryFn: () => api.marketing.overview(s.storeId!, range), enabled: !!s.storeId, placeholderData: keepPreviousData });
}

export function useCampaigns(filters: CampaignListFilters) {
  const s = useStoreScope();
  return useQuery({ queryKey: campaignKeys.list(s, filters), queryFn: () => api.campaigns.list(s.storeId!, filters), enabled: !!s.storeId, placeholderData: keepPreviousData });
}

/** Detail; polls every 5 s while `sending` (§8.4). */
export function useCampaign(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({
    queryKey: campaignKeys.detail(s, id),
    queryFn: () => api.campaigns.get(s.storeId!, id!),
    enabled: !!s.storeId && !!id,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'sending' ? 5_000 : false),
  });
}

export function useCampaignRecipients(id: string, filters: Omit<CampaignRecipientFilters, 'cursor'>, opts: { enabled: boolean; poll: boolean }) {
  const s = useStoreScope();
  return useInfiniteQuery({
    queryKey: campaignKeys.recipients(s, id, filters),
    queryFn: ({ pageParam }) => api.campaigns.recipients(s.storeId!, id, { ...filters, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor,
    enabled: opts.enabled && !!s.storeId,
    refetchInterval: opts.poll ? 5_000 : false,
  });
}

/**
 * Debounced copy of a plain-JSON value, keyed on its content (not object identity, which changes every render and kept
 * resetting the timer — P85-QA-1). The first value is returned at once.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [state, setState] = useState(() => ({ key, value }));
  useEffect(() => {
    if (key === state.key) return;
    const id = setTimeout(() => setState({ key, value: JSON.parse(key) as T }), ms);
    return () => clearTimeout(id);
  }, [key, ms, state.key]);
  return state.value;
}

/** Debounced `audience-preview` (§8.3 step 2); `enabled` false while the params are incomplete. */
export function useAudiencePreview(input: AudiencePreviewInput, enabled: boolean) {
  const s = useStoreScope();
  const debounced = useDebouncedValue(input, 400);
  return useQuery({
    queryKey: campaignKeys.preview(s, debounced),
    queryFn: ({ signal }) => api.campaigns.audiencePreview(s.storeId!, debounced, { signal }),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    // 30/min limiter (P85-QA-8): try again after the window instead of leaving a stale error.
    retry: (n, e) => isApiError(e) && e.status === 429 && n < 2,
    retryDelay: (_n, e) => (isApiError(e) && e.retryAfter ? e.retryAfter * 1000 : 15_000),
    staleTime: 30_000,
  });
}

/** Debounced `estimate` (Allowance card); re-runs whenever the audience or content changes. */
export function useCampaignEstimate(input: CampaignEstimateInput, enabled: boolean) {
  const s = useStoreScope();
  const debounced = useDebouncedValue(input, 600);
  return useQuery({
    queryKey: campaignKeys.estimate(s, debounced),
    queryFn: ({ signal }) => api.campaigns.estimate(s.storeId!, debounced, { signal }),
    // Gate on the debounced input so a request never goes out with an older body than the one that enabled it.
    enabled: enabled && !!debounced.body.trim() && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

/** A fresh estimate for exactly this input (the confirm dialog must never show stale numbers — P85-QA-1). */
export function useFetchEstimate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (input: CampaignEstimateInput) =>
    qc.fetchQuery({ queryKey: campaignKeys.estimate(s, input), queryFn: ({ signal }) => api.campaigns.estimate(s.storeId!, input, { signal }), staleTime: 0 });
}

function useInvalidateCampaigns() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (row?: Campaign) => {
    if (row) qc.setQueryData(campaignKeys.detail(s, row.id), row);
    void qc.invalidateQueries({ queryKey: campaignKeys.all(s) });
    void qc.invalidateQueries({ queryKey: campaignKeys.overview(s) });
    void qc.invalidateQueries({ queryKey: ['features', s.tenantId] });
  };
}

export function useSaveCampaign() {
  const s = useStoreScope();
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: CreateCampaignInput | UpdateCampaignInput }) =>
      id ? api.campaigns.update(s.storeId!, id, input as UpdateCampaignInput) : api.campaigns.create(s.storeId!, input as CreateCampaignInput),
    onSuccess: (row) => invalidate(row),
  });
}

export type CampaignCommand = 'cancel' | 'unschedule' | 'duplicate';

export function useCampaignCommand() {
  const s = useStoreScope();
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: CampaignCommand }) => api.campaigns[command](s.storeId!, id),
    onSuccess: (row) => invalidate(row),
  });
}

export function useDeleteCampaign() {
  const s = useStoreScope();
  const invalidate = useInvalidateCampaigns();
  return useMutation({ mutationFn: (id: string) => api.campaigns.delete(s.storeId!, id), onSuccess: () => invalidate() });
}

export function useSendTest() {
  const s = useStoreScope();
  const invalidate = useInvalidateCampaigns();
  return useMutation({ mutationFn: (id: string) => api.campaigns.sendTest(s.storeId!, id), onSuccess: () => invalidate() });
}

/**
 * Schedule / send now. `onLaunched` runs before any cache write so the caller can leave the composer first: writing the
 * `sending` campaign into the cache while the composer is mounted flipped it into "can't be edited" (P85-QA-3).
 */
export function useLaunchCampaign(onLaunched: (row: Campaign) => void) {
  const s = useStoreScope();
  const invalidate = useInvalidateCampaigns();
  return useMutation({
    mutationFn: ({ id, scheduledAt, idempotencyKey }: { id: string; scheduledAt: string | null; idempotencyKey: string }) =>
      scheduledAt ? api.campaigns.schedule(s.storeId!, id, { scheduled_at: scheduledAt }, idempotencyKey) : api.campaigns.send(s.storeId!, id, idempotencyKey),
    onSuccess: (row) => {
      onLaunched(row);
      invalidate(row);
    },
  });
}

/** Customer detail "Stop marketing messages" / "Allow again" (§8.5). */
export function useCustomerOptOut(customerId: string) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, stop }: { channel: MarketingChannel; stop: boolean }) =>
      stop ? api.customers.marketingOptOut(s.storeId!, customerId, channel) : api.customers.removeMarketingOptOut(s.storeId!, customerId, channel),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.customer(s, customerId) });
      void qc.invalidateQueries({ queryKey: keys.customers(s) });
    },
  });
}
