import { NextResponse } from 'next/server';
import { getAvailability } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * `GET /api/availability/{slug}` (P5-29): read-only proxy to the no-store availability endpoint
 * (booleans + low-stock counts only, P5-6). GET only: other methods get 405 from Next (S12).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 200) return NextResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404, headers: NO_STORE });
  const ctx = await getCommerceContext();
  if (!ctx) return NextResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404, headers: NO_STORE });
  const data = await getAvailability(ctx.store.host, slug, ctx.call.previewToken);
  if (!data) return NextResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ data }, { headers: NO_STORE });
}
