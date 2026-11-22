import { findCurrentStore, primaryRedirectFor } from '@/lib/store';
import { primaryRedirectResponse, robotsResponse } from '@/lib/seo-files';

export const dynamic = 'force-dynamic';

/**
 * Per-host robots.txt. Unknown, draft and preview views disallow everything; a non-primary host
 * answers 301 to the primary's robots.txt.
 */
export async function GET() {
  const store = await findCurrentStore();
  const target = store ? await primaryRedirectFor(store) : null;
  return target ? primaryRedirectResponse(target) : robotsResponse(store);
}
