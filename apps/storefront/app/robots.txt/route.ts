import { findCurrentStore } from '@/lib/store';
import { robotsResponse } from '@/lib/seo-files';

export const dynamic = 'force-dynamic';

/** Per-host robots.txt. Unknown, draft and preview views disallow everything. */
export async function GET() {
  return robotsResponse(await findCurrentStore());
}
