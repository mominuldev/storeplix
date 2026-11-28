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
  // PHASE-8-9B §9.3 platform SMS
  sms_provider_driver_unavailable: 'This provider isn’t available yet. Use “Other (HTTP API)” for it meanwhile.',
  sms_provider_name_taken: 'Another provider already has this name. Pick a different name.',
  sms_provider_test_required: 'Send a passing test SMS with these settings before activating.',
  sms_provider_test_failed: 'The test SMS failed, so nothing was saved. The current credentials keep working.',
  sms_provider_is_primary: 'The primary provider can’t be removed. Make another provider primary first.',
  confirmation_mismatch: 'The name you typed doesn’t match. Type it exactly as shown.',
  platform_sms_type_locked: 'This message is locked: it is always on and its text can’t be changed.',
  platform_sms_type_disabled: 'Broadcasts are switched off in Message types. Switch them on first.',
  broadcasts_pending: 'A broadcast is scheduled or sending. Cancel it or wait until it finishes.',
  platform_sms_template_unknown_merge_field: 'The text uses a merge tag this message doesn’t have.',
  platform_sms_template_missing_merge_field: 'The text is missing a required merge tag.',
  platform_sms_template_link_not_allowed: 'Links can’t be typed in. Use the {link} merge tag instead.',
  platform_sms_template_too_long: 'Too long. Keep it within 3 SMS parts.',
  outside_sending_hours: 'Promotional SMS can only go out between 9 AM and 9 PM Bangladesh time.',
  broadcast_estimate_changed: 'The number of recipients changed. Check the new numbers and type the new count.',
  promotional_sender_not_approved: 'The promotional sender mask isn’t approved yet, so broadcasts can’t be scheduled.',
  gateway_balance_insufficient: 'The gateway balance is too low for this broadcast. Top up at the provider first.',
  broadcast_empty_audience: 'Nobody in this audience can receive the broadcast.',
  export_too_large: 'Too many rows to export. Narrow the dates or filters (max 50,000 rows).',
  revision_conflict: 'Someone else changed this. Reload and try again.',
  // PHASE-8-9C §11.3 help center and support
  help_article_not_found: 'This article no longer exists.',
  help_category_not_found: 'This category no longer exists.',
  help_slug_taken: 'Another article already uses this slug. Pick a different one.',
  help_category_slug_taken: 'Another category already uses this slug.',
  help_category_not_empty: 'Move or archive this category’s articles before deleting it.',
  help_category_limit_reached: 'You can have up to 30 categories.',
  help_article_incomplete: 'Fill in the title, summary and article before publishing.',
  help_article_media_missing: 'An image is still processing or failed. Wait a moment or replace it.',
  support_ticket_closed: 'This ticket is closed. The merchant has to open a new ticket.',
  support_assignee_invalid: 'This person can’t be assigned support tickets.',
  support_attachment_processing: 'The file is still being processed. Try again in a moment.',
  impersonation_read_only: 'Read-only session. Changes are disabled.',
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

/** The fixed sentence for a stable error `code`, if there is one (domain 422s whose `details` aren't field messages). */
export function messageForCode(code: string): string | undefined {
  return byCode[code];
}
