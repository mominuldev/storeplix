import { z } from 'zod';

/** The ticket is opaque (32 random bytes, base64url/hex); anything else is not worth a request. */
const TicketSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);

/** Reads `#ticket=…` (a fragment, so it never reaches a server log; P8-9). */
export function ticketFromHash(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('ticket');
  const parsed = TicketSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
