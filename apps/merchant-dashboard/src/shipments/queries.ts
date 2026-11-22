import type { CourierProvider, ShipmentListFilters } from '@storeplix/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';

// 5b §10 query keys `[…, 'shipments', filters]`, `[…, 'shipment', id]`; couriers share WEB-1's `[…, 'couriers']`.

export function useShipments(filters: ShipmentListFilters, opts: { enabled?: boolean } = {}) {
  const s = useStoreScope();
  return useQuery({
    queryKey: keys.shipments(s, filters),
    queryFn: () => api.shipments.list(s.storeId!, filters),
    enabled: !!s.storeId && (opts.enabled ?? true),
    placeholderData: keepPreviousData,
  });
}

export function useShipment(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.shipment(s, id), queryFn: () => api.shipments.get(s.storeId!, id!), enabled: !!s.storeId && !!id, staleTime: 0 });
}

export function useCourierAccounts(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.couriers(s), queryFn: () => api.couriers.list(s.storeId!), enabled: !!s.storeId && enabled, retry: false });
}

export function useCourierAreas(provider: CourierProvider | null, query: { level: 'city' | 'zone' | 'area'; parent_id?: string; district_code?: string; thana_code?: string } | null) {
  const s = useStoreScope();
  return useQuery({
    queryKey: [...keys.couriers(s), provider, 'areas', query] as const,
    queryFn: () => api.couriers.areas(s.storeId!, provider!, query!),
    enabled: !!s.storeId && !!provider && !!query,
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/** §10: a shipment mutation refreshes the order, orders list, shipments and the dashboard. */
export function useShipmentInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  const { afterOrderChange } = useCommerceInvalidate();
  return useCallback(
    (opts: { orderId?: string | null; shipmentId?: string | null } = {}) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.shipments(s) }),
        ...(opts.shipmentId ? [qc.invalidateQueries({ queryKey: keys.shipment(s, opts.shipmentId) })] : []),
        qc.invalidateQueries({ queryKey: keys.couriers(s) }),
        afterOrderChange(opts.orderId ?? undefined),
      ]),
    [qc, s, afterOrderChange],
  );
}
