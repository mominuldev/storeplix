import type {
  BillingInvoiceKind,
  SmsCreditPurchaseInput,
  SmsLogFilters,
  SmsSenderIdRequestInput,
  SmsTemplateKey,
  SmsTemplatePreviewInput,
  SmsTestInput,
  UpdateSmsCreditSettingsInput,
} from '@storeplix/types';
import type { UploadOptions } from '@storeplix/api-client';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { api } from '../lib/api';
import { canOpenSms } from './sms';

// PHASE-8-9A §12 server state. Store-scoped keys: [tenantId, storeId, 'sms', …]; tenant-level credits:
// ['billing', tenantId, 'sms-credits', …] (next to the Phase 7 billing keys).

type Scope = { tenantId: string | null; storeId: string | null };

export const smsKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'sms'] as const,
  overview: (s: Scope) => [s.tenantId, s.storeId, 'sms', 'overview'] as const,
  templates: (s: Scope) => [s.tenantId, s.storeId, 'sms', 'templates'] as const,
  preview: (s: Scope, input: SmsTemplatePreviewInput | null) => [s.tenantId, s.storeId, 'sms', 'preview', input] as const,
  senderIds: (s: Scope) => [s.tenantId, s.storeId, 'sms', 'sender-ids'] as const,
  log: (s: Scope, filters: SmsLogFilters) => [s.tenantId, s.storeId, 'sms', 'log', filters] as const,
  credits: (tenantId: string | null) => ['billing', tenantId, 'sms-credits'] as const,
  ledger: (tenantId: string | null) => ['billing', tenantId, 'sms-credits', 'ledger'] as const,
  purchases: (tenantId: string | null, page: number) => ['billing', tenantId, 'invoices', 'sms_credits', page] as const,
};

export function useSmsOverview() {
  const s = useStoreScope();
  return useQuery({ queryKey: smsKeys.overview(s), queryFn: () => api.sms.overview(s.storeId!), enabled: !!s.storeId, retry: false });
}

export function useSmsTemplates({ enabled = true }: { enabled?: boolean } = {}) {
  const s = useStoreScope();
  return useQuery({ queryKey: smsKeys.templates(s), queryFn: () => api.sms.templates.list(s.storeId!), enabled: enabled && !!s.storeId, retry: false });
}

/** Debounced server preview (§7.3); a changed key aborts the previous request via `signal`. */
export function useTemplatePreview(input: SmsTemplatePreviewInput | null) {
  const s = useStoreScope();
  return useQuery({
    queryKey: smsKeys.preview(s, input),
    queryFn: ({ signal }) => api.sms.templates.preview(s.storeId!, input!, { signal }),
    enabled: !!s.storeId && !!input && input.body.trim().length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
}

export function useSenderIds({ enabled = true }: { enabled?: boolean } = {}) {
  const s = useStoreScope();
  return useQuery({ queryKey: smsKeys.senderIds(s), queryFn: () => api.sms.senderIds.list(s.storeId!), enabled: enabled && !!s.storeId, retry: false });
}

export function useSmsLog(filters: SmsLogFilters) {
  const s = useStoreScope();
  return useQuery({
    queryKey: smsKeys.log(s, filters),
    queryFn: () => api.sms.messages(s.storeId!, filters),
    enabled: !!s.storeId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** `GET /billing/sms-credits` — readable by everyone who can open the SMS page. */
export function useSmsCredits() {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({ queryKey: smsKeys.credits(tenantId), queryFn: () => api.billing.smsCredits.get(), enabled: !!tenantId && canOpenSms(activeTenant), retry: false });
}

export function useCreditLedger(enabled: boolean) {
  const { tenantId } = useAuth();
  return useInfiniteQuery({
    queryKey: smsKeys.ledger(tenantId),
    queryFn: ({ pageParam }) => api.billing.smsCredits.ledger({ cursor: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    enabled: enabled && !!tenantId,
    retry: false,
  });
}

const SMS_KIND: BillingInvoiceKind[] = ['sms_credits'];

export function useSmsPurchases(page: number, enabled: boolean) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: smsKeys.purchases(tenantId, page),
    queryFn: () => api.billing.invoices({ kind: SMS_KIND, page, per_page: 10 }),
    enabled: enabled && !!tenantId,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Everything SMS (store + tenant credit keys). */
export function useSmsInvalidate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return () =>
    Promise.all([qc.invalidateQueries({ queryKey: smsKeys.all(s) }), qc.invalidateQueries({ queryKey: smsKeys.credits(s.tenantId) }), qc.invalidateQueries({ queryKey: ['billing', s.tenantId, 'invoices'] })]);
}

export function useSendTestSms() {
  const s = useStoreScope();
  const invalidate = useSmsInvalidate();
  return useMutation({ mutationFn: (input: SmsTestInput) => api.sms.sendTest(s.storeId!, input), onSuccess: () => void invalidate() });
}

export function useSaveTemplate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: SmsTemplateKey; language: 'bn' | 'en'; body: string; revision: number }) => api.sms.templates.update(s.storeId!, v.key, v.language, { body: v.body, revision: v.revision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: smsKeys.templates(s) }),
  });
}

export function useResetTemplate() {
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: SmsTemplateKey; language: 'bn' | 'en' }) => api.sms.templates.reset(s.storeId!, v.key, v.language),
    onSuccess: () => qc.invalidateQueries({ queryKey: smsKeys.templates(s) }),
  });
}

export function useRequestSenderId() {
  const s = useStoreScope();
  const invalidate = useSmsInvalidate();
  return useMutation({
    mutationFn: (v: { input: SmsSenderIdRequestInput; opts?: UploadOptions }) => api.sms.senderIds.request(s.storeId!, v.input, v.opts),
    onSuccess: () => void invalidate(),
  });
}

export function useCancelSenderId() {
  const s = useStoreScope();
  const invalidate = useSmsInvalidate();
  return useMutation({ mutationFn: (id: string) => api.sms.senderIds.cancel(s.storeId!, id), onSuccess: () => void invalidate() });
}

export function useUpdateCreditAlert() {
  const { tenantId } = useAuth();
  const s = useStoreScope();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSmsCreditSettingsInput) => api.billing.smsCredits.update(input),
    onSuccess: (account) => {
      qc.setQueryData(smsKeys.credits(tenantId), account);
      void qc.invalidateQueries({ queryKey: smsKeys.overview(s) });
    },
  });
}

export function usePurchaseCredits() {
  return useMutation({ mutationFn: (v: { input: SmsCreditPurchaseInput; key: string }) => api.billing.smsCredits.purchase(v.input, v.key) });
}
