import { z } from 'zod';

/** PHASE-8-1 conventions: every admin write takes `reason`, 5–500 chars, trimmed; it lands in the audit log. */
export const reasonSchema = z.string().trim().min(5, 'Enter a reason of at least 5 characters').max(500, 'Keep the reason under 500 characters');
