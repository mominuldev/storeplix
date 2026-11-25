import { ApiError } from '@storeplix/api-client';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';

// ApiErrorDetails accepts non-array values (openapi ApiError.details): field helpers read only string arrays.
describe('errorMessage with mixed details', () => {
  it('uses the first validation message', () => {
    expect(errorMessage(new ApiError(422, 'validation_failed', 'Invalid.', { session_id: 'PS9', name: ['Name is required.'] }))).toBe('Name is required.');
  });

  it('falls back to the message when no detail is a string array', () => {
    expect(errorMessage(new ApiError(422, 'close_note_required', 'Add a note.', { variance_amount: -8000 }))).toBe('Add a note.');
  });
});
