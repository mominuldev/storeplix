import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Query keys for PHASE-8-9A admin data (invalidated after every review / adjust). */
export const smsKeys = {
  senderIds: ['admin', 'sender-ids'] as const,
  pendingCount: ['admin', 'sender-ids', 'pending-count'] as const,
  senderId: (id: string) => ['admin', 'sender-ids', 'detail', id] as const,
  credits: (tenantId: string) => ['admin', 'tenant', tenantId, 'sms-credits'] as const,
  ledger: (tenantId: string) => ['admin', 'tenant', tenantId, 'sms-credits', 'ledger'] as const,
};

/** Sidebar badge: `meta.counts.pending` (one tiny list call, refreshed every minute). Undefined while unknown. */
export function usePendingSenderIdCount(enabled: boolean): number | undefined {
  const q = useQuery({
    queryKey: smsKeys.pendingCount,
    queryFn: () => api.admin.senderIds.list({ status: 'pending', per_page: 1 }),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return enabled ? q.data?.meta.counts.pending : undefined;
}

/** `AdminSmsCredits` for the merchant detail usage row and Billing card (`view_merchants`). */
export function useAdminSmsCredits(tenantId: string) {
  return useQuery({ queryKey: smsKeys.credits(tenantId), queryFn: () => api.admin.smsCredits.get(tenantId) });
}
