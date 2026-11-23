import { isStorefrontSuspended } from '@storeplix/types';
import { z } from 'zod';

/** `{data: {availability: "suspended"}}` (openapi 1.9.0 `StorefrontSuspended`); every other field is ignored. */
const SuspendedSchema = z.object({ data: z.object({ availability: z.literal('suspended') }) });

/** True when a `/storefront/config` body is the Phase 8.1 `StorefrontSuspended` answer (P8-12). Edge/proxy safe. */
export function isSuspendedConfigBody(body: unknown): boolean {
  const parsed = SuspendedSchema.safeParse(body);
  return parsed.success && isStorefrontSuspended(parsed.data.data);
}
