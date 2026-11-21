import type { Store } from '@storeplix/types';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';

// Contract D1 (revised): exactly one store per tenant. The active store is the active tenant's store.
export const storeKey = (tenantId: string | null) => ['store', tenantId] as const;

export async function fetchTenantStore(tenantId?: string): Promise<Store | null> {
  const { data } = await api.stores.list({ per_page: 1 }, tenantId ? { tenantId } : undefined);
  return data[0] ?? null;
}

export function useTenantStore() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: storeKey(tenantId),
    queryFn: () => fetchTenantStore(tenantId ?? undefined),
    enabled: !!tenantId,
    retry: false,
  });
}

export function storeDomain(store: Pick<Store, 'primary_domain' | 'slug'>) {
  return store.primary_domain ?? `${store.slug}.storeplix.com`;
}
