import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';

// PHASE-8-9C §11.3: copy for every Help & support error a member can hit. Unknown codes fall back to the API message.

export function helpErrorText(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  switch (error.code) {
    case 'impersonation_attachment_hidden':
      return 'Attachments are hidden in a support session.';
    case 'help_article_not_found':
      return 'This guide was moved or unpublished.';
    case 'help_category_not_found':
      return 'This topic has no guides right now.';
    case 'support_ticket_closed':
      return 'This ticket is closed. Open a new ticket.';
    case 'support_ticket_limit_reached':
      return 'You have 20 open tickets. Mark some as solved before opening another.';
    case 'support_rating_unavailable':
      return 'Ratings close 14 days after a ticket is solved.';
    case 'support_attachment_processing':
      return 'This file is still being processed. Try again in a moment.';
    case 'rate_limited':
    case 'too_many_requests':
      return 'Too many tries. Wait a little and try again.';
    default:
      if (error.status === 429) return 'Too many tries. Wait a little and try again.';
      return error.fieldErrors ? (Object.values(error.fieldErrors)[0]?.[0] ?? error.message) : errorMessage(error, fallback);
  }
}

export const isNotFound = (error: unknown) => isApiError(error) && error.status === 404;
