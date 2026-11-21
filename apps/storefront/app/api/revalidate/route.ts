import { revalidateTag } from 'next/cache';
import { serverEnv } from '@/lib/env';
import { storeTag } from '@/lib/cache-tags';
import { bearerToken, parseRevalidateBody, secretMatches } from '@/lib/revalidate';

/**
 * POST /api/revalidate  (called by Laravel when a merchant publishes)
 *   Authorization: Bearer <REVALIDATE_SECRET>
 *   { "host": "demo.storeplix.com" }  or  { "hosts": ["a.storeplix.com", "shop.example.com"] }
 * Expires the `store:{host}` cache tag so the next request fetches fresh config.
 */
export async function POST(request: Request) {
  const secret = serverEnv.revalidateSecret;
  if (!secret) {
    return Response.json({ error: { code: 'revalidate_disabled', message: 'Revalidation is not configured' } }, { status: 503 });
  }
  if (!secretMatches(bearerToken(request.headers.get('authorization')), secret)) {
    return Response.json({ error: { code: 'unauthorized', message: 'Invalid revalidation secret' } }, { status: 401 });
  }

  const hosts = parseRevalidateBody(await request.json().catch(() => null));
  if (!hosts) {
    return Response.json(
      { error: { code: 'validation_failed', message: 'Body must be {"host": string} or {"hosts": string[]} with valid hostnames' } },
      { status: 422 },
    );
  }

  // Publish must show immediately: expire now rather than serve stale-while-revalidate.
  for (const host of hosts) revalidateTag(storeTag(host), { expire: 0 });
  return Response.json({ data: { revalidated: hosts } });
}
