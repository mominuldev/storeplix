import type { ExpenseCategory, ExpenseInput, UpdateExpenseInput } from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// PHASE-8-7 §10: query keys `[tenantId, storeId, 'expenses', …]`; every write invalidates the expenses prefix and the
// Profit & loss reports prefix `[tenantId, storeId, 'reports', 'profit']` (reports keys end with `from, to`).

type Scope = { tenantId: string | null; storeId: string | null };

export const expenseKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'expenses'] as const,
  summary: (s: Scope, month: string) => [s.tenantId, s.storeId, 'expenses', 'summary', month] as const,
  list: (s: Scope, month: string, category: ExpenseCategory | null) => [s.tenantId, s.storeId, 'expenses', 'list', month, category] as const,
  profitReports: (s: Scope) => [s.tenantId, s.storeId, 'reports', 'profit'] as const,
};

/** After any expense write: refresh the ledger and every cached Profit & loss range. */
export function invalidateAfterExpenseWrite(qc: QueryClient, s: Scope) {
  return Promise.all([qc.invalidateQueries({ queryKey: expenseKeys.all(s) }), qc.invalidateQueries({ queryKey: expenseKeys.profitReports(s) })]);
}

export function useExpenseSummary(month: string) {
  const scope = useStoreScope();
  return useQuery({
    queryKey: expenseKeys.summary(scope, month),
    queryFn: () => api.expenses.summary(scope.storeId!, month),
    enabled: !!scope.storeId,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useExpenseList(month: string, category: ExpenseCategory | null) {
  const scope = useStoreScope();
  return useInfiniteQuery({
    queryKey: expenseKeys.list(scope, month, category),
    queryFn: ({ pageParam }) => api.expenses.list(scope.storeId!, { month, category: category ? [category] : undefined, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.next_cursor ?? null,
    enabled: !!scope.storeId,
    retry: false,
    placeholderData: keepPreviousData,
    // §10.1: "Processing…" until the receipt is ready — poll while any listed receipt is still being re-encoded.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.data.some((e) => e.receipt?.status === 'processing')) ? RECEIPT_POLL_MS : false,
  });
}

export const RECEIPT_POLL_MS = 3000;

export function useExpenseMutations() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const done = () => invalidateAfterExpenseWrite(qc, scope);
  return {
    create: useMutation({ mutationFn: (input: ExpenseInput) => api.expenses.create(scope.storeId!, input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateExpenseInput }) => api.expenses.update(scope.storeId!, id, input), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api.expenses.delete(scope.storeId!, id), onSuccess: done }),
  };
}
