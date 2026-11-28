import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import { SMS_TEMPLATE_MAX_PARTS } from '@storeplix/types';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';

// PHASE-8-9A §10.2: copy for every SMS error code the merchant can hit. Unknown codes fall back to the API message.

const fieldsOf = (e: { details?: Record<string, unknown> }): string[] => {
  const f = e.details?.fields;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : [];
};
const tags = (fields: string[]) => fields.map((f) => `{${f}}`).join(', ');

export function smsErrorText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  switch (error.code) {
    case 'sms_credits_exhausted':
      return 'No SMS left this month — buy credits to keep sending.';
    case 'phone_not_verified':
      return 'Verify your phone in your profile first.';
    case 'provider_error':
      return 'The SMS gateway didn’t accept the message. Nothing was charged — try again in a minute.';
    case 'sms_template_read_only':
      return 'This message is managed by Fake order guard and can’t be edited.';
    case 'sms_template_unknown_merge_field':
      return `${tags(fieldsOf(error)) || 'A tag'} isn’t a merge tag for this message. Use the Insert chips.`;
    case 'sms_template_missing_merge_field':
      return `Keep ${tags(fieldsOf(error)) || 'the required tags'} — this message needs it.`;
    case 'sms_template_link_not_allowed':
      return 'Links can’t be typed in. Use the link merge tags instead.';
    case 'sms_template_too_long': {
      const max = typeof error.details?.max_parts === 'number' ? error.details.max_parts : SMS_TEMPLATE_MAX_PARTS;
      return `Too long for one message. Keep it within ${max} parts.`;
    }
    case 'revision_conflict':
      return 'Someone else changed this template. Reload to see their version.';
    case 'sender_id_request_pending':
      return 'You already have a request in review. Cancel it first to ask for another name.';
    case 'sender_id_taken':
      return 'Another business already uses or asked for this sender ID. Pick a different one.';
    case 'sender_id_reserved':
      return 'This name is reserved. Pick a different sender ID.';
    case 'sender_id_unchanged':
      return 'This is already your sender ID.';
    case 'invalid_state_transition':
      return 'This request has changed. Refresh the page to see where it stands.';
    case 'billing_gateway_unavailable':
      return 'That payment method isn’t available right now. Choose another one.';
    case 'provider_unavailable':
      return 'The payment gateway didn’t answer. Nothing was charged — try again.';
    case 'idempotency_key_mismatch':
    case 'idempotency_key_in_use':
      return 'A payment for this pack is already starting. Wait a moment and try again.';
    case 'plan_limit_reached':
      return 'Your plan’s limit is reached.';
    case 'rate_limited':
    case 'too_many_requests':
      return error.retryAfter ? `Too many tries. Try again in ${Math.ceil(error.retryAfter / 60)} min.` : 'Too many tries. Wait a little and try again.';
    default:
      if (error.status === 429) return 'Too many tries. Wait a little and try again.';
      return error.fieldErrors ? (Object.values(error.fieldErrors)[0]?.[0] ?? error.message) : errorMessage(error, fallback);
  }
}
