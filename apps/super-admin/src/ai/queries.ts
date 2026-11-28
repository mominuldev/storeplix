import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Query keys for PHASE-8-9D §10.4 admin AI credits (invalidated after every adjust). */
export const aiKeys = {
  credits: (tenantId: string) => ['admin', 'tenant', tenantId, 'ai-credits'] as const,
  ledger: (tenantId: string) => ['admin', 'tenant', tenantId, 'ai-credits', 'ledger'] as const,
};

/** `AdminAiCredits` for the merchant detail usage row and Billing card (`view_merchants`). */
export function useAdminAiCredits(tenantId: string) {
  return useQuery({ queryKey: aiKeys.credits(tenantId), queryFn: () => api.admin.aiCredits.get(tenantId) });
}
