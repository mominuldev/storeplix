import { NextResponse, type NextRequest } from 'next/server';
import { fetchPaymentResult } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';
import { PAYMENT_ID_RE } from '@/lib/commerce-schemas';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * `GET /api/payment-status?payment=` (PHASE-5B-CONTRACT §11): the pending payment-result page polls
 * this every 2 s. Returns only `{ data: { status } }` (no amounts, names or tokens). GET only (S12).
 */
export async function GET(req: NextRequest) {
  const payment = req.nextUrl.searchParams.get('payment') ?? '';
  if (!PAYMENT_ID_RE.test(payment)) {
    return NextResponse.json({ error: { code: 'validation_failed', message: 'Unknown payment.' } }, { status: 422, headers: NO_STORE });
  }
  const ctx = await getCommerceContext();
  if (!ctx) return NextResponse.json({ error: { code: 'not_found', message: 'Unknown payment.' } }, { status: 404, headers: NO_STORE });
  const r = await fetchPaymentResult(ctx.call, payment);
  if (r.ok) return NextResponse.json({ data: { status: r.data.status } }, { headers: NO_STORE });
  const status = r.status === 404 ? 404 : r.status === 429 ? 429 : 502;
  return NextResponse.json({ error: { code: status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'unavailable', message: '' } }, { status, headers: NO_STORE });
}
