import { isApiError } from '@storeplix/api-client';

const byCode: Record<string, string> = {
  forbidden: 'Your role doesn’t allow this action.',
  not_found: 'This record no longer exists.',
  invalid_state_transition: 'This action no longer applies; the record changed. Refresh and try again.',
  invoice_not_open: 'This invoice is no longer open.',
  plan_unchanged: 'The shop is already on this plan and interval.',
  plan_unavailable: 'This plan isn’t available.',
  last_super_admin: 'The last active super admin can’t be disabled or demoted.',
  staff_self_action: 'You can’t do this to your own account. Ask another super admin.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  feature_not_in_plan: 'Not included in the shop’s plan.',
  plan_limit_reached: 'Not included in the shop’s plan.',
  network_error: 'Unable to reach the server. Check your connection.',
  sender_id_taken: 'Another shop already uses or requested this sender ID. Reject this request instead.',
  sms_credits_insufficient: 'The shop doesn’t have that many purchased credits to deduct.',
  document_processing: 'The licence is still being processed. Try again in a minute.',
  idempotency_key_mismatch: 'This change was already submitted with different values. Close the dialog and start again.',
  idempotency_key_in_use: 'This change is still being saved. Wait a moment.',
};

/** One readable sentence for any mutation/query error. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (isApiError(error)) {
    if (error.status === 402) return 'Not included in the shop’s plan.';
    if (error.status === 422 && error.fieldErrors) {
      const first = Object.values(error.fieldErrors)[0];
      if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
    }
    if (error.status === 429 && error.retryAfter) return `Too many requests. Try again in ${error.retryAfter} s.`;
    return byCode[error.code] ?? error.message ?? fallback;
  }
  return fallback;
}
