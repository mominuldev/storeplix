import type { CourierProvider } from '@storeplix/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// 5b §10 query key `[…, 'couriers']` (all three providers, `not_connected` when absent). Shared with WEB-2's booking
// dialog and shipments pages (read-only use).

export function useCouriers() {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.couriers(s), queryFn: () => api.couriers.list(s.storeId!), enabled: !!s.storeId });
}

/** Pathao stores / RedX pickup stores, loaded only once the account is connected. */
export function useCourierPickupStores(provider: CourierProvider, enabled: boolean) {
  const s = useStoreScope();
  return useQuery({
    queryKey: keys.courierPickupStores(s, provider),
    queryFn: () => api.couriers.pickupStores(s.storeId!, provider),
    enabled: enabled && !!s.storeId && provider !== 'steadfast',
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Connect / patch / disconnect: the courier list, plan usage (courier_connections) and the dashboard. */
export function useCourierInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return useCallback(
    () => Promise.all([qc.invalidateQueries({ queryKey: keys.couriers(s) }), qc.invalidateQueries({ queryKey: keys.dashboard(s) }), qc.invalidateQueries({ queryKey: ['features'] })]),
    [qc, s],
  );
}
