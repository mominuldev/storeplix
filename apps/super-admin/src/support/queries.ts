import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Query keys for PHASE-8-9C support queue (admin). */
export const supportKeys = {
  all: ['admin', 'support'] as const,
  list: ['admin', 'support', 'list'] as const,
  waiting: ['admin', 'support', 'waiting-count'] as const,
  ticket: (id: string) => ['admin', 'support', 'ticket', id] as const,
  messages: (id: string) => ['admin', 'support', 'ticket', id, 'messages'] as const,
  assignees: ['admin', 'support', 'assignees'] as const,
};

export const QUEUE_POLL_MS = 60_000;
export const THREAD_POLL_MS = 15_000;

/** Sidebar badge (§2.2): `open` + `awaiting_support` from the default queue meta. Undefined while unknown. */
export function useSupportWaitingCount(enabled: boolean): number | undefined {
  const q = useQuery({
    queryKey: supportKeys.waiting,
    queryFn: () => api.admin.support.list({ per_page: 1 }),
    enabled,
    staleTime: QUEUE_POLL_MS,
    refetchInterval: QUEUE_POLL_MS,
  });
  if (!enabled || !q.data) return undefined;
  return q.data.meta.counts.open + q.data.meta.counts.awaiting_support;
}

export function useSupportAssignees(enabled = true) {
  return useQuery({ queryKey: supportKeys.assignees, queryFn: () => api.admin.support.assignees(), enabled, staleTime: 5 * 60_000 });
}
