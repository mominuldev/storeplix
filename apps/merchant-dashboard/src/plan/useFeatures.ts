import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';

export function useFeatures() {
  const { tenantId } = useAuth();
  return useQuery({ queryKey: ['features', tenantId], queryFn: () => api.features.get(), enabled: !!tenantId, retry: false, staleTime: 60_000 });
}

export function trialDaysLeft(trialEndsAt: string | null | undefined, now = Date.now()): number | null {
  if (!trialEndsAt) return null;
  const ms = Date.parse(trialEndsAt) - now;
  return Number.isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 86_400_000));
}

export function planName(code: string | undefined): string {
  if (!code) return 'Plan';
  return code.charAt(0).toUpperCase() + code.slice(1);
}
