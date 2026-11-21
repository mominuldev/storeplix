import type { ApiError as ApiErrorBody } from '@storeplix/types';

export type ApiErrorDetails = Record<string, string[]>;

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

  /** First message for a field from `details` (Laravel validation shape). */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0];
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
