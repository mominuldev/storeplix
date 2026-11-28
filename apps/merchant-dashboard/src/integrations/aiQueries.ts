import { AI_GENERATION_POLL_MS, type AiGeneration, type AiGenerationFilters, type ApplyPhotoEditInput, type PhotoEditInput, type ProductDescriptionInput } from '@storeplix/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { newIdempotencyKey } from '../commerce/format';
import { api } from '../lib/api';
import { canReadAiCredits, isWorking, POLL_LIMIT_MS } from './ai';
import { integrationKeys } from './queries';

// PHASE-8-9D §10–§11 server state: the shared AI credit pool (tenant-level) and AI generations (store-scoped).

export const aiKeys = {
  credits: (tenantId: string | null) => [tenantId, 'billing', 'ai-credits'] as const,
  generations: (s: { tenantId: string | null; storeId: string | null }) => [s.tenantId, s.storeId, 'ai', 'generations'] as const,
  generation: (s: { tenantId: string | null; storeId: string | null }, id: string) => [s.tenantId, s.storeId, 'ai', 'generation', id] as const,
};

/** `GET /billing/ai-credits` (`products.edit | integrations.manage | billing.view`). */
export function useAiCredits(enabled = true) {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({ queryKey: aiKeys.credits(tenantId), queryFn: () => api.billing.aiCredits.get(), enabled: enabled && !!tenantId && canReadAiCredits(activeTenant), retry: false });
}

/**
 * One generation, polled every 1.5 s while queued/running; polling stops after 2 minutes (`timedOut`), when the
 * caller shows "taking longer than usual" with a retry.
 */
export function useGeneration(id: string | null) {
  const s = useStoreScope();
  const [expiredId, setExpiredId] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => setExpiredId(id), POLL_LIMIT_MS);
    return () => clearTimeout(t);
  }, [id]);
  const expired = !!id && expiredId === id;
  const query = useQuery({
    queryKey: aiKeys.generation(s, id ?? ''),
    queryFn: ({ signal }) => api.ai.generation(s.storeId!, id!, { signal }),
    enabled: !!id && !!s.storeId,
    retry: false,
    refetchInterval: (q) => (isWorking(q.state.data) && !expired ? AI_GENERATION_POLL_MS : false),
  });
  const timedOut = expired && isWorking(query.data);
  return { ...query, timedOut };
}

/** Refresh credits and history after a job is created or settles. */
function useAiInvalidate() {
  const qc = useQueryClient();
  const s = useStoreScope();
  const { tenantId } = useAuth();
  return () => {
    void qc.invalidateQueries({ queryKey: aiKeys.credits(tenantId) });
    void qc.invalidateQueries({ queryKey: aiKeys.generations(s) });
  };
}

/** Seed the polled query with the 202 body so the panel shows "queued" at once. */
function useSeed() {
  const qc = useQueryClient();
  const s = useStoreScope();
  return (g: AiGeneration) => qc.setQueryData(aiKeys.generation(s, g.id), g);
}

/** `POST …/ai/product-descriptions`; one Idempotency-Key per click (P89D-34). */
export function useDescribeProduct() {
  const s = useStoreScope();
  const seed = useSeed();
  const invalidate = useAiInvalidate();
  return useMutation({
    mutationFn: (input: ProductDescriptionInput) => api.ai.describeProduct(s.storeId!, input, newIdempotencyKey()),
    onSuccess: (g) => {
      seed(g);
      invalidate();
    },
    onError: invalidate,
  });
}

export function useEditPhoto() {
  const s = useStoreScope();
  const seed = useSeed();
  const invalidate = useAiInvalidate();
  return useMutation({
    mutationFn: (input: PhotoEditInput) => api.ai.editPhoto(s.storeId!, input, newIdempotencyKey()),
    onSuccess: (g) => {
      seed(g);
      invalidate();
    },
    onError: invalidate,
  });
}

export function useApplyPhoto() {
  const s = useStoreScope();
  const seed = useSeed();
  const invalidate = useAiInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApplyPhotoEditInput }) => api.ai.applyPhoto(s.storeId!, id, input),
    onSuccess: (g) => {
      seed(g);
      invalidate();
    },
  });
}

export function useUndoPhoto() {
  const s = useStoreScope();
  const seed = useSeed();
  const invalidate = useAiInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.ai.undoPhoto(s.storeId!, id),
    onSuccess: (g) => {
      seed(g);
      invalidate();
    },
  });
}

export function useGenerations(filters: AiGenerationFilters, enabled = true) {
  const s = useStoreScope();
  return useQuery({
    queryKey: [...aiKeys.generations(s), filters],
    queryFn: () => api.ai.generations(s.storeId!, filters),
    enabled: enabled && !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Turn an AI tool On (PUT with settings) — Off goes through `useDisconnect` ("Turn off"). */
export function useTurnOnAi<P extends 'ai_writer' | 'ai_photos'>(provider: P) {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.integrations.save<P>>[2]) => api.integrations.save(s.storeId!, provider, input),
    onSuccess: (row) => {
      qc.setQueryData(integrationKeys.one(s, provider), row);
      void qc.invalidateQueries({ queryKey: integrationKeys.list(s) });
    },
  });
}

/** The AI tool row for the product editor (`products.edit` can read it); off / error → no AI button (P89D-2). */
export function useAiToolOn<P extends 'ai_writer' | 'ai_photos'>(provider: P, enabled: boolean) {
  const s = useStoreScope();
  const q = useQuery({ queryKey: integrationKeys.one(s, provider), queryFn: () => api.integrations.get<P>(s.storeId!, provider), enabled: enabled && !!s.storeId, retry: false });
  const row = q.data;
  return { on: !!row && (row.status === 'connected' || row.status === 'needs_attention'), row };
}
