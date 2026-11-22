import 'server-only';
import { headers } from 'next/headers';
import { clientIpFromHeaders } from './commerce-request';
import { isTrustedProxy } from './host';

/**
 * Shopper IP for no-store (preview) storefront calls, so they count toward the per-shopper limit
 * (PHASE-5B-CONTRACT §2.10). Public cached calls never carry it: their body is shared by every visitor.
 */
export async function previewClientIp(previewToken: string | null): Promise<string | null> {
  if (!previewToken) return null;
  try {
    return clientIpFromHeaders(await headers(), isTrustedProxy());
  } catch {
    // Outside a request scope (build steps, tests): no shopper, so the call counts toward the store-host limit only.
    return null;
  }
}
