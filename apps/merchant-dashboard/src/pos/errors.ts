import { isApiError } from '@storeplix/api-client';
import { z } from 'zod';

// PHASE-8-8D §10 error details are read through Zod (trust boundary: the API's `error.details`).

const alreadyOpen = z.object({ session_id: z.string().min(1) });
const closeNote = z.object({
  variance_amount: z.number().int(),
  tolerance_amount: z.number().int(),
});
const lineMessages = z.record(z.string(), z.array(z.string()));

export const errorCode = (e: unknown): string | null => (isApiError(e) ? e.code : null);

/** 409 `register_already_open` → the open session to join. */
export function alreadyOpenSession(e: unknown): string | null {
  if (!isApiError(e) || e.code !== 'register_already_open') return null;
  const parsed = alreadyOpen.safeParse(e.details);
  return parsed.success ? parsed.data.session_id : null;
}

/** 422 `close_note_required` details. */
export function closeNoteDetails(e: unknown): z.infer<typeof closeNote> | null {
  if (!isApiError(e) || e.code !== 'close_note_required') return null;
  const parsed = closeNote.safeParse(e.details);
  return parsed.success ? parsed.data : null;
}

/** 422 `out_of_stock`: `details["lines.{i}.quantity"] = ["Only n left at {location}."]` → line index → message. */
export function outOfStockLines(e: unknown): Record<number, string> {
  if (!isApiError(e) || e.code !== 'out_of_stock') return {};
  const parsed = lineMessages.safeParse(e.details ?? {});
  if (!parsed.success) return {};
  const out: Record<number, string> = {};
  for (const [key, messages] of Object.entries(parsed.data)) {
    const m = /^lines\.(\d+)\.quantity$/.exec(key);
    if (m && messages[0]) out[Number(m[1])] = messages[0];
  }
  return out;
}

/** Status 0 (`network_error`): the request never reached the API. */
export const isNetworkError = (e: unknown) => isApiError(e) && e.status === 0;
