import { isApiError } from '@storeplix/api-client';

export const MAX_TOTP_ATTEMPTS = 5;

export type TotpFailure = { kind: 'wrong'; attemptsLeft: number } | { kind: 'locked' } | { kind: 'expired' } | { kind: 'message'; message: string };

/** 422 `invalid_totp` (details.attempts_left), 404 = login token dropped (5th failure) or expired. */
export function classifyTotpError(error: unknown): TotpFailure {
  if (isApiError(error)) {
    if (error.code === 'invalid_totp') {
      const raw = (error.details as unknown as Record<string, unknown> | undefined)?.attempts_left;
      const value = Array.isArray(raw) ? raw[0] : raw;
      const left = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(left)) return left <= 0 ? { kind: 'locked' } : { kind: 'wrong', attemptsLeft: left };
      return {
        kind: 'message',
        message: 'That code didn’t work. Try the newest code from your app.',
      };
    }
    if (error.status === 404) return { kind: 'expired' };
    if (error.status === 429)
      return {
        kind: 'message',
        message: error.retryAfter ? `Too many attempts. Try again in ${error.retryAfter} s.` : 'Too many attempts. Wait a minute and try again.',
      };
    if (error.isValidation)
      return {
        kind: 'message',
        message: Object.values(error.fieldErrors ?? {})[0]?.[0] ?? error.message,
      };
    return { kind: 'message', message: error.message };
  }
  return {
    kind: 'message',
    message: 'Something went wrong. Please try again.',
  };
}

export const LOCKED_TITLE = 'Account locked for 15 minutes';
export const LOCKED_TEXT = 'Too many incorrect codes. Sign-in is blocked for 15 minutes and the security team has been alerted.';
export const EXPIRED_TEXT = 'Your sign-in timed out. Enter your email and password again.';
