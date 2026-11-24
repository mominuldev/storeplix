import type { BlockNumberInput, FraudGuardEventType, FraudGuardSettings, UpdateFraudGuardSettingsInput } from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { keys, useStoreScope } from '../catalog/scope';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';

// PHASE-8-8 §10: query keys `[tenantId, storeId, 'fraud-guard', …]`. Settings writes refresh the guard keys; block /
// unblock also refresh customers (the "Block this number" card) and orders (badges); releasing a hold refreshes
// `[tenantId, storeId, 'orders']`, the order and the guard log.

type Scope = { tenantId: string | null; storeId: string | null };

export const fraudKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'fraud-guard'] as const,
  settings: (s: Scope) => [s.tenantId, s.storeId, 'fraud-guard', 'settings'] as const,
  overview: (s: Scope, month?: string) => [s.tenantId, s.storeId, 'fraud-guard', 'overview', month ?? null] as const,
  events: (s: Scope, limit: 'recent' | 'all', type: FraudGuardEventType | null = null) => [s.tenantId, s.storeId, 'fraud-guard', 'events', limit, type] as const,
  blocked: (s: Scope, q: string, limit: 'recent' | 'all') => [s.tenantId, s.storeId, 'fraud-guard', 'blocked', limit, q] as const,
};

export function invalidateGuard(qc: QueryClient, s: Scope) {
  return qc.invalidateQueries({ queryKey: fraudKeys.all(s) });
}

/** After block / unblock: the guard page, customers (block card) and orders (badges). */
export function invalidateAfterBlock(qc: QueryClient, s: Scope) {
  return Promise.all([invalidateGuard(qc, s), qc.invalidateQueries({ queryKey: keys.customers(s) }), qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'customer'] }), qc.invalidateQueries({ queryKey: keys.orders(s) })]);
}

export function useGuardSettings(enabled = true) {
  const scope = useStoreScope();
  return useQuery({ queryKey: fraudKeys.settings(scope), queryFn: () => api.fraudGuard.settings.get(scope.storeId!), enabled: !!scope.storeId && enabled, retry: false });
}

export function useGuardOverview() {
  const scope = useStoreScope();
  return useQuery({ queryKey: fraudKeys.overview(scope), queryFn: () => api.fraudGuard.overview(scope.storeId!), enabled: !!scope.storeId, retry: false });
}

/** `recent` = first page only (the guard page shows 5); `all` = the composed log page with "Show more". */
export function useGuardEvents(limit: 'recent' | 'all', type: FraudGuardEventType | null = null) {
  const scope = useStoreScope();
  return useInfiniteQuery({
    queryKey: fraudKeys.events(scope, limit, type),
    queryFn: ({ pageParam }) => api.fraudGuard.events(scope.storeId!, { type: type ? [type] : undefined, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor ?? null,
    enabled: !!scope.storeId,
    retry: false,
  });
}

export function useBlockedNumbers(q: string, limit: 'recent' | 'all') {
  const scope = useStoreScope();
  return useInfiniteQuery({
    queryKey: fraudKeys.blocked(scope, q, limit),
    queryFn: ({ pageParam }) => api.fraudGuard.blockedNumbers.list(scope.storeId!, { q: q || undefined, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor ?? null,
    enabled: !!scope.storeId,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** Autosave per change (§10.1): optimistic cache update, rolled back on error. */
export function useUpdateGuardSettings() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFraudGuardSettingsInput) => api.fraudGuard.settings.update(scope.storeId!, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: fraudKeys.settings(scope) });
      const prev = qc.getQueryData<FraudGuardSettings>(fraudKeys.settings(scope));
      if (prev) qc.setQueryData<FraudGuardSettings>(fraudKeys.settings(scope), { ...prev, ...input });
      return { prev };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(fraudKeys.settings(scope), ctx.prev);
    },
    onSuccess: (data) => {
      qc.setQueryData(fraudKeys.settings(scope), data);
      void qc.invalidateQueries({ queryKey: fraudKeys.overview(scope) });
    },
  });
}

export function useResetGuardSettings() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.fraudGuard.settings.reset(scope.storeId!),
    onSuccess: (data) => {
      qc.setQueryData(fraudKeys.settings(scope), data);
      void qc.invalidateQueries({ queryKey: fraudKeys.overview(scope) });
    },
  });
}

export function useBlockMutations() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const done = () => invalidateAfterBlock(qc, scope);
  return {
    block: useMutation({ mutationFn: (input: BlockNumberInput) => api.fraudGuard.blockedNumbers.create(scope.storeId!, input), onSuccess: done }),
    unblock: useMutation({ mutationFn: (id: string) => api.fraudGuard.blockedNumbers.remove(scope.storeId!, id), onSuccess: done }),
  };
}

export function useCheckNumber() {
  const scope = useStoreScope();
  return useMutation({ mutationFn: (phone: string) => api.fraudGuard.check(scope.storeId!, phone) });
}

/** §5.3 release (`orders.process`): refreshes `[tenantId, storeId, 'orders']`, the order, its customer and the guard log. */
export function useReleaseHold() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useCommerceInvalidate();
  return useMutation({
    mutationFn: (orderId: string) => api.orders.releaseHold(scope.storeId!, orderId),
    onSuccess: async (order) => {
      await Promise.all([invalidate.afterOrderChange(order.id, order.customer.id), invalidateGuard(qc, scope)]);
    },
  });
}
