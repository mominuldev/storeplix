import type { ReportMeta } from '@storeplix/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';
import type { ReportRange } from './range';

export type ReportType = 'sales' | 'profit' | 'delivery';

export function reportKey(tenantId: string | null, storeId: string | null, type: ReportType, range: Pick<ReportRange, 'from' | 'to'>) {
  return [tenantId, storeId, 'reports', type, range.from, range.to] as const;
}

/** §8.3: query keys `[tenantId, storeId, 'reports', type, from, to]`, staleTime 60 s. */
export function useReport<T>(type: ReportType, range: ReportRange, fetcher: (storeId: string) => Promise<{ data: T; meta: ReportMeta }>, enabled = true) {
  const scope = useStoreScope();
  return useQuery({
    queryKey: reportKey(scope.tenantId, scope.storeId, type, range),
    queryFn: () => fetcher(scope.storeId!),
    enabled: enabled && !!scope.storeId,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export const fetchers = {
  sales: (range: ReportRange) => (storeId: string) => api.reports.sales(storeId, { from: range.from, to: range.to }),
  profit: (range: ReportRange) => (storeId: string) => api.reports.profit(storeId, { from: range.from, to: range.to }),
  delivery: (range: ReportRange) => (storeId: string) => api.reports.delivery(storeId, { from: range.from, to: range.to }),
};

