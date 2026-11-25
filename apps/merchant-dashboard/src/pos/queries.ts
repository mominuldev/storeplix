import { isApiError } from '@storeplix/api-client';
import type { OrderCustomerSummary, PosQuoteInput, PosRegisterInput, PosSaleListFilters } from '@storeplix/types';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// PHASE-8-8D part A server state. Keys: [tenantId, storeId, 'pos', …] (contract §9.2 pattern).

type Scope = { tenantId: string | null; storeId: string | null };

export const posKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'pos'] as const,
  registers: (s: Scope) => [s.tenantId, s.storeId, 'pos', 'registers'] as const,
  session: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'pos', 'session', id] as const,
  catalog: (s: Scope, registerId: string | undefined, q: string, categoryId: string) => [s.tenantId, s.storeId, 'pos', 'catalog', registerId, q, categoryId] as const,
  quote: (s: Scope, input: PosQuoteInput | null) => [s.tenantId, s.storeId, 'pos', 'quote', input] as const,
  customer: (s: Scope, phone: string | null) => [s.tenantId, s.storeId, 'pos', 'customer', phone] as const,
  held: (s: Scope, registerId: string | undefined) => [s.tenantId, s.storeId, 'pos', 'held', registerId] as const,
  sales: (s: Scope, filters?: PosSaleListFilters) => (filters ? ([s.tenantId, s.storeId, 'pos', 'sales', filters] as const) : ([s.tenantId, s.storeId, 'pos', 'sales'] as const)),
  sale: (s: Scope, id: string | null | undefined) => [s.tenantId, s.storeId, 'pos', 'sale', id] as const,
};

export function usePosRegisters() {
  const s = useStoreScope();
  return useQuery({
    queryKey: posKeys.registers(s),
    queryFn: () => api.pos.registers.list(s.storeId!),
    enabled: !!s.storeId,
  });
}

/** §6.2: the POS bar polls the session every 30 s (and after each write via invalidation). `poll` in ms. */
export function usePosSession(id: string | undefined, { poll = false }: { poll?: number | false } = {}) {
  const s = useStoreScope();
  return useQuery({
    queryKey: posKeys.session(s, id),
    queryFn: () => api.pos.sessions.get(s.storeId!, id!),
    enabled: !!s.storeId && !!id,
    refetchInterval: poll,
  });
}

export function usePosCatalog(registerId: string | undefined, q: string, categoryId: string) {
  const s = useStoreScope();
  return useInfiniteQuery({
    queryKey: posKeys.catalog(s, registerId, q, categoryId),
    queryFn: ({ pageParam, signal }) =>
      api.pos.catalog(
        s.storeId!,
        {
          register_id: registerId!,
          q: q || undefined,
          category_id: categoryId || undefined,
          cursor: pageParam || undefined,
        },
        { signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    enabled: !!s.storeId && !!registerId,
    placeholderData: keepPreviousData,
  });
}

/** §5.1 cart totals (read-only). `input` null = empty cart, no request. */
export function usePosQuote(input: PosQuoteInput | null) {
  const s = useStoreScope();
  return useQuery({
    queryKey: posKeys.quote(s, input),
    queryFn: ({ signal }) => api.pos.quote(s.storeId!, input!, { signal }),
    enabled: !!s.storeId && !!input && input.lines.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
}

/** §5.3 exact phone lookup; 404 → `null` (a new customer). */
export function usePosCustomer(phone: string | null) {
  const s = useStoreScope();
  return useQuery({
    queryKey: posKeys.customer(s, phone),
    queryFn: async (): Promise<OrderCustomerSummary | null> => {
      try {
        return await api.pos.customerLookup(s.storeId!, phone!);
      } catch (e) {
        if (isApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!s.storeId && !!phone,
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateRegister() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PosRegisterInput) => api.pos.registers.create(s.storeId!, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: posKeys.registers(s) }),
  });
}

/** P88D-21: the browser's online state (Charge is disabled while offline). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** §11.6 held sales of one register (newest first). */
export function usePosHeld(registerId: string | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: posKeys.held(s, registerId), queryFn: () => api.pos.held.list(s.storeId!, registerId!), enabled: !!s.storeId && !!registerId });
}

/** §11.7 history: cursor pages + `meta.summary` (KPIs come from the first page). */
export function usePosSales(filters: PosSaleListFilters, enabled = true) {
  const s = useStoreScope();
  return useInfiniteQuery({
    queryKey: posKeys.sales(s, filters),
    queryFn: ({ pageParam }) => api.pos.sales.list(s.storeId!, { ...filters, cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
  });
}

export function usePosSale(id: string | null | undefined) {
  const s = useStoreScope();
  return useQuery({ queryKey: posKeys.sale(s, id), queryFn: () => api.pos.sales.get(s.storeId!, id!), enabled: !!s.storeId && !!id });
}
