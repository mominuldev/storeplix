import { NextResponse } from 'next/server';
import { fetchCart } from '@/lib/commerce-api';
import { clearCartCookie, getCommerceContext } from '@/lib/commerce-context';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/cart-summary` (P5-29): the header badge count. Never exposes the cart token; a stale
 * token (404 `cart_not_found`) is cleared. GET only (S12).
 */
export async function GET() {
  const ctx = await getCommerceContext();
  let linesCount = 0;
  let itemsCount = 0;
  if (ctx?.call.cartToken) {
    const r = await fetchCart(ctx.call);
    if (r.ok) {
      linesCount = r.data.cart.lines_count;
      itemsCount = r.data.cart.items_count;
    } else if (r.code === 'cart_not_found') {
      await clearCartCookie();
    }
  }
  return NextResponse.json({ data: { lines_count: linesCount, items_count: itemsCount } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
