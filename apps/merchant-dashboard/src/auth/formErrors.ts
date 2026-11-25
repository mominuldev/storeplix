import { isApiError } from '@storeplix/api-client';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

/** Maps API validation details onto form fields; returns a form-level message for everything else. */
export function applyApiErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, fields: Path<T>[]): string | null {
  if (isApiError(error)) {
    if (error.isValidation && error.fieldErrors) {
      let mapped = false;
      for (const field of fields) {
        const message = error.fieldError(field);
        if (message) {
          setError(field, { type: 'server', message });
          mapped = true;
        }
      }
      if (mapped) return null;
    }
    if (error.status === 401) return 'Email or password is incorrect.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
