import { isApiError, isImpersonationReadOnly, isTenantSuspended } from '@storeplix/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { session } from '../lib/session';
import { toast } from '../online-store/components/Toast';
import { suspension } from './suspension';

export const READ_ONLY_MESSAGE = 'Read-only support session. Changes are disabled.';
const TOAST_GAP_MS = 3000;

/**
 * Contract §7.2 global API error handling, attached to the app's QueryClient caches (so it also covers screens that
 * handle their own errors):
 *  - any mutation failing with 403 `impersonation_read_only` → one toast (debounced; autosaving editors retry often);
 *  - any query or mutation failing with 403 `tenant_suspended` → the suspended screen for the active shop;
 *  - PHASE-8-3 §7.1: any other 403 → refetch `/auth/me` so `permissions` update in place.
 */
export function ApiErrorWatcher() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let lastToast = 0;
    const onError = (error: unknown) => {
      if (isTenantSuspended(error)) suspension.mark(session.getTenantId());
      else if (isApiError(error) && error.status === 403 && !isImpersonationReadOnly(error)) {
        void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      }
    };
    const offMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const error = event.action.error;
      if (isImpersonationReadOnly(error)) {
        const now = Date.now();
        if (now - lastToast > TOAST_GAP_MS) toast(READ_ONLY_MESSAGE, 'error');
        lastToast = now;
      }
      onError(error);
    });
    const offQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      offMutations();
      offQueries();
    };
  }, [queryClient]);

  return null;
}
