import type { DomainListMeta, StoreDomain } from '@storeplix/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { keys, useStoreScope } from '../../catalog/scope';
import { api } from '../../lib/api';
import { settingsKey } from '../../settings/schema';
import { storeKey } from '../../stores/useTenantStore';
import { isMoving } from './domainCopy';

// PHASE-6-CONTRACT §8: query keys `[tenantId, storeId, 'domains']` / `[…, 'domain', id]`; refetch every 15 s while a
// row is moving on its own (pending_verification, verified, ssl_provisioning). TanStack Query pauses interval
// refetches while the tab is hidden (refetchIntervalInBackground defaults to false).

export const POLL_MS = 15_000;

export type DomainList = { data: StoreDomain[]; meta: DomainListMeta };

/** 15 s while any row is moving on its own, else no polling. */
export function domainsPollInterval(rows: Pick<StoreDomain, 'status'>[] | undefined): number | false {
  return rows?.some((d) => isMoving(d.status)) ? POLL_MS : false;
}

export function useDomains() {
  const s = useStoreScope();
  return useQuery({
    queryKey: keys.domains(s),
    queryFn: () => api.domains.list(s.storeId!),
    enabled: !!s.storeId,
    refetchInterval: (q) => domainsPollInterval(q.state.data?.data),
  });
}

export function useDomain(id: string | undefined) {
  const s = useStoreScope();
  return useQuery({
    queryKey: keys.domain(s, id),
    queryFn: ({ signal }) => api.domains.get(s.storeId!, id!, { signal }),
    enabled: !!s.storeId && !!id,
    retry: false,
    refetchInterval: (q) => domainsPollInterval(q.state.data ? [q.state.data] : undefined),
  });
}

/** Writes one updated row into the list and detail caches. */
function usePutRow() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return useCallback(
    (row: StoreDomain) => {
      qc.setQueryData<DomainList>(keys.domains(s), (old) => (old ? { ...old, data: old.data.map((d) => (d.id === row.id ? row : d)) } : old));
      qc.setQueryData(keys.domain(s, row.id), row);
    },
    [qc, s],
  );
}

/** Everything that shows the shop URL or domain usage: store, settings, launch checklist, dashboard, plan usage. */
export function useInvalidateDomains() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.domains(s) }),
        qc.invalidateQueries({ queryKey: keys.domain(s) }),
        qc.invalidateQueries({ queryKey: storeKey(s.tenantId) }),
        qc.invalidateQueries({ queryKey: settingsKey(s.storeId ?? undefined) }),
        qc.invalidateQueries({ queryKey: keys.launchChecklist(s) }),
        qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
        qc.invalidateQueries({ queryKey: ['features'] }),
      ]),
    [qc, s],
  );
}

export function useAddDomain() {
  const s = useStoreScope();
  const invalidate = useInvalidateDomains();
  return useMutation({
    mutationFn: (hostname: string) => api.domains.add(s.storeId!, { hostname }),
    onSuccess: () => invalidate(),
  });
}

export function useRecheckDomain() {
  const s = useStoreScope();
  const put = usePutRow();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.domains.recheck(s.storeId!, id),
    onSuccess: (row) => {
      put(row);
      // A re-check may move the row (and a primary fallback may follow); refresh the list meta too.
      void qc.invalidateQueries({ queryKey: keys.domains(s) });
    },
  });
}

export function useMakePrimary() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useInvalidateDomains();
  return useMutation({
    mutationFn: (id: string) => api.domains.makePrimary(s.storeId!, id),
    onSuccess: (rows) => {
      qc.setQueryData<DomainList>(keys.domains(s), (old) => (old ? { ...old, data: rows } : old));
      return invalidate();
    },
  });
}

export function useRemoveDomain() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useInvalidateDomains();
  return useMutation({
    mutationFn: (id: string) => api.domains.remove(s.storeId!, id),
    onSuccess: (_v, id) => {
      qc.setQueryData<DomainList>(keys.domains(s), (old) => (old ? { ...old, data: old.data.filter((d) => d.id !== id) } : old));
      qc.removeQueries({ queryKey: keys.domain(s, id) });
      return invalidate();
    },
  });
}

/** Per-domain "Check now" cooldown after a 429 (`retry_after` seconds). Returns seconds left (0 = ready). */
export function useCooldowns() {
  const [until, setUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const active = Object.values(until).some((t) => t > now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const start = useCallback((id: string, seconds: number) => {
    const at = Date.now();
    setNow(at);
    setUntil((u) => ({ ...u, [id]: at + seconds * 1000 }));
  }, []);
  const left = useCallback((id: string) => Math.max(0, Math.ceil(((until[id] ?? 0) - now) / 1000)), [until, now]);
  return { start, left };
}
