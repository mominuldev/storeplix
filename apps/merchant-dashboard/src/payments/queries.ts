import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { keys, useStoreScope } from '../catalog/scope';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { settingsKey } from '../settings/schema';

// 5b §10 query key `[…, 'payment-gateways']`. A payment mutation invalidates the order, orders list and dashboard.

export function usePaymentGateways(opts: { refetchInterval?: number | false } = {}) {
  const s = useStoreScope();
  return useQuery({ queryKey: keys.paymentGateways(s), queryFn: () => api.paymentGateways.list(s.storeId!), enabled: !!s.storeId, refetchInterval: opts.refetchInterval });
}

export function usePaymentInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  const commerce = useCommerceInvalidate();
  return {
    /** Gateway connect/patch/disconnect: the list, store settings (payment methods) and the go-live checklist. */
    gateways: useCallback(
      () => Promise.all([qc.invalidateQueries({ queryKey: keys.paymentGateways(s) }), qc.invalidateQueries({ queryKey: settingsKey(s.storeId ?? undefined) }), commerce.launch()]),
      [qc, s, commerce],
    ),
    /** Link create/resend/cancel, gateway refund: the order, the orders list and the dashboard. */
    order: commerce.afterOrderChange,
  };
}
