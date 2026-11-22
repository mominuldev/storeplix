import type { BdGeo, CouponListFilters, OrderListFilters } from '@storeplix/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// Phase 5a query hooks (contract §9.1): keys `[tenantId, storeId, …]`, geo `['geo','bd']` with staleTime ∞.

export function useGeo() {
  return useQuery({ queryKey: keys.geo(), queryFn: () => api.geo.bd(), staleTime: Infinity, gcTime: Infinity });
}

export interface GeoIndex {
  districts: { code: string; name: string; division_code: string; thanas: { code: string; name: string; is_city: boolean }[] }[];
  districtName: (code: string | null | undefined) => string;
  thanaName: (code: string | null | undefined) => string;
}

export function buildGeoIndex(geo: BdGeo | undefined): GeoIndex {
  const byDistrict = new Map<string, { code: string; name: string; is_city: boolean }[]>();
  const thanaNames = new Map<string, string>();
  for (const t of geo?.thanas ?? []) {
    const list = byDistrict.get(t.district_code) ?? [];
    list.push({ code: t.code, name: t.name, is_city: t.is_city });
    byDistrict.set(t.district_code, list);
    thanaNames.set(t.code, t.name);
  }
  const districts = [...(geo?.districts ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ code: d.code, name: d.name, division_code: d.division_code, thanas: (byDistrict.get(d.code) ?? []).sort((a, b) => a.name.localeCompare(b.name)) }));
  const districtNames = new Map(districts.map((d) => [d.code, d.name]));
  return {
    districts,
    districtName: (c) => (c ? (districtNames.get(c) ?? c) : ''),
    thanaName: (c) => (c ? (thanaNames.get(c) ?? c) : ''),
  };
}

export function useGeoIndex() {
  const geo = useGeo();
  const index = useMemo(() => buildGeoIndex(geo.data), [geo.data]);
  return { ...geo, index };
}

export function useShipping() {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.shipping(s), queryFn: () => api.shipping.get(s.storeId!), enabled: !!s.storeId });
}

export function useOrders(filters: OrderListFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.orders(s, filters), queryFn: () => api.orders.list(s.storeId!, filters), enabled: !!s.storeId && enabled, placeholderData: keepPreviousData });
}

export function useOrder(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.order(s, id), queryFn: () => api.orders.get(s.storeId!, id!), enabled: !!s.storeId && !!id, staleTime: 0 });
}

export function useCoupons(filters: CouponListFilters) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.coupons(s, filters), queryFn: () => api.coupons.list(s.storeId!, filters), enabled: !!s.storeId, placeholderData: keepPreviousData });
}

export function useCoupon(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.coupon(s, id), queryFn: () => api.coupons.get(s.storeId!, id!), enabled: !!s.storeId && !!id });
}

export function useLaunchChecklist(enabled = true) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.launchChecklist(s), queryFn: () => api.launch.checklist(s.storeId!), enabled: !!s.storeId && enabled, retry: false });
}

/** §9.1 invalidation: order mutations refresh the order, lists, dashboard, inventory and the customer. */
export function useCommerceInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return {
    afterOrderChange: useCallback(
      (orderId?: string, customerId?: string | null) =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.orders(s) }),
          qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
          qc.invalidateQueries({ queryKey: keys.inventory(s) }),
          qc.invalidateQueries({ queryKey: keys.customers(s) }),
          qc.invalidateQueries({ queryKey: keys.launchChecklist(s) }),
          ...(orderId ? [qc.invalidateQueries({ queryKey: keys.order(s, orderId) })] : []),
          ...(customerId ? [qc.invalidateQueries({ queryKey: keys.customer(s, customerId) })] : []),
          qc.invalidateQueries({ queryKey: ['features'] }),
        ]),
      [qc, s],
    ),
    coupons: useCallback(
      (couponId?: string) =>
        Promise.all([qc.invalidateQueries({ queryKey: keys.coupons(s) }), ...(couponId ? [qc.invalidateQueries({ queryKey: keys.coupon(s, couponId) })] : [])]),
      [qc, s],
    ),
    shipping: useCallback(() => Promise.all([qc.invalidateQueries({ queryKey: keys.shipping(s) }), qc.invalidateQueries({ queryKey: keys.launchChecklist(s) })]), [qc, s]),
    launch: useCallback(() => qc.invalidateQueries({ queryKey: keys.launchChecklist(s) }), [qc, s]),
  };
}
