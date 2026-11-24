import type { CustomerListFilters, InventoryListFilters, ProductListFilters, StockMovementFilters } from '@storeplix/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../lib/api';
import { keys, useStoreScope } from './scope';

export function useCategories() {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.categories(s), queryFn: () => api.categories.list(s.storeId!), enabled: !!s.storeId, select: (r) => r.data });
}

export function useProducts(filters: ProductListFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({
    queryKey: keys.products(s, filters),
    queryFn: () => api.products.list(s.storeId!, filters),
    enabled: !!s.storeId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useProduct(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.product(s, id), queryFn: () => api.products.get(s.storeId!, id!), enabled: !!s.storeId && !!id, staleTime: 0 });
}

export function useInventory(filters: InventoryListFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.inventory(s, filters), queryFn: () => api.inventory.list(s.storeId!, filters), enabled: !!s.storeId && enabled, placeholderData: keepPreviousData });
}

export function useMovements(filters: StockMovementFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.movements(s, filters), queryFn: () => api.inventory.movements(s.storeId!, filters), enabled: !!s.storeId && enabled, placeholderData: keepPreviousData });
}

export function useCustomers(filters: CustomerListFilters) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.customers(s, filters), queryFn: () => api.customers.list(s.storeId!, filters), enabled: !!s.storeId, placeholderData: keepPreviousData });
}

export function useCustomer(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.customer(s, id), queryFn: () => api.customers.get(s.storeId!, id!), enabled: !!s.storeId && !!id });
}

export function useDashboard() {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.dashboard(s), queryFn: () => api.dashboard.get(s.storeId!), enabled: !!s.storeId, retry: false });
}

/** Contract §9.2 invalidation sets. */
export function useInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return {
    afterProductSave: useCallback(
      (productId?: string) =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.products(s) }),
          qc.invalidateQueries({ queryKey: keys.inventory(s) }),
          qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
          qc.invalidateQueries({ queryKey: keys.categories(s) }),
          ...(productId ? [qc.invalidateQueries({ queryKey: keys.product(s, productId) })] : []),
        ]),
      [qc, s],
    ),
    afterAdjustment: useCallback(
      () =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.inventory(s) }),
          qc.invalidateQueries({ queryKey: keys.movements(s) }),
          qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'product'] }),
          qc.invalidateQueries({ queryKey: keys.products(s) }),
          qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
          // PHASE-8-8C: units / value per location (Warehouses tab).
          qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'locations'] }),
        ]),
      [qc, s],
    ),
    categories: useCallback(() => qc.invalidateQueries({ queryKey: keys.categories(s) }), [qc, s]),
    customers: useCallback(
      (id?: string) =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.customers(s) }),
          qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
          ...(id ? [qc.invalidateQueries({ queryKey: keys.customer(s, id) })] : []),
        ]),
      [qc, s],
    ),
  };
}
