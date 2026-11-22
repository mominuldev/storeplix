import { useAuth } from '../auth/AuthProvider';
import { can } from '../lib/permissions';
import { useTenantStore } from '../stores/useTenantStore';

/** Active tenant + store ids, used as the query-key prefix `[tenantId, storeId, …]` (contract §9.2). */
export function useStoreScope() {
  const { tenantId, activeTenant } = useAuth();
  const store = useTenantStore().data ?? null;
  const role = activeTenant?.role;
  return {
    tenantId,
    storeId: store?.id ?? null,
    store,
    role,
    canViewCosts: can.viewCosts(role),
    canManageCatalog: can.manageCatalog(role),
    canBulkData: can.bulkData(role),
    canManageMarketing: can.manageMarketing(role),
    canManageRefunds: can.manageRefunds(role),
    canManageSettings: can.manageSettings(role),
    canManageIntegrations: can.manageIntegrations(role),
    canManageDomains: can.manageDomains(role),
  };
}

type Scope = { tenantId: string | null; storeId: string | null };

export const keys = {
  all: (s: Scope) => [s.tenantId, s.storeId] as const,
  products: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'products'] as const) : ([s.tenantId, s.storeId, 'products', filters] as const)),
  product: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'product', id] as const,
  categories: (s: Scope) => [s.tenantId, s.storeId, 'categories'] as const,
  inventory: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'inventory'] as const) : ([s.tenantId, s.storeId, 'inventory', filters] as const)),
  movements: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'movements'] as const) : ([s.tenantId, s.storeId, 'movements', filters] as const)),
  customers: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'customers'] as const) : ([s.tenantId, s.storeId, 'customers', filters] as const)),
  customer: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'customer', id] as const,
  dashboard: (s: Scope) => [s.tenantId, s.storeId, 'dashboard'] as const,
  import: (s: Scope, id?: string | null) => [s.tenantId, s.storeId, 'import', id] as const,
  importRows: (s: Scope, id: string | null, filter: string) => [s.tenantId, s.storeId, 'import', id, 'rows', filter] as const,
  // Phase 5a §9.1
  orders: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'orders'] as const) : ([s.tenantId, s.storeId, 'orders', filters] as const)),
  order: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'order', id] as const,
  coupons: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'coupons'] as const) : ([s.tenantId, s.storeId, 'coupons', filters] as const)),
  coupon: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'coupon', id] as const,
  shipping: (s: Scope) => [s.tenantId, s.storeId, 'shipping'] as const,
  launchChecklist: (s: Scope) => [s.tenantId, s.storeId, 'launch-checklist'] as const,
  geo: () => ['geo', 'bd'] as const,
  // Phase 5b §10
  returns: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'returns'] as const) : ([s.tenantId, s.storeId, 'returns', filters] as const)),
  return: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'return', id] as const,
  document: (s: Scope, id?: string | null) => [s.tenantId, s.storeId, 'document', id] as const,
  documentTemplates: (s: Scope) => [s.tenantId, s.storeId, 'document-templates'] as const,
  paymentGateways: (s: Scope) => [s.tenantId, s.storeId, 'payment-gateways'] as const,
  // 5b-3 shipments (WEB-2)
  shipments: (s: Scope, filters?: unknown) => (filters === undefined ? ([s.tenantId, s.storeId, 'shipments'] as const) : ([s.tenantId, s.storeId, 'shipments', filters] as const)),
  shipment: (s: Scope, id?: string) => [s.tenantId, s.storeId, 'shipment', id] as const,
  shipmentBatch: (s: Scope, id?: string | null) => [s.tenantId, s.storeId, 'shipment-batch', id] as const,
  couriers: (s: Scope) => [s.tenantId, s.storeId, 'couriers'] as const,
  courierPickupStores: (s: Scope, provider: string) => [s.tenantId, s.storeId, 'couriers', provider, 'pickup-stores'] as const,
  // Phase 6 §8 custom domains
  domains: (s: Scope) => [s.tenantId, s.storeId, 'domains'] as const,
  domain: (s: Scope, id?: string) => (id === undefined ? ([s.tenantId, s.storeId, 'domain'] as const) : ([s.tenantId, s.storeId, 'domain', id] as const)),
};
