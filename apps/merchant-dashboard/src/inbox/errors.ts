import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';

// PHASE-8-8E §13.3: copy for every Inbox error code a member can hit. Unknown codes fall back to the API message.

export function inboxErrorText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  switch (error.code) {
    case 'impersonation_attachment_hidden':
      return 'Attachments are hidden in a support session.';
    case 'inbox_assignee_invalid':
      return 'That teammate can’t use the Inbox any more. Pick someone else.';
    case 'inbox_order_locked':
      return 'Order messages always stay with their order.';
    case 'inbox_attachment_processing':
      return 'This photo is still being processed. Try again in a moment.';
    case 'saved_reply_shortcut_taken':
      return 'Another saved reply already uses this shortcut.';
    case 'saved_reply_limit_reached':
      return 'You have 200 saved replies — delete one to add another.';
    case 'saved_reply_unknown_merge_tag': {
      const tags = Array.isArray(error.details?.tags) ? (error.details.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      return `${tags.map((t) => `{${t}}`).join(', ') || 'A tag'} isn’t a merge tag. Use the Insert chips.`;
    }
    case 'inbox_email_unavailable':
      return 'Email replies aren’t available yet. Ask Store Plix support to set up inbound email.';
    case 'revision_conflict':
      return 'Someone else changed this just now. We loaded the latest version.';
    case 'not_found':
      return 'This conversation no longer exists.';
    case 'rate_limited':
    case 'too_many_requests':
      return 'Too many tries. Wait a little and try again.';
    default:
      if (error.status === 429) return 'Too many tries. Wait a little and try again.';
      return error.fieldErrors ? (Object.values(error.fieldErrors)[0]?.[0] ?? error.message) : errorMessage(error, fallback);
  }
}
