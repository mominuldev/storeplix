import { isApiError } from '@storeplix/api-client';
import type { PlatformSmsBroadcastFilters, PlatformSmsLogFilters } from '@storeplix/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../../lib/api';
import { errorMessage, messageForCode } from '../../lib/errors';

/** PHASE-8-9B query keys (everything under one root so a provider write refreshes the whole page). */
export const platformSmsKeys = {
  root: ['admin', 'platform-sms'] as const,
  overview: ['admin', 'platform-sms', 'overview'] as const,
  drivers: ['admin', 'platform-sms', 'drivers'] as const,
  alerts: ['admin', 'platform-sms', 'alerts'] as const,
  messageTypes: ['admin', 'platform-sms', 'message-types'] as const,
  broadcasts: (f: PlatformSmsBroadcastFilters) => ['admin', 'platform-sms', 'broadcasts', f] as const,
  audiences: ['admin', 'platform-sms', 'audiences'] as const,
  recipients: (id: string, cursor: string | undefined) => ['admin', 'platform-sms', 'recipients', id, cursor ?? null] as const,
  messages: (f: PlatformSmsLogFilters) => ['admin', 'platform-sms', 'messages', f] as const,
};

export function useProviderOverview() {
  return useQuery({ queryKey: platformSmsKeys.overview, queryFn: () => api.admin.platformSms.providers.overview() });
}

export function useDrivers(enabled = true) {
  return useQuery({ queryKey: platformSmsKeys.drivers, queryFn: () => api.admin.platformSms.drivers(), staleTime: 10 * 60_000, enabled });
}

/** Shell banner (§11): refetched on route change, stale after 60 s. */
export function usePlatformSmsAlerts(enabled: boolean) {
  return useQuery({ queryKey: platformSmsKeys.alerts, queryFn: () => api.admin.platformSms.alerts(), staleTime: 60_000, enabled });
}

export function useInvalidatePlatformSms() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: platformSmsKeys.root }), [qc]);
}

/** Error text for the platform SMS screens: template codes carry `{fields}` / `{parts}` details, not field messages. */
export function smsErrorText(error: unknown): string {
  if (isApiError(error)) {
    const d = (error.details ?? {}) as Record<string, unknown>;
    const fields = Array.isArray(d.fields) ? (d.fields as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    switch (error.code) {
      case 'platform_sms_template_unknown_merge_field':
        return `${fields.map((f) => `{${f}}`).join(', ') || 'A tag'} isn’t a merge tag for this message.`;
      case 'platform_sms_template_missing_merge_field':
        return `Keep ${fields.map((f) => `{${f}}`).join(', ') || 'the required tags'} — this message needs it.`;
      case 'platform_sms_template_too_long':
        return typeof d.parts === 'number' ? `Too long: ${d.parts} SMS parts. Keep it within ${typeof d.max_parts === 'number' ? d.max_parts : 3}.` : errorMessage(error);
      case 'sms_provider_test_failed': {
        const detail = typeof d.detail === 'string' && d.detail ? ` (${d.detail})` : '';
        return `The test SMS with the new credentials failed${detail}. Nothing was saved; the current credentials keep working.`;
      }
      default:
        if (error.status === 409 || error.status === 422) {
          const known = messageForCode(error.code);
          if (known && !error.fieldErrors) return known;
        }
    }
  }
  return errorMessage(error);
}
