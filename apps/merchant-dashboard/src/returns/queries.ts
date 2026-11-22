import type { ReturnListFilters } from '@storeplix/api-client';
import type { ReturnRequest } from '@storeplix/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys, useStoreScope } from '../catalog/scope';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';

// 5b §10 query keys `[…, 'returns', filters]`, `[…, 'return', id]`.

export function useReturns(filters: ReturnListFilters) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.returns(s, filters), queryFn: () => api.returns.list(s.storeId!, filters), enabled: !!s.storeId, placeholderData: keepPreviousData });
}

export function useReturn(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.return(s, id), queryFn: () => api.returns.get(s.storeId!, id!), enabled: !!s.storeId && !!id, staleTime: 0 });
}

/** A return write refreshes the returns list, the return, and the order (with its lists, inventory and dashboard). */
export function useReturnInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  const commerce = useCommerceInvalidate();
  return (r: Pick<ReturnRequest, 'id' | 'order'>) =>
    Promise.all([qc.invalidateQueries({ queryKey: keys.returns(s) }), qc.invalidateQueries({ queryKey: keys.return(s, r.id) }), commerce.afterOrderChange(r.order.id)]);
}
