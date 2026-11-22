import { NextResponse, type NextRequest } from 'next/server';
import { fetchShippingQuote } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';
import { errorMessage } from '@/lib/commerce-messages';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** `GET /api/shipping-quote?district_code&thana_code` (checkout zone refresh). GET only (S12). */
export async function GET(req: NextRequest) {
  const district = req.nextUrl.searchParams.get('district_code') ?? '';
  const thana = req.nextUrl.searchParams.get('thana_code') ?? '';
  if (!CODE.test(district) || !CODE.test(thana) || district.length > 48 || thana.length > 48) {
    return NextResponse.json({ error: { code: 'validation_failed', message: 'Choose your district and thana.' } }, { status: 422, headers: NO_STORE });
  }
  const ctx = await getCommerceContext();
  if (!ctx?.call.cartToken) return NextResponse.json({ error: { code: 'cart_not_found', message: errorMessage({ code: 'cart_not_found', message: '', details: {} }) } }, { status: 404, headers: NO_STORE });
  const r = await fetchShippingQuote(ctx.call, district, thana);
  if (r.ok) return NextResponse.json({ data: r.data }, { headers: NO_STORE });
  return NextResponse.json({ error: { code: r.code, message: errorMessage(r) } }, { status: r.status >= 400 && r.status < 600 ? r.status : 502, headers: NO_STORE });
}
