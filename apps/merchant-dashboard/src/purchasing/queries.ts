import type {
  CreatePurchaseOrderInput,
  PurchaseOrderListFilters,
  QuickPurchaseInput,
  ReceivePurchaseOrderInput,
  SendPurchaseOrderInput,
  SupplierInput,
  SupplierListFilters,
  SupplierPaymentInput,
  UpdatePurchaseOrderInput,
  UpdateSupplierInput,
} from '@storeplix/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { keys, useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';

// PHASE-8-8B §10: query keys `[tenantId, storeId, 'purchase-orders' | 'suppliers' | 'purchasing', …]`. Every purchasing
// write refreshes the three prefixes; a receipt or quick purchase also refreshes inventory, stock movements, products
// (variant cost changes, §5.4) and the dashboard.

type Scope = { tenantId: string | null; storeId: string | null };

export const purchasingKeys = {
  orders: (s: Scope) => [s.tenantId, s.storeId, 'purchase-orders'] as const,
  orderList: (s: Scope, f: PurchaseOrderListFilters) => [s.tenantId, s.storeId, 'purchase-orders', 'list', f] as const,
  orderSummary: (s: Scope) => [s.tenantId, s.storeId, 'purchase-orders', 'summary'] as const,
  order: (s: Scope, id: string | undefined) => [s.tenantId, s.storeId, 'purchase-orders', 'detail', id] as const,
  suppliers: (s: Scope) => [s.tenantId, s.storeId, 'suppliers'] as const,
  supplierList: (s: Scope, f: SupplierListFilters) => [s.tenantId, s.storeId, 'suppliers', 'list', f] as const,
  supplierSummary: (s: Scope) => [s.tenantId, s.storeId, 'suppliers', 'summary'] as const,
  supplier: (s: Scope, id: string | null | undefined) => [s.tenantId, s.storeId, 'suppliers', 'detail', id] as const,
  purchasing: (s: Scope) => [s.tenantId, s.storeId, 'purchasing'] as const,
  suggestions: (s: Scope) => [s.tenantId, s.storeId, 'purchasing', 'reorder-suggestions'] as const,
};

/** After any purchasing write (PO, supplier, payment). */
export function invalidatePurchasing(qc: QueryClient, s: Scope) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: purchasingKeys.orders(s) }),
    qc.invalidateQueries({ queryKey: purchasingKeys.suppliers(s) }),
    qc.invalidateQueries({ queryKey: purchasingKeys.purchasing(s) }),
  ]);
}

/** After a receipt / quick purchase: stock, movements, incoming, variant cost and the dashboard change too. */
export function invalidateAfterReceipt(qc: QueryClient, s: Scope) {
  return Promise.all([
    invalidatePurchasing(qc, s),
    qc.invalidateQueries({ queryKey: keys.inventory(s) }),
    qc.invalidateQueries({ queryKey: keys.movements(s) }),
    qc.invalidateQueries({ queryKey: keys.products(s) }),
    qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'product'] }),
    qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
  ]);
}

/** Incoming quantities on the inventory list follow PO state (send / close / cancel / edit). */
function invalidateIncoming(qc: QueryClient, s: Scope) {
  return Promise.all([invalidatePurchasing(qc, s), qc.invalidateQueries({ queryKey: keys.inventory(s) })]);
}

export function usePurchaseOrders(filters: PurchaseOrderListFilters, enabled = true) {
  const scope = useStoreScope();
  return useQuery({
    queryKey: purchasingKeys.orderList(scope, filters),
    queryFn: () => api.purchaseOrders.list(scope.storeId!, filters),
    enabled: !!scope.storeId && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function usePurchaseOrderSummary(enabled = true) {
  const scope = useStoreScope();
  return useQuery({ queryKey: purchasingKeys.orderSummary(scope), queryFn: () => api.purchaseOrders.summary(scope.storeId!), enabled: !!scope.storeId && enabled, retry: false });
}

export function usePurchaseOrder(id: string | undefined) {
  const scope = useStoreScope();
  return useQuery({ queryKey: purchasingKeys.order(scope, id), queryFn: () => api.purchaseOrders.get(scope.storeId!, id!), enabled: !!scope.storeId && !!id, retry: false });
}

export function useSuppliers(filters: SupplierListFilters, enabled = true) {
  const scope = useStoreScope();
  return useQuery({
    queryKey: purchasingKeys.supplierList(scope, filters),
    queryFn: () => api.suppliers.list(scope.storeId!, filters),
    enabled: !!scope.storeId && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useSupplierSummary() {
  const scope = useStoreScope();
  return useQuery({ queryKey: purchasingKeys.supplierSummary(scope), queryFn: () => api.suppliers.summary(scope.storeId!), enabled: !!scope.storeId, retry: false });
}

export function useSupplier(id: string | null | undefined) {
  const scope = useStoreScope();
  return useQuery({ queryKey: purchasingKeys.supplier(scope, id), queryFn: () => api.suppliers.get(scope.storeId!, id!), enabled: !!scope.storeId && !!id, retry: false });
}

/** §7 reorder suggestions (`purchasing.manage`). */
export function useReorderSuggestions(enabled = true) {
  const scope = useStoreScope();
  return useQuery({
    queryKey: purchasingKeys.suggestions(scope),
    queryFn: () => api.purchasing.reorderSuggestions(scope.storeId!),
    enabled: !!scope.storeId && enabled,
    retry: false,
    staleTime: 60_000,
  });
}

export function usePurchaseOrderMutations() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const sid = () => scope.storeId!;
  const done = () => invalidateIncoming(qc, scope);
  return {
    create: useMutation({ mutationFn: (input: CreatePurchaseOrderInput) => api.purchaseOrders.create(sid(), input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdatePurchaseOrderInput }) => api.purchaseOrders.update(sid(), id, input), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api.purchaseOrders.delete(sid(), id), onSuccess: done }),
    send: useMutation({ mutationFn: ({ id, input }: { id: string; input: SendPurchaseOrderInput }) => api.purchaseOrders.send(sid(), id, input), onSuccess: done }),
    markOrdered: useMutation({ mutationFn: ({ id, revision }: { id: string; revision?: number }) => api.purchaseOrders.markOrdered(sid(), id, { revision }), onSuccess: done }),
    close: useMutation({ mutationFn: ({ id, revision }: { id: string; revision?: number }) => api.purchaseOrders.close(sid(), id, { revision }), onSuccess: done }),
    cancel: useMutation({ mutationFn: ({ id, revision }: { id: string; revision?: number }) => api.purchaseOrders.cancel(sid(), id, { revision }), onSuccess: done }),
    receive: useMutation({
      mutationFn: ({ id, input, key }: { id: string; input: ReceivePurchaseOrderInput; key: string }) => api.purchaseOrders.receive(sid(), id, input, key),
      onSuccess: () => invalidateAfterReceipt(qc, scope),
    }),
    quick: useMutation({
      mutationFn: ({ input, key }: { input: QuickPurchaseInput; key: string }) => api.purchaseOrders.quick(sid(), input, key),
      onSuccess: () => invalidateAfterReceipt(qc, scope),
    }),
  };
}

export function useSupplierMutations() {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const sid = () => scope.storeId!;
  const done = () => invalidatePurchasing(qc, scope);
  return {
    create: useMutation({ mutationFn: (input: SupplierInput) => api.suppliers.create(sid(), input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSupplierInput }) => api.suppliers.update(sid(), id, input), onSuccess: done }),
    archive: useMutation({ mutationFn: (id: string) => api.suppliers.archive(sid(), id), onSuccess: done }),
    unarchive: useMutation({ mutationFn: (id: string) => api.suppliers.unarchive(sid(), id), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api.suppliers.delete(sid(), id), onSuccess: done }),
    recordPayment: useMutation({ mutationFn: ({ id, input }: { id: string; input: SupplierPaymentInput }) => api.suppliers.recordPayment(sid(), id, input), onSuccess: done }),
    deletePayment: useMutation({ mutationFn: (id: string) => api.supplierPayments.delete(sid(), id), onSuccess: done }),
  };
}
