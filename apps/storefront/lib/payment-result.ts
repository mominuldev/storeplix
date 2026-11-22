import 'server-only';
import type { StorefrontOrder, StorefrontPaymentResult } from '@storeplix/types';
import { fetchConfirmation, fetchPaymentResult, type ShopperCall } from './commerce-api';
import { PAYMENT_ID_RE } from './commerce-schemas';

/**
 * What `/checkout/payment-result` and `/pay/result` render (PHASE-5B-CONTRACT §11, §5.3 step 3).
 * The status always comes from `GET /storefront/payments/{id}/result` (server-verified); the full
 * order is shown only when the shopper's own `sp_order` cookie names the same order number.
 */
export type PaymentResultView =
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'order'; order: StorefrontOrder; result: StorefrontPaymentResult | null; pending: boolean }
  | { kind: 'card'; result: StorefrontPaymentResult };

export async function resolvePaymentResult(call: ShopperCall, rawPaymentId: unknown, orderToken: string | null): Promise<PaymentResultView> {
  if (typeof rawPaymentId !== 'string' || !PAYMENT_ID_RE.test(rawPaymentId)) return { kind: 'invalid' };
  const [result, confirmation] = await Promise.all([
    fetchPaymentResult(call, rawPaymentId),
    orderToken ? fetchConfirmation(call.host, orderToken, call.previewToken, call.clientIp) : Promise.resolve(null),
  ]);
  const order = confirmation?.ok ? confirmation.data : null;

  if (!result.ok) {
    if (result.status === 404) return { kind: 'invalid' };
    // API hiccup: the shopper's own order (if any) still shows its last known state.
    return order ? { kind: 'order', order, result: null, pending: false } : { kind: 'unavailable' };
  }
  if (order && order.number === result.data.order_number) {
    return { kind: 'order', order, result: result.data, pending: result.data.status === 'pending' };
  }
  return { kind: 'card', result: result.data };
}
