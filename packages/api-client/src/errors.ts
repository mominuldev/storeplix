import type { ApiError as ApiErrorBody, ApiErrorDetailValue } from '@storeplix/types';

/**
 * `error.details` as sent: Laravel validation messages (`string[]` per field) or any other value for domain errors
 * (e.g. `session_id`, `variance_amount`, a fresh `quote`; openapi `ApiError.details`, PHASE-8-8D §5.4).
 */
export type ApiErrorDetails = Record<string, ApiErrorDetailValue>;
/** Field → messages: only the `string[]` entries of `details`. */
export type ApiFieldErrors = Record<string, string[]>;

/** The `string[]` entries of `details` (non-string items dropped); undefined when there are none. */
export function fieldErrorsOf(details: ApiErrorDetails | null | undefined): ApiFieldErrors | undefined {
  if (!details) return undefined;
  const out: ApiFieldErrors = {};
  for (const [key, value] of Object.entries(details)) {
    if (!Array.isArray(value)) continue;
    const messages = (value as readonly unknown[]).filter((m): m is string => typeof m === 'string');
    if (messages.length) out[key] = messages;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Thrown for every non-2xx response, network failure or malformed body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiErrorDetails;
  /** Seconds until retry is allowed (429 `otp_rate_limited`, `rate_limited`). */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, details?: ApiErrorDetails, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isValidation(): boolean {
    return this.status === 422;
  }

  /** Validation messages per field: only the array values of `details`; undefined when there are none. */
  get fieldErrors(): ApiFieldErrors | undefined {
    return fieldErrorsOf(this.details);
  }

  /** First message for a field from `details` (Laravel validation shape). */
  fieldError(field: string): string | undefined {
    return this.fieldErrors?.[field]?.[0];
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isErrorEnvelope(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const err = (body as { error: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}
