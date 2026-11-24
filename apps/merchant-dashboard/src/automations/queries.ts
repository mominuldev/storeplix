import type { AutomationDetail, AutomationDryRunInput, AutomationRunFilters, AutomationStatsDays, RecipeKey, UpdateAutomationInput } from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStoreScope } from '../catalog/scope';
import { campaignKeys } from '../campaigns/queries';
import { api } from '../lib/api';

// PHASE-8-6 §9.1. Keys are store-scoped `[tenantId, storeId, 'automations', …]`.

type Scope = { tenantId: string | null; storeId: string | null };

export const automationKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'automations'] as const,
  list: (s: Scope) => [s.tenantId, s.storeId, 'automations', 'list'] as const,
  detail: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'automations', 'detail', id] as const,
  stats: (s: Scope, id: string | undefined, days: AutomationStatsDays) => [s.tenantId, s.storeId, 'automations', 'stats', id, days] as const,
  runs: (s: Scope, f: Omit<AutomationRunFilters, 'cursor'>) => [s.tenantId, s.storeId, 'automations', 'runs', f] as const,
};

export function useAutomations() {
  const s = useStoreScope();
  return useQuery({ queryKey: automationKeys.list(s), queryFn: () => api.automations.list(s.storeId!), enabled: !!s.storeId });
}

export function useAutomation(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: automationKeys.detail(s, id), queryFn: () => api.automations.get(s.storeId!, id!), enabled: !!s.storeId && !!id, retry: false });
}

export function useAutomationStats(id: string | undefined, days: AutomationStatsDays = 14) {
  const s = useStoreScope();
  return useQuery({ queryKey: automationKeys.stats(s, id, days), queryFn: () => api.automations.stats(s.storeId!, id!, days), enabled: !!s.storeId && !!id });
}

/** Run log / Recent runs / Recent carts (cursor pages of 50, newest first). `poll` in ms (Recent carts: 60 s). */
export function useAutomationRuns(filters: Omit<AutomationRunFilters, 'cursor'>, opts: { enabled?: boolean; poll?: number } = {}) {
  const s = useStoreScope();
  return useInfiniteQuery({
    queryKey: automationKeys.runs(s, filters),
    queryFn: ({ pageParam }) => api.automations.runs(s.storeId!, { ...filters, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor,
    enabled: (opts.enabled ?? true) && !!s.storeId,
    refetchInterval: opts.poll ?? false,
    placeholderData: keepPreviousData,
  });
}

function useInvalidate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return (row?: AutomationDetail) => {
    if (row) qc.setQueryData(automationKeys.detail(s, row.id), row);
    void qc.invalidateQueries({ queryKey: automationKeys.all(s) });
    void qc.invalidateQueries({ queryKey: campaignKeys.overview(s) });
  };
}

export function useCreateAutomation() {
  const s = useStoreScope();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (recipe: RecipeKey) => api.automations.create(s.storeId!, { recipe }), onSuccess: (row) => invalidate(row) });
}

export function useUpdateAutomation() {
  const s = useStoreScope();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAutomationInput }) => api.automations.update(s.storeId!, id, input),
    onSuccess: (row) => invalidate(row),
    // 409 revision_conflict: reload the latest version.
    onError: () => invalidate(),
  });
}

/** ON toggle: enable / disable. */
export function useToggleAutomation() {
  const s = useStoreScope();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? api.automations.enable(s.storeId!, id) : api.automations.disable(s.storeId!, id)),
    onSuccess: (row) => invalidate(row),
  });
}

export function useDeleteAutomation() {
  const s = useStoreScope();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.automations.delete(s.storeId!, id), onSuccess: () => invalidate() });
}

/** P86-21 dry run: no side effects, so it is a mutation the merchant triggers ("Test with an order"). */
export function useDryRun() {
  const s = useStoreScope();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: AutomationDryRunInput }) => api.automations.dryRun(s.storeId!, id, input) });
}

export function useAutomationTestMessage() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, step }: { id: string; step: 1 | 2 }) => api.automations.testMessage(s.storeId!, id, step),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['features', s.tenantId] }),
  });
}
